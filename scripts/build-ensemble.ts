#!/usr/bin/env bun
/**
 * Deterministic content assembly for the three ensemble consumption paths.
 *
 * One maintained method source (`content/ensemble/common/`) plus one directory of
 * path-specific sections per target are combined into three closed artifacts.
 * Every target has an explicit, ordered file list below; nothing is discovered
 * implicitly and no template language is involved.
 *
 *   build(target)  assemble in memory and validate everything; writes nothing
 *   write(target)  validate, then create/replace only the allowlisted files
 *   check(target)  compare the artifact with what is on disk; report drift
 *
 * CLI: bun scripts/build-ensemble.ts build|check <skill|omp|dsh>
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export type Target = "skill" | "omp" | "dsh";

/** The complete set of build targets. Order is stable and part of the contract. */
export const TARGETS: readonly Target[] = ["skill", "omp", "dsh"];

export interface BuildFile {
  /** Path relative to `outDir`, POSIX separators. */
  readonly path: string;
  /** Byte length of `content`. */
  readonly bytes: number;
  readonly sha256: string;
  /** The assembled bytes, so packers never have to read the default staging path. */
  readonly content: Uint8Array;
}

export interface BuildResult {
  readonly target: Target;
  /** Absolute output directory. */
  readonly outDir: string;
  /** Artifact files, sorted by `path` with a plain codepoint comparison. */
  readonly files: readonly BuildFile[];
  /** Serialized `{target, files}` manifest; stable across runs and JSON-safe. */
  readonly manifest: string;
}

export interface BuildOptions {
  /** Repository root to read sources from and resolve default output paths against. */
  root?: string;
  /**
   * Output directory; absolute, or relative to `root`. It must stay inside `root`.
   *
   * Packers that need an independent staging root (a package tarball root, a
   * `/tmp` directory) must not point this outside the repository: consume
   * `build(target).files[].content` instead and write those bytes themselves.
   */
  outDir?: string;
}

interface OutputSpec {
  readonly path: string;
  /** Source files, repo-relative, concatenated in this order. */
  readonly parts: readonly string[];
}

interface TargetSpec {
  readonly outDir: string;
  readonly outputs: readonly OutputSpec[];
}

const COMMON = "content/ensemble/common";

function spec(target: Target): TargetSpec {
  const own = `content/ensemble/${target}`;
  return {
    outDir:
      target === "skill" ? "skills/ensemble" : `build/ensemble/${target}/skills/ensemble`,
    outputs: [
      {
        path: "SKILL.md",
        parts: [`${own}/entry.frontmatter.md`, `${COMMON}/intro.md`, `${own}/entry.operations.md`, `${COMMON}/method.md`],
      },
      { path: "README.md", parts: [`${COMMON}/README.md`, `${own}/README.records.md`] },
      { path: "PATTERNS.md", parts: [`${COMMON}/PATTERNS.md`] },
      { path: "GLOSSARY.md", parts: [`${COMMON}/GLOSSARY.md`] },
      { path: "STATE-TEMPLATE.md", parts: [`${own}/STATE-TEMPLATE.records.md`, `${COMMON}/state-fields.md`] },
      { path: "EVOLUTION-TEMPLATE.md", parts: [`${COMMON}/EVOLUTION-TEMPLATE.md`] },
    ],
  };
}

/**
 * Tokens that identify a specific path. The shared method must name none of them,
 * and an artifact must name none of the *other* paths' tokens. A path's own entry
 * below is therefore allowed in its own artifact only.
 */
const PATH_TOKENS: Record<Target, readonly RegExp[]> = {
  // The pure skill keeps its Git installation source (DISTRIBUTION.md §3); that
  // command is this path's own, so it is banned for the other two targets only.
  skill: [/`npx skills/, /vcup\/skills/],
  omp: [/\bOMP\b/, /Oh My Pi/, /omp install/, /`ensemble_state`/, /\.ensemble\//],
  dsh: [/\bDSH\b/, /DeepSeek/, /ensemble_reference/],
};

/**
 * Banned in every artifact, including the pure skill's own.
 *
 * A link into the maintainer repository's multi-path design documents would pull
 * the other paths back into an installed artifact's reading closure
 * (DISTRIBUTION.md §4), so it is never allowed — unlike the install command,
 * which only names the repository as an installation source.
 */
const FORBIDDEN_IN_ANY_TARGET: readonly RegExp[] = [/github\.com\/vcup/];

/**
 * Path-selection phrasing that must never appear in shared content.
 *
 * A keyword ban on platform names is not enough: a sentence can select between
 * path behaviours with no platform word at all ("where this path supplies X ...
 * otherwise Y"). `DISTRIBUTION.md` requires those whole sections to live with
 * the path, so the shared method must name one action and defer to
 * `#records-on-this-path` for who performs it.
 */
const BRANCH_TOKENS: readonly RegExp[] = [
  /Where (?:this path|the path) (?:supplies|provides|offers|has)/i,
  /Where it does not/i,
  /plugin-managed/i,
  /managed plugin/i,
  /skill-only/i,
  /pure[- ]skill/i,
  /(?:with|without) managed (?:archive|plugin|publication|reflection|storage|support|tools?)/i,
  /managed (?:mode|tools?) (?:own|maintain|uses?|provides?|manage)/i,
  /isolated records (?:area|repository)/i,
  /ordinary authorized file tools/i,
  /otherwise,? (?:maintain|save|keep|use|fall back)/i,
  /if (?:a |the )?(?:managed|domain) tools? (?:is |are )?(?:available|unavailable)/i,
];

export class BuildError extends Error {
  override readonly name = "BuildError";
}

function fail(message: string): never {
  throw new BuildError(message);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Reject anything that is not a clean repo-relative POSIX path. */
function assertRelativePath(value: string, what: string): void {
  if (value.length === 0) fail(`${what}: empty path`);
  if (isAbsolute(value)) fail(`${what}: absolute path is not allowed: ${value}`);
  if (value.includes("\\")) fail(`${what}: backslash in path: ${value}`);
  const normalized = posix.normalize(value);
  if (normalized !== value) fail(`${what}: path is not normalized: ${value}`);
  if (normalized === ".." || normalized.startsWith("../")) {
    fail(`${what}: path escapes its root: ${value}`);
  }
}

/** Walk from `root` to `target` and refuse any symbolic link on the way. */
async function assertNoSymlink(root: string, target: string, what: string): Promise<void> {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) fail(`${what}: escapes root: ${target}`);
  const segments = rel === "" ? [] : rel.split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      return; // missing components are reported by the caller
    }
    if (stats.isSymbolicLink()) fail(`${what}: symbolic link is not allowed: ${current}`);
  }
}

async function readSource(root: string, relPath: string): Promise<Uint8Array> {
  assertRelativePath(relPath, "source");
  const absolute = resolve(root, relPath);
  if (!absolute.startsWith(`${root}${sep}`)) fail(`source escapes root: ${relPath}`);
  await assertNoSymlink(root, absolute, "source");
  try {
    const stats = await lstat(absolute);
    if (!stats.isFile()) fail(`source is not a regular file: ${relPath}`);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    fail(`missing source file: ${relPath}`);
  }
  return await readFile(absolute);
}

/** Every regular file under `dir`, repo-relative and POSIX-separated. */
async function listFiles(root: string, dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    const absolute = resolve(root, relDir);
    await assertNoSymlink(root, absolute, "source tree");
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      fail(`missing source directory: ${relDir}`);
    }
    for (const entry of entries) {
      const relChild = `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`source tree contains a symbolic link: ${relChild}`);
      if (entry.isDirectory()) await walk(relChild);
      else if (entry.isFile()) found.push(relChild);
      else fail(`source tree contains an unsupported entry: ${relChild}`);
    }
  };
  await walk(dir);
  return found.sort();
}

function joinParts(parts: readonly Uint8Array[], relPath: string): Uint8Array {
  const pieces = parts.map((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\s+$/, ""));
  const text = `${pieces.join("\n\n")}\n`;
  if (text.includes("\r")) fail(`${relPath}: carriage returns are not allowed in generated content`);
  return new TextEncoder().encode(text);
}

function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_[\]()]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headings(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) slugs.add(headingSlug(heading[1]));
  }
  return slugs;
}

interface LinkTarget {
  readonly path: string;
  readonly fragment: string;
}

function links(markdown: string): LinkTarget[] {
  const found: LinkTarget[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const candidates = [...line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
    const reference = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (reference) candidates.push(reference[1]);
    for (const raw of candidates) {
      const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external scheme
      const hash = target.indexOf("#");
      const path = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? "" : target.slice(hash + 1);
      found.push({ path, fragment });
    }
  }
  return found;
}

function checkTokens(target: Target, relPath: string, text: string, extra: readonly RegExp[]): void {
  for (const pattern of [...extra, ...FORBIDDEN_IN_ANY_TARGET]) {
    const match = pattern.exec(text);
    if (match) {
      fail(`${relPath}: contains a path-specific or cross-path marker (${pattern}): ${match[0]}`);
    }
  }
}

async function assemble(target: Target, options: BuildOptions = {}): Promise<{
  outDir: string;
  files: BuildFile[];
  contents: Map<string, Uint8Array>;
}> {
  if (!TARGETS.includes(target)) fail(`unknown target: ${String(target)}; expected one of ${TARGETS.join(", ")}`);
  const root = resolve(options.root ?? join(import.meta.dir, ".."));
  const targetSpec = spec(target);
  const outDir = options.outDir
    ? resolve(root, options.outDir)
    : resolve(root, targetSpec.outDir);

  if (!outDir.startsWith(`${root}${sep}`) && outDir !== root) {
    fail(
      `output directory escapes the repository root: ${outDir}\n` +
        "This builder only writes inside the repository. Packers that need their own staging root " +
        "(including /tmp) must consume build(target).files[].content and write those bytes " +
        "themselves, or place the staging root inside the repository.",
    );
  }

  // Allowlist, both directions: every declared source exists, and no source file
  // in the shared or this target's directory is left unused.
  const declared = new Set<string>();
  for (const output of targetSpec.outputs) {
    assertRelativePath(output.path, "output");
    for (const part of output.parts) {
      assertRelativePath(part, "source");
      const allowed = part.startsWith(`${COMMON}/`) || part.startsWith(`content/ensemble/${target}/`);
      if (!allowed) fail(`${output.path}: source belongs to another target: ${part}`);
      declared.add(part);
    }
  }

  const present = [
    ...(await listFiles(root, COMMON)),
    ...(await listFiles(root, `content/ensemble/${target}`)),
  ];
  for (const part of declared) {
    if (!present.includes(part)) fail(`declared source is missing: ${part}`);
  }
  for (const file of present) {
    if (!declared.has(file)) {
      fail(`source file is not used by the ${target} allowlist: ${file}`);
    }
  }

  // Shared content must be path-neutral; each artifact must not name another path.
  const otherTokens: RegExp[] = [];
  for (const other of TARGETS) {
    if (other !== target) otherTokens.push(...PATH_TOKENS[other]);
  }

  const contents = new Map<string, Uint8Array>();
  const files: BuildFile[] = [];
  for (const output of targetSpec.outputs) {
    const parts = await Promise.all(output.parts.map((part) => readSource(root, part)));
    const bytes = joinParts(parts, output.path);
    const text = new TextDecoder("utf-8").decode(bytes);
    checkTokens(target, output.path, text, otherTokens);
    for (const part of output.parts) {
      if (!part.startsWith(`${COMMON}/`)) continue;
      const sourceText = new TextDecoder("utf-8").decode(await readSource(root, part));
      checkTokens(target, part, sourceText, [...PATH_TOKENS.skill, ...PATH_TOKENS.omp, ...PATH_TOKENS.dsh, ...BRANCH_TOKENS]);
    }
    contents.set(output.path, bytes);
    files.push({ path: output.path, bytes: bytes.byteLength, sha256: sha256(bytes), content: bytes });
  }

  // Reference closure: every relative link resolves inside this artifact, and
  // every heading fragment exists in its target file.
  const slugCache = new Map<string, Set<string>>();
  const slugsOf = (relPath: string): Set<string> => {
    let cached = slugCache.get(relPath);
    if (!cached) {
      const bytes = contents.get(relPath);
      if (!bytes) fail(`link points at a file outside the artifact: ${relPath}`);
      cached = headings(new TextDecoder("utf-8").decode(bytes));
      slugCache.set(relPath, cached);
    }
    return cached;
  };

  for (const [relPath, bytes] of contents) {
    const text = new TextDecoder("utf-8").decode(bytes);
    for (const link of links(text)) {
      if (link.path === "" && link.fragment === "") continue;
      const resolvedPath =
        link.path === "" ? relPath : posix.normalize(posix.join(posix.dirname(relPath), link.path));
      if (resolvedPath.startsWith("..") || posix.isAbsolute(resolvedPath)) {
        fail(`${relPath}: link escapes the artifact: ${link.path}${link.fragment ? `#${link.fragment}` : ""}`);
      }
      if (!contents.has(resolvedPath)) {
        fail(`${relPath}: link target is not part of this artifact: ${link.path}`);
      }
      if (link.fragment && !slugsOf(resolvedPath).has(link.fragment)) {
        fail(`${relPath}: link fragment does not match a heading in ${resolvedPath}: #${link.fragment}`);
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { outDir, files, contents };
}

function serializeManifest(target: Target, files: readonly BuildFile[]): string {
  // Deliberately excludes `content`: the manifest stays small, JSON-safe, and
  // stable, while packers read bytes from `BuildFile.content`.
  const entries = files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }));
  return `${JSON.stringify({ target, files: entries }, null, 2)}\n`;
}

/**
 * Assemble and validate one artifact in memory. Writes nothing.
 * Throws `BuildError` when any invariant fails.
 */
export async function build(target: Target, options: BuildOptions = {}): Promise<BuildResult> {
  const { outDir, files } = await assemble(target, options);
  return { target, outDir, files, manifest: serializeManifest(target, files) };
}

async function existingEntries(outDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(absolute, entry.name), rel);
      else found.push(rel);
    }
  };
  await walk(outDir, "");
  return found.sort();
}

/**
 * Validate, then create or replace only the allowlisted files.
 *
 * This never deletes anything. A pre-existing entry that the artifact does not
 * own is a conflict: the write stops and names it, so a user file is never
 * silently removed.
 */
export async function write(
  target: Target,
  options: BuildOptions = {},
): Promise<{ written: string[]; removed: string[] }> {
  const { outDir, files, contents } = await assemble(target, options);

  await assertNoSymlink(dirname(outDir), outDir, "output");
  const owned = new Set(files.map((file) => file.path));
  const conflicts = (await existingEntries(outDir)).filter((entry) => !owned.has(entry));
  if (conflicts.length > 0) {
    fail(
      `${outDir}: refusing to write; ${conflicts.length} existing entr${conflicts.length === 1 ? "y is" : "ies are"} not owned by this artifact: ${conflicts.join(", ")}`,
    );
  }

  const written: string[] = [];
  for (const file of files) {
    const absolute = join(outDir, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    const bytes = contents.get(file.path);
    if (!bytes) fail(`internal: missing assembled content for ${file.path}`);
    await writeFile(absolute, bytes);
    written.push(file.path);
  }
  return { written, removed: [] };
}

/**
 * Compare the artifact with what is on disk. Reports drift, extra files, and
 * missing files; changes nothing.
 */
export async function check(
  target: Target,
  options: BuildOptions = {},
): Promise<{ ok: boolean; problems: string[] }> {
  const { outDir, files, contents } = await assemble(target, options);
  const problems: string[] = [];

  const owned = new Set(files.map((file) => file.path));
  for (const entry of await existingEntries(outDir)) {
    if (!owned.has(entry)) problems.push(`${entry}: unexpected file is not part of this artifact`);
  }

  for (const file of files) {
    const absolute = join(outDir, file.path);
    let actual: Uint8Array;
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        problems.push(`${file.path}: is a symbolic link`);
        continue;
      }
      if (!stats.isFile()) {
        problems.push(`${file.path}: is not a regular file`);
        continue;
      }
      actual = await readFile(absolute);
    } catch {
      problems.push(`${file.path}: missing from ${outDir}`);
      continue;
    }
    if (sha256(actual) !== file.sha256) {
      const expected = contents.get(file.path);
      problems.push(
        `${file.path}: content drifted from the maintained source (expected ${file.sha256}, found ${sha256(actual)}${
          expected ? `, ${expected.byteLength} bytes expected, ${actual.byteLength} found` : ""
        })`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const [command, rawTarget] = process.argv.slice(2);
  if (command !== "build" && command !== "check") {
    console.error("usage: bun scripts/build-ensemble.ts build|check <skill|omp|dsh>");
    process.exit(2);
  }
  if (!TARGETS.includes(rawTarget as Target)) {
    console.error(`unknown target: ${rawTarget ?? "(none)"}; expected one of ${TARGETS.join(", ")}`);
    process.exit(2);
  }
  const target = rawTarget as Target;
  try {
    if (command === "build") {
      const result = await write(target);
      console.log(`built ${target}: ${result.written.length} files -> ${target}`);
    } else {
      const result = await check(target);
      if (result.ok) {
        console.log(`check ${target}: up to date`);
      } else {
        for (const problem of result.problems) console.error(`${target}: ${problem}`);
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
