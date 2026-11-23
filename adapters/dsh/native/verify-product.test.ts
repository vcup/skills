/**
 * The product gate's own contract: what it refuses, what it cleans up, and what
 * it proves about the artifact bytes. Nothing here installs a product or boots a
 * Host — those are the gate's *subject*, not its contract. What is tested is the
 * part that was wrong before and would be wrong again silently:
 *
 *   - a candidate whose bytes do not match the pin is refused **before** anything
 *     is installed, so a wrong artifact can never produce a green run;
 *   - an installed file that differs from the tarball member is a failure, because
 *     "installed distribution" is a claim about bytes;
 *   - a missing runtime, a missing tarball, an unknown flag and a malformed pin
 *     are exit 2 with a message, not a crash;
 *   - a caller's persistent gate root is never deleted;
 *   - every child is bounded and a child that outlives its bound is killed, so a
 *     red gate cannot leave a Host or a fixture running.
 *
 * The artifacts here are built in a temporary directory by `tar`, so these tests
 * need no release candidate and cannot disturb the shared `build/` tree.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  PINNED_ENTRIES,
  bounded,
  nodeBin,
  parseInvocation,
  readTarballEntry,
  runGate,
  sha256,
  stop,
  verifyArtifact,
} from "../../../scripts/verify-dsh-product.ts";
import { productRunContext, type ProductRunContextInput } from "./verify-product-context.mjs";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "product-gate-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Build a minimal but real `.tgz` with exactly the pinned entries. */
function buildTarball(directory: string, overrides: Record<string, string> = {}): string {
  const pkg = join(directory, "package");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  const contents: Record<string, string> = {
    "index.js": "export const name = 'fixture'\n",
    "client.js": "module.exports = {}\n",
    "bin/ensemble-archive.js": "#!/usr/bin/env node\n",
    "package.json": '{"name":"dsh-ensemble","version":"1.0.0"}\n',
    ...overrides,
  };
  for (const [name, body] of Object.entries(contents)) writeFileSync(join(pkg, name), body);
  const tarball = join(directory, "dsh-ensemble-fixture.tgz");
  const tar = Bun.spawnSync(["tar", "czf", tarball, "-C", directory, "package"]);
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return tarball;
}

/** Materialize a fake installation whose pinned files equal the tarball's. */
function fakeInstall(directory: string, tarball: string, mutate?: (root: string) => void): string {
  const installed = join(directory, "installed");
  mkdirSync(installed, { recursive: true });
  for (const entry of PINNED_ENTRIES) {
    const bytes = readTarballEntry(tarball, entry);
    if (bytes === undefined) continue;
    mkdirSync(join(installed, entry, ".."), { recursive: true });
    writeFileSync(join(installed, entry), bytes);
  }
  mutate?.(installed);
  return installed;
}

describe("artifact pinning", () => {
  test("the pin must match the file's bytes before anything else happens", () => {
    const directory = scratch();
    const tarball = buildTarball(directory);
    const installed = fakeInstall(directory, tarball);
    expect(() => verifyArtifact(tarball, installed, "0".repeat(64))).toThrow(/not the pinned artifact/);
    const measured = verifyArtifact(tarball, installed, sha256(readFileSync(tarball)));
    expect(measured.pinned).toBe(true);
    expect(measured.tarballSha256).toBe(sha256(readFileSync(tarball)));
    expect(measured.files.map((file) => file.entry)).toEqual(PINNED_ENTRIES);
  });

  test("an installed file that differs from the tarball member fails", () => {
    const directory = scratch();
    const tarball = buildTarball(directory);
    // Same byte length, different content: a size check would pass, a hash must not.
    const installed = fakeInstall(directory, tarball, (root) => writeFileSync(join(root, "client.js"), "module.exports = { }\n"));
    expect(() => verifyArtifact(tarball, installed, undefined)).toThrow(/installed bytes differ from the tarball/);
  });

  test("a tarball without a pinned entry is refused, not silently accepted", () => {
    const directory = scratch();
    buildTarball(directory);
    rmSync(join(directory, "package", "client.js"));
    const rebuilt = join(directory, "dsh-ensemble-fixture-noclient.tgz");
    expect(Bun.spawnSync(["tar", "czf", rebuilt, "-C", directory, "package"]).exitCode).toBe(0);
    const installed = fakeInstall(directory, rebuilt);
    expect(() => verifyArtifact(rebuilt, installed, undefined)).toThrow(/missing client\.js/);
  });

  test("an unpinned invocation records the hash but does not claim to be pinned", () => {
    const directory = scratch();
    const tarball = buildTarball(directory);
    const measured = verifyArtifact(tarball, fakeInstall(directory, tarball), undefined);
    expect(measured.pinned).toBe(false);
    expect(measured.tarballSha256).toHaveLength(64);
  });

  test("a missing installation directory is named by the failing entry", () => {
    const directory = scratch();
    const tarball = buildTarball(directory);
    expect(() => verifyArtifact(tarball, join(directory, "absent"), undefined)).toThrow(/the installation is missing index\.js/);
  });
});

describe("argument contract", () => {
  const env = (overrides: Record<string, string> = {}) => ({ ...overrides });

  test("defaults name an install, an artifact and the phase list in execution order", () => {
    const invocation = parseInvocation([], env());
    expect(invocation.runtime.endsWith(".scratch/rc5-cycle/rc5")).toBe(true);
    expect(invocation.tarball.endsWith("build/pack/dsh/dsh-ensemble-1.0.0.tgz")).toBe(true);
    // environment precedes selection: the evidence write is an environment-ledger
    // transaction, so the ledger must exist before it is cited.
    expect(invocation.phases).toEqual(["launch", "identity", "core", "environment", "selection", "currentauth", "legacy", "network", "coldrestart", "team", "learning"]);
    expect(invocation.serve).toBe(false);
    expect(invocation.timeoutMs).toBe(240_000);
  });

  test("positional arguments are the install and the artifact", () => {
    const invocation = parseInvocation(["/opt/dsh", "/tmp/pkg.tgz"], env());
    expect(invocation.runtime).toBe("/opt/dsh");
    expect(invocation.tarball).toBe("/tmp/pkg.tgz");
  });

  test("a malformed pin, an unknown flag and a bad timeout are refused with a reason", () => {
    expect(() => parseInvocation(["--sha256", "ABC"], env())).toThrow(/64 lowercase hex/);
    expect(() => parseInvocation(["--nope"], env())).toThrow(/unknown flag/);
    expect(() => parseInvocation(["--timeout", "soon"], env())).toThrow(/positive millisecond/);
    expect(() => parseInvocation(["--timeout", "0"], env())).toThrow(/positive millisecond/);
    expect(() => parseInvocation(["--phases", " , "], env())).toThrow(/at least one phase/);
  });

  test("serve comes from the flag or the environment, and the two pins must agree", () => {
    expect(parseInvocation(["--serve"], env()).serve).toBe(true);
    expect(parseInvocation([], env({ ENSEMBLE_PRODUCT_SERVE: "1" })).serve).toBe(true);
    expect(parseInvocation([], env({ ENSEMBLE_PRODUCT_SERVE: "0" })).serve).toBe(false);
    const pin = "a".repeat(64);
    expect(parseInvocation([], env({ ENSEMBLE_PRODUCT_SHA256: pin })).sha256).toBe(pin);
    expect(parseInvocation(["--sha256", pin], env()).sha256).toBe(pin);
    expect(() => parseInvocation(["--sha256", pin], env({ ENSEMBLE_PRODUCT_SHA256: "b".repeat(64) }))).toThrow(/disagree/);
  });

  test("phases are selectable so part of the journey can run alone", () => {
    expect(parseInvocation(["--phases", "identity,core"], env()).phases).toEqual(["identity", "core"]);
  });
});

describe("the gate refuses before it installs", () => {
  test("a missing runtime and a missing artifact are exit 2", async () => {
    const directory = scratch();
    const tarball = buildTarball(directory);
    expect(await runGate(parseInvocation([join(directory, "no-such-install"), tarball], {}), {})).toBe(2);
    expect(await runGate(parseInvocation([process.cwd(), join(directory, "no-such-package.tgz")], {}), {})).toBe(2);
  });

  test("a caller's persistent root is not deleted", async () => {
    const directory = scratch();
    const tarball = buildTarball(directory);
    const root = join(directory, "gate-root");
    mkdirSync(root, { recursive: true });
    const invocation = parseInvocation([process.cwd(), tarball], { ENSEMBLE_PRODUCT_ROOT: root });
    const status = await runGate({ ...invocation, sha256: "0".repeat(64) }, { ENSEMBLE_PRODUCT_ROOT: root });
    expect([1, 2]).toContain(status);
    expect(readdirSync(directory)).toContain("gate-root");
  });
});

describe("the serve handoff cannot mix credentials", () => {
  test("the manifest names two distinct cookie roles and keeps the legacy field labelled", () => {
    // The handoff is produced by `serveHost`; what is testable without a Host is the
    // *contract* it must publish, so this asserts the documented field set from the
    // driver source. A regression that collapses the two roles fails here.
    const source = readFileSync(new URL("../../../scripts/verify-dsh-product.ts", import.meta.url), "utf8");
    expect(source).toContain("browserCookieFile");
    expect(source).toContain("apiCookieFile");
    expect(source).toContain('cookieFileMeaning: "api"');
    // The page fence must use the browser cookie, and the API cookie must be proven
    // unable to load the page before the handoff is written.
    expect(source).toContain("the API cookie unexpectedly loads the page");
    expect(source).toContain("the browser cookie must load the page");
    // The browser exchange is the `/?token=` route, not `/connect`.
    expect(source).toContain("const exchange = await fetch(url, { redirect: \"manual\" })");
  });
});

describe("the delegated journey seam", () => {
  /** A stand-in for the driver's live objects: deliberately minimal and mutable. */
  const base = (): Record<string, unknown> => ({
    ctx: {}, agent: { id: "s" }, workspace: { id: "w" }, project: { project_id: "p" }, source: "/src",
    remote: async () => ({ ok: true, value: { projects: [{ project_id: "p", read_revision: "r", authorization_epoch: 1 }] } }),
    call: async () => ({}), modelCall: async () => ({}), phase: async (_n: string, body: () => Promise<unknown>) => body(),
    evidence: {}, head: async () => "r", spawnMember: async () => ({}), ownRoot: (l: string) => `/tmp/x-${l}`,
  });
  /** The same object as the seam's input type, for calls that must type-check. */
  const input = () => base() as unknown as ProductRunContextInput;

  test("the context refuses to be built without a live Host object", () => {
    for (const missing of ["ctx", "agent", "remote", "call", "modelCall", "phase", "evidence", "spawnMember", "ownRoot"]) {
      const incomplete = base();
      delete incomplete[missing];
      expect(() => productRunContext(incomplete as unknown as ProductRunContextInput)).toThrow(/is required/);
    }
  });

  test("identity is derived from the Host, not accepted from the caller", async () => {
    const context = productRunContext(input());
    // There is no constructor argument through which an actor could be injected.
    expect(Object.keys(base())).not.toContain("actor");
    expect(await context.actorFacts()).toEqual({ ok: true, projectId: "p", authorizationEpoch: 1, readRevision: "r", rootSessionId: "s" });
  });

  test("a journey gets no reducer or registry back door", () => {
    const context = productRunContext(input());
    // The only ways to touch the archive are the real tool executor and the real
    // Remote; a journey that called `applyCoordination`/the registry directly would
    // not be testing the installed product.
    expect(Object.isFrozen(context)).toBe(true);
    for (const forbidden of ["registry", "reducer", "applyCoordination", "archive", "store"]) {
      expect(Object.keys(context)).not.toContain(forbidden);
    }
    expect(Object.keys(context)).toEqual(expect.arrayContaining([
      "ctx", "agent", "workspace", "projectId", "source", "remote", "call", "modelCall",
      "phase", "evidence", "head", "spawnMember", "actorFacts", "ownRoot", "scratch",
    ]));
  });

  test("an isolated root is handed out per label so a journey cannot touch the live fixture", () => {
    const context = productRunContext(input());
    expect(context.ownRoot("learning")).toBe("/tmp/x-learning");
    expect(context.scratch("learning")).toBe("/tmp/x-learning/scratch");
    expect(context.ownRoot("learning")).not.toBe(context.ownRoot("other"));
  });
});

describe("the cold-restart pass is a separate process, not a second read", () => {
  test("the driver spawns a verify-only fixture and merges the evidence", () => {
    const source = readFileSync(new URL("../../../scripts/verify-dsh-product.ts", import.meta.url), "utf8");
    // The restart must be a child process on the same DSH_HOME, carrying the write
    // pass's own committed facts — not the same process reading itself.
    expect(source).toContain('ENSEMBLE_PRODUCT_VERIFY_ONLY: "1"');
    expect(source).toContain("ENSEMBLE_PRODUCT_EXPECTED: readFileSync(expectationPath");
    expect(source).toContain("restart-expectation.json");
    // A write pass that leaves no expectation must fail, not silently skip.
    expect(source).toContain("the restart was NOT verified");
    // The second process's failure fails the gate.
    expect(source).toContain("a fresh Host did not serve the committed state");
  });

  test("the fixture refuses to treat missing state as a successful restart", () => {
    const fixture = readFileSync(new URL("./verify-product.mjs", import.meta.url), "utf8");
    expect(fixture).toContain("coldrestart-verify");
    expect(fixture).toContain("the committed project must survive the restart");
    // Retired v1 entries must be re-checked after the restart, not only before it.
    expect(fixture).toContain("must stay retired after a restart");
    expect(fixture).toContain("unsupported_version");
  });
});

describe("children are bounded and stopped", () => {
  test("a child that outlives its bound is killed and named in the failure", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const started = Date.now();
    await expect(bounded(child, 300, "holdout")).rejects.toThrow(/holdout exceeded its 300ms bound/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(child.signalCode === "SIGKILL" || child.exitCode !== null).toBe(true);
  });

  test("stopping an already-exited child is a no-op, so cleanup is idempotent", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((done) => child.once("exit", done));
    await stop(child);
    await stop(child);
    await stop(undefined);
  });

  test("stopping a running child terminates it", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await stop(child, 2000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  test("bounded returns the exit status and captured output", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('hi'); process.exit(3)"], { stdio: ["ignore", "pipe", "pipe"] });
    const result = await bounded(child, 10_000, "printer");
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("hi");
  });

  test("the Node resolution refuses a runtime that is not Node", () => {
    expect(() => nodeBin({ ENSEMBLE_PRODUCT_NODE: "/bin/false" })).toThrow(/needs a real Node executable/);
    expect(() => nodeBin({ ENSEMBLE_PRODUCT_NODE: join(tmpdir(), "definitely-not-a-binary") })).toThrow(/needs a real Node executable/);
  });
});
