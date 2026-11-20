#!/usr/bin/env bun
/**
 * Type-check the Host entry modules against a real isolated DSH install.
 *
 * `index.ts` and `loader-check.ts` import `@deepseek-ai/*`. The repository's
 * root `tsconfig.json` deliberately excludes them and declares no DSH
 * dependency, so their types can only be checked where those packages are
 * actually installed. This script turns that check into a repeatable command:
 * it copies the modules into a scratch directory beside the install, writes a
 * NodeNext config there, and runs that install's own `tsc`.
 *
 * No shim, stub, or hand-written declaration is used: resolution goes to the
 * published `.d.ts` files of the install. Nothing is installed, and the
 * repository and the install are not modified.
 *
 *   bun adapters/dsh/typecheck-host.ts <isolated-install-dir>
 *
 * `<isolated-install-dir>` is a directory that already contains
 * `node_modules/@deepseek-ai/dsh` (plus `dsh-skill`, `dsh-tools`,
 * `dsh-app-boot`), `typescript`, and `@types/node`. The accepted releases come
 * from `./compatibility.ts`; create the install once with the default one:
 *
 *   dsh_install="${TMPDIR:-/tmp}/dsh-probe"
 *   mkdir -p "$dsh_install" && cd "$dsh_install" && npm init -y
 *   npm install --ignore-scripts @deepseek-ai/dsh@<default> typescript@5.9 @types/node@24
 *
 * This is a separate gate from `make typecheck`; it is not part of that
 * target and never runs in CI without such an install.
 *
 * @module adapters/dsh/typecheck-host
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DSH_VERSION,
  DSH_RELEASE_PACKAGES,
  judgeReleases,
  supportedVersionsText,
  type ReleaseReading,
} from "./compatibility.ts";

/** Modules checked here; the dependency-free siblings are pulled in transitively. */
const HOST_MODULES = ["index.ts", "loader-check.ts"] as const;

/**
 * Every module copied, so relative imports resolve inside the scratch root.
 *
 * This is a hand-maintained closure: a new module reached from `index.ts`,
 * `loader-check.ts` or one of their imports must be added here, or `tsc` would
 * resolve it from this repository and the gate would prove nothing about the
 * install. `compatibility.ts` is in the closure because `meta.ts` re-exports
 * from it.
 */
const COPIED_MODULES = [
  "compatibility.ts",
  "index.ts",
  "loader-check.ts",
  "meta.ts",
  "reference.ts",
  "skill.ts",
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(message: string): never {
  console.error(`typecheck-host: ${message}`);
  process.exit(2);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const installArg = process.argv[2];
if (installArg === undefined) {
  fail("usage: bun adapters/dsh/typecheck-host.ts <isolated-install-dir>");
}
const installDir = resolve(installArg);

if (!existsSync(installDir)) fail(`install directory does not exist: ${installDir}`);

const modulesDir = join(installDir, "node_modules");
if (!existsSync(join(modulesDir, "@deepseek-ai/dsh-skill/package.json"))) {
  fail(
    `no @deepseek-ai/dsh-skill in ${modulesDir}; this check needs a real install, not a repository checkout`,
  );
}

/**
 * Versions of the packages the checked modules actually import.
 *
 * Read through the same module every other gate uses, so "which releases are
 * acceptable" is answered once. A future or malformed release is refused here
 * rather than compiled against and silently reported as supported.
 */
function readings(): ReleaseReading[] {
  return DSH_RELEASE_PACKAGES.map((name) => {
    const manifest = join(modulesDir, name, "package.json");
    if (!existsSync(manifest)) return { package: name, version: undefined };
    try {
      return { package: name, version: String(readJson(manifest).version ?? "") || undefined };
    } catch {
      return { package: name, version: undefined };
    }
  });
}

const verdict = judgeReleases(readings(), { require: DSH_RELEASE_PACKAGES });
if (!verdict.ok) {
  fail(
    `${installDir} is not an install this gate can measure (tested set: ${supportedVersionsText()}):\n` +
      verdict.problems.map((problem) => `  ${problem}`).join("\n") +
      `\n  Create one with the default release, ${DEFAULT_DSH_VERSION}.`,
  );
}
const installed = readings().find((reading) => reading.package === "@deepseek-ai/dsh")?.version ?? "";

const tscBin = join(modulesDir, "typescript/bin/tsc");
if (!existsSync(tscBin)) fail(`no typescript in ${modulesDir}; install it in the isolated directory`);
if (!existsSync(join(modulesDir, "@types/node/package.json"))) {
  fail(`no @types/node in ${modulesDir}; install it in the isolated directory`);
}

// The scratch root lives beside the install so Node resolves bare specifiers
// from the install's node_modules, exactly as an installed plugin would.
const scratch = mkdtempSync(join(installDir, "typecheck-host-"));
try {
  for (const name of COPIED_MODULES) {
    cpSync(join(HERE, name), join(scratch, name));
  }
  writeFileSync(join(scratch, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  // `tsconfig.host.json` is the single source of truth for the compiler
  // options; only `include` is rewritten to the checked entry modules.
  const hostConfig = readJson(join(HERE, "tsconfig.host.json"));
  writeFileSync(
    join(scratch, "tsconfig.json"),
    `${JSON.stringify({ ...hostConfig, include: [...HOST_MODULES] }, null, 2)}\n`,
  );

  // Run the install's own `tsc` with the current runtime (bun), so the check
  // does not require a separate `node` on PATH.
  const run = spawnSync(process.execPath, [tscBin, "-p", join(scratch, "tsconfig.json")], {
    cwd: scratch,
    stdio: "inherit",
  });
  if (run.error !== undefined) fail(`could not run tsc: ${run.error.message}`);
  const code = run.status ?? 1;
  console.log(
    code === 0
      ? `typecheck-host: OK ${HOST_MODULES.join(", ")} against @deepseek-ai/* ${installed} (${installDir})`
      : `typecheck-host: FAILED (tsc exit ${code})`,
  );
  process.exitCode = code;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
