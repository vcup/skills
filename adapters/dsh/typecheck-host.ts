#!/usr/bin/env bun
/**
 * Type-check the runtime-typed modules against a real isolated DSH install.
 *
 * Some maintained modules import `@deepseek-ai/*`. Those packages are not
 * dependencies of this repository — they belong to a DSH installation — so the
 * root `tsconfig.json` cannot compile them and the repository declares no shim,
 * stub or hand-written declaration for them. This runner is how they are checked:
 * it copies the maintained sources beside a *real* install of a tested release,
 * writes the two runtime programs there, and runs that install's own `tsc`.
 *
 * Two programs, because the Host and the Client do not share a shape:
 *
 * - **Host** (`tsconfig.host.json`): Node-shaped. Every module that reaches a
 *   published package through a Host entry, including the tests that import
 *   Host modules. A DOM global is an error here, not a convenience.
 * - **Client** (`tsconfig.client.json`): the browser modules. They need JSX, the
 *   DOM lib, React at the major the official client plugins declare, and the
 *   published slot package at *exactly* the install's release — the slot contract
 *   is versioned with the release, so a different version is refused (exit 2)
 *   rather than compiled into a claim.
 *
 * Nothing is installed and the repository and install are not modified.
 *
 *   bun adapters/dsh/typecheck-host.ts <isolated-install-dir>
 *   bun adapters/dsh/typecheck-host.ts <isolated-install-dir> --client-types <dir>
 *   bun adapters/dsh/typecheck-host.ts <isolated-install-dir> --list-files <file>
 *
 * `<isolated-install-dir>` must contain `node_modules/@deepseek-ai/dsh` (plus its
 * shared packages), `typescript`, `@types/node`. `<dir>` for `--client-types`
 * must contain `node_modules/@deepseek-ai/dsh-client-ui-slots` at the same release
 * and `@types/react`; `make runtime-setup` creates both.
 *
 * `--list-files <file>` appends the repository-relative path of every maintained
 * file the programs compiled, which is what `scripts/check-type-coverage.ts`
 * uses to prove no runtime-typed module is missing from a program. It writes a
 * file instead of stdout so the human-readable result stays the same.
 *
 * Exit codes: 0 both selected programs compiled, 1 a program failed, 2 refused
 * (usage, not an install, unsupported release, missing/mismatched client types).
 *
 * @module adapters/dsh/typecheck-host
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DSH_VERSION,
  DSH_RELEASE_PACKAGES,
  judgeReleases,
  supportedVersionsText,
  type ReleaseReading,
} from "./compatibility.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

/** The two runtime programs, in the order they are reported. */
const PROGRAMS = [
  { name: "host", config: "adapters/dsh/tsconfig.host.json", needsClientTypes: false },
  { name: "client", config: "adapters/dsh/tsconfig.client.json", needsClientTypes: true },
] as const;

/**
 * Include patterns whose resolution differs between the repository and the
 * scratch tree.
 *
 * `tsconfig.host.json` and `tsconfig.client.json` name files relative to
 * `adapters/dsh`, which is where they live; they are copied to the same path in
 * the scratch tree, so the patterns resolve there unchanged. This function exists
 * so an include entry that is *not* representable that way is a refusal instead
 * of a program that silently compiles nothing.
 */
function assertIncludesResolve(config: string): void {
  const parsed = readJson(join(REPO_ROOT, config));
  const include = parsed.include;
  if (!Array.isArray(include) || include.length === 0) {
    fail(`${config} has no include list; a program that compiles nothing would pass`);
  }
  for (const entry of include) {
    if (typeof entry !== "string" || entry.startsWith("/")) {
      fail(`${config} has an absolute or non-string include entry: ${String(entry)}`);
    }
  }
}

function fail(message: string): never {
  console.error(`typecheck-host: ${message}`);
  process.exit(2);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

interface Invocation {
  readonly install: string;
  readonly clientTypes: string | undefined;
  readonly listFiles: string | undefined;
}

/**
 * Parse the command line in one pass.
 *
 * A repeated or unknown option is a refusal: this gate must not silently check
 * one program when the caller asked for another.
 */
export function parseInvocation(argv: readonly string[]): Invocation {
  let install: string | undefined;
  let clientTypes: string | undefined;
  let listFiles: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--client-types") clientTypes = argv[++index];
    else if (token === "--list-files") listFiles = argv[++index];
    else if (token.startsWith("--")) throw new Error(`unknown argument: ${token}`);
    else if (install === undefined) install = token;
    else throw new Error(`unexpected argument: ${token}`);
  }
  if (install === undefined || install === "") {
    throw new Error(
      "usage: bun adapters/dsh/typecheck-host.ts <isolated-install-dir> [--client-types <dir>] [--list-files <file>]",
    );
  }
  return { install: resolve(install), clientTypes: clientTypes === undefined ? undefined : resolve(clientTypes), listFiles };
}

/**
 * Every maintained TypeScript file, repository-relative.
 *
 * The whole maintained tree is copied, not a hand-picked subset: a module that
 * becomes reachable from an entry must be present for the program to compile, and
 * the copy is what lets the compiler report repository paths. Ignored trees never
 * appear because discovery goes through Git.
 */
function maintainedFiles(): string[] {
  const listing = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "*.ts", "*.tsx"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const fromGit =
    listing.status === 0
      ? listing.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : undefined;
  if (fromGit !== undefined) return fromGit.sort();

  // An exported tree or a copied fixture has no Git metadata but must still be
  // checkable, so fall back to a walk with the same exclusions.
  const found: string[] = [];
  const skip = new Set(["node_modules", "build", ".scratch", ".git"]);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, directory), { withFileTypes: true })) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (directory === "" && skip.has(entry.name)) continue;
        walk(path);
      } else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx"))) {
        found.push(path);
      }
    }
  };
  walk("");
  console.error("typecheck-host: git is unavailable or this is not a checkout; enumerating sources directly.");
  return found.sort();
}

/** True when the file is one this runner itself compiles or drives. */
function isRunner(file: string): boolean {
  return file === "adapters/dsh/typecheck-host.ts" || file === "adapters/dsh/tsconfig.host.json";
}

/**
 * Versions of the packages the checked modules actually import.
 *
 * Read through the same module every other gate uses, so "which releases are
 * acceptable" is answered once. A future or malformed release is refused here
 * rather than compiled against and reported as supported.
 */
function readings(modulesDir: string): ReleaseReading[] {
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

/**
 * The exact release of the install, as one string.
 *
 * The Client program is compiled against slot types from that same release, so
 * this value is the pin the client-types directory is held to.
 */
function installedRelease(modulesDir: string): string {
  const manifest = join(modulesDir, "@deepseek-ai/dsh/package.json");
  if (!existsSync(manifest)) fail(`no @deepseek-ai/dsh in ${modulesDir}; this check needs a real install`);
  return String(readJson(manifest).version ?? "");
}

/**
 * Link one install package tree into the scratch module directory.
 *
 * Symlinks, not copies: the checked modules must resolve the published `.d.ts`
 * files of the measured install, and a copy would silently drift from it.
 */
function linkPackages(modulesDir: string, scratchModules: string): void {
  mkdirSync(scratchModules, { recursive: true });
  for (const scope of readdirSync(modulesDir)) {
    if (!scope.startsWith("@")) continue;
    mkdirSync(join(scratchModules, scope), { recursive: true });
    for (const name of readdirSync(join(modulesDir, scope))) {
      symlinkSync(join(modulesDir, scope, name), join(scratchModules, scope, name));
    }
  }
  for (const name of readdirSync(modulesDir)) {
    if (name.startsWith("@")) continue;
    symlinkSync(join(modulesDir, name), join(scratchModules, name));
  }
}

/**
 * Add the Client type environment to a scratch module tree.
 *
 * `@deepseek-ai/dsh-client-ui-slots` is deliberately not a dependency of an
 * install: the official client plugins declare it as a dev dependency and the
 * Host never loads it. It is still the type surface every official Client module
 * imports, so the Client program needs it — at the install's exact release.
 */
function addClientTypes(scratch: string, scratchModules: string, clientTypesDir: string, release: string): void {
  const slotsManifest = join(clientTypesDir, "node_modules/@deepseek-ai/dsh-client-ui-slots/package.json");
  if (!existsSync(slotsManifest)) {
    fail(
      `no @deepseek-ai/dsh-client-ui-slots in ${clientTypesDir}; the Client program needs its published types ` +
        `(make runtime-setup creates one at the tested release)`,
    );
  }
  const slots = String(readJson(slotsManifest).version ?? "");
  if (slots !== release) {
    fail(
      `the Client slot types are ${slots} but the install is ${release}: the slot contract is versioned with the ` +
        `release, so a different version would compile a contract this release does not have`,
    );
  }
  const destination = join(scratchModules, "@deepseek-ai/dsh-client-ui-slots");
  if (!existsSync(destination)) symlinkSync(join(clientTypesDir, "node_modules/@deepseek-ai/dsh-client-ui-slots"), destination);

  // Everything else the Client type project declares — React and its types, the
  // Bun type package its gate scripts use, the browser driver — is linked the same
  // way. Only names the install does not already provide are added, so the
  // measured release keeps its own runtime and type packages.
  const clientModules = join(clientTypesDir, "node_modules");
  for (const scope of readdirSync(clientModules)) {
    if (!scope.startsWith("@")) continue;
    const target = join(clientModules, scope);
    mkdirSync(join(scratchModules, scope), { recursive: true });
    for (const name of readdirSync(target)) {
      if (!existsSync(join(scratchModules, scope, name))) {
        symlinkSync(join(target, name), join(scratchModules, scope, name));
      }
    }
  }
  for (const name of readdirSync(clientModules)) {
    if (name.startsWith("@")) continue;
    if (name === "@deepseek-ai" || !existsSync(join(scratchModules, name))) {
      symlinkSync(join(clientModules, name), join(scratchModules, name));
    }
  }

  // Official Client packages augment `@deepseek-ai/dsh-client-ui-slots` by module
  // name. Those declarations live inside the *install*, where that package is not
  // present, so without help the augmentation resolves to nothing and every slot
  // key collapses to `never` — a compile error that looks like a Client bug.
  // A `paths` map routes every `@deepseek-ai/*` specifier, including the ones
  // inside published `.d.ts` files, to this one module tree, which contains both
  // the install's packages and the exact-release slot package.
  const clientConfig = join(scratch, "adapters/dsh/tsconfig.client.json");
  const config = readJson(clientConfig);
  const options = config.compilerOptions as Record<string, unknown>;
  options.baseUrl = ".";
  options.paths = { "@deepseek-ai/*": ["../../node_modules/@deepseek-ai/*"] };
  options.typeRoots = [join(scratchModules, "@types")];
  writeFileSync(clientConfig, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Compile one program and return the maintained files it read.
 *
 * `--listFilesOnly` is used rather than parsing `tsc` output so the coverage gate
 * learns the program's real closure from the compiler.
 */
function compile(
  tscBin: string,
  scratch: string,
  config: string,
): { code: number; output: string; files: string[] } {
  const listing = spawnSync(process.execPath, [tscBin, "-p", join(scratch, config), "--listFilesOnly"], {
    cwd: scratch,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files: string[] = [];
  for (const line of (listing.stdout ?? "").split("\n")) {
    const path = line.trim();
    if (!path) continue;
    if (path.startsWith(`${scratch}/`)) files.push(path.slice(scratch.length + 1));
  }
  const run = spawnSync(process.execPath, [tscBin, "-p", join(scratch, config)], {
    cwd: scratch,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`
    .split("\n")
    .map((line) => (line.startsWith(`${scratch}/`) ? line.slice(scratch.length + 1) : line))
    .join("\n")
    .trim();
  return { code: run.status ?? 1, output, files };
}

/**
 * Copy the maintained tree into a scratch root beside the install.
 *
 * Repository-relative layout is preserved on purpose: nested modules import the
 * domain through `../../..` paths, and the compiler reports the same paths a
 * maintainer sees in the repository.
 */
function stageSources(scratch: string, files: readonly string[]): void {
  for (const file of files) {
    if (isRunner(file)) continue;
    const destination = join(scratch, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(REPO_ROOT, file), destination);
  }
  writeFileSync(join(scratch, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);
  for (const program of PROGRAMS) {
    cpSync(join(REPO_ROOT, program.config), join(scratch, program.config));
  }
}

function main(): void {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2));
  } catch (error) {
    fail((error as Error).message);
  }
  const { install, clientTypes, listFiles } = invocation;

  if (!existsSync(install)) fail(`install directory does not exist: ${install}`);
  const modulesDir = join(install, "node_modules");
  if (!existsSync(join(modulesDir, "@deepseek-ai/dsh-skill/package.json"))) {
    fail(`no @deepseek-ai/dsh-skill in ${modulesDir}; this check needs a real install, not a repository checkout`);
  }

  const verdict = judgeReleases(readings(modulesDir), { require: DSH_RELEASE_PACKAGES });
  if (!verdict.ok) {
    fail(
      `${install} is not an install this gate can measure (tested set: ${supportedVersionsText()}):\n` +
        verdict.problems.map((problem) => `  ${problem}`).join("\n") +
        `\n  Create one with the default release, ${DEFAULT_DSH_VERSION}.`,
    );
  }
  const release = installedRelease(modulesDir);

  const tscBin = join(modulesDir, "typescript/bin/tsc");
  if (!existsSync(tscBin)) fail(`no typescript in ${modulesDir}; install it in the isolated directory`);
  if (!existsSync(join(modulesDir, "@types/node/package.json"))) {
    fail(`no @types/node in ${modulesDir}; install it in the isolated directory`);
  }

  if (clientTypes !== undefined && !existsSync(clientTypes)) fail(`client types directory does not exist: ${clientTypes}`);

  const checked = clientTypes === undefined ? [PROGRAMS[0]] : PROGRAMS;
  if (clientTypes === undefined) {
    console.log(
      "typecheck-host: the Client program was not selected; pass --client-types <dir> to compile it.",
    );
  }
  for (const program of checked) assertIncludesResolve(program.config);

  const scratch = mkdtempSync(join(tmpdir(), "typecheck-host-"));
  try {
    stageSources(scratch, maintainedFiles());
    const scratchModules = join(scratch, "node_modules");
    linkPackages(modulesDir, scratchModules);
    // Bun's test globals are needed by the Host tests in the program; the
    // repository's @types/bun is a type-only addition and cannot shadow the
    // install's runtime packages.
    const repoTyTypes = join(REPO_ROOT, "node_modules/@types");
    const hostConfig = join(scratch, "adapters/dsh/tsconfig.host.json");
    if (existsSync(join(repoTyTypes, "bun"))) {
      symlinkSync(join(repoTyTypes, "bun"), join(scratchModules, "@types/bun"));
      const config = readJson(hostConfig);
      const options = config.compilerOptions as Record<string, unknown>;
      options.typeRoots = [join(scratchModules, "@types"), join(REPO_ROOT, "node_modules/@types")];
      writeFileSync(hostConfig, `${JSON.stringify(config, null, 2)}\n`);
    }
    if (clientTypes !== undefined) addClientTypes(scratch, scratchModules, clientTypes, release);

    let failed = false;
    const compiled = new Set<string>();
    for (const program of checked) {
      const result = compile(tscBin, scratch, program.config);
      for (const file of result.files) {
        if (!file.startsWith("node_modules/")) compiled.add(file);
      }
      if (result.code !== 0) {
        failed = true;
        console.error(`typecheck-host: ${program.name} program FAILED (tsc exit ${result.code}):`);
        console.error(result.output);
      } else {
        console.log(`typecheck-host: OK ${program.name} program against @deepseek-ai/* ${release} (${install})`);
      }
    }
    if (listFiles !== undefined) {
      writeFileSync(listFiles, `${[...compiled].sort().join("\n")}\n`);
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
