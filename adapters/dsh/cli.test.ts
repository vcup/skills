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
const TARBALL = join(REPO_ROOT, "build", "pack", "dsh", "dsh-ensemble-probe-0.3.0.tgz");

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

async function repack(): Promise<void> {
  const packed = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "pack-dsh.ts")], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode, packed.stderr.toString()).toBe(0);
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
  return { profile, packageDir: join(profile, "node_modules", "dsh-ensemble-probe") };
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
      expect(manifest.version).toBe("0.3.0");
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
      expect(manifest.dsh?.profile?.bundles).toContain("dsh-ensemble-probe");

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
      const broken = join(temporaryRoot("cli-broken-"), "dsh-ensemble-probe");
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
      const result = runCli(packageDir, ["status", "--cookie-file", cookie, "--url", "http://127.0.0.1:3999"], {
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
    "status, initialize and readBack all succeed over the real transport",
    async () => {
      await repack();
      const { packageDir } = installIntoExclusiveProfile();
      const origin = LIVE_ORIGIN as string;
      const cookie = LIVE_COOKIE as string;
      const env = { ENSEMBLE_ARCHIVE_COOKIE: "" };

      const status = runCli(packageDir, ["status", "--cookie-file", cookie, "--url", origin], env);
      expect(status.code, status.stderr).toBe(0);
      const parsed = JSON.parse(status.stdout) as { ok: boolean; value: { headRevision: string | null } };
      expect(parsed.ok).toBe(true);

      let head = parsed.value.headRevision;
      if (head === null) {
        const init = runCli(
          packageDir,
          [
            "initialize",
            "--cookie-file",
            cookie,
            "--url",
            origin,
            "--request",
            JSON.stringify({
              source_descriptor: {
                worldIdentity: "host-a",
                canonicalAddress: "/srv/cli-test",
                nativeWorkspaceRef: "ws:cli",
              },
              initial_grants: [{ subjectId: "owner", rights: ["manage"] }],
            }),
          ],
          env,
        );
        expect(init.code, init.stderr).toBe(0);
        head = (JSON.parse(init.stdout) as { value: { headRevision: string } }).value.headRevision;
      }
      expect(head).toMatch(/^[0-9a-f]{40}$/);

      const readBack = runCli(
        packageDir,
        [
          "readBack",
          "--cookie-file",
          cookie,
          "--url",
          origin,
          "--request",
          JSON.stringify({ revision: head, path: "meta.json" }),
        ],
        env,
      );
      expect(readBack.code, readBack.stderr).toBe(0);
      expect(readBack.stdout).toContain("ensemble-archive/v1");

      // An invalid credential is refused by the Host and mapped to its own code.
      const bad = join(temporaryRoot(), "bad.txt");
      writeFileSync(bad, "dsh-auth-bogus=deadbeef\n");
      const rejected = runCli(packageDir, ["status", "--cookie-file", bad, "--url", origin], env);
      expect(rejected.code).toBe(4);
    },
    { timeout: 300_000 },
  );
});
