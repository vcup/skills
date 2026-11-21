/**
 * The invocation form the package README documents must actually resolve.
 *
 * This test exists because the README once told users to run a bare
 * `ensemble-archive`, and that fails: `dsh plugin add` installs the binary into
 * the **profile** (`<DSH_HOME>/profiles/<name>/node_modules/.bin/`), which is on
 * no `PATH`, and `dsh plugin` has no `exec` subcommand to reach it through — it
 * only forwards its arguments to pnpm. A documented-but-unrunnable command is a
 * defect a reader cannot diagnose, so it is pinned here.
 *
 * What is asserted, against a real `dsh plugin add` into a fresh `DSH_HOME`:
 *
 * 1. a bare `ensemble-archive` on a normal `PATH` fails with 127 — the honest
 *    starting point, and the reason the README names a path;
 * 2. the profile-`.bin` path form the README gives resolves and runs (exit 3
 *    with no credential, which means it loaded and parsed arguments);
 * 3. prepending the profile `.bin` to `PATH` also works;
 * 4. every command in the README's `Run a command` block uses that resolved
 *    form, and the README does not promise a bare command or a `dsh` subcommand.
 *
 * The `node` requirement is checked too: the shebang is `#!/usr/bin/env node`, so
 * a shell without `node` on `PATH` fails even when the path is right.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

function temporaryRoot(prefix = "cli-invocation-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TARBALL = join(REPO_ROOT, "build", "pack", "dsh", "dsh-ensemble-probe-0.3.0.tgz");
const PACKAGE_README = join(REPO_ROOT, "adapters", "dsh", "package-readme.md");

/** A PATH with no profile `.bin` on it, and `node` available. */
function plainPath(): string {
  const node = Bun.which("node");
  expect(node, "these tests need a real node on PATH").not.toBeNull();
  const dir = resolve(node as string, "..");
  return `${dir}:/usr/local/bin:/usr/bin:/bin`;
}

/** The isolated install that provides `dsh`, or undefined. */
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

/** Install into a fresh profile and return the paths the README refers to. */
function freshInstall(): { profileBin: string; script: string; home: string } {
  const root = temporaryRoot();
  const home = join(root, "home");
  const env = {
    DSH_HOME: home,
    npm_config_cache: join(root, "npm-cache"),
    PNPM_HOME: join(root, "pnpm"),
    PATH: `${join(INSTALL as string, "node_modules", ".bin")}:${plainPath()}`,
  };
  const added = Bun.spawnSync(["dsh", "plugin", "--profile", "web", "add", TARBALL], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  expect(added.exitCode, `${added.stdout.toString()}\n${added.stderr.toString()}`).toBe(0);
  const profile = join(home, "profiles", "web");
  return {
    home,
    profileBin: join(profile, "node_modules", ".bin", "ensemble-archive"),
    script: join(profile, "node_modules", "dsh-ensemble-probe", "bin", "ensemble-archive.js"),
  };
}

/** Run a shell command with an explicit PATH and no inherited cookie. */
function sh(command: string, env: Record<string, string>) {
  const result = Bun.spawnSync(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { HOME: process.env.HOME ?? "/root", ENSEMBLE_ARCHIVE_COOKIE: "", ...env },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("the documented invocation form", () => {
  test.skipIf(SKIP)(
    "a bare `ensemble-archive` is not on PATH, which is why the README names one",
    () => {
      const { profileBin } = freshInstall();
      expect(existsSync(profileBin)).toBe(true);
      const result = sh("ensemble-archive status", { PATH: plainPath() });
      expect(result.code).toBe(127);
      expect(result.stderr).toContain("command not found");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the profile-.bin path the README gives resolves and runs",
    () => {
      const { profileBin } = freshInstall();
      const result = sh(`"${profileBin}" status`, { PATH: plainPath() });
      // 3 = loaded, parsed, and refused for want of a credential. A 127 here
      // would mean the documented path is wrong.
      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain("no credential");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "prepending the profile .bin to PATH also works, as the README's alternative says",
    () => {
      const { profileBin } = freshInstall();
      const binDir = resolve(profileBin, "..");
      const result = sh("ensemble-archive status", { PATH: `${binDir}:${plainPath()}` });
      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain("no credential");
    },
    { timeout: 300_000 },
  );

  test.skipIf(SKIP)(
    "the shebang needs node on PATH, and says so rather than failing obscurely",
    () => {
      const { script } = freshInstall();
      // A PATH with the script but genuinely no `node` on it: /usr/bin contains
      // one, so an empty temporary directory is the only honest way to say it.
      const emptyBin = temporaryRoot("no-node-path-");
      const result = Bun.spawnSync(["/bin/bash", "-c", `"${script}" status`], {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: emptyBin, HOME: process.env.HOME ?? "/root", ENSEMBLE_ARCHIVE_COOKIE: "" },
      });
      expect(result.exitCode).not.toBe(0);
      // Either bash could not find node, or env reported it. Both are legible.
      expect(`${result.stderr.toString()}${result.stdout.toString()}`).toMatch(/node/i);
    },
    { timeout: 300_000 },
  );
});

describe("the README text matches the tested form", () => {
  test("every command in the Run-a-command block uses a resolved path", () => {
    const text = readFileSync(PACKAGE_README, "utf8");
    // The block between the Run-a-command heading and the options table.
    const start = text.indexOf("### Run a command");
    const end = text.indexOf("| Option | Meaning |");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = text.slice(start, end);

    // No line may invoke the bare command *unless* the block has just put the
    // profile `.bin` on PATH: that is the one context where the bare form is
    // correct, and the README shows both forms deliberately.
    const pathExported = block.includes('export PATH="$DSH_HOME/profiles/web/node_modules/.bin');
    expect(pathExported, "the README must show the PATH alternative").toBe(true);
    const bare = block
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => /(^|\s)(ensemble-archive)\s/.test(line))
      .filter((line) => !line.includes("$ENSEMBLE_ARCHIVE"))
      .filter((line) => !line.includes("export PATH="))
      .filter((line) => !line.includes("ENSEMBLE_ARCHIVE="))
      // The bare form is allowed only after the PATH export, which the README
      // places immediately above it.
      .filter((line) => {
        const at = block.indexOf(line);
        return !(at > -1 && block.slice(0, at).includes('export PATH="$DSH_HOME/profiles/web/node_modules/.bin'));
      });
    expect(bare, `bare invocations with no PATH export above them:\n${bare.join("\n")}`).toEqual([]);

    // The block must state the real location and the PATH alternative.
    expect(block).toContain("node_modules/.bin/ensemble-archive");
    expect(block).toContain("export PATH=");
    // And it must be honest that nothing is installed globally.
    expect(block.toLowerCase()).toContain("not onto your `path`");
  });

  test("the README does not promise a `dsh` subcommand for the archive", () => {
    const text = readFileSync(PACKAGE_README, "utf8");
    // It is correct to *mention* that no such subcommand exists; it is not
    // correct to show one being run. Command position means a line that starts
    // with `dsh plugin`, inside or outside a fence.
    const commandLines = text.split("\n").filter((line) => /^\s*\$?\s*dsh plugin (exec|archive)\b/.test(line));
    expect(commandLines, `the README shows a nonexistent subcommand:\n${commandLines.join("\n")}`).toEqual([]);
    // `dsh plugin` only forwards to pnpm; the README says so where it matters.
    expect(text).toMatch(/`dsh plugin` forwards (its arguments )?to \*\*pnpm\*\*/);
    // And the bind caveat must match what was actually measured over the wire.
    expect(text).not.toContain("were not driven over the");
    expect(text).toContain("`bind` was driven over the transport");
  });

  test("the README does not tell users to rewrite the jar", () => {
    // The parser reads `curl -c` output verbatim, including `#HttpOnly_`.
    const text = readFileSync(PACKAGE_README, "utf8");
    expect(text).not.toContain("awk '/dsh-auth-");
    expect(text).toContain("#HttpOnly_");
  });
});
