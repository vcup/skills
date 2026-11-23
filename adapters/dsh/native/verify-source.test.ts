/**
 * Negative controls for `verify-source.mjs`.
 *
 * The driver's whole value is that it **refuses** a fixture that is not on a
 * different filesystem. A gate that only ever runs against a correct fixture is
 * untested precisely where it matters, so these cases point it at fixtures it must
 * reject, and assert the refusal reason rather than just a non-zero exit.
 *
 * The important one is `same filesystem`: a fixture started **on the runner's own
 * filesystem** must fail. That is the false positive the previous version could
 * not detect, because it asserted on the virtual `/source` prefix instead of the
 * root the fixture actually serves from.
 *
 * These run the real driver as a child process against a real fixture server, so
 * the assertions are about observable behaviour, not internal functions.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// `HERE` is `adapters/dsh/native`, so the project root is three levels up — with
// two, this resolved to `adapters/`, whose non-existent `scripts/fixtures` child
// made every `spawn` fail with an ENOENT that looks like a missing bun binary.
const ROOT = join(HERE, "..", "..", "..");
const SERVER = join(ROOT, "scripts/fixtures/source-world-server.mjs");
const DRIVER = join(HERE, "verify-source.mjs");
const TOKEN = "verify-source-negative-control-token-0123456789";

/**
 * The isolated install, if this tree has one.
 *
 * `.scratch/` is gitignored, so a fresh clone, a CI runner or another checkout has
 * no `.scratch/rc5-cycle`. Every refusal below is decided **before** the driver
 * resolves `@deepseek-ai/*`, so those cases run for real without an install — no
 * skip. Only a future positive-path test would need one, and it skips explicitly.
 */
const INSTALL = process.env.DSH_ARCHIVE_SEAM_INSTALL ?? join(ROOT, ".scratch/rc5-cycle/rc5");
const NO_INSTALL = !existsSync(join(INSTALL, "node_modules/@deepseek-ai/dsh/package.json"));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

interface Started {
  readonly child: import("node:child_process").ChildProcess;
  readonly origin: string;
  readonly world: string;
  readonly root: string;
}

/** Start a real fixture and wait for its banner. */
async function start(token = TOKEN): Promise<Started> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, "scripts/fixtures"),
    env: { ...process.env, ENSEMBLE_SOURCE_TEST_TOKEN: token, ENSEMBLE_SOURCE_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const banner = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`fixture did not start: ${stdout}${stderr}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) { clearTimeout(timer); resolve(stdout); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited with ${code}: ${stdout}${stderr}`)); });
  });
  const parsed = JSON.parse(banner.trim()) as { world: string; root: string };
  return { child, origin: `http://127.0.0.1:${port}`, world: parsed.world, root: parsed.root };
}

/** The operator attestation every real run must state; container facts are not observable. */
const ATTEST = {
  ENSEMBLE_SOURCE_ATTEST_BY: "verify-source negative-control suite",
  ENSEMBLE_SOURCE_ATTEST_CONTAINER: "test-fixture-no-mount-container",
  ENSEMBLE_SOURCE_ATTEST_STATEMENT: "fixture runs in a container with no project mount",
  ENSEMBLE_SOURCE_ATTEST_COPY_SHA256: "70a3c142bd683c1a034fd7131a2a10a9859301f2c5fc77c3db4e6344a5dba8b7",
} as const;

/** Run the driver and collect its outcome. */
async function drive(url: string, token: string | undefined, attest: boolean = true): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ENSEMBLE_SOURCE_TEST_URL: url, ...(attest ? ATTEST : {}) };
  if (token === undefined) delete env.ENSEMBLE_SOURCE_TEST_TOKEN;
  else env.ENSEMBLE_SOURCE_TEST_TOKEN = token;
  if (!attest) for (const key of Object.keys(ATTEST)) delete env[key];
  const child = spawn(process.execPath, [DRIVER, INSTALL], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>(resolve => child.once("exit", () => resolve(child.exitCode)));
  return { code, stdout, stderr };
}

const running: Started[] = [];
afterAll(() => { for (const started of running) started.child.kill("SIGTERM"); });

describe("verify-source refuses a fixture that is not on another filesystem", () => {
  test("the same filesystem is refused, naming the existing root", async () => {
    const fixture = await start();
    running.push(fixture);
    // This fixture runs in *this* process tree on *this* filesystem, so the root it
    // reports really exists here. That is the false positive the old driver missed:
    // it asserted on the virtual `/source` prefix, which is absent everywhere.
    expect((await stat(fixture.root)).isDirectory()).toBe(true);
    const outcome = await drive(fixture.origin, TOKEN);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("exists on this filesystem");
    expect(outcome.stderr).toContain(fixture.root);
    // It must not claim a pass while refusing.
    expect(outcome.stdout).not.toContain("PASS");
  }, 60_000);

  test("a missing token is refused before any transfer", async () => {
    const outcome = await drive("http://127.0.0.1:1", undefined);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("test-only fixture token is required");
  }, 30_000);

  test("a wrong token is refused by the fixture, not treated as identity", async () => {
    const fixture = await start();
    running.push(fixture);
    const outcome = await drive(fixture.origin, `${TOKEN}-but-wrong`);
    expect(outcome.code).not.toBe(0);
    // The identity route is authenticated, so a wrong token never yields a root.
    expect(outcome.stderr).toContain("403");
    expect(outcome.stdout).not.toContain("PASS");
  }, 60_000);

  test("an unreachable endpoint is refused, not silently passed", async () => {
    const outcome = await drive("http://127.0.0.1:1", TOKEN);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stdout).not.toContain("PASS");
  }, 30_000);

  test("a missing operator attestation is refused, never assumed", async () => {
    // Container-level facts are not observable from the runner, so the driver must
    // not invent them. Without an operator statement it refuses rather than writing
    // a `true` it did not measure — the defect this replaced.
    const fixture = await start();
    running.push(fixture);
    const outcome = await drive(fixture.origin, TOKEN, false);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("ENSEMBLE_SOURCE_ATTEST_BY must be stated by the operator");
    expect(outcome.stdout).not.toContain("PASS");
  }, 60_000);
});

describe("the fixture reports an identity the driver can check", () => {
  test("identity is authenticated, absolute, fixture-shaped and world-consistent", async () => {
    const fixture = await start();
    running.push(fixture);
    const response = await fetch(fixture.origin + "/fixture/identity", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const identity = await response.json() as { ok: boolean; world: string; root: string; fixture: string };
    expect(identity.ok).toBe(true);
    expect(identity.fixture).toBe("source-world");
    expect(identity.world).toBe(fixture.world);
    expect(identity.root).toBe(fixture.root);
    expect(identity.root.startsWith("/")).toBe(true);
    expect(identity.root.includes("ensemble-source-world-")).toBe(true);

    // Unauthenticated callers learn nothing, including the root.
    const anonymous = await fetch(fixture.origin + "/fixture/identity");
    expect(anonymous.status).toBe(403);
    const body = await anonymous.json() as { root?: string };
    expect(body.root).toBeUndefined();
  }, 60_000);

  test("identity and health cannot describe different worlds", async () => {
    const fixture = await start();
    running.push(fixture);
    const [identity, health] = await Promise.all([
      fetch(fixture.origin + "/fixture/identity", { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json()),
      fetch(fixture.origin + "/health", { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json()),
    ]) as [{ world: string }, { world: string }];
    // The driver asserts these agree; a fixture that echoed a different world would
    // make the served root unattributable to the bytes that were read.
    expect(identity.world).toBe(health.world);
  }, 60_000);

  test("the root is generated by the fixture, not taken from the environment", async () => {
    const fixture = await start();
    running.push(fixture);
    const response = await fetch(fixture.origin + "/fixture/identity", { headers: { authorization: `Bearer ${TOKEN}` } });
    const identity = await response.json() as { root: string };
    expect(identity.root).toBe(fixture.root);
    // It is a real directory on this filesystem — which is why this same-filesystem
    // fixture is refused, and why the check becomes meaningful on the other side.
    expect((await stat(identity.root)).isDirectory()).toBe(true);
    expect(identity.root.startsWith(tmpdir())).toBe(true);
  }, 60_000);
});
