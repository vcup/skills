#!/usr/bin/env bun
/**
 * Lifecycle helpers for the repository `Makefile`.
 *
 * The Makefile is the interface maintainers use; this module is the one piece of
 * logic behind it that is not a straight command invocation. It answers four
 * questions that are awkward to express in shell and easy to get wrong there:
 *
 *   doctor       what is installed, what is missing, and which targets that blocks
 *   staging      does the ignored staging for a content path exist yet
 *   inspect      what tarballs exist and what is inside them
 *   clean        delete only generated paths this repository owns
 *   install-dir  is this a real isolated DSH install, or just a directory
 *
 * Everything here is read-only except `clean`, and `clean` refuses anything it
 * cannot prove it owns. No network access, no package manager, no `npm run`.
 *
 *   bun scripts/project-tasks.ts doctor
 *   bun scripts/project-tasks.ts staging <omp|dsh>
 *   bun scripts/project-tasks.ts inspect
 *   bun scripts/project-tasks.ts install-dir [--types] [--quiet] <dir>
 *   bun scripts/project-tasks.ts clean [--all]
 *
 * Exit codes: 0 success, 1 a check failed, 2 refused or misconfigured (nothing
 * was changed).
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The DSH release the Host gates are pinned to. */
const EXPECTED_DSH = "0.2.2-rc.4";

/** Generated directories this repository owns. `clean` deletes nothing else. */
const GENERATED_DIR = "build";
const DEPENDENCY_DIR = "node_modules";

/** A command probe, injected so tests never depend on the real PATH. */
export type Probe = (command: string, args: readonly string[]) => { ok: boolean; output: string };

export interface ToolReport {
  readonly name: string;
  /** What the tool is used for, in one phrase. */
  readonly role: string;
  readonly found: boolean;
  readonly version: string;
  /** Targets that cannot run without it. Empty means nothing is blocked. */
  readonly blocks: readonly string[];
}

const TOOLS: readonly { name: string; role: string; command: string; versionArgs: readonly string[]; blocks: readonly string[] }[] = [
  {
    name: "bun",
    role: "runs every script, test and typecheck",
    command: "bun",
    versionArgs: ["--version"],
    blocks: ["check", "test", "content", "content-build", "pack", "inspect"],
  },
  {
    name: "node",
    role: "runs the real Loader check and npm",
    command: "node",
    versionArgs: ["--version"],
    blocks: ["pack", "host-check", "install-smoke"],
  },
  {
    name: "npm",
    role: "produces both package tarballs",
    command: "npm",
    versionArgs: ["--version"],
    blocks: ["pack", "pack-omp", "pack-dsh", "release-check", "all"],
  },
  {
    name: "npx",
    role: "runs the pinned skills installer",
    command: "npx",
    versionArgs: ["--version"],
    blocks: ["install-smoke"],
  },
  {
    name: "python3",
    role: "runs the documentation checker",
    command: "python3",
    versionArgs: ["--version"],
    blocks: ["docs", "check", "release-check"],
  },
  {
    name: "git",
    role: "read-only history review",
    command: "git",
    versionArgs: ["--version"],
    blocks: ["status", "diff", "git-review"],
  },
  {
    name: "omp",
    role: "installs the local OMP package into a profile",
    command: "omp",
    versionArgs: ["--version"],
    blocks: ["install-omp"],
  },
];

function defaultProbe(command: string, args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 20_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

/** Locate a tool on PATH, with the repository-local fallback for `omp`. */
function locate(command: string, root: string): string {
  if (command === "omp") {
    const local = join(root, "node_modules/.bin/omp");
    if (existsSync(local)) return local;
  }
  return command;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export interface DoctorResult {
  readonly lines: readonly string[];
  /** True when the default offline path can run. */
  readonly ok: boolean;
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
}

/**
 * Report tools, dependencies and artifacts, and say what each gap blocks.
 *
 * "Required" means required by the default offline path (`check`); an optional
 * tool only narrows what else is available and never fails the report.
 */
export function doctor(root: string = REPO_ROOT, probe: Probe = defaultProbe): DoctorResult {
  const lines: string[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  lines.push("== doctor: tools");
  for (const tool of TOOLS) {
    const { ok, output } = probe(locate(tool.command, root), tool.versionArgs);
    if (ok) {
      lines.push(`  ok      ${tool.name.padEnd(8)} ${firstLine(output)}  (${tool.role})`);
      continue;
    }
    const required = tool.blocks.includes("check");
    (required ? missingRequired : missingOptional).push(tool.name);
    lines.push(`  MISSING ${tool.name.padEnd(8)} ${tool.role}`);
    lines.push(`          blocks: ${tool.blocks.join(", ")}`);
  }

  lines.push("== doctor: dependencies");
  const typescript = join(root, "node_modules/typescript/bin/tsc");
  const checks: readonly { label: string; present: boolean; fix: string }[] = [
    { label: "node_modules/", present: existsSync(join(root, "node_modules")), fix: "make setup" },
    { label: "typescript (node_modules/typescript/bin/tsc)", present: existsSync(typescript), fix: "make setup" },
  ];
  for (const entry of checks) {
    if (entry.present) {
      lines.push(`  ok      ${entry.label}`);
      continue;
    }
    missingRequired.push(entry.label);
    lines.push(`  MISSING ${entry.label}  -> run \`${entry.fix}\``);
  }

  lines.push("== doctor: generated artifacts (ignored; absence is normal on a fresh clone)");
  const artifacts: readonly { label: string; path: string; producedBy: string }[] = [
    { label: "committed skill", path: join(root, "skills/ensemble/SKILL.md"), producedBy: "committed; verify with make check" },
    { label: "content staging (omp)", path: join(root, "build/ensemble/omp"), producedBy: "make content-build TARGET=omp" },
    { label: "content staging (dsh)", path: join(root, "build/ensemble/dsh"), producedBy: "make content-build TARGET=dsh" },
    { label: "OMP staging root", path: join(root, "build/pack/omp/staging"), producedBy: "make pack-omp" },
    { label: "OMP tarball", path: join(root, "build/pack/omp"), producedBy: "make pack-omp" },
    { label: "DSH tarball", path: join(root, "build/pack/dsh"), producedBy: "make pack-dsh" },
  ];
  for (const artifact of artifacts) {
    const present = existsSync(artifact.path);
    lines.push(
      present
        ? `  ok      ${artifact.label.padEnd(22)} ${relative(root, artifact.path)}`
        : `  absent  ${artifact.label.padEnd(22)} (${artifact.producedBy})`,
    );
  }

  lines.push("== doctor: DSH Host gates");
  lines.push(
    "  host-check and typecheck-host need an existing isolated rc.4 install; pass INSTALL_DIR=<dir>.",
  );
  lines.push("  profile boot and execution-world isolation are not verified by this repository yet.");

  const ok = missingRequired.length === 0;
  lines.push("");
  lines.push(
    ok
      ? `default path: ok (offline check can run)${missingOptional.length > 0 ? `; optional tools missing: ${missingOptional.join(", ")}` : ""}`
      : `default path: BLOCKED by ${missingRequired.join(", ")}`,
  );
  return { lines, ok, missingRequired, missingOptional };
}

/**
 * Confirm the ignored staging for a generated path exists before `check` reads
 * it. A fresh clone has none, which is not drift: the answer says what to run.
 */
export function stagingStatus(
  target: string,
  root: string = REPO_ROOT,
): { ok: boolean; message: string } {
  if (target === "skill") return { ok: true, message: "skill is a committed artifact; no staging needed" };
  if (target !== "omp" && target !== "dsh") {
    return { ok: false, message: `unknown content path: ${target}` };
  }
  const dir = join(root, "build/ensemble", target);
  if (existsSync(dir)) return { ok: true, message: `staging exists: ${relative(root, dir)}` };
  return {
    ok: false,
    message:
      `no generated staging at ${relative(root, dir)} — this path has not been built in this working tree.\n` +
      `  That is not drift. Generate it first: make content-build TARGET=${target}\n` +
      `  (Only the skill path is committed; omp and dsh are generated into the ignored build/ tree.)`,
  };
}

/** List the built tarballs and their contents. Reports nothing when none exist. */
export function inspectArtifacts(
  root: string = REPO_ROOT,
  probe: Probe = defaultProbe,
): { ok: boolean; lines: readonly string[] } {
  const lines: string[] = [];
  const packDir = join(root, "build/pack");
  const tarballs: string[] = [];
  for (const target of ["omp", "dsh"] as const) {
    const dir = join(packDir, target);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".tgz")) tarballs.push(join(dir, entry));
    }
  }

  if (tarballs.length === 0) {
    return {
      ok: false,
      lines: [
        "no package tarballs under build/pack — nothing has been packed in this working tree.",
        "  Build them first: make pack",
      ],
    };
  }

  for (const tarball of tarballs.sort()) {
    const size = statSync(tarball).size;
    lines.push(`${relative(root, tarball)} (${size} bytes)`);
    const listing = probe("tar", ["-tzf", tarball]);
    if (!listing.ok) {
      lines.push("  could not read the archive with tar -tzf; is tar installed?");
      return { ok: false, lines };
    }
    for (const entry of listing.output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
      lines.push(`  ${entry}`);
    }
  }
  return { ok: true, lines };
}

export interface InstallDirReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Check that a directory really is an isolated DSH install for the pinned
 * release. The gates themselves re-check this; failing here just fails earlier
 * and with a better message.
 *
 * `requireTypes` is off for the Loader gate, which needs the published runtime
 * packages but not `tsc`; the type gate needs both.
 */
export function validateInstallDir(path: string, options: { requireTypes?: boolean } = {}): InstallDirReport {
  const problems: string[] = [];
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return { ok: false, problems: [`INSTALL_DIR does not exist: ${resolved}`] };
  }
  if (!statSync(resolved).isDirectory()) {
    return { ok: false, problems: [`INSTALL_DIR is not a directory: ${resolved}`] };
  }
  const modules = join(resolved, "node_modules");
  const manifestPath = join(modules, "@deepseek-ai/dsh-skill/package.json");
  if (!existsSync(manifestPath)) {
    problems.push(
      `no @deepseek-ai/dsh-skill in ${modules}\n` +
        "  This must be a separate install of the published rc.4 packages, not this working tree.\n" +
        "  Any writable directory outside the repository works; create one with:\n" +
        '    dsh_install="${TMPDIR:-/tmp}/dsh-rc4"\n' +
        '    mkdir -p "$dsh_install" && cd "$dsh_install" && npm init -y\n' +
        `    npm install --ignore-scripts @deepseek-ai/dsh@${EXPECTED_DSH} typescript@5.9 @types/node@24`,
    );
  } else {
    const manifest = JSON.parse(readFileText(manifestPath)) as { version?: string };
    if (manifest.version !== EXPECTED_DSH) {
      problems.push(`@deepseek-ai/dsh-skill is ${manifest.version ?? "(unknown)"}, expected ${EXPECTED_DSH}`);
    }
  }
  if (options.requireTypes === true) {
    for (const [label, rel] of [
      ["typescript", "typescript/bin/tsc"],
      ["@types/node", "@types/node/package.json"],
    ] as const) {
      if (!existsSync(join(modules, rel))) problems.push(`no ${label} in ${modules}; install it in the isolated directory`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}

export interface CleanPlan {
  /** Absolute paths that will be removed, in order. */
  readonly remove: readonly string[];
  /** Paths that were considered and refused, with the reason. */
  readonly refused: readonly string[];
}

/**
 * Decide what `clean` may delete. Deletion itself is `applyClean`.
 *
 * Ownership rules: the path must be exactly `<root>/build` (or
 * `<root>/node_modules` with `--all`), must exist, must not be a symlink, and
 * `build/` must hold no Git-tracked files. Anything else is refused, never
 * silently skipped.
 */
export function cleanPlan(
  options: { root?: string; all?: boolean; trackedFiles?: (relativePath: string) => readonly string[] } = {},
): CleanPlan {
  const root = options.root ?? REPO_ROOT;
  const remove: string[] = [];
  const refused: string[] = [];
  const tracked = options.trackedFiles ?? (() => []);

  const consider = (name: string): void => {
    const expected = join(root, name);
    const actual = resolve(root, name);
    if (actual !== expected || !actual.startsWith(`${resolve(root)}${sep}`)) {
      refused.push(`${name}: resolved to ${actual}, outside ${root}`);
      return;
    }
    if (!existsSync(actual)) return;
    const stats = lstatSync(actual);
    if (stats.isSymbolicLink()) {
      refused.push(`${name}: is a symbolic link; remove it yourself after checking where it points`);
      return;
    }
    if (!stats.isDirectory()) {
      refused.push(`${name}: is not a directory`);
      return;
    }
    if (name === GENERATED_DIR) {
      const trackedInside = tracked(name);
      if (trackedInside.length > 0) {
        refused.push(
          `${name}: contains Git-tracked files (${trackedInside.slice(0, 3).join(", ")}` +
            `${trackedInside.length > 3 ? ", ..." : ""}); refusing to delete tracked content`,
        );
        return;
      }
    }
    remove.push(actual);
  };

  consider(GENERATED_DIR);
  if (options.all === true) consider(DEPENDENCY_DIR);
  return { remove, refused };
}

/** Delete exactly what `cleanPlan` allowed. Returns the removed paths. */
export async function applyClean(plan: CleanPlan): Promise<readonly string[]> {
  for (const path of plan.remove) await rm(path, { recursive: true, force: true });
  return plan.remove;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "doctor": {
      const report = doctor();
      for (const line of report.lines) console.log(line);
      process.exit(report.ok ? 0 : 2);
    }
    case "staging": {
      const target = rest[0];
      if (target === undefined) fail("usage: project-tasks.ts staging <omp|dsh>", 2);
      const status = stagingStatus(target);
      if (!status.ok) fail(status.message, 2);
      console.log(status.message);
      break;
    }
    case "inspect": {
      const result = inspectArtifacts();
      for (const line of result.lines) console.log(line);
      process.exit(result.ok ? 0 : 1);
    }
    case "install-dir": {
      const requireTypes = rest.includes("--types");
      const quiet = rest.includes("--quiet");
      const unknown = rest.filter((arg) => arg !== "--types" && arg !== "--quiet");
      if (unknown.length > 1) fail("usage: project-tasks.ts install-dir [--types] [--quiet] <dir>", 2);
      const path = unknown[0];
      if (path === undefined || path === "") fail("usage: project-tasks.ts install-dir [--types] [--quiet] <dir>", 2);
      const report = validateInstallDir(path, { requireTypes });
      if (!report.ok) fail(report.problems.map((problem) => `error: ${problem}`).join("\n"), 2);
      if (!quiet) console.log(`ok      isolated DSH install: ${resolve(path)} (${EXPECTED_DSH})`);
      break;
    }
    case "clean": {
      const all = rest.includes("--all");
      const unknown = rest.filter((arg) => arg !== "--all");
      if (unknown.length > 0) fail(`unknown argument: ${unknown[0]}\nusage: project-tasks.ts clean [--all]`, 2);
      const plan = cleanPlan({ all, trackedFiles: gitTrackedUnder });
      for (const refusal of plan.refused) console.error(`refused: ${refusal}`);
      if (plan.refused.length > 0) process.exit(2);
      if (plan.remove.length === 0) {
        console.log("nothing to remove: no generated directories are present");
        break;
      }
      for (const path of plan.remove) console.log(`removing ${relative(REPO_ROOT, path)}/`);
      const removed = await applyClean(plan);
      console.log(`removed ${removed.length} generated director${removed.length === 1 ? "y" : "ies"}`);
      break;
    }
    default:
      fail(
        "usage: bun scripts/project-tasks.ts <doctor|staging <omp|dsh>|inspect|install-dir [--types] [--quiet] <dir>|clean [--all]>",
        2,
      );
  }
}

/** Git-tracked paths under a repository-relative directory; empty when git is unavailable. */
function gitTrackedUnder(relativePath: string): readonly string[] {
  const result = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "--", relativePath], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return (result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}
