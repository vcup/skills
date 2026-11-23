#!/usr/bin/env bun
/**
 * `live-cli-test` — the live CLI case, executed for real and never skipped.
 *
 * ## Why this is a gate of its own
 *
 * `adapters/dsh/cli.test.ts` contains one case that needs a running Host: it lists the
 * Host's real projects, reads a project's context with `query`, and performs a
 * **reversible** owner write (`manage` pause) against the observed `read_revision`,
 * confirming the committed revision by reading again and then resuming so the case is
 * repeatable. Offline it skips, which is correct — but a release cannot claim that case
 * ran while its only execution path is "skipped unless somebody remembers to export two
 * variables by hand". Lead's rule: release wiring must bind the live case, not plan to
 * pass arguments later.
 *
 * So this gate **owns the Host lifecycle**: it starts the product driver in serve mode,
 * waits for the handoff, takes the `origin` and the **api cookie file path** from that
 * handoff, runs the case, and then insists the case actually executed — `skip=0`,
 * `fail=0`, `pass>0`.
 *
 * ## Three ways this could be faked, and what stops each
 *
 * 1. **Skipping again.** The environment names are the test's own
 *    (`DSH_CLI_LIVE_ORIGIN`, `DSH_CLI_LIVE_COOKIE_FILE`), but a skip is a failure here.
 *    A gate that accepts "skipped" is exactly how this case went uncovered before.
 * 2. **A credential in argv.** The cookie travels by **path**, taken from the handoff;
 *    its contents are never read, printed, or passed as a value.
 * 3. **A Host that was not there.** The handoff is read only after the driver publishes
 *    it, and this process closes the port on the way out.
 *
 * ## Why it reuses the driver rather than a second install
 *
 * `verify-dsh-product.ts --serve` is already how `auth-ui-check` and
 * `fresh-journey-check` obtain a Host. Reusing it avoids a second large download and
 * keeps one way to get a Host instead of three.
 *
 *   bun scripts/verify-dsh-live-cli.ts --install-dir DIR --package TGZ --sha256 HEX \
 *       --output DIR [--timeout MS]
 *
 * Exit: 0 the live case ran and passed; 1 it failed or did not run; 2 a prerequisite is
 * missing (nothing concluded).
 *
 * @module scripts/verify-dsh-live-cli
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRunRoot, outputProblem } from "./gate-root";

const DEFAULT_TIMEOUT_MS = 300_000;
const STOP_GRACE_MS = 15_000;

/** The test file that holds the live case. */
const LIVE_FILE = "adapters/dsh/cli.test.ts";

/**
 * The `describe` that holds the live lane, used as the `bun test -t` selector.
 *
 * A describe name is stable; the case title is not. See the comment at the call site.
 */
const LIVE_DESCRIBE = "packaged CLI against a live Host";

interface Invocation {
  readonly install: string;
  readonly packageFile: string;
  readonly sha256: string;
  readonly output: string;
  readonly outputRaw: string;
  readonly timeoutMs: number;
}

function fail(message: string): never {
  console.error(`live-cli-test: ${message}`);
  process.exit(2);
}

export function parseInvocation(argv: readonly string[], env: Record<string, string | undefined>): Invocation {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`option needs a value: ${token}`);
    values.set(token, value);
    index += 1;
  }
  const known = new Set(["--install-dir", "--package", "--sha256", "--output", "--timeout"]);
  for (const token of values.keys()) if (!known.has(token)) throw new Error(`unknown option: ${token}`);

  const install = values.get("--install-dir") ?? env.INSTALL_DIR;
  const packageFile = values.get("--package") ?? env.PACKAGE;
  const sha256 = values.get("--sha256") ?? env.PACKAGE_SHA256;
  const output = values.get("--output");
  if (install === undefined) throw new Error("missing --install-dir");
  if (packageFile === undefined) throw new Error("missing --package");
  if (sha256 === undefined) throw new Error("missing --sha256 (this gate verifies one frozen artifact)");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("--sha256 must be 64 lowercase hex characters");
  if (output === undefined) throw new Error("missing --output");
  const timeout = values.get("--timeout");
  const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive number");
  return {
    install: resolve(install),
    packageFile: resolve(packageFile),
    sha256,
    output: resolve(output),
    outputRaw: output,
    timeoutMs,
  };
}

/**
 * The two facts the live case needs, taken from the driver's handoff.
 *
 * Returns the problem instead of throwing so the caller keeps one exit path. A handoff
 * without an origin or an api cookie file is a prerequisite failure — never a silent
 * skip, and never a reason to invent a value.
 */
export function handoffProblem(handoff: Record<string, unknown>): string | undefined {
  const origin = handoff.origin;
  if (typeof origin !== "string" || !origin.startsWith("http://")) {
    return `the handoff carries no usable origin: ${String(origin)}`;
  }
  const cookie = handoff.apiCookieFile;
  if (typeof cookie !== "string" || cookie === "") {
    return "the handoff carries no apiCookieFile, so the CLI has no credential to use";
  }
  if (!existsSync(cookie)) return `the handoff's apiCookieFile does not exist: ${cookie}`;
  return undefined;
}

/**
 * Decide the verdict from the numbers.
 *
 * Separated from the process handling so it can be tested without a Host, and because the
 * three failure modes are easy to confuse: a skip is "did not run", a fail is "ran and was
 * wrong", and a zero-count pass is "nothing ran but the exit code looked fine".
 */
export function verdict(counts: { pass: number; fail: number; skip: number }, exit: number): {
  code: number;
  reason: string;
} {
  if (counts.skip > 0) {
    return { code: 1, reason: `the live case skipped (skip=${counts.skip}); the environment did not reach the test` };
  }
  if (counts.fail > 0 || exit !== 0) {
    return { code: 1, reason: `the live case failed (fail=${counts.fail}, exit=${exit})` };
  }
  if (counts.pass === 0) {
    return { code: 1, reason: "no live test ran; a zero-count pass is not evidence" };
  }
  return { code: 0, reason: `the live case executed and passed (pass=${counts.pass}, skip=0)` };
}

/** Read bun's summary lines; the numbers decide, not the prose. */
export function summarize(output: string): { pass: number; fail: number; skip: number } {
  const pick = (label: string): number => {
    const match = output.match(new RegExp(`^\\s*(\\d+)\\s+${label}\\s*$`, "m"));
    return match === null ? 0 : Number(match[1]);
  };
  return { pass: pick("pass"), fail: pick("fail"), skip: pick("skip") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForHandoff(path: string, timeoutMs: number, alive: () => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        // A half-written file is not a handoff.
      }
    }
    if (!alive()) throw new Error("the product driver exited before publishing connection.json");
    if (Date.now() > deadline) throw new Error(`no connection.json after ${timeoutMs} ms`);
    await sleep(250);
  }
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
  const { install, packageFile, sha256, output, outputRaw, timeoutMs } = invocation;

  const outputIssue = outputProblem(outputRaw, resolve(import.meta.dir, ".."));
  if (outputIssue !== undefined) fail(outputIssue);
  if (!existsSync(install)) fail(`install directory does not exist: ${install}`);
  if (!existsSync(packageFile)) fail(`candidate package does not exist: ${packageFile}`);
  if (spawnSync("node", ["--version"], { encoding: "utf8" }).status !== 0) {
    fail("no real node on PATH; the Host launcher is a Node program");
  }

  mkdirSync(output, { recursive: true });
  // A fresh per-run root, so a stale handoff from an earlier run cannot be read.
  const runRoot = createRunRoot(output, "live-cli-run");
  const serveRoot = join(runRoot.path, "serve");
  mkdirSync(serveRoot, { recursive: true });
  const handoffPath = join(serveRoot, "connection.json");
  const resultPath = join(output, "live-cli.json");
  const startedAt = new Date().toISOString();

  const driver = spawn(
    process.execPath,
    [join(import.meta.dir, "verify-dsh-product.ts"), install, packageFile, "--sha256", sha256, "--serve"],
    {
      env: { ...process.env, ENSEMBLE_PRODUCT_ROOT: serveRoot, ENSEMBLE_PRODUCT_SERVE: "1", ENSEMBLE_PRODUCT_NODE: "node" },
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
  let reason = "the live CLI case did not run";
  let counts = { pass: 0, fail: 0, skip: 0 };
  let origin = "";

  try {
    let handoff: Record<string, unknown>;
    try {
      handoff = await waitForHandoff(handoffPath, timeoutMs, alive);
    } catch (error) {
      reason = (error as Error).message;
      console.error(`live-cli-test: ${reason}`);
      return;
    }
    const problem = handoffProblem(handoff);
    if (problem !== undefined) {
      reason = problem;
      console.error(`live-cli-test: ${reason}`);
      return;
    }
    origin = String(handoff.origin);
    const cookieFile = String(handoff.apiCookieFile);
    // The path is logged; the credential never is, and its contents are never read here.
    process.stdout.write(`== live-cli-test: Host at ${origin}, credential file ${cookieFile}\n`);

    // Select the live lane by its **describe** name, not by a case title.
    //
    // The first version matched the case title as it read when the case drove the v1 verbs
    // (`status, initialize and readBack`). When the product retired those verbs and the case
    // was rewritten for the shipped surface, the title changed and this selector matched
    // **zero** tests — the wrapper then reported `pass=0`, which is its "nothing ran"
    // refusal. That is the right verdict, but it would have been read as a product failure
    // and it cost a real Host boot to find.
    //
    // A describe name states *which lane this is* ("a packaged CLI against a live Host"),
    // which is stable across rewording of what the lane currently exercises. A title
    // describes the current verbs, and those are exactly what changes.
    const run = spawnSync(process.execPath, ["test", LIVE_FILE, "-t", LIVE_DESCRIBE], {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        DSH_ARCHIVE_SEAM_INSTALL: install,
        DSH_CLI_LIVE_ORIGIN: origin,
        DSH_CLI_LIVE_COOKIE_FILE: cookieFile,
      },
      encoding: "utf8",
      timeout: timeoutMs,
    });
    const outputText = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    counts = summarize(outputText);
    process.stdout.write(outputText.slice(-2000));
    const decision = verdict(counts, run.status ?? 1);
    exitCode = decision.code;
    reason = decision.reason;
    if (exitCode !== 0) console.error(`live-cli-test: ${reason}`);
  } finally {
    await stop(driver);
    if (origin !== "" && !(await portClosed(origin))) {
      exitCode = exitCode === 0 ? 1 : exitCode;
      reason = `${reason}; the Host still accepted connections on ${origin}`;
    }
    writeFileSync(
      resultPath,
      `${JSON.stringify(
        {
          status: exitCode === 0 ? "passed" : "failed",
          install,
          package: packageFile,
          sha256,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
          reason,
          counts,
          // The handoff path is recorded; the credential's contents never are.
          handoff: existsSync(handoffPath) ? handoffPath : null,
          driverLogTail: log.slice(-3000),
        },
        null,
        2,
      )}\n`,
    );
  }

  console.log(exitCode === 0 ? "== live-cli-test: ok" : `== live-cli-test: FAILED (exit ${exitCode}) — ${reason}`);
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
