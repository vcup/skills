#!/usr/bin/env bun
/**
 * The fresh-Host journey gate: a browser creates a Workspace through the official
 * UI, and the shipped Client binds it.
 *
 * ## Why this is a separate door from `auth-ui-check`
 *
 * `auth-ui-check` drives a Host that already has a project: it proves the Client
 * reads, writes and loses authorization correctly on a *prepared* instance. This
 * door proves the opposite end — that a **new** user can get to a working state at
 * all: the native UI offers a Workspace control, the directory flow opens, a real
 * directory is chosen, the Workspace is created, and only then does the Ensemble
 * picker see it and the GUI `initialize`/`bind` pair succeed.
 *
 * The difference matters because an empty Host that merely *boots* satisfies every
 * cheaper check while being completely unusable. So the Host this script starts is
 * explicitly a **diagnostic** one:
 *
 * - `ENSEMBLE_PRODUCT_DIAGNOSTIC_ONLY=1` — the driver records `diagnosticOnly: true`
 *   in the handoff, so no artifact from this run can be quoted as an acceptance;
 * - `--phases launch,identity` — nothing beyond a bootable Host with an empty
 *   registry is claimed by the setup;
 * - the only thing that can make this exit 0 is the probe walking the journey.
 *
 * ## What this script does
 *
 * 1. starts the product driver in serve mode against the pinned artifact, in its
 *    own gate root (so its own `DSH_HOME`), never shared with another lane;
 * 2. waits for `connection.json` and refuses a handoff that is not `diagnosticOnly`,
 *    is not `launch,identity`, or already names a project — that would be the wrong
 *    lane and the probe's premise would be false;
 * 3. runs `adapters/dsh/client/verify-fresh-journey.ts` against it;
 * 4. stops the driver, waits, and verifies the origin port refuses connections;
 * 5. writes `fresh-journey.json` with the handoff, the probe output path and the
 *    exit code it returned.
 *
 *   bun scripts/verify-dsh-fresh-journey.ts --install-dir DIR --package TGZ \
 *       --sha256 HEX --browser CHROME --output DIR [--timeout MS]
 *
 * Exit codes: 0 the probe walked the journey; 1 the probe or the driver failed;
 * 2 a prerequisite is missing or the handoff came from the wrong lane (nothing was
 * concluded).
 *
 * @module scripts/verify-dsh-fresh-journey
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRunRoot, outputProblem } from "./gate-root";

/** Bounded wait for the driver to publish its handoff. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Grace between SIGTERM and SIGKILL for the driver. */
const STOP_GRACE_MS = 15_000;

interface Invocation {
  readonly install: string;
  readonly packageFile: string;
  readonly sha256: string;
  readonly browser: string;
  /** Resolved path used for every write. */
  readonly output: string;
  /** Exactly what the caller typed; the `..` guard needs the unnormalised form. */
  readonly outputRaw: string;
  readonly timeoutMs: number;
}

function fail(message: string): never {
  console.error(`fresh-journey: ${message}`);
  process.exit(2);
}

/**
 * Parse the command line in one pass.
 *
 * Everything except `--timeout` is required. A repeated or unknown option is a
 * refusal: this gate must not run a weaker journey because a stale invocation lost
 * an argument.
 */
export function parseInvocation(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Invocation {
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
  const known = new Set(["--install-dir", "--package", "--sha256", "--browser", "--output", "--timeout"]);
  for (const token of values.keys()) if (!known.has(token)) throw new Error(`unknown option: ${token}`);

  const install = values.get("--install-dir");
  const packageFile = values.get("--package");
  const sha256 = values.get("--sha256");
  const output = values.get("--output");
  const browser = values.get("--browser") ?? env.ENSEMBLE_BROWSER_EXECUTABLE;
  if (install === undefined) throw new Error("missing --install-dir");
  if (packageFile === undefined) throw new Error("missing --package");
  if (sha256 === undefined) throw new Error("missing --sha256 (this gate verifies one frozen artifact)");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("--sha256 must be 64 lowercase hex characters");
  if (output === undefined) throw new Error("missing --output");
  if (browser === undefined || browser === "") {
    throw new Error("missing --browser (or ENSEMBLE_BROWSER_EXECUTABLE)");
  }
  const timeout = values.get("--timeout");
  const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive number");
  return {
    install: resolve(install),
    packageFile: resolve(packageFile),
    sha256,
    browser: resolve(browser),
    output: resolve(output),
    outputRaw: output,
    timeoutMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Wait for the driver's handoff, or fail when the driver dies first. */
async function waitForHandoff(
  path: string,
  timeoutMs: number,
  alive: () => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        // Half-written is not a handoff.
      }
    }
    if (!alive()) throw new Error("the product driver exited before publishing connection.json");
    if (Date.now() > deadline) throw new Error(`no connection.json after ${timeoutMs} ms`);
    await sleep(250);
  }
}

/**
 * Refuse a handoff that came from the wrong lane.
 *
 * The probe's premise is "this Host has no Workspace yet, so the journey starts at
 * creation". A handoff that already names a project, is not diagnostic-only, or ran
 * phases beyond a plain boot would make the probe test a different thing — so it is
 * a refusal (exit 2), not a failed assertion.
 *
 * On `phases`: the driver removes `launch` from the recorded list because the launch
 * fence is a process-level proof with no phase evidence of its own, so a request for
 * `launch,identity` is recorded as `identity`. Both spellings mean "booted, nothing
 * else exercised"; anything longer means the Host did real work and its registry may
 * no longer be empty.
 */
export function handoffProblem(handoff: Record<string, unknown>): string | undefined {
  if (handoff.diagnosticOnly !== true) {
    return "the handoff is not diagnostic-only; this gate needs a fresh Host, not an acceptance Host";
  }
  const phases = handoff.phases;
  if (phases !== "identity" && phases !== "launch,identity") {
    return `the handoff ran phases ${JSON.stringify(phases)}; the fresh door needs only launch and identity`;
  }
  for (const key of ["projectId", "workspaceId", "head", "authorizationEpoch"]) {
    if (handoff[key] !== undefined) {
      return `the handoff already names ${key}; the registry is not empty, so the create journey cannot be tested`;
    }
  }
  const origin = handoff.origin;
  if (typeof origin !== "string" || !origin.startsWith("http://")) {
    return `the handoff carries no usable origin: ${String(origin)}`;
  }
  return undefined;
}

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

/** True when nothing is listening on the handoff's port any more. */
async function portClosed(origin: string): Promise<boolean> {
  const port = Number(new URL(origin).port);
  if (!Number.isFinite(port) || port === 0) return true;
  return await new Promise<boolean>((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

async function main(): Promise<void> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2), process.env);
  } catch (error) {
    fail((error as Error).message);
  }
  const { install, packageFile, sha256, browser, output, outputRaw, timeoutMs } = invocation;

  if (!existsSync(install)) fail(`install directory does not exist: ${install}`);
  if (!existsSync(packageFile)) fail(`candidate package does not exist: ${packageFile}`);
  if (!existsSync(browser)) fail(`browser does not exist: ${browser}`);
  if (spawnSync("node", ["--version"], { encoding: "utf8" }).status !== 0) {
    fail("no real node on PATH; the Host launcher is a Node program");
  }

  // The caller's --output must be a directory this gate may write into; a root, the
  // repository itself, a `..` path or a symlink is a refusal before anything is made.
  const outputIssue = outputProblem(outputRaw, resolve(import.meta.dir, ".."));
  if (outputIssue !== undefined) fail(outputIssue);
  mkdirSync(output, { recursive: true });
  // Its own gate root, therefore its own DSH_HOME: a profile and its ledger are
  // single-writer, so this lane never shares one with the prepared-Host lane.
  //
  // Created fresh per run by `mkdtemp`, so a `connection.json` left by an earlier run
  // cannot be read — a stale handoff names a Host that no longer exists, and waiting
  // for "the file" would then use a dead origin and fail with a connection refusal
  // that looks like a product bug. Nothing is removed: the old
  // `rmSync(join(output, "serve"))` could have deleted a caller-named directory this
  // gate never created.
  const runRoot = createRunRoot(output, "fresh-run");
  const serveRoot = join(runRoot.path, "serve");
  mkdirSync(serveRoot, { recursive: true });
  const handoffPath = join(serveRoot, "connection.json");
  const resultPath = join(output, "fresh-journey.json");
  const startedAt = new Date().toISOString();
  writeFileSync(
    resultPath,
    `${JSON.stringify({ status: "running", install, package: packageFile, sha256, browser, startedAt }, null, 2)}\n`,
  );

  const driver = spawn(
    process.execPath,
    [
      join(import.meta.dir, "verify-dsh-product.ts"),
      install,
      packageFile,
      "--sha256",
      sha256,
      "--phases",
      "launch,identity",
      "--serve",
    ],
    {
      env: {
        ...process.env,
        ENSEMBLE_PRODUCT_ROOT: serveRoot,
        ENSEMBLE_PRODUCT_SERVE: "1",
        ENSEMBLE_PRODUCT_DIAGNOSTIC_ONLY: "1",
        ENSEMBLE_PRODUCT_PHASES: "launch,identity",
        ENSEMBLE_PRODUCT_NODE: "node",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let log = "";
  driver.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
    process.stdout.write(chunk);
  });
  driver.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
    process.stderr.write(chunk);
  });

  const alive = (): boolean => driver.exitCode === null && driver.signalCode === null;
  let exitCode = 1;
  let reason = "the fresh-journey probe did not run";
  try {
    let handoff: Record<string, unknown>;
    try {
      handoff = await waitForHandoff(handoffPath, timeoutMs, alive);
    } catch (error) {
      reason = (error as Error).message;
      console.error(`fresh-journey: ${reason}`);
      return;
    }
    const problem = handoffProblem(handoff);
    if (problem !== undefined) {
      reason = problem;
      console.error(`fresh-journey: ${reason}`);
      return;
    }
    const origin = String(handoff.origin);
    process.stdout.write(`== fresh-journey: diagnostic Host at ${origin} (phases launch,identity)\n`);

    // The probe creates a Workspace by picking a real directory, so it needs an
    // empty one of its own. It is created here, inside the gate root: a directory
    // shared with anything else would let the probe "create" a Workspace that
    // already existed, which is the exact false positive this door exists to catch.
    const hostDirectory = join(output, "host-directory");
    mkdirSync(hostDirectory, { recursive: true });

    const probe = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../adapters/dsh/client/verify-fresh-journey.ts"),
        "--connection",
        handoffPath,
        "--browser",
        browser,
        "--output",
        join(output, "probe"),
        "--host-directory",
        hostDirectory,
      ],
      { stdio: "inherit", env: process.env, cwd: join(import.meta.dir, "..") },
    );
    exitCode = probe.status ?? 1;
    reason =
      exitCode === 0
        ? "the probe created a Workspace through the official UI and the Client bound it"
        : `the fresh-journey probe exited ${exitCode}`;

    await stop(driver);
    if (!(await portClosed(origin))) {
      exitCode = exitCode === 0 ? 1 : exitCode;
      reason = `${reason}; the diagnostic Host still accepted connections on ${origin}`;
      console.error(`fresh-journey: ${reason}`);
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
          probeOutput: join(output, "probe"),
          driverLogTail: log.slice(-4000),
        },
        null,
        2,
      )}\n`,
    );
  }

  console.log(exitCode === 0 ? "== fresh-journey: ok" : `== fresh-journey: FAILED (exit ${exitCode}) — ${reason}`);
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
