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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    timeout: 120_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
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
    // Nothing generated: the gate is read-only.
    expect(existsSync(join(fixture, "build"))).toBe(false);
  });

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
    expect(all).toContain("isolated DSH rc.4 install");
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

describe("unverified capabilities report themselves", () => {
  test("profile-check fails and says the capability is unverified", async () => {
    const { code, all } = await make(["profile-check"]);
    expect(code).toBe(2);
    expect(all).toContain("not implemented yet");
    expect(all).toContain("unverified");
    expect(all).toContain("nothing is claimed");
  });

  test("isolation-check fails and says the capability is unverified", async () => {
    const { code, all } = await make(["isolation-check"]);
    expect(code).toBe(2);
    expect(all).toContain("not implemented yet");
    expect(all).toContain("unverified");
  });

  test("inspect reports that nothing is packed instead of inventing output", async () => {
    const { code, all } = await make(["inspect"]);
    // Non-zero: make normalises any failing recipe to its own exit status.
    expect(code).not.toBe(0);
    expect(all).toContain("nothing has been packed");
    expect(all).toContain("make pack");
  });
});

describe("release doors", () => {
  test("package-check is the offline aggregate and needs no INSTALL_DIR", async () => {
    const { code, all } = await make(["package-check"]);
    expect(code).toBe(0);
    // All four offline steps ran, in order, and the door said what it covered.
    expect(all).toContain("check: ok");
    expect(all).toContain("pass");
    expect(all).toContain("package-check: ok (offline; Host gates not included)");
    expect(existsSync(join(fixture, "build/pack/omp/vcup-skills-0.2.0.tgz"))).toBe(true);
    expect(existsSync(join(fixture, "build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz"))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 120_000);

  test("release-check without INSTALL_DIR fails and asks for Host verification", async () => {
    const { code, all } = await make(["release-check"]);
    expect(code).toBe(2);
    // Not a skip, not a pass: the strict door refuses.
    expect(all).toContain("INSTALL_DIR is not set");
    expect(all).toContain("isolated DSH rc.4 install");
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
  }, 120_000);

  test("no target reaches a green release door by skipping the Host gates", async () => {
    // A default-green release door was the defect this split removed. Assert the
    // mechanism is gone, not just that one message changed.
    const makefile = await readFile(join(fixture, "Makefile"), "utf8");
    expect(makefile).not.toContain("SKIPPED host-check");
    expect(makefile).not.toContain("were NOT verified");

    // The strict door's prerequisites include the Host gate and the install check.
    const line = makefile.split("\n").find((entry) => entry.startsWith("release-check:"));
    expect(line).toBeDefined();
    expect(line).toContain("require-install-dir");
    expect(line).toContain("host-check");
  });

  test("help distinguishes the two doors and marks the strict one", async () => {
    const { stdout } = await make(["help"]);
    const packageLine = stdout.split("\n").find((entry) => entry.trimStart().startsWith("package-check"));
    const releaseLine = stdout.split("\n").find((entry) => entry.trimStart().startsWith("release-check"));

    expect(packageLine).toBeDefined();
    expect(packageLine).toContain("offline aggregate");
    expect(packageLine).toContain("no Host gates");

    expect(releaseLine).toBeDefined();
    expect(releaseLine).toContain("[needs INSTALL_DIR]");
    expect(releaseLine).toContain("strict release door");
    expect(releaseLine).toContain("Host types");
    expect(releaseLine).toContain("real Loader");
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
    expect(all).toContain("${TMPDIR:-/tmp}/dsh-rc4");
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
  test("every workflow step runs make, and none runs a package script", async () => {
    const workflow = await readFile(join(REPO_ROOT, ".github/workflows/ensemble-content.yml"), "utf8");
    // Comments may name the commands this workflow deliberately does not use;
    // only executable lines are the claim under test.
    const executable = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const runs = workflow
      .split("\n")
      .filter((line) => line.trimStart().startsWith("run:"))
      .map((line) => line.slice(line.indexOf("run:") + 4).trim());

    expect(runs.length).toBeGreaterThan(0);
    for (const command of runs) {
      expect(command).toMatch(/^make \S/);
    }
    expect(runs.some((command) => command.startsWith("make setup"))).toBe(true);
    expect(executable).not.toMatch(/\b(npm|bun)\s+run\b/);
    expect(executable).not.toMatch(/\bbun test\b/);
    expect(executable).not.toMatch(/\bbun install\b/);
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
    expect(existsSync(join(fixture, "build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz"))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 60_000);

  test("make -j8 all runs the whole offline chain to completion", async () => {
    const { code, all } = await make(["-j8", "all"]);
    expect(code).toBe(0);
    expect(all).toContain("check: ok");
    expect(existsSync(join(fixture, "build/pack/omp/vcup-skills-0.2.0.tgz"))).toBe(true);
    expect(existsSync(join(fixture, "build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz"))).toBe(true);

    await rm(join(fixture, "build"), { recursive: true, force: true });
  }, 120_000);
});
