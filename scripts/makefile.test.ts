/**
 * Interface tests for the repository `Makefile`.
 *
 * These drive the real `make` binary against a throwaway fixture repository, so
 * they check the interface a maintainer actually meets: exit codes, the messages
 * printed before a refusal, and that a default check neither writes in the
 * repository nor needs a build tree.
 *
 * What is *not* faked: the Makefile itself is the committed one, copied into the
 * fixture; `make` is the real program. Tool absence is simulated by pointing the
 * Makefile's `BUN`/`NODE` variables at a nonexistent command, which is the same
 * mechanism a maintainer on a bare machine hits.
 *
 * The fixture is a copy of this repository (minus ignored trees and Git
 * metadata), so a target that needs a real script gets the real script. Nothing
 * here reaches the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_VERSION } from "../adapters/dsh/meta.ts";
import { DEFAULT_DSH_VERSION, SUPPORTED_DSH_VERSIONS } from "../adapters/dsh/compatibility.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The make subprocess has a 120-second timeout. These two isolation cases allow
 * another 30 seconds for assertions and cleanup, so the subprocess timeout can
 * report an error before Bun terminates the test.
 */
const CHILD_TIMEOUT_MS = 120_000;
const TEST_SLACK_MS = 30_000;

/**
 * The fixture is the repository itself minus the ignored trees: the Makefile's
 * targets read documentation, content sources and scripts, so a partial copy
 * would test something other than this repository. `node_modules` is linked
 * instead of copied, so no test ever installs anything.
 */
const SKIPPED = new Set([".git", "node_modules", "build", ".scratch"]);

/**
 * This suite is not copied into the fixture. `make test` runs the full suite, so
 * a copy of this file inside the fixture would start a nested fixture run of its
 * own, forever. The fixture tests the Makefile; it does not re-test itself.
 */
const SKIPPED_FILES = new Set(["scripts/makefile.test.ts"]);

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (SKIPPED_FILES.has(relative(REPO_ROOT, source))) continue;
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isSymbolicLink()) await symlink(await readlink(source), target);
    else await cp(source, target);
  }
}

let fixture: string;

/**
 * Interface variables and make's own propagation flags are stripped before each
 * run. Without this the suite would inherit `INSTALL_DIR`/`TARGET` from the
 * `make test` invocation that started it, and the fixture would silently test a
 * different configuration than the one written in each test.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "TARGET", "INSTALL_DIR", "CONFIRM"]) {
    delete env[key];
  }
  return env;
}

async function make(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  const result = spawnSync("make", [...args], {
    cwd: options.cwd ?? fixture,
    encoding: "utf8",
    env: { ...cleanEnv(), ...options.env },
    timeout: CHILD_TIMEOUT_MS,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  // A timeout is diagnosed, not swallowed into `code: -1`. `spawnSync` reports it as
  // `error.code === "ETIMEDOUT"` with `status: null`, `signal: "SIGTERM"` and empty
  // output; without this the caller only sees `code: -1` and an assertion that reads
  // captured output fails with an empty string instead of naming the real cause.
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error !== undefined && error.code === "ETIMEDOUT") {
    throw new Error(
      `make ${args.join(" ")} timed out after ${CHILD_TIMEOUT_MS} ms ` +
        `(signal=${String(result.signal)}, error=${error.message}); ` +
        `stdout=${stdout.length}B stderr=${stderr.length}B`,
    );
  }
  return { code: result.status ?? -1, stdout, stderr, all: `${stdout}${stderr}` };
}

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "makefile-test-"));
  await copyTree(REPO_ROOT, fixture);
  // Dependencies are linked, never installed: these tests must not use the
  // network, and a missing toolchain is simulated explicitly where needed.
  await symlink(join(REPO_ROOT, "node_modules"), join(fixture, "node_modules"));
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("help and the default target", () => {
  test("make with no argument prints the grouped help", async () => {
    const { code, stdout } = await make([]);
    expect(code).toBe(0);
    for (const group of [
      "Getting started",
      "Verify",
      "Content",
      "Packages",
      "Runtime gates",
      "Install",
      "Git",
      "Release and cleanup",
    ]) {
      expect(stdout).toContain(group);
    }
  });

  test("help lists every documented target with a description", async () => {
    const { code, stdout } = await make(["help"]);
    expect(code).toBe(0);
    for (const target of [
      "help",
      "doctor",
      "setup",
      "check",
      "test",
      "test-narrow",
      "test-watch",
      "typecheck",
      "typecheck-host",
      "docs",
      "content",
      "content-build",
      "pack",
      "pack-omp",
      "pack-dsh",
      "inspect",
      "host-check",
      "profile-check",
      "isolation-check",
      "diagnose",
      "install-omp",
      "install-smoke",
      "status",
      "diff",
      "git-review",
      "package-check",
      "release-check",
      "all",
      "clean",
      "clean-all",
      // Targets the docs cite as public entry points, so `make help` must list
      // them: a target that works while being absent from the list contradicts
      // the instruction "use make help as the interface".
      "cli-check",
      "dsh-bundle",
      "dsh-bundle-check",
      "product-check",
      "client-check",
      "maintenance-check",
      "environment-check",
      "store-acceptance-check",
      "native-acceptance-check",
      "source-acceptance-check",
      "fixture-test",
      "matrix-check",
      "production-check",
      "runtime-setup",
      "typecheck-wait-host",
      "wait-host-check",
      "wait-runtime-check",
      "pack-dsh-agent-wait",
      "check-upstream",
      "archive-owner-help",
      "archive-owner-status",
      "archive-owner-call",
    ]) {
      expect(stdout).toMatch(new RegExp(`^  ${target}\\s+\\S`, "m"));
    }
  });

  test("help marks the network, profile-writing and destructive targets", async () => {
    const { stdout } = await make(["help"]);
    expect(stdout).toContain("[network]");
    expect(stdout).toContain("[writes live profile]");
    expect(stdout).toContain("[destructive]");
    expect(stdout).toContain("[writes]");
    expect(stdout).toContain("[needs INSTALL_DIR]");
  });

  test("the help footer says what make will not do on its own", async () => {
    const { stdout } = await make(["help"]);
    expect(stdout).toContain("Nothing here publishes a package, commits, or installs into a live profile on its own.");
  });
});

describe("check — the default offline gate", () => {
  test("passes in a tree with no build directory and writes nothing", async () => {
    expect(existsSync(join(fixture, "build"))).toBe(false);

    const { code, stdout } = await make(["check"]);
    expect(code).toBe(0);
    expect(stdout).toContain("check: ok");
    // The gate now also proves type coverage, which compiles both plain programs;
    // that is real work, so the assertion is on the outcome rather than on speed.
    expect(stdout).toContain("check: every maintained TypeScript file is in a compiled program");
    // Nothing generated: the gate is read-only.
    expect(existsSync(join(fixture, "build"))).toBe(false);
  }, 120_000);

  test("fails with a setup pointer when dependencies are missing", async () => {
    const bare = await mkdtemp(join(tmpdir(), "makefile-bare-"));
    await cp(join(fixture, "Makefile"), join(bare, "Makefile"));

    const { code, all } = await make(["check"], { cwd: bare });
    expect(code).toBe(2);
    expect(all).toContain("dependencies are missing");
    expect(all).toContain("make setup");
    expect(all).toContain("this is not a pass");

    await rm(bare, { recursive: true, force: true });
  });

  test("fails before doing anything when bun is absent", async () => {
    const { code, all } = await make(["check"], { env: { BUN: "/nonexistent/bun" } });
    expect(code).toBe(2);
    expect(all).toContain("bun is not installed");
    // The refusal names the targets that cannot run.
    expect(all).toContain("Blocked targets:");
    expect(all).toContain("check");
  });

  test("fails when the documentation checker's interpreter is absent", async () => {
    const { code, all } = await make(["docs"], { env: { PYTHON: "/nonexistent/python3" } });
    expect(code).toBe(2);
    expect(all).toContain("python3 is not installed");
    expect(all).toContain("docs check release-check");
  });
});

describe("content", () => {
  test("reports the committed skill as up to date", async () => {
    const { code, stdout } = await make(["content", "TARGET=skill"]);
    expect(code).toBe(0);
    expect(stdout).toContain("up to date");
  });

  test("rejects an invalid TARGET before reading or writing anything", async () => {
    const { code, all } = await make(["content", "TARGET=dsh2"]);
    expect(code).toBe(2);
    expect(all).toContain("TARGET=dsh2 is not a content path");
    expect(all).toContain("skill omp dsh");
    expect(all).toContain("Nothing was read or written");
  });

  test("rejects an invalid TARGET for content-build too", async () => {
    const { code, all } = await make(["content-build", "TARGET=nope"]);
    expect(code).toBe(2);
    expect(all).toContain("not a content path");
  });

  test("explains an unbuilt generated path instead of reporting drift", async () => {
    const { code, all } = await make(["content", "TARGET=omp"]);
    expect(code).toBe(2);
    expect(all).toContain("has not been built");
    expect(all).toContain("That is not drift");
    expect(all).toContain("make content-build TARGET=omp");
    // The unbuilt path was not silently created.
    expect(existsSync(join(fixture, "build/ensemble/omp"))).toBe(false);
  });

  test("content-build writes only the requested path, then content verifies it", async () => {
    const built = await make(["content-build", "TARGET=dsh"]);
    expect(built.code).toBe(0);
    expect(existsSync(join(fixture, "build/ensemble/dsh"))).toBe(true);
    // The other generated path is untouched.
    expect(existsSync(join(fixture, "build/ensemble/omp"))).toBe(false);

    const checked = await make(["content", "TARGET=dsh"]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("up to date");

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 60_000);
});

describe("install gates", () => {
  test("install-omp refuses without CONFIRM=yes", async () => {
    const { code, all } = await make(["install-omp"]);
    expect(code).toBe(2);
    expect(all).toContain("CONFIRM=yes");
    expect(all).toContain("live OMP profile");
    // The refusal says what the install replaces, not just that it writes.
    expect(all).toContain("replacing any @vcup/skills package already installed there");
  });

  test("install-omp refuses when there is no staging root to install", async () => {
    const { code, all } = await make(["install-omp", "CONFIRM=yes"], {
      env: { OMP: "/bin/true" },
    });
    expect(code).toBe(2);
    expect(all).toContain("no OMP staging root");
    expect(all).toContain("make pack-omp");
  });

  test("install-smoke fails clearly when npx is absent", async () => {
    const { code, all } = await make(["install-smoke"], { env: { NPX: "/nonexistent/npx" } });
    expect(code).toBe(2);
    expect(all).toContain("npx is not installed");
  });

  test("install-smoke pins the installer version it uses", async () => {
    const { stdout } = await make(["-n", "install-smoke"]);
    expect(stdout).toContain("skills@1.9.0");
  });
});

describe("clean", () => {
  test("removes the generated tree and reports it", async () => {
    await mkdir(join(fixture, "build/pack/dsh"), { recursive: true });
    await writeFile(join(fixture, "build/pack/dsh/x.tgz"), "x");

    const { code, stdout } = await make(["clean"]);
    expect(code).toBe(0);
    expect(stdout).toContain("removing build/");
    expect(existsSync(join(fixture, "build"))).toBe(false);
    // Dependencies are never touched by plain clean.
    expect(existsSync(join(fixture, "node_modules"))).toBe(true);
  });

  test("says so when there is nothing to remove", async () => {
    const { code, stdout } = await make(["clean"]);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to remove");
  });

  test("clean-all refuses without CONFIRM=yes and deletes nothing", async () => {
    await mkdir(join(fixture, "build"), { recursive: true });

    const { code, all } = await make(["clean-all"]);
    expect(code).toBe(2);
    expect(all).toContain("CONFIRM=yes");
    expect(existsSync(join(fixture, "build"))).toBe(true);
    expect(existsSync(join(fixture, "node_modules"))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  });

  test("refuses a symlinked build directory instead of following it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "makefile-outside-"));
    await writeFile(join(outside, "precious.txt"), "keep");
    await symlink(outside, join(fixture, "build"));

    const { code, all } = await make(["clean"]);
    expect(code).toBe(2);
    expect(all).toContain("symbolic link");
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);

    await rm(join(fixture, "build"), { force: true });
    await rm(outside, { recursive: true, force: true });
  });
});

describe("Host gates", () => {
  test("typecheck-host explains what INSTALL_DIR is when unset", async () => {
    const { code, all } = await make(["typecheck-host"]);
    expect(code).toBe(2);
    expect(all).toContain("INSTALL_DIR is not set");
    expect(all).toContain("isolated DSH install");
    // The supported set is enumerated, not a single release: rc.4 and rc.5.
    for (const version of SUPPORTED_DSH_VERSIONS) expect(all).toContain(version);
    expect(all).toContain("0.2.2-rc.4");
  });

  test("typecheck-host rejects a directory that is not an isolated install", async () => {
    const { code, all } = await make(["typecheck-host", `INSTALL_DIR=${fixture}`]);
    expect(code).toBe(2);
    expect(all).toContain("no @deepseek-ai/dsh-skill");
    // The working tree is explicitly called out as the wrong target.
    expect(all).toContain("not this working tree");
  });

  test("typecheck-host rejects a path that does not exist", async () => {
    const missing = join(tmpdir(), "definitely-missing-install-8c1f");
    const { code, all } = await make(["typecheck-host", `INSTALL_DIR=${missing}`]);
    expect(code).toBe(2);
    expect(all).toContain("does not exist");
    expect(all).toContain(missing);
  });

  test("host-check without INSTALL_DIR fails rather than skipping", async () => {
    const { code, all } = await make(["host-check"]);
    expect(code).toBe(2);
    expect(all).toContain("INSTALL_DIR is not set");
  });
});

describe("loader-check declares ESM in its scratch directory", () => {
  /**
   * Regression: `loader-check.ts` uses `import`, and Node decides how to parse a
   * `.ts` file by walking up to the nearest `package.json`. An install created
   * with `npm init -y` — the exact command `require-install-dir` prints — writes
   * `"type": "commonjs"`, so a scratch directory without its own declaration is
   * parsed as CommonJS and dies with "Cannot use import statement outside a
   * module". That made `make host-check` fail on a correctly prepared install
   * while passing on a hand-made one that happened to omit the `type` field.
   *
   * The install below is a faithful `npm init -y` root with only the manifest
   * `validateInstallDir` requires. It has no real `@deepseek-ai/*` packages, so
   * the Loader cannot succeed; what is asserted is *how* it fails. Parsing the
   * module at all proves the declaration is in effect.
   */
  /**
   * A faithful `npm init -y` root. `probe: false` omits the repository's probe
   * package, which is what an install built from the `INSTALL_DIR` guidance
   * alone looks like; `probe: true` includes it so the Loader path is reached.
   *
   * The distinction matters: `loader-check` refuses before running when the
   * probe is absent, so a fixture without it can only exercise the guard.
   */
  async function commonjsInstall(options: { probe?: boolean } = {}): Promise<string> {
    const install = await mkdtemp(join(tmpdir(), "make-commonjs-install-"));
    // Byte-for-byte the shape npm 12 writes, including the commonjs type.
    await writeFile(
      join(install, "package.json"),
      `${JSON.stringify({ name: "dsh-rc4", version: "1.0.0", type: "commonjs", private: true })}\n`,
    );
    await mkdir(join(install, "node_modules/@deepseek-ai/dsh-skill"), { recursive: true });
    await writeFile(
      join(install, "node_modules/@deepseek-ai/dsh-skill/package.json"),
      `${JSON.stringify({ name: "@deepseek-ai/dsh-skill", version: "0.2.2-rc.4" })}\n`,
    );
    if (options.probe === true) {
      // The guard only requires the directory to exist; resolution still fails
      // further down because the real Loader packages are not installed here.
      await mkdir(join(install, "node_modules/dsh-ensemble"), { recursive: true });
      await writeFile(
        join(install, "node_modules/dsh-ensemble/package.json"),
        `${JSON.stringify({ name: "dsh-ensemble", version: PACKAGE_VERSION })}\n`,
      );
    }
    return install;
  }

  test("the recipe writes an ESM declaration into the scratch directory", async () => {
    const recipe = await readFile(join(fixture, "Makefile"), "utf8");
    const block = recipe.slice(recipe.indexOf("\nloader-check:"));
    const lines = block.slice(0, block.indexOf("\n\n"));
    expect(lines).toContain('printf \'{"type":"module"}\\n\' > "$$scratch/package.json"');
  });

  test("a commonjs install parses as ESM instead of dying on import syntax", async () => {
    // The probe must be present, or the guard below refuses before the module is
    // ever parsed and this test would measure the guard instead of the parse.
    const install = await commonjsInstall({ probe: true });
    const before = await readFile(join(install, "package.json"), "utf8");
    try {
      const { all } = await make(["loader-check", `INSTALL_DIR=${install}`]);
      // The regression's signature. Its absence is the point of this test.
      expect(all).not.toContain("Cannot use import statement outside a module");
      // Module resolution ran as ESM: this failure can only happen after the
      // module was parsed. A CommonJS misparse would never get this far.
      expect(all).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package '@deepseek-ai\/dsh-app-boot'/);
      // The user's install manifest is read, never rewritten.
      expect(await readFile(join(install, "package.json"), "utf8")).toBe(before);
    } finally {
      await rm(install, { recursive: true, force: true });
    }
  });

  test("a missing probe package gets an actionable message, not a resolution stack", async () => {
    // The probe package must be installed in INSTALL_DIR; the Loader resolves it
    // like any other dependency. Without the guard, Node's own
    // ERR_MODULE_NOT_FOUND stack is all a maintainer sees, which names no fix.
    const install = await commonjsInstall();
    try {
      const { code, all } = await make(["loader-check", `INSTALL_DIR=${install}`]);
      expect(code).toBe(2);
      // The remedy, in the order it must be run.
      expect(all).toContain("make pack-dsh");
      expect(all).toContain("dsh-ensemble");
      expect(all).toContain("npm install --ignore-scripts");
      // The guard names the missing package and refuses before running.
      expect(all).toContain("no dsh-ensemble installed");
      // The bare resolution failure must not be what the user reads.
      expect(all).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(all).not.toContain("at defaultResolve");
      // Nor may a missing dependency be misreported as the ESM parse failure.
      expect(all).not.toContain("Cannot use import statement outside a module");
      // It says plainly that nothing was changed or proven.
      expect(all).toContain("Nothing was installed and nothing was verified");
      // The supplied directory is echoed so the command is copy-pasteable.
      expect(all).toContain(install);
    } finally {
      await rm(install, { recursive: true, force: true });
    }
  });

  test("the INSTALL_DIR guidance names the probe install step", async () => {
    // A first-time reader gets the whole sequence, not just the rc.4 packages.
    const { code, all } = await make(["loader-check"]);
    expect(code).toBe(2);
    expect(all).toContain(`@deepseek-ai/dsh@${DEFAULT_DSH_VERSION}`);
    expect(all).toContain("make pack-dsh");
    expect(all).toContain("dsh-ensemble");
  });

  test("the scratch directory is cleaned up even when the Loader fails", async () => {
    // Needs the probe present so the recipe actually creates a scratch directory.
    const install = await commonjsInstall({ probe: true });
    try {
      await make(["loader-check", `INSTALL_DIR=${install}`]);
      const left = (await readdir(install)).filter((name) => name.startsWith(".make-loader."));
      expect(left).toEqual([]);
    } finally {
      await rm(install, { recursive: true, force: true });
    }
  });

  test("host-check passes against a real isolated install of a tested release", async () => {
    const installDir = process.env.MAKE_TEST_INSTALL_DIR;
    if (installDir === undefined || installDir === "") {
      console.log("skip: set MAKE_TEST_INSTALL_DIR=<isolated install of a tested release> to run the positive path");
      return;
    }
    const { code, all } = await make(["loader-check", `INSTALL_DIR=${installDir}`]);
    expect(code).toBe(0);
    expect(all).toContain("OK dsh-ensemble via real Loader");
  }, 300_000);
});

describe("gates fail closed; diagnose observes", () => {
  // Contract: a target whose name ends in `-check` is a gate. Exit 0 means every
  // required check really ran and agreed. A missing prerequisite is a failure,
  // never a green "partially unverified" summary.
  test("isolation-check without INSTALL_DIR fails instead of exiting 0", async () => {
    const { code, all } = await make(["isolation-check"]);
    expect(code).toBe(2);
    expect(all).toContain("UNVERIFY");
    // The gate must not be talked out of its exit code by its own summary text.
    expect(all).not.toContain("== exit code 0 (partially unverified)");
    // Explicit budget: the child is a real subprocess and bun's 5 s default would kill
    // it mid-run, emptying the captured output (see `make()` for the measurement).
  }, CHILD_TIMEOUT_MS + TEST_SLACK_MS);

  test("isolation-check against a directory that is not an install fails", async () => {
    // Constructed here rather than borrowing a machine path: the point is that an
    // INSTALL_DIR was supplied and could not be used.
    const notAnInstall = await mkdtemp(join(tmpdir(), "not-an-install-"));
    try {
      const { code, all } = await make(["isolation-check", `INSTALL_DIR=${notAnInstall}`]);
      expect(code).toBe(2);
      // The gate names the supplied directory as unusable rather than quietly
      // measuring something else, and says plainly that nothing was verified.
      expect(all).toContain("CONFIG ERROR");
      expect(all).toContain("nothing was verified");
      expect(all).toContain("UNVERIFIED");
    } finally {
      // Cleanup in `finally`: a failing assertion (or a throw from `make()` on timeout)
      // must not leave the temporary directory behind.
      await rm(notAnInstall, { recursive: true, force: true });
    }
  }, CHILD_TIMEOUT_MS + TEST_SLACK_MS);

  test("isolation-check against a usable install runs every probe", async () => {
    const installDir = process.env.MAKE_TEST_INSTALL_DIR;
    if (installDir === undefined || installDir === "") {
      console.log("skip: set MAKE_TEST_INSTALL_DIR=<isolated install of a tested release> to run the positive path");
      return;
    }
    const { code, all } = await make(["isolation-check", `INSTALL_DIR=${installDir}`]);
    expect(code).toBe(0);
    expect(all).toMatch(/SUMMARY pass=\d+ refused=\d+ unverify=0 fail=0 total=11/);
  }, 240_000);

  test("profile-check without INSTALL_DIR fails and claims nothing", async () => {
    const { code, all } = await make(["profile-check"]);
    expect(code).toBe(2);
    expect(all).toContain("UNVERIFIED");
    expect(all).toContain("no INSTALL_DIR");
    expect(all).not.toContain("not implemented yet");
    expect(all).toContain("make profile-check INSTALL_DIR=");
  });

  test("profile-check against a directory that is not an install fails", async () => {
    const notAnInstall = await mkdtemp(join(tmpdir(), "not-an-install-"));
    const { code } = await make(["profile-check", `INSTALL_DIR=${notAnInstall}`]);
    expect(code).toBe(2);
    await rm(notAnInstall, { recursive: true, force: true });
  }, 120_000);

  test("profile-check against a usable install boots profiles and reports PASS", async () => {
    const installDir = process.env.MAKE_TEST_INSTALL_DIR;
    if (installDir === undefined || installDir === "") {
      console.log("skip: set MAKE_TEST_INSTALL_DIR=<isolated install of a tested release> to run the positive path");
      return;
    }
    const { code, all } = await make(["profile-check", `INSTALL_DIR=${installDir}`]);
    expect(code).toBe(0);
    expect(all).toContain("PASS:");
  }, 300_000);

  test("diagnose is observation only: exits 0 and says so", async () => {
    // `diagnose` asserts nothing, so it is allowed — required — to be green even
    // when nothing can be verified. That is why it is not called a `-check`.
    const { code, all } = await make(["diagnose"]);
    expect(code).toBe(0);
    expect(all).toContain("OBSERVATION ONLY");
  }, 120_000);

  test("diagnose never claims verification in its own output", async () => {
    const { code, all } = await make(["diagnose"]);
    expect(code).toBe(0);
    expect(all).toContain("OBSERVATION ONLY");
    // It reports; it does not conclude.
    expect(all).not.toContain("PASS:");
  }, 120_000);

  test("the naming contract is visible in help", async () => {
    const { stdout } = await make(["help"]);
    const diagnoseLine = stdout.split("\n").find((line) => line.trimStart().startsWith("diagnose"));
    expect(diagnoseLine).toBeDefined();
    expect(diagnoseLine).toContain("observation only");
    expect(diagnoseLine).toContain("always exits 0");
    // The gates say that a missing prerequisite is a failure.
    expect(stdout).toContain("*-check target is a gate");
    expect(stdout).toContain("Missing prerequisites -> non-zero");
  });

  test("inspect reports that nothing is packed instead of inventing output", async () => {
    const { code, all } = await make(["inspect"]);
    // Non-zero: make normalises any failing recipe to its own exit status.
    expect(code).not.toBe(0);
    expect(all).toContain("nothing has been packed");
    expect(all).toContain("make pack");
  });
});

describe("type coverage is a gate, not a claim", () => {
  // A script that no tsconfig includes is never type-checked by `make check`,
  // however green the gate looks. Guard the include list itself.
  test("every scripts/*-check.ts and its test are in the root tsconfig", async () => {
    const tsconfig = JSON.parse(await readFile(join(REPO_ROOT, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    const scripts = await readdir(join(REPO_ROOT, "scripts"));
    // Both naming conventions are in use: `profile-check.ts` and
    // `check-isolation.ts`. A filter for only one of them would pass while
    // leaving the other unchecked — the exact gap this test exists to close.
    const checkScripts = scripts.filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        (name.endsWith("-check.ts") || name.startsWith("check-")),
    );

    expect(checkScripts.length).toBeGreaterThan(0);
    // Prove the matcher actually sees both conventions, so a future rename
    // cannot make this test vacuous.
    expect(checkScripts.some((name) => name.endsWith("-check.ts"))).toBe(true);
    expect(checkScripts.some((name) => name.startsWith("check-"))).toBe(true);
    for (const name of checkScripts) {
      expect(tsconfig.include).toContain(`scripts/${name}`);
      const testFile = `scripts/${name.replace(/\.ts$/, ".test.ts")}`;
      if (scripts.includes(testFile.replace("scripts/", ""))) {
        expect(tsconfig.include).toContain(testFile);
      }
    }
  });

  test("the isolation probe modules are type-checked through the check script", async () => {
    // `adapters/dsh/probes/**` is not in any include list on purpose: it enters
    // the program by import from check-isolation.ts. Assert that path exists, so
    // removing the import cannot silently drop the coverage.
    const entry = await readFile(join(REPO_ROOT, "scripts/check-isolation.ts"), "utf8");
    expect(entry).toMatch(/from ['"]\.\.\/adapters\/dsh\/probes\/isolation\.ts['"]/);

    const tsconfig = JSON.parse(await readFile(join(REPO_ROOT, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    expect(tsconfig.include).toContain("scripts/check-isolation.ts");
  });

  test("make typecheck covers the check scripts, not just the app code", async () => {
    const { code, all } = await make(["typecheck"]);
    expect(code).toBe(0);
    // tsc --noEmit is silent on success; the assertion that matters is that the
    // include list above is what the gate actually compiles.
    expect(all.trim()).toBe("");
  }, 120_000);
});

describe("release doors", () => {
  test("package-check is the offline aggregate and needs no INSTALL_DIR", async () => {
    const { code, all } = await make(["package-check"]);
    expect(code, all).toBe(0);
    // All four offline steps ran, in order, and the door said what it covered.
    expect(all).toContain("check: ok");
    expect(all).toContain("pass");
    expect(all).toContain("package-check: ok (offline; Host gates not included)");
    expect(existsSync(join(fixture, "build/pack/omp/vcup-skills-0.2.0.tgz"))).toBe(true);
    expect(existsSync(join(fixture, `build/pack/dsh/dsh-ensemble-${PACKAGE_VERSION}.tgz`))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 300_000);

  test("release-check without INSTALL_DIR fails and asks for Host verification", async () => {
    const { code, all } = await make(["release-check"]);
    expect(code).toBe(2);
    // Not a skip, not a pass: the strict door refuses.
    expect(all).toContain("INSTALL_DIR is not set");
    expect(all).toContain("isolated DSH install");
    // The supported set is enumerated, not a single release: rc.4 and rc.5.
    for (const version of SUPPORTED_DSH_VERSIONS) expect(all).toContain(version);
    // And it says what is missing, in verification terms.
    expect(all).toContain("Any writable directory outside the repository works");
  });

  test("release-check with an INSTALL_DIR that is not an isolated install fails", async () => {
    const { code, all } = await make(["release-check", `INSTALL_DIR=${fixture}`]);
    expect(code).toBe(2);
    expect(all).toContain("no @deepseek-ai/dsh-skill");
    expect(all).toContain("not this working tree");
  });

  test("all is the offline chain and never claims Host verification", async () => {
    const { code, all } = await make(["all"]);
    expect(code).toBe(0);
    expect(all).toContain("package-check: ok (offline; Host gates not included)");
    expect(all).not.toContain("release-check: ok");

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 300_000);

  test("no target reaches a green release door by skipping the Host gates", async () => {
    // A default-green release door was the defect this split removed. Assert the
    // mechanism is gone, not just that one message changed.
    const makefile = await readFile(join(fixture, "Makefile"), "utf8");
    expect(makefile).not.toContain("SKIPPED host-check");
    expect(makefile).not.toContain("were NOT verified");

    // The strict door's prerequisites include the Host gate and the install
    // check. The list may be wrapped over several lines with backslashes, so it
    // is joined first: this assertion is about what the target depends on, not
    // about how the Makefile is formatted.
    const line = prerequisites(makefile, "release-check");
    expect(line).toBeDefined();
    expect(line).toContain("require-install-dir");
    expect(line).toContain("host-check");
  });

  test("the strict door gates every package it builds", async () => {
    // It packs all three packages, so gating only the ensemble probe would let
    // the door go green while shipping a wait plugin nobody verified.
    const makefile = await readMakefile();
    const line = prerequisites(makefile, "release-check");
    expect(line).toBeDefined();
    expect(line).toContain("pack");
    expect(line).toContain("wait-host-check");
    expect(line).toContain("host-check");
    // And it now verifies the installed product, not only the Loader.
    expect(line).toContain("production-check");
  });

  test("the strict door runs the native families and the live CLI case", async () => {
    // Offline `bun test` skips 92 tests for want of an install, which is correct
    // there and unacceptable as a release claim. `runtime-test-check` runs them and
    // `live-cli-test` runs the one case that must never be left to "skipped unless
    // somebody exports two variables". Both must be unconditional prerequisites:
    // a gate that can be dropped when it is inconvenient is not a gate.
    const makefile = await readMakefile();
    const line = prerequisites(makefile, "release-check");
    expect(line).toBeDefined();
    expect(line).toContain("runtime-test-check");
    expect(line).toContain("live-cli-test");
  });

  test("the live CLI target owns the Host and refuses to pass on a skip", async () => {
    const makefile = await readMakefile();
    // It starts the Host itself rather than taking a hand-passed origin, so a release
    // cannot claim the case ran while the wiring was only "planned".
    expect(makefile).toContain("live-cli-test:");
    expect(makefile).toContain("scripts/verify-dsh-live-cli.ts");
    // The gate must depend on the pinned artifact, like every other release gate.
    const line = prerequisites(makefile, "live-cli-test");
    expect(line).toBeDefined();
    expect(line).toContain("require-package-sha");
  });

  test("the strict door runs the browser and cross-container gates unconditionally", async () => {
    // A release conclusion may not rest on "we did not run those today". Both
    // gates are plain prerequisites of the door, and neither may be wrapped in a
    // make conditional: `$(if $(BROWSER),client-check)` would let a machine
    // without a browser print a green release check.
    const makefile = await readMakefile();
    const line = prerequisites(makefile, "release-check");
    expect(line).toContain("client-check");
    expect(line).toContain("auth-ui-check");
    // The source world is one target now: it starts the container, runs the
    // cross-container read and stops the container on every exit path, so a CI
    // step cannot leak it or skip it.
    expect(line).toContain("source-acceptance-sidecar-check");
    // The live maintenance run and the independent replica suite are unconditional
    // too: the engine regression and the typed replica cases are their own gates.
    expect(line).toContain("maintenance-live-check");
    expect(line).toContain("replica-acceptance-check");
    // The complete type claim: both plain programs, both runtime programs and the
    // closure check that no maintained file is in no program.
    expect(line).toContain("typecheck-strict");
    expect(line).not.toMatch(/\$\(if \$\(BROWSER\)/);
    expect(line).not.toMatch(/\$\(if \$\(SOURCE_CHECK\)/);

    // And the door's own report may not hedge about what it skipped.
    const body = ruleBody(makefile, "release-check");
    expect(body).not.toContain("NOT verified here");
    expect(body).toContain("cross-container source world");
    expect(body).toContain("real browser");
  });

  test("the browser and source gates fail closed, so the door cannot go green without them", async () => {
    const makefile = await readMakefile();
    // Each gate refuses at exit 2 with the command that supplies its fixture.
    expect(ruleBody(makefile, "client-check")).toContain("require-browser");
    expect(ruleBody(makefile, "client-check")).toContain("require-slots");
    const source = ruleBody(makefile, "source-acceptance-check");
    expect(source).toContain("ENSEMBLE_SOURCE_TEST_TOKEN");
    expect(source).toContain("ENSEMBLE_SOURCE_TEST_URL");
    expect(source).toContain("was not run");
  });

  test("help distinguishes the two doors and marks the strict one", async () => {
    const { stdout } = await make(["help"]);
    const packageLine = stdout.split("\n").find((entry) => entry.trimStart().startsWith("package-check"));
    const releaseLine = stdout.split("\n").find((entry) => entry.trimStart().startsWith("release-check"));

    expect(packageLine).toBeDefined();
    expect(packageLine).toContain("offline aggregate");
    expect(packageLine).toContain("no Host gates");

    expect(releaseLine).toBeDefined();
    // The door needs an isolated install *and* the two fixtures the strict
    // contract requires; the help line names all of them, so a reader cannot
    // mistake it for a run that only needs INSTALL_DIR.
    // The door's prerequisites grew with the strict contract: the Client program
    // also needs the published slot types (CLIENT_TYPES) beside the browser
    // (BROWSER), the static slot package (SLOTS) and the cross-container fixture.
    for (const requirement of ["INSTALL_DIR", "BROWSER", "SLOTS", "CLIENT_TYPES", "source fixture"]) {
      expect(releaseLine).toContain(requirement);
    }
    expect(releaseLine).toContain("strict release door");
    expect(releaseLine).toContain("browser UI");
    expect(releaseLine).toContain("live maintenance run");
    expect(releaseLine).toContain("cross-container source world");
    // The old, misleading wording is gone.
    expect(releaseLine).not.toContain("only when INSTALL_DIR is set");
  });
});

describe("portable wording", () => {
  test("no public message hardcodes a machine-specific temp path", async () => {
    // Product text must not bind to one machine's temporary directory; the
    // examples use ${TMPDIR:-/tmp} so they work anywhere.
    for (const file of ["Makefile", "scripts/project-tasks.ts"]) {
      const text = await readFile(join(REPO_ROOT, file), "utf8");
      expect(text).not.toContain("/tmp/dsh-rc4");
      expect(text).toContain("${TMPDIR:-/tmp}");
    }
  });

  test("the isolated-install instructions say any writable directory works", async () => {
    const { code, all } = await make(["typecheck-host"]);
    expect(code).toBe(2);
    expect(all).toContain("Any writable directory outside the repository works");
    expect(all).toContain("${TMPDIR:-/tmp}/dsh-install");
  });
});

describe("install-smoke runs without a TTY", () => {
  test("passes -y and an explicit agent target to the installer", async () => {
    // The installer prompts for an agent when stdin is not a TTY and exits 1;
    // the smoke target must therefore be non-interactive by construction.
    const makefile = await readFile(join(REPO_ROOT, "Makefile"), "utf8");
    const recipe = makefile.slice(makefile.indexOf("install-smoke: require-npx"));
    const command = recipe.split("\n").find((line) => line.includes("skills@1.9.0"));
    expect(command).toBeDefined();
    expect(command).toContain("-y");
    expect(command).toContain("--agent");
    // And it must not read from a terminal it does not have.
    expect(recipe).toContain("</dev/null");
  });

  test("keeps the installer version pinned", async () => {
    const { stdout } = await make(["-n", "install-smoke"]);
    expect(stdout).toContain("skills@1.9.0");
    expect(stdout).not.toContain("skills@latest");
  });
});

describe("CI drives make, not package scripts", () => {
  /**
   * Split a workflow into the commands each `run:` actually executes.
   *
   * A `run:` value can be a single line or a YAML block scalar (`run: |`). The
   * earlier version of this test read `run:` lines literally, so a block scalar
   * produced the string "|" and the assertion was about YAML syntax rather than
   * about what CI runs. Both forms are legitimate; what must hold is the set of
   * *commands* that come out of them.
   *
   * Returns one entry per workflow file so the caller can assert over all of
   * them; a second workflow added later cannot quietly escape the check.
   */
  async function workflowRuns(path: string): Promise<{ commands: string[]; executable: string }> {
    const lines = (await readFile(path, "utf8")).split("\n");
    const commands: string[] = [];
    const executableLines: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trimStart().startsWith("#")) executableLines.push(line);
      const match = /^(\s*)-\s+run:\s*(.*)$/.exec(line) ?? /^(\s*)run:\s*(.*)$/.exec(line);
      if (match === null) continue;
      const [, indent, value] = match;
      if (value !== undefined && value !== "|" && value !== ">" && value.trim() !== "") {
        commands.push(value.trim());
        continue;
      }
      // Block scalar: every following line indented deeper belongs to the script.
      const baseIndent = indent!.length;
      for (index += 1; index < lines.length; index += 1) {
        const scriptLine = lines[index]!;
        if (scriptLine.trim() === "") continue;
        const scriptIndent = scriptLine.length - scriptLine.trimStart().length;
        if (scriptIndent <= baseIndent) {
          index -= 1;
          break;
        }
        const command = scriptLine.trim();
        if (!command.startsWith("#")) commands.push(command);
      }
    }
    return { commands, executable: executableLines.filter((line) => !line.trimStart().startsWith("#")).join("\n") };
  }

  const WORKFLOWS = [".github/workflows/ensemble-content.yml"];

  /**
   * Every step in a workflow, with its name, its `run:` script and whether it is
   * conditional.
   *
   * Steps are the unit a reader reasons about ("the browser step"), so they are
   * the unit this test checks. A `run:` may be one line or a block scalar; both
   * arrive here as the script text.
   */
  async function workflowSteps(path: string): Promise<{ name: string; script: string; conditional: boolean }[]> {
    const text = await readFile(path, "utf8");
    const steps: { name: string; script: string; conditional: boolean }[] = [];
    const parts = text.split(/\n      - name: /).slice(1);
    for (const part of parts) {
      const name = part.split("\n")[0]!.trim();
      const raw = /\n        run: ([\s\S]*?)(?=\n      - name: |\n  [a-z]|$)/.exec(part)?.[1]?.trim() ?? "";
      // `run: |` is a block scalar: drop the marker and join the script's lines so
      // the assertion is about the command, not about YAML indentation.
      const script = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line !== "|" && line !== ">")
        .join(" ")
        .trim();
      const conditional = /\n        if: /.test(part);
      steps.push({ name, script, conditional });
    }
    return steps;
  }

  /**
   * Steps that legitimately do not run `make`.
   *
   * Each is provisioning for a gate rather than a gate: the browser build and its
   * fonts (CI-only dependencies), the container runtime check, the derived release
   * matrix and the pinned candidate. Naming them means adding one is a deliberate
   * edit; a permissive pattern would let a gate become a shell block unnoticed.
   */
  const NOT_GATES = new Set([
    "Install Bun",
    "Install Node",
    "Check out repository",
    "Install the locked development dependencies",
    "Install browser runtime, fonts and container runtime",
    "Derive the release matrix from the maintained support declarations",
    "Pin the candidate artifact by sha256",
    "Refuse a caller-supplied hash that does not match the packed bytes",
    "Retrieve the pinned candidate",
    "Prove the retrieved candidate is the pinned byte",
    "Retain the pinned candidate and the local package set",
    "Retain the evidence this leg produced",
    "Confirm every leg ran and every artifact was retained",
    "Report the pinned artifact",
  ]);

  test("every workflow step is a make target or a named provisioning step", async () => {
    for (const path of WORKFLOWS) {
      const steps = await workflowSteps(join(REPO_ROOT, path));
      expect(steps.length, path).toBeGreaterThan(0);
      for (const step of steps) {
        const isMake = /^make \S/.test(step.script);
        const isNamed = NOT_GATES.has(step.name);
        expect(isMake || isNamed, `${path}: ${step.name} -> ${step.script.split("\n")[0]}`).toBe(true);
        // A conditional step may only be artifact retention or the caller's hash
        // check. A gate that can be skipped is not a gate.
        if (step.conditional) {
          expect(step.name, `${path}: ${step.name} is conditional`).toMatch(/Retain|Refuse a caller-supplied/);
        }
      }
      expect(steps.some((step) => step.script.startsWith("make setup")), path).toBe(true);
      // A workflow made only of provisioning steps would satisfy every rule above
      // while verifying nothing. The gates are the reason the file exists.
      const gates = steps.filter((step) => /^make \S/.test(step.script));
      expect(gates.length, path).toBeGreaterThan(8);
      // And the strict type claim is one of them, so the closure check cannot be
      // dropped from CI without failing this test.
      expect(steps.some((step) => /make typecheck-strict/.test(step.script)), path).toBe(true);
    }
  });

  test("no workflow step runs a package script, a test runner, or an installer directly", async () => {
    for (const path of WORKFLOWS) {
      const { executable } = await workflowRuns(join(REPO_ROOT, path));
      // Installs, tests and packaging go through make, which is what makes the
      // local and remote runs the same evidence. These four spellings are the
      // ways that guarantee is usually lost.
      expect(executable, path).not.toMatch(/\b(npm|bun)\s+run\b/);
      expect(executable, path).not.toMatch(/\bbun test\b/);
      expect(executable, path).not.toMatch(/\bbun install\b/);
      expect(executable, path).not.toMatch(/\bnpm (install|pack)\b/);
      expect(executable, path).not.toMatch(/\bnpx /);
    }
  });

  test("the native legs run the whole gate set, with no per-plugin conditional", async () => {
    const workflow = await readFile(join(REPO_ROOT, WORKFLOWS[0]!), "utf8");
    // A matrix leg that skips gates reports a green check that verified less than
    // its name says. Every per-release leg runs the same set.
    const native = workflow.slice(workflow.indexOf("  native:"));
    expect(native).toContain("make runtime-setup");
    expect(native).toContain("make host-check");
    expect(native).toContain("make wait-host-check");
    expect(native).toContain("make wait-runtime-check");
    expect(native).toContain("make production-check");
    // The only remaining `if:` on a gate step may be `always()` for artifact
    // upload; a conditional gate is what this test exists to prevent.
    expect(native).not.toMatch(/if:\s*matrix\.(plugin|version)/);
  });
});

describe("paths and variables", () => {
  test("accepts an INSTALL_DIR containing spaces and echoes it unchanged", async () => {
    const spaced = join(tmpdir(), "install dir with spaces");
    const { code, all } = await make(["typecheck-host", `INSTALL_DIR=${spaced}`]);
    expect(code).toBe(2);
    // The path is reported whole: it was quoted, not word-split.
    expect(all).toContain(spaced);
    expect(all).toContain("does not exist");
  });

  test("an unknown target fails and names the interface", async () => {
    const { code, all } = await make(["no-such-target"]);
    expect(code).not.toBe(0);
    expect(all).toContain("No rule to make target");
  });

  test("setup is the only target that installs dependencies", async () => {
    const makefile = await readFile(join(fixture, "Makefile"), "utf8");
    const installLines = makefile
      .split("\n")
      .filter((line) => /\bbun install\b/.test(line) && !line.trimStart().startsWith("#"));
    expect(installLines).toHaveLength(1);
  });

  test("no recipe shells out to npm run or bun run", async () => {
    const makefile = await readFile(join(fixture, "Makefile"), "utf8");
    for (const line of makefile.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      expect(line).not.toMatch(/\b(npm|bun)\s+run\b/);
    }
  });
});

describe("parallel safety", () => {
  test("make -j8 pack writes both packages without a race", async () => {
    const makefile = await readFile(join(fixture, "Makefile"), "utf8");
    expect(makefile).toContain(".NOTPARALLEL");

    // `pack` has two prerequisites that both write under build/pack; under -j
    // they would run concurrently without .NOTPARALLEL.
    const { code, all } = await make(["-j8", "pack"]);
    expect(code).toBe(0);
    expect(all).not.toContain("Error");
    expect(existsSync(join(fixture, "build/pack/omp/vcup-skills-0.2.0.tgz"))).toBe(true);
    expect(existsSync(join(fixture, `build/pack/dsh/dsh-ensemble-${PACKAGE_VERSION}.tgz`))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 60_000);

  test("make -j8 all runs the whole offline chain to completion", async () => {
    const { code, all } = await make(["-j8", "all"]);
    expect(code).toBe(0);
    expect(all).toContain("check: ok");
    expect(existsSync(join(fixture, "build/pack/omp/vcup-skills-0.2.0.tgz"))).toBe(true);
    expect(existsSync(join(fixture, `build/pack/dsh/dsh-ensemble-${PACKAGE_VERSION}.tgz`))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 300_000);
});

/**
 * Read the committed Makefile as data for the wiring assertions below. These do
 * not run targets that need a real DSH install or a running Host: those are
 * exercised by the gates themselves, and a unit test that faked them would be
 * asserting its own stub.
 */
async function readMakefile(): Promise<string> {
  return await readFile(join(REPO_ROOT, "Makefile"), "utf8");
}

/**
 * The prerequisites of one target, with line continuations joined.
 *
 * A wrapped prerequisite list is ordinary Makefile style; reading only the first
 * physical line would make a dependency assertion depend on formatting instead
 * of on what the target actually runs.
 */
function prerequisites(makefile: string, target: string): string {
  const lines = makefile.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));
  if (start === -1) throw new Error(`target not found: ${target}`);
  let joined = "";
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    const continues = line.endsWith("\\");
    joined += `${line.replace(/\\$/, "").trim()} `;
    if (!continues) break;
  }
  return joined;
}

/** Body of one target, up to the next rule. */
function ruleBody(makefile: string, target: string): string {
  const lines = makefile.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));
  if (start === -1) throw new Error(`target not found: ${target}`);
  const body: string[] = [];
  // Prerequisite lines may be folded with trailing backslashes; they belong to
  // the rule header, so skip past them before looking for the recipe body.
  let index = start;
  for (; index < lines.length; index += 1) {
    body.push(lines[index]);
    if (!lines[index].endsWith("\\")) break;
  }
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== "" && !line.startsWith("\t") && !line.startsWith("#")) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("third package wiring", () => {
  test("pack builds all three packages", async () => {
    const makefile = await readMakefile();
    const pack = ruleBody(makefile, "pack");
    expect(pack).toContain("pack-omp");
    expect(pack).toContain("pack-dsh ");
    expect(pack).toContain("pack-dsh-agent-wait");
  });

  test("the wait package target runs the real pack script", async () => {
    const makefile = await readMakefile();
    const body = ruleBody(makefile, "pack-dsh-agent-wait");
    // A wrapper that echoes success instead of packing would be a false door.
    expect(body).toContain("scripts/pack-dsh-agent-wait.ts");
    expect(body).not.toMatch(/echo\s+['"]?(packed|ok|success)/i);
  });

  test("the wait tarball directory is derived, not hardcoded to one version", async () => {
    const makefile = await readMakefile();
    expect(makefile).toContain("WAIT_PROBE_DIR");
    // A version literal here would break the target on the next bump.
    const body = ruleBody(makefile, "wait-loader-check");
    expect(body).toMatch(/dsh-agent-wait-\*\.tgz/);
  });

  test("doctor and inspect cover the third package", async () => {
    const tasks = await readFile(join(REPO_ROOT, "scripts/project-tasks.ts"), "utf8");
    expect(tasks).toContain("build/pack/dsh-agent-wait");
  });
});

describe("wait Host gates fail closed", () => {
  test("both gates require an isolated install", async () => {
    const makefile = await readMakefile();
    for (const target of ["typecheck-wait-host", "wait-loader-check"]) {
      expect(ruleBody(makefile, target)).toContain("require-install-dir");
    }
    expect(ruleBody(makefile, "wait-host-check")).toContain("typecheck-wait-host");
    expect(ruleBody(makefile, "wait-host-check")).toContain("wait-loader-check");
  });

  test("the loader gate refuses a missing package with actionable steps", async () => {
    const makefile = await readMakefile();
    const body = ruleBody(makefile, "wait-loader-check");
    expect(body).toContain("make pack-dsh-agent-wait");
    expect(body).toContain("no dsh-agent-wait installed");
    // It must state that nothing was verified rather than implying a pass.
    expect(body).toContain("Nothing was installed and nothing was verified");
    // The scratch directory must declare ESM, or Node parses the check as CJS.
    expect(body).toContain('"type":"module"');
  });

  test("the wait gates stay out of every offline default", async () => {
    const makefile = await readMakefile();
    for (const target of ["check", "test", "package-check", "all"]) {
      const body = ruleBody(makefile, target);
      expect(body).not.toContain("wait-host-check");
      expect(body).not.toContain("typecheck-wait-host");
    }
  });
});

describe("owner archive wrapper", () => {
  test("the wrapper runs the packaged CLI from the install, not the source tree", async () => {
    const makefile = await readMakefile();
    const body = ruleBody(makefile, "archive-owner-help");
    // bin/ and lib/ import @deepseek-ai/cordis, which only an install provides.
    expect(body).toContain("node_modules/dsh-ensemble/bin/ensemble-archive.js");
    expect(body).toContain("require-install-dir");
  });

  test("no target accepts a credential on the command line", async () => {
    const makefile = await readMakefile();
    for (const target of ["archive-owner-help", "archive-owner-status", "archive-owner-call"]) {
      const body = ruleBody(makefile, target);
      // The CLI refuses --cookie for a reason; the wrapper must not reintroduce it.
      expect(body).not.toMatch(/--cookie[^-]/);
      expect(body).not.toContain("--cookie ");
    }
    expect(makefile).toContain("ENSEMBLE_ARCHIVE_COOKIE");
  });

  test("the wrapper never prints a credential", async () => {
    const makefile = await readMakefile();
    for (const target of ["archive-owner-status", "archive-owner-call"]) {
      const body = ruleBody(makefile, target);
      expect(body).not.toMatch(/printf[^\n]*\$\$?\{?ENSEMBLE_ARCHIVE_COOKIE/);
      expect(body).not.toMatch(/echo[^\n]*ENSEMBLE_ARCHIVE_COOKIE/);
    }
  });

  test("the endpoints gate their inputs before touching the Host", async () => {
    const makefile = await readMakefile();
    const body = ruleBody(makefile, "archive-owner-call");
    // Both inputs are checked, and each failure names the missing one.
    expect(body).toContain("ARCHIVE_METHOD is not set");
    expect(body).toContain("ARCHIVE_REQUEST is not set");
  });

  test("the CLI's own code is printed, because make returns 2 for any failure", async () => {
    const makefile = await readMakefile();
    const body = ruleBody(makefile, "archive-owner-status");
    // Measured: `make` returns 2 for *any* failing recipe, whatever the child
    // exited with. The wrapper therefore prints the CLI's real code (3 no
    // credential, 4 rejected, 5 unreachable) so the distinction survives in the
    // output. The contract is "printed code + make exit 2", never "make exits 3".
    expect(body).toContain("archive CLI exit code");
    expect(body).toMatch(/exit \$\$code/);
  });

  test("every help line survives the shell, including apostrophes", async () => {
    // Regression: a single-quoted printf containing a raw ' ends the shell
    // string and the whole `help` target dies with "unexpected EOF while
    // looking for matching `''" -- after printing half the list, which looks
    // like a successful run until the exit code is read.
    const makefile = await readMakefile();
    const helpLines = makefile
      .split("\n")
      .filter((line) => line.includes("printf") && line.includes("'  %-16s"));
    expect(helpLines.length).toBeGreaterThan(10);
    for (const line of helpLines) {
      const singleQuoted = line.match(/'[^']*'/g) ?? [];
      expect(singleQuoted.length).toBeGreaterThan(1);
    }
  });

  test("archive targets are absent from the offline defaults", async () => {
    const makefile = await readMakefile();
    for (const target of ["check", "test", "package-check", "all"]) {
      expect(ruleBody(makefile, target)).not.toContain("archive-owner");
    }
  });
});
