#!/usr/bin/env bun
/**
 * Type coverage is a gate, not a claim.
 *
 * A `tsc` program can be green while half the repository is in no program at
 * all: an entry list that forgets a directory, a new `*.test.ts` nobody added, a
 * `verify-*.ts` driver that is only ever executed by `make`. This gate closes
 * that hole by asking the compiler itself which files it read and comparing that
 * union with every maintained TypeScript file in the tree.
 *
 * The repository has two kinds of modules, and the gate keeps them apart instead
 * of pretending one program checks both:
 *
 * - **plain** — reaches no published DSH package. Compiled by `tsconfig.json` and
 *   `adapters/dsh/tsconfig.json` against the repository's own dependencies.
 * - **runtime-typed** — transitively imports `@deepseek-ai/*`. Its types only
 *   exist inside a real isolated DSH install, so it is compiled by
 *   `adapters/dsh/typecheck-host.ts` against that install (Host programs) and
 *   against exact-version Client types (Client TSX). No stub, no `any` facade.
 *
 * Modes:
 *
 * - default (offline): every *plain* maintained file must be in a plain program.
 *   A plain file in no program fails the gate. Runtime-typed files are counted
 *   and named as out of scope, so the report states what was not compiled rather
 *   than implying everything was.
 * - `--strict --host-install DIR --client-types DIR`: the runtime-typed programs
 *   are compiled too, and then *every* maintained file must be in one of the
 *   four programs. This is the release claim; it refuses (exit 2) without both
 *   directories instead of reporting a partial pass.
 *
 * There is deliberately no "known unchecked" allowlist: the fix for a missing
 * file is to put it in a program, not to name it here. `skipLibCheck` applies to
 * published `.d.ts` files; it never turns off checking of this repository.
 *
 * Compiler answers come from `tsc --listFilesOnly`, so they describe the program
 * `make typecheck` really runs, not a second reimplementation of include globs.
 *
 *   bun scripts/check-type-coverage.ts
 *   bun scripts/check-type-coverage.ts --strict --host-install DIR --client-types DIR
 *
 * Exit codes: 0 covered, 1 a maintained file is in no program (or a program
 * failed), 2 refused/misconfigured (nothing was concluded).
 *
 * @module scripts/check-type-coverage
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Programs that compile the dependency-free closure. Each must exist. */
const PLAIN_PROGRAMS = ["tsconfig.json", "adapters/dsh/tsconfig.json"] as const;

/** The runner that compiles the runtime-typed closure against a real install. */
const RUNTIME_RUNNER = "adapters/dsh/typecheck-host.ts";

/**
 * Every TypeScript source extension this repository uses.
 *
 * `.mts`/`.cts` are TypeScript modules, and `.d.mts`/`.d.cts` are the declarations
 * that make a shipped plain-ESM module checkable instead of implicitly `any`.
 * Leaving them out of discovery is how `environment/native-check.mts` — a file
 * `make environment-check` actually executes — ended up in no program at all.
 */
const SOURCE = /\.(?:ts|tsx|mts|cts)$/;

/** Directories that are never maintained source, whatever Git says. */
const NOT_SOURCE = new Set(["node_modules", "build", ".scratch", ".git"]);

/**
 * True for a path this repository maintains as source (not a build artifact).
 *
 * `.d.ts` is excluded because published packages ship their own declarations; the
 * `.d.mts`/`.d.cts` forms are kept because here they are hand-written companions to
 * shipped `.mjs` modules, not vendor output.
 */
export function maintained(path: string): boolean {
  if (!SOURCE.test(path) || path.endsWith(".d.ts")) return false;
  return !NOT_SOURCE.has(path.split("/")[0]!);
}

interface Options {
  readonly strict: boolean;
  readonly hostInstall: string | undefined;
  readonly clientTypes: string | undefined;
}

/** Parse argv; every unknown or repeated flag is a refusal, never a default. */
export function parseOptions(argv: readonly string[]): Options {
  let strict = false;
  let hostInstall: string | undefined;
  let clientTypes: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--strict") strict = true;
    else if (token === "--host-install") hostInstall = argv[++index];
    else if (token === "--client-types") clientTypes = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  if (strict && (hostInstall === undefined || clientTypes === undefined)) {
    throw new Error("--strict needs both --host-install DIR and --client-types DIR (that mode compiles the runtime-typed programs)");
  }
  if (!strict && (hostInstall !== undefined || clientTypes !== undefined)) {
    throw new Error("--host-install/--client-types only apply to --strict");
  }
  return { strict, hostInstall, clientTypes };
}

/**
 * Every maintained TypeScript file, tracked or new.
 *
 * `git ls-files -co --exclude-standard` is preferred because it applies the
 * repository's ignore rules exactly. It is not the only answer, though: an
 * exported tree (`git archive`), a copied fixture, or a CI job that deliberately
 * does not check out Git history has no `.git` and must still be checkable — so a
 * plain walk with the same exclusions is used there. Both produce the same list
 * for a normal checkout.
 *
 * @returns repository-relative paths, sorted.
 */
export function maintainedFiles(root: string = REPO_ROOT): string[] {
  const listing = spawnSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "*.ts", "*.tsx", "*.mts", "*.cts"],
    {
    cwd: root,
    encoding: "utf8",
  });
  const fromGit =
    listing.status === 0
      ? listing.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : undefined;
  // An *empty* answer from git is not an answer. Outside a work tree — which is how the
  // Makefile tests build their fixture, by copying the tree without `.git` — `git ls-files`
  // exits non-zero with no output, and treating that as "the repository has no source files"
  // made the gate refuse the whole offline chain (`no maintained TypeScript files found`).
  // Falling through to the walk is what keeps discovery honest: the file list comes from the
  // filesystem, which is the same authority `tsc --listFilesOnly` is checked against.
  if (fromGit !== undefined && fromGit.length > 0) return fromGit.filter(maintained).sort();

  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (NOT_SOURCE.has(entry.name) && directory === "") continue;
        walk(path);
      } else if (entry.isFile() && SOURCE.test(path) && maintained(path)) {
        found.push(path);
      }
    }
  };
  walk("");
  console.error(
    "type-coverage: git is unavailable or this is not a checkout; enumerating files directly (ignored trees skipped).",
  );
  return found.sort();
}

/**
 * Classify which maintained files need a real DSH install to compile.
 *
 * Two rules, both honest about *why* the file needs that environment:
 *
 * 1. It reaches a published `@deepseek-ai/*` package, directly or through a
 *    relative import. Those packages belong to an installation; the repository
 *    declares no stub for them.
 * 2. It lives under `adapters/dsh/client/`. Every Client module is compiled in
 *    the Client program, which uses the official React major and the published
 *    slot package at the install's exact release — never the repository's own
 *    React. A Client module that imports no published package still cannot be
 *    checked correctly against the wrong React version, so it is in this scope.
 *
 * The TypeScript parser decides, so a string literal, a doc comment, or a
 * commented-out import cannot fake a classification.
 *
 * @param files - maintained files, repository-relative.
 * @returns the set of files that only the runtime programs can check.
 */
export function runtimeTyped(files: readonly string[]): Set<string> {
  const known = new Set(files);
  const specifiers = new Map<string, string[]>();
  const read = (file: string): string[] => {
    const cached = specifiers.get(file);
    if (cached !== undefined) return cached;
    const absolute = join(REPO_ROOT, file);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteral(first)) found.push(first.text);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        found.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    specifiers.set(file, found);
    return found;
  };
  const relativeTargets = (file: string): string[] => {
    const targets: string[] = [];
    for (const spec of read(file)) {
      if (!spec.startsWith(".")) continue;
      const base = relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, file)), spec)).split(sep).join("/");
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (known.has(candidate)) {
          targets.push(candidate);
          break;
        }
      }
    }
    return targets;
  };
  const memo = new Map<string, boolean>();
  const needs = (file: string, seen: Set<string>): boolean => {
    const cached = memo.get(file);
    if (cached !== undefined) return cached;
    if (seen.has(file)) return false;
    seen.add(file);
    let value = read(file).some((spec) => spec.startsWith("@deepseek-ai/"));
    if (!value) {
      for (const target of relativeTargets(file)) {
        if (needs(target, seen)) {
          value = true;
          break;
        }
      }
    }
    memo.set(file, value);
    return value;
  };
  const isClient = (file: string): boolean => file.startsWith("adapters/dsh/client/");
  const needsRuntime = (file: string): boolean => isClient(file) || needs(file, new Set());
  return new Set(files.filter(needsRuntime));
}

/** Run one `tsc` program and return the repository-relative files it read. */
function programFiles(config: string, tscBin: string): Set<string> {
  const run = spawnSync(process.execPath, [tscBin, "-p", join(REPO_ROOT, config), "--listFilesOnly"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(`type-coverage: ${config} did not compile (tsc exit ${run.status ?? "null"}):`);
    console.error(`${run.stdout}${run.stderr}`.trim());
    process.exit(1);
  }
  const files = new Set<string>();
  for (const line of run.stdout.split("\n")) {
    const path = line.trim();
    if (!path.startsWith(`${REPO_ROOT}${sep}`)) continue;
    const rel = relative(REPO_ROOT, path).split(sep).join("/");
    if (maintained(rel)) files.add(rel);
  }
  return files;
}

/**
 * Ask the runtime runner which files its programs compiled.
 *
 * The runner copies sources beside the install, so it reports repository-relative
 * names on purpose (`--list-files`). Asking it is the only way to learn those
 * programs' closures without duplicating its copy rules here.
 *
 * @param args - runner arguments (install first), already validated.
 * @returns repository-relative files the runner compiled.
 */
function runtimeFiles(args: readonly string[]): Set<string> {
  const listing = mkdtempSync(join(tmpdir(), "type-coverage-"));
  const out = join(listing, "files.txt");
  try {
    const run = spawnSync(process.execPath, [join(REPO_ROOT, RUNTIME_RUNNER), ...args, "--list-files", out], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "inherit",
    });
    if (run.status !== 0) {
      console.error(`type-coverage: the runtime program failed (exit ${run.status ?? "null"}); see the output above.`);
      process.exit(1);
    }
    if (!existsSync(out)) {
      console.error("type-coverage: the runtime runner compiled no program (it wrote no file list).");
      process.exit(1);
    }
    return new Set(
      readFileSync(out, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } finally {
    rmSync(listing, { recursive: true, force: true });
  }
}

function main(): void {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`type-coverage: ${(error as Error).message}`);
    process.exit(2);
  }

  const tscBin = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
  if (!existsSync(tscBin)) {
    console.error("type-coverage: no typescript in this checkout; run `make setup` first.");
    process.exit(2);
  }

  const files = maintainedFiles();
  if (files.length === 0) {
    console.error("type-coverage: no maintained TypeScript files found; the discovery rule is wrong.");
    process.exit(2);
  }
  const runtime = runtimeTyped(files);

  const covered = new Set<string>();
  for (const config of PLAIN_PROGRAMS) {
    if (!existsSync(join(REPO_ROOT, config))) {
      console.error(`type-coverage: ${config} does not exist; every plain program must be named here on purpose.`);
      process.exit(2);
    }
    for (const file of programFiles(config, tscBin)) covered.add(file);
  }

  if (options.strict) {
    if (!existsSync(join(REPO_ROOT, RUNTIME_RUNNER))) {
      console.error(`type-coverage: ${RUNTIME_RUNNER} does not exist.`);
      process.exit(2);
    }
    for (const directory of [options.hostInstall!, options.clientTypes!]) {
      if (!existsSync(resolve(directory))) {
        console.error(`type-coverage: not a directory: ${directory}`);
        process.exit(2);
      }
    }
    for (const file of runtimeFiles([
      resolve(options.hostInstall!),
      "--client-types",
      resolve(options.clientTypes!),
    ])) {
      covered.add(file);
    }
  }

  const missing = files.filter((file) => !covered.has(file));
  const missingPlain = missing.filter((file) => !runtime.has(file));
  const missingRuntime = missing.filter((file) => runtime.has(file));

  if (options.strict) {
    if (missing.length > 0) {
      console.error(`type-coverage: ${missing.length} maintained file(s) are in no tsc program [strict]:`);
      for (const file of missing) console.error(`  ${runtime.has(file) ? "runtime-typed" : "plain"}  ${file}`);
      process.exit(1);
    }
    console.log(`type-coverage: OK ${files.length} maintained files [strict: plain + runtime-typed]`);
    console.log(`  plain ${files.length - runtime.size}, runtime-typed ${runtime.size}; every file is in a compiled program.`);
    return;
  }

  if (missingPlain.length > 0) {
    console.error(`type-coverage: ${missingPlain.length} maintained file(s) reach no DSH package and are in no plain program:`);
    for (const file of missingPlain) console.error(`  ${file}`);
    console.error("  These are a real gap in tsconfig.json / adapters/dsh/tsconfig.json: add them, do not allow-list them.");
    process.exit(1);
  }

  console.log(`type-coverage: OK ${files.length - runtime.size} plain maintained files are compiled [offline]`);
  console.log(
    `  out of scope here: ${runtime.size} runtime-typed file(s) need a real DSH install and exact Client types;` +
      `\n  the strict door runs them with --strict --host-install DIR --client-types DIR.`,
  );
}

if (import.meta.main) main();
