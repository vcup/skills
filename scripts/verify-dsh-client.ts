#!/usr/bin/env bun
/**
 * Authenticated-UI release gate: the *shipped* Client, in a real browser,
 * against a real Host it booted itself.
 *
 * This is not `adapters/dsh/client/verify-browser.ts`. That gate extracts the
 * packed factory, mounts it into a shell it declares itself and answers the
 * Remote from fixtures — useful, but it cannot see the failure that matters most
 * here: a Client that loads, renders nothing and never activates because the
 * plugin reads a service it did not inject. Only a real Host composes the real
 * module system over the real profile, so only a real Host can prove the shipped
 * Client works.
 *
 * The orchestration is deliberately thin, because each half already exists and
 * owns its own contract:
 *
 * 1. `scripts/verify-dsh-product.ts <install> <tarball> --sha256 <hex> --serve`
 *    installs the pinned artifact, runs the product gate, boots the real Host and
 *    writes `connection.json` with the cookie the Host itself issued. It blocks
 *    until it is signalled, and its `finally` stops the Host — so the driver is
 *    the only handle that produces ordered cleanup.
 * 2. `adapters/dsh/client/verify-auth.ts --connection … --browser … --output …`
 *    drives that live Host in a browser and asserts the whole authenticated
 *    journey.
 *
 * This file adds no protocol, no fixture and no assertion of its own. What it
 * adds is the lifecycle: a background driver group, a bounded wait for the
 * handoff, ordered shutdown, and an exit code that fails closed. A gate that
 * leaked a Host would hold a profile lock and make the *next* run fail, which is
 * a worse failure than the one it was measuring.
 *
 * Browser prerequisites are the caller's to name: `--browser` (or
 * `ENSEMBLE_BROWSER_EXECUTABLE`) must be an official Chrome/Chromium build, and
 * `ENSEMBLE_BROWSER_LIBRARIES` / `ENSEMBLE_BROWSER_FONTCONFIG` carry the shared
 * libraries and a font configuration when the image has none. A browser that
 * aborts for want of a font is an environment failure (exit 2), never a product
 * failure and never a skip.
 *
 *   bun scripts/verify-dsh-client.ts --install-dir <dir> --package <tgz> \
 *       --browser <chrome> --output <dir> [--sha256 <hex>] [--timeout <ms>]
 *
 * Exit codes: 0 every phase passed; 1 the product gate or the browser gate
 * failed; 2 a prerequisite was missing or unusable (nothing was concluded).
 *
 * @module scripts/verify-dsh-client
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRunRoot, outputProblem } from "./gate-root";

/** Bounded wait for the driver to publish its handoff. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Grace between SIGTERM and SIGKILL for the driver group. */
const STOP_GRACE_MS = 15_000;

interface Invocation {
  readonly install: string;
  readonly packageFile: string;
  readonly browser: string;
  /** Resolved path used for every write. */
  readonly output: string;
  /** Exactly what the caller typed; the `..` guard needs the unnormalised form. */
  readonly outputRaw: string;
  readonly sha256: string | undefined;
  readonly timeoutMs: number;
}

function fail(message: string): never {
  console.error(`auth-ui: ${message}`);
  process.exit(2);
}

/**
 * Parse the command line in one pass.
 *
 * Every option is required except `--sha256` and `--timeout`, no option may
 * repeat, and an unknown token is a refusal: a stale invocation must not quietly
 * run a weaker check than the one that was asked for.
 */
export function parseInvocation(argv: readonly string[], env: Record<string, string | undefined>): Invocation {
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    if (seen.has(token)) throw new Error(`repeated option: ${token}`);
    seen.add(token);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`option needs a value: ${token}`);
    values.set(token, value);
    index += 1;
  }
  const known = new Set(["--install-dir", "--package", "--browser", "--output", "--sha256", "--timeout"]);
  for (const token of values.keys()) if (!known.has(token)) throw new Error(`unknown option: ${token}`);

  const install = values.get("--install-dir");
  const packageFile = values.get("--package");
  const output = values.get("--output");
  const browser = values.get("--browser") ?? env.ENSEMBLE_BROWSER_EXECUTABLE;
  if (install === undefined) throw new Error("missing --install-dir");
  if (packageFile === undefined) throw new Error("missing --package");
  if (output === undefined) throw new Error("missing --output");
  if (browser === undefined || browser === "") {
    throw new Error("missing --browser (or ENSEMBLE_BROWSER_EXECUTABLE)");
  }
  const timeout = values.get("--timeout");
  const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`--timeout must be a positive number`);
  return {
    install: resolve(install),
    packageFile: resolve(packageFile),
    browser: resolve(browser),
    output: resolve(output),
    outputRaw: output,
    sha256: values.get("--sha256"),
    timeoutMs,
  };
}

/** Resolve the Bun and Node programs this gate spawns, or refuse by name. */
function runtimes(): { bun: string; node: string } {
  const bun = process.execPath;
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (node.status !== 0) {
    fail("no real node on PATH; the Host launcher is a Node program (set ENSEMBLE_PRODUCT_NODE).");
  }
  return { bun, node: "node" };
}

/**
 * Wait until `path` exists and parses as JSON, or fail after `timeoutMs`.
 *
 * The driver writes the handoff only after measuring both credentials against the
 * surfaces they are for, so the file's existence already means "the Host is
 * serving and both cookies are correct". A partial write cannot pass: the read is
 * retried until it parses.
 */
async function waitForHandoff(path: string, timeoutMs: number, alive: () => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        // A half-written file is not a handoff; keep waiting.
      }
    }
    if (!alive()) throw new Error("the product driver exited before publishing connection.json");
    if (Date.now() > deadline) throw new Error(`no connection.json after ${timeoutMs} ms`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Stop a driver and everything it started, then wait for it to be gone. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((done) => child.once("exit", () => done(true))),
    new Promise<boolean>((done) => setTimeout(() => done(false), STOP_GRACE_MS)),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      setTimeout(done, 5_000);
    });
  }
}

/**
 * Prove the Host's port is closed after the driver exited.
 *
 * A connection that still succeeds means the Host outlived its driver — the next
 * leg would then contend for the same profile lock, and the failure would look
 * unrelated to this run.
 */
async function portClosed(origin: string): Promise<boolean> {
  const url = new URL(origin);
  const port = Number(url.port);
  if (!Number.isFinite(port) || port === 0) return true;
  return await new Promise<boolean>((done) => {
    const socket = createServer();
    socket.once("error", () => done(false));
    socket.listen(port, "127.0.0.1", () => socket.close(() => done(true)));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function main(): Promise<void> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2), process.env);
  } catch (error) {
    fail((error as Error).message);
  }
  const { install, packageFile, browser, output, outputRaw, sha256, timeoutMs } = invocation;

  if (!existsSync(install)) fail(`install directory does not exist: ${install}`);
  if (!existsSync(packageFile)) fail(`candidate package does not exist: ${packageFile}`);
  if (!existsSync(browser)) fail(`browser does not exist: ${browser}`);
  if (!existsSync(join(install, "node_modules/@deepseek-ai/dsh/package.json"))) {
    fail(`no @deepseek-ai/dsh in ${install}; this gate needs a real isolated install`);
  }

  const { bun, node } = runtimes();
  // The caller's --output must be a directory this gate may write into; a root, the
  // repository itself, a `..` path or a symlink is a refusal before anything is made.
  const outputIssue = outputProblem(outputRaw, resolve(import.meta.dir, ".."));
  if (outputIssue !== undefined) fail(outputIssue);
  mkdirSync(output, { recursive: true });
  // A dedicated gate root: the serving Host owns one profile and one ledger, and
  // sharing it with the strict product gate would make two writers of one store.
  //
  // It is created fresh per run by `mkdtemp`, so a `connection.json` from an earlier
  // run cannot be read (a stale handoff names a dead Host, and the browser would then
  // fail with ECONNREFUSED — an environment symptom that reads like a product bug).
  // Removing nothing is what makes this safe: the old `rmSync(join(output, "serve"))`
  // would have deleted a caller-named directory the gate never created.
  const runRoot = createRunRoot(output, "auth-run");
  const serveRoot = join(runRoot.path, "serve");
  mkdirSync(serveRoot, { recursive: true });
  const handoffPath = join(serveRoot, "connection.json");
  const resultPath = join(output, "auth-ui.json");
  const startedAt = new Date().toISOString();

  writeFileSync(
    resultPath,
    `${JSON.stringify({ status: "running", install, package: packageFile, sha256, browser, startedAt }, null, 2)}\n`,
  );

  const driver = spawn(
    bun,
    [
      join(import.meta.dir, "verify-dsh-product.ts"),
      install,
      packageFile,
      ...(sha256 === undefined ? [] : ["--sha256", sha256]),
      "--serve",
    ],
    {
      env: { ...process.env, ENSEMBLE_PRODUCT_ROOT: serveRoot, ENSEMBLE_PRODUCT_SERVE: "1", ENSEMBLE_PRODUCT_NODE: node },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a signal reaches the launcher and the Host it
      // started rather than only this wrapper's direct child.
      detached: true,
    },
  );
  let driverLog = "";
  driver.stdout?.on("data", (chunk: Buffer) => {
    driverLog += chunk.toString();
    process.stdout.write(chunk);
  });
  driver.stderr?.on("data", (chunk: Buffer) => {
    driverLog += chunk.toString();
    process.stderr.write(chunk);
  });

  const alive = (): boolean => driver.exitCode === null && driver.signalCode === null;
  let exitCode = 1;
  let reason = "the browser gate did not run";
  try {
    let handoff: Record<string, unknown>;
    try {
      handoff = await waitForHandoff(handoffPath, timeoutMs, alive);
    } catch (error) {
      reason = (error as Error).message;
      console.error(`auth-ui: ${reason}`);
      return;
    }
    const origin = String(handoff.origin ?? "");
    if (!origin.startsWith("http://")) {
      reason = `the handoff carries no usable origin: ${origin}`;
      console.error(`auth-ui: ${reason}`);
      return;
    }
    process.stdout.write(`== auth-ui: Host serving at ${origin}, handoff ${handoffPath}\n`);

    const auth = spawnSync(
      bun,
      [
        join(import.meta.dir, "../adapters/dsh/client/verify-auth.ts"),
        "--connection",
        handoffPath,
        "--browser",
        browser,
        "--output",
        join(output, "browser"),
      ],
      { stdio: "inherit", env: process.env, cwd: join(import.meta.dir, "..") },
    );
    exitCode = auth.status ?? 1;
    reason =
      exitCode === 0
        ? "the shipped Client passed the authenticated browser journey"
        : `the browser gate exited ${exitCode}`;

    // Ordered shutdown: the driver is the only handle whose `finally` stops the
    // Host, so it is signalled first and awaited before the port is checked.
    await stop(driver);
    const closed = await Promise.race([portClosed(origin), sleep(10_000).then(() => false)]);
    if (!closed) {
      exitCode = exitCode === 0 ? 1 : exitCode;
      reason = `${reason}; the Host still accepted connections on ${origin} after the driver exited`;
      console.error(`auth-ui: ${reason}`);
    }
  } finally {
    await stop(driver);
    writeFileSync(
      resultPath,
      `${JSON.stringify(
        {
          status: exitCode === 0 ? "passed" : "failed",
          install,
          package: packageFile,
          sha256,
          browser,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
          reason,
          handoff: existsSync(handoffPath) ? handoffPath : null,
          browserOutput: join(output, "browser"),
          driverLogTail: driverLog.slice(-4000),
        },
        null,
        2,
      )}\n`,
    );
  }

  console.log(exitCode === 0 ? "== auth-ui: ok" : `== auth-ui: FAILED (exit ${exitCode}) — ${reason}`);
  process.exitCode = exitCode;
}

await main();
