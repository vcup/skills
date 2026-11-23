/**
 * Tests for the packaged CLI: `bin/ensemble-archive.js`.
 *
 * These run the **packed artifact**, not the source, because the defects this
 * file exists to catch are packaging defects: a missing allowlist entry, a
 * manifest without `bin`, and — the one that took longest to find — a transport
 * whose bare imports cannot be resolved from an installed package.
 *
 * Two rules decide how every case here runs, and both were learned from a test
 * that was green while the package was broken:
 *
 * 1. **The package is installed into an exclusive tree.** An earlier version
 *    unpacked the tarball *inside* the shared DSH install "so its dependencies
 *    resolve". That made the test unable to fail: an ancestor `node_modules`
 *    satisfied `cordis`, so a package with no working transport still ran. The
 *    install below is a real `dsh plugin add` into a fresh `DSH_HOME` under the
 *    test's own temporary directory, with no DSH install anywhere above it.
 * 2. **The CLI runs under real Node.** `process.execPath` under `bun test` is
 *    Bun, and Bun resolves modules differently from Node — including through
 *    ancestor directories Node would not consult. The CLI ships as a Node
 *    program and must be measured as one.
 *
 * Groups:
 *
 * - **Offline contract** runs whenever an isolated install is available: the
 *   argument parser, the credential rules, and the exit codes that need no Host.
 * - **Installed package** proves the artifact runs from a real profile install
 *   and that a package missing its transport bundle fails, so the positive case
 *   cannot pass vacuously.
 * - **Live Host** runs only when `DSH_CLI_LIVE_ORIGIN` and
 *   `DSH_CLI_LIVE_COOKIE_FILE` name a running Host and a valid session.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PACKAGE_NAME, PACKAGE_VERSION, STAGING_DIR } from "./meta.ts";

const roots: string[] = [];

function temporaryRoot(prefix = "cli-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPO_ROOT = join(import.meta.dir, "..", "..");
/**
 * The packaged tarball under test.
 *
 * The name is derived from `meta.ts` rather than restated: an earlier version of
 * this file hard-coded the probe tarball name, and after the package was renamed
 * every case still cleared its skip guard, so the suite stayed green while
 * pointing at a file that no longer existed.
 *
 * `DSH_CLI_TEST_TARBALL` pins an existing artifact instead of repacking. Use it
 * when the shared staging directory belongs to another process (a release gate
 * packing at the same time); repacking into it from a test would race the owner.
 */
const PINNED_TARBALL = process.env.DSH_CLI_TEST_TARBALL;
/**
 * Where this file's own pack lands when nothing is pinned.
 *
 * Deliberately NOT the shared `build/pack/dsh`: several test files pack the same
 * tree, and the staging step clears its target first, so two files packing
 * concurrently deleted each other's tarball and produced failures with nothing to
 * do with the CLI. A private directory per test run removes the race without
 * weakening the assertion — it is still the real `pack()` output.
 */
const PRIVATE_STAGING = join(tmpdir(), `cli-pack-${process.pid}-${Date.now()}`);
const TARBALL = PINNED_TARBALL === undefined || PINNED_TARBALL.trim() === ""
  ? join(PRIVATE_STAGING, `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`)
  : resolve(PINNED_TARBALL);

/**
 * The Node binary the CLI is measured with.
 *
 * Resolved explicitly rather than through `process.execPath`, which is Bun when
 * this file runs under `bun test`. A missing Node is a hard failure: silently
 * falling back to Bun would restore the blind spot this file exists to remove.
 */
function resolveNode(): string {
  const found = Bun.which("node");
  if (found === null) {
    throw new Error("these tests need a real `node` on PATH: the packaged CLI is a Node program, and Bun resolves modules differently");
  }
  return found;
}

const NODE = resolveNode();

/** The isolated install that provides the `dsh` CLI, or undefined. */
function resolveInstall(): string | undefined {
  const raw = process.env.DSH_ARCHIVE_SEAM_INSTALL;
  if (raw === undefined || raw.trim() === "") return undefined;
  const absolute = resolve(raw);
  if (!existsSync(join(absolute, "node_modules/@deepseek-ai/cordis/package.json"))) {
    throw new Error(`DSH_ARCHIVE_SEAM_INSTALL=${absolute} is not an isolated DSH install`);
  }
  return absolute;
}

const INSTALL = resolveInstall();
const SKIP = INSTALL === undefined || INSTALL === "";

let repacked: Promise<void> | undefined;
/**
 * Pack the current tree once per test run.
 *
 * Idempotent because every case calls it: `pack()` re-stages and re-tarballs its
 * output, so repeated calls would both waste time and let a later call overwrite
 * a tarball an earlier assertion is still reading.
 */
function repack(): Promise<void> {
  // A pinned artifact is used as-is: see DSH_CLI_TEST_TARBALL above.
  if (PINNED_TARBALL !== undefined && PINNED_TARBALL.trim() !== "") return Promise.resolve();
  return (repacked ??= (async () => {
    const { pack } = (await import("../../scripts/pack-dsh.ts")) as typeof import("../../scripts/pack-dsh.ts");
    const result = await pack({ root: REPO_ROOT, stagingDir: PRIVATE_STAGING });
    expect(result.tarball).toBe(TARBALL);
  })());
}

/** Run the packaged CLI with real Node and return its exit code and streams. */
function runCli(packageDir: string, args: readonly string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([NODE, join(packageDir, "bin", "ensemble-archive.js"), ...args], {
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
    // A clean environment apart from what the case passes: no inherited
    // NODE_PATH or NODE_OPTIONS could otherwise satisfy an import the package
    // does not declare.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root", ...env },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/**
 * A real `dsh plugin add` into an exclusive profile, and the package directory
 * it installed to.
 *
 * The profile is a genuine one: `dsh plugin` initialises it from the shipped
 * `web` template, so the package is installed by the same pnpm call an installer
 * runs, with the Host's own `.pnpmrc`-equivalent settings (`nodeLinker: hoisted`,
 * `autoInstallPeers: false`). Nothing is symlinked and no DSH install sits above
 * the tree, so a bare import in the package has nowhere to resolve from.
 * @returns the profile directory and the installed package directory.
 */
function installIntoExclusiveProfile(): { profile: string; packageDir: string } {
  const root = temporaryRoot("cli-install-");
  const env = {
    DSH_HOME: join(root, "home"),
    npm_config_cache: join(root, "npm-cache"),
    PNPM_HOME: join(root, "pnpm"),
    PATH: `${join(INSTALL as string, "node_modules", ".bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  const added = Bun.spawnSync(["dsh", "plugin", "--profile", "web", "add", TARBALL], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  expect(added.exitCode, `${added.stdout.toString()}\n${added.stderr.toString()}`).toBe(0);
  const profile = join(root, "home", "profiles", "web");
  return { profile, packageDir: join(profile, "node_modules", PACKAGE_NAME) };
}

describe("packaged CLI", () => {
  test.skipIf(SKIP)(
    "the tarball ships the bin and the transport bundle",
    async () => {
      await repack();
      expect(existsSync(TARBALL)).toBe(true);
      const listed = Bun.spawnSync(["tar", "-tzf", TARBALL], { stdout: "pipe", stderr: "pipe" });
      const entries = listed.stdout.toString().split("\n");
      for (const required of [
        "package/bin/ensemble-archive.js",
        "package/lib/transport.bundle.mjs",
        "package/lib/transport.bundle.json",
        "package/lib/cookie-jar.mjs",
        "package/package.json",
      ]) {
        expect(entries).toContain(required);
      }
      // The reviewed source has bare imports and must not ship as the CLI's
      // transport: only the bundle is runnable from an installed package.
      expect(entries).not.toContain("package/lib/transport.mjs");
    },
    { timeout: 240_000 },
  );

  test.skipIf(SKIP)(
    "the packaged manifest declares the bin, the exports, and no ordinary dependency",
    async () => {
      await repack();
      const workspace = temporaryRoot("cli-manifest-");
      const extract = Bun.spawnSync(["tar", "-xzf", TARBALL], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
      expect(extract.exitCode, extract.stderr.toString()).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(workspace, "package", "package.json"), "utf8"),
      ) as {
        bin?: Record<string, string>;
        exports?: Record<string, string>;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        version?: string;
      };
      expect(manifest.version).toBe(PACKAGE_VERSION);
      expect(manifest.bin?.["ensemble-archive"]).toBe("./bin/ensemble-archive.js");
      expect(Object.keys(manifest.exports ?? {})).toContain("./transport");

      // No ordinary dependency at all. The client package must not be installed
      // into the profile: that is what shadowed the Host's own connection, and
      // it is not a version-pinning problem — the package must not depend on it.
      expect(manifest.dependencies).toBeUndefined();
      expect(manifest.peerDependencies?.["@deepseek-ai/dsh-client-connection"]).toBeUndefined();

      // Every package the Host entry imports is declared, and as a peer: the
      // Host supplies those instances through its own resolver.
      for (const peer of [
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-skill",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-subprocess-local",
        "@deepseek-ai/dsh-sandbox-local",
        "@deepseek-ai/dsh-typert-protocol",
      ]) {
        expect(manifest.peerDependencies?.[peer], `${peer} must be a declared peer`).toBeDefined();
      }
      // `cordis` stays a peer, not a dependency: the CLI gets it from its own
      // private bundle.
      expect(manifest.peerDependencies?.["@deepseek-ai/cordis"]).toBe("~4.1.0");
    },
    { timeout: 240_000 },
  );

  test.skipIf(SKIP)(
    "the packaged CLI runs from a real profile install under plain Node",
    async () => {
      await repack();
      const { profile, packageDir } = installIntoExclusiveProfile();
      expect(existsSync(packageDir)).toBe(true);

      // The profile registered the package as a bundle row.
      const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8")) as {
        dsh?: { profile?: { bundles?: string[] } };
      };
      expect(manifest.dsh?.profile?.bundles).toContain(PACKAGE_NAME);

      // No private DSH copies: a nested `@deepseek-ai/dsh-skill` (or `-tools`)
      // would make the plugin run against a different release than the Host.
      // `cordis` is *not* checked here: the CLI's bundle carries its own, which
      // is by design and is not a mixed DSH install.
      for (const shared of ["dsh-skill", "dsh-tools", "dsh-subprocess-local", "dsh-sandbox-local"]) {
        expect(
          existsSync(join(packageDir, "node_modules", "@deepseek-ai", shared)),
          `${shared} must not be a private copy inside the installed package`,
        ).toBe(false);
      }

      // The real proof: plain Node, from the installed package, with no
      // credential. Exit 3 means the module graph loaded and the parser ran; a
      // transport that needed a resolver would fail earlier with
      // ERR_MODULE_NOT_FOUND.
      const result = runCli(packageDir, ["status"], { ENSEMBLE_ARCHIVE_COOKIE: "" });
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stderr).not.toContain("Cannot find module");
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("no credential");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "a package without its transport bundle fails, so the case above cannot pass vacuously",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();

      // Break exactly one thing — the bundle the CLI imports — in a copy of the
      // installed package. This is the red evidence for the defect the bundle
      // fixes: without it, the reviewed source's bare imports cannot resolve.
      const broken = join(temporaryRoot("cli-broken-"), PACKAGE_NAME);
      cpSync(packageDir, broken, { recursive: true });
      rmSync(join(broken, "lib", "transport.bundle.mjs"));

      const result = runCli(broken, ["status"], { ENSEMBLE_ARCHIVE_COOKIE: "" });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
      expect(result.stderr).toContain("transport.bundle.mjs");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the packaged CLI refuses to run without a credential, and sends nothing",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const result = runCli(packageDir, ["status"], { ENSEMBLE_ARCHIVE_COOKIE: "" });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("no credential");
      expect(result.stderr).toContain("never falls back");
      expect(result.stderr).toContain("ENSEMBLE_ARCHIVE_COOKIE");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the packaged CLI refuses a credential on the command line without echoing it",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const result = runCli(packageDir, ["status", "--cookie", "dsh-auth-x=y"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("refusing a credential on the command line");
      expect(result.stderr).not.toContain("dsh-auth-x=y");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the packaged CLI reports an unknown method as a usage error",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const result = runCli(packageDir, ["frobnicate"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unknown method");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the packaged CLI reports an empty credential file as no credential",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const empty = join(temporaryRoot(), "empty.txt");
      writeFileSync(empty, "");
      const result = runCli(packageDir, ["status", "--cookie-file", empty], { ENSEMBLE_ARCHIVE_COOKIE: "" });
      expect(result.code).toBe(3);
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the packaged CLI reports an unreachable Host as unreachable, not as a refusal",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const cookie = join(temporaryRoot(), "cookie.txt");
      writeFileSync(cookie, "dsh-auth-probe=abcdef\n");
      // A supported method, because a retired one is now refused before any
      // connection is opened (exit 2) and would never exercise reachability.
      const result = runCli(packageDir, ["projects", "--cookie-file", cookie, "--url", "http://127.0.0.1:3999"], {
        ENSEMBLE_ARCHIVE_COOKIE: "",
      });
      expect(result.code).toBe(5);
      expect(result.stderr).toContain("could not reach the Host");
    },
    { timeout: 300_000 },
  );
});

// ── the live Host ───────────────────────────────────────────────────────────

const LIVE_ORIGIN = process.env.DSH_CLI_LIVE_ORIGIN;
const LIVE_COOKIE = process.env.DSH_CLI_LIVE_COOKIE_FILE;

describe("packaged CLI against a live Host", () => {
  test.skipIf(SKIP || LIVE_ORIGIN === undefined || LIVE_COOKIE === undefined)(
    "projects, a reversible owner write and query all succeed over the real transport",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const origin = LIVE_ORIGIN as string;
      const cookie = LIVE_COOKIE as string;
      const env = { ENSEMBLE_ARCHIVE_COOKIE: "" };

      // The 1.0 package retires the v1 verbs outright: `status`, `initialize`, `bind`
      // and `readBack` are `retired: true` in bin/ensemble-archive.js and refuse before
      // contacting the Host. This case therefore speaks the shipped v2 surface — a
      // catalogue read, a real reversible write, and a pinned read — instead of
      // `status` → `initialize` → `readBack` with a v1 byte marker. That old sequence is
      // exactly why this was the one case that could never pass against the 1.0 package.
      //
      // The live fixture's Host is already initialized and bound (`core init+bind`, one
      // project), so there is no synthetic initialize here: the case selects the real
      // project the Host reports and writes against it.
      const listed = runCli(packageDir, ["projects", "--cookie-file", cookie, "--url", origin], env);
      expect(listed.code, listed.stderr).toBe(0);
      const parsed = JSON.parse(listed.stdout) as {
        ok: boolean;
        value: { projects: readonly { project_id: string; read_revision: string; authorization_epoch: number }[] };
      };
      expect(parsed.ok).toBe(true);
      const project = parsed.value.projects[0];
      expect(project?.project_id).toBeDefined();

      // A pinned read first, so the write below is measured against a known state.
      const before = runCli(
        packageDir,
        ["query", "--cookie-file", cookie, "--url", origin, "--request", JSON.stringify({ kind: "context", project_id: project!.project_id })],
        env,
      );
      expect(before.code, before.stderr).toBe(0);
      const beforePage = JSON.parse(before.stdout) as { ok: boolean; value: { project_id: string; read_revision: string; authorization_epoch: number } };
      expect(beforePage.ok).toBe(true);
      expect(beforePage.value.project_id).toBe(project!.project_id);
      expect(beforePage.value.read_revision).toMatch(/^[0-9a-f]{40}$/);

      // A real, reversible owner write: pause then resume. `pause` advances the policy
      // epoch and commits a new revision (store: `policy.epoch+1`, then `#publish`), so
      // this proves an actual write reached the Host rather than a read-only round trip.
      // The revision is the one the Host just reported, not a guessed value.
      //
      // The operation id is a fresh nonce per run **on purpose**. `operation_id` is an
      // idempotency key: reusing a fixed string would make a second run against the same
      // Host collide with the durable receipt of the first (same key, different payload),
      // which the store correctly rejects as `operation_key_conflict`. A nonce keeps the
      // case genuinely repeatable; the same id is reused for the read-back below so the
      // write and its verification are provably the same operation.
      const pauseOperation = `cli-live-pause-${randomUUID()}`;
      const paused = runCli(
        packageDir,
        [
          "manage",
          "--cookie-file",
          cookie,
          "--url",
          origin,
          "--request",
          JSON.stringify({
            action: "pause",
            project_id: project!.project_id,
            expected_revision: beforePage.value.read_revision,
            operation_id: pauseOperation,
            payload: { reason: "packaged CLI live write check" },
          }),
        ],
        env,
      );
      expect(paused.code, paused.stderr).toBe(0);
      const pauseReceipt = JSON.parse(paused.stdout) as { ok: boolean; value: { status: string; committed_revision: string } };
      expect(pauseReceipt.ok).toBe(true);
      // The receipt must say what was committed, not merely that something was.
      expect(pauseReceipt.value.status).toBe("committed");
      expect(pauseReceipt.value.committed_revision).toMatch(/^[0-9a-f]{40}$/);

      // Confirm the effect by reading again, rather than trusting the receipt alone.
      const after = runCli(
        packageDir,
        ["query", "--cookie-file", cookie, "--url", origin, "--request", JSON.stringify({ kind: "context", project_id: project!.project_id })],
        env,
      );
      expect(after.code, after.stderr).toBe(0);
      const afterPage = JSON.parse(after.stdout) as { ok: boolean; value: { read_revision: string; authorization_epoch: number } };
      expect(afterPage.ok).toBe(true);
      expect(afterPage.value.read_revision).toBe(pauseReceipt.value.committed_revision);
      expect(afterPage.value.authorization_epoch).toBeGreaterThan(beforePage.value.authorization_epoch);

      // Restore the fixture's state so the case is repeatable and leaves no pause behind.
      // The resume is a second real write with its own nonce, and it is verified the same
      // way — a committed status, a new revision, and a further epoch — so "reversible" is
      // an observed fact rather than an `ok: true`.
      const resumeOperation = `cli-live-resume-${randomUUID()}`;
      const resumed = runCli(
        packageDir,
        [
          "manage",
          "--cookie-file",
          cookie,
          "--url",
          origin,
          "--request",
          JSON.stringify({
            action: "resume",
            project_id: project!.project_id,
            expected_revision: afterPage.value.read_revision,
            operation_id: resumeOperation,
            payload: { reason: "packaged CLI live write check cleanup", diagnostic_ref: { kind: "external", url: "https://example.invalid/cli-live" } },
          }),
        ],
        env,
      );
      expect(resumed.code, resumed.stderr).toBe(0);
      const resumeReceipt = JSON.parse(resumed.stdout) as { ok: boolean; value: { status: string; committed_revision: string } };
      expect(resumeReceipt.ok).toBe(true);
      expect(resumeReceipt.value.status).toBe("committed");
      expect(resumeReceipt.value.committed_revision).toMatch(/^[0-9a-f]{40}$/);

      // The archive is genuinely back to running: a third read shows the resume's
      // revision and another advanced epoch, so the pause did not linger.
      const restored = runCli(
        packageDir,
        ["query", "--cookie-file", cookie, "--url", origin, "--request", JSON.stringify({ kind: "context", project_id: project!.project_id })],
        env,
      );
      expect(restored.code, restored.stderr).toBe(0);
      const restoredPage = JSON.parse(restored.stdout) as { ok: boolean; value: { read_revision: string; authorization_epoch: number } };
      expect(restoredPage.ok).toBe(true);
      expect(restoredPage.value.read_revision).toBe(resumeReceipt.value.committed_revision);
      expect(restoredPage.value.authorization_epoch).toBeGreaterThan(afterPage.value.authorization_epoch);

      // An invalid credential is refused by the Host and mapped to its own code.
      const bad = join(temporaryRoot(), "bad.txt");
      writeFileSync(bad, "dsh-auth-bogus=deadbeef\n");
      const rejected = runCli(packageDir, ["projects", "--cookie-file", bad, "--url", origin], env);
      expect(rejected.code).toBe(4);
    },
    { timeout: 300_000 },
  );
});
