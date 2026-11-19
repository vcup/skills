#!/usr/bin/env bun
/**
 * Stage and pack the OMP installation root.
 *
 * The package is built from maintained sources only:
 *   - the ensemble skill comes from content-builder's in-memory `build("omp")`
 *     API (never from its default staging path, never re-assembled here);
 *   - the always and edit-commit-msg skills and the three task roles are copied
 *     byte for byte from the repository;
 *   - the `ensemble_state` extension is a byte-for-byte copy of the adapter.
 *
 * The staging root is self-contained: every file it holds is produced here, and
 * every relative link inside it resolves inside it. Nothing in the package
 * refers to the mother repository.
 *
 * CLI: bun scripts/pack-omp.ts [--root <dir>] [--out <dir>]
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import { build } from "./build-ensemble";

/** Package identity, kept identical to the existing OMP package. */
export const PACKAGE_NAME = "@vcup/skills";

/** Repository-relative directories copied verbatim into the package. */
const VERBATIM_SKILLS = ["skills/always", "skills/edit-commit-msg"] as const;
const VERBATIM_ROLES = ["agents"] as const;
/** The adapter source copied as the packaged extension. */
const ADAPTER_SOURCE = "adapters/omp/index.ts";
const PACKAGED_EXTENSION = "omp-extension/index.ts";

/**
 * Markers that must not appear in packaged Markdown. `package.json` is exempt:
 * its `name` field carries the package identity on purpose, and the ban is a
 * content rule, not a metadata rule.
 */
const FORBIDDEN_MARKERS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /npx skills/, what: "pure-skill installer command" },
  { pattern: /vcup\/skills/, what: "pure-skill repository address" },
  { pattern: /ensemble_reference/, what: "DSH tool name" },
  { pattern: /managed domain tools?/i, what: "path-bound tool category" },
];

/**
 * OMP 17.2.15's installer accepts a local directory or a registry spec, but not
 * a `.tgz` file. Any packaged instruction that tells a user to install a
 * tarball is wrong, so it is rejected wherever it appears.
 */
const FORBIDDEN_TARBALL_INSTALL: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /omp install[^\n]*\.tgz/, what: "tarball install command unsupported by OMP 17.2.15" },
];

/**
 * The package is unpacked on its own, so its instructions cannot depend on
 * scripts that only exist in the source repository.
 */
const FORBIDDEN_MOTHER_REPO_PATH: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bscripts\//, what: "path that only exists in the source repository" },
];

export interface PackFile {
  /** Path inside the package, POSIX separators, relative to the package root. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PackOptions {
  /** Repository root. Defaults to the parent of this script's directory. */
  readonly root?: string;
  /** Staging root for the package tree. Defaults to `<root>/build/pack/omp/staging`. */
  readonly stagingRoot?: string;
  /** Directory receiving the tarball. Defaults to `<root>/build/pack/omp`. */
  readonly outputDir?: string;
  /** When false, stop after staging and produce no tarball. */
  readonly pack?: boolean;
}

export interface PackResult {
  readonly stagingRoot: string;
  readonly files: readonly PackFile[];
  /** Serialized file list; same shape as the content builder's manifest. */
  readonly manifest: string;
  /** Absolute path of the tarball, or null when packing was skipped. */
  readonly tarball: string | null;
  /** Package name and version read from the staged manifest. */
  readonly name: string;
  readonly version: string;
}

export class PackError extends Error {
  override readonly name = "PackError";
}

function fail(message: string): never {
  throw new PackError(message);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function toPosix(value: string): string {
  return value.split(sep).join(posix.sep);
}

function assertRelative(value: string, what: string): void {
  if (value.length === 0) fail(`${what}: empty path`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) fail(`${what}: absolute path is not allowed: ${value}`);
  if (value.split(sep).includes("..")) fail(`${what}: path escapes the package: ${value}`);
}

/** Collect every file under a directory, as repo-relative POSIX paths. */
async function listFiles(root: string, dir: string): Promise<string[]> {
  const absolute = join(root, dir);
  const found: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  await walk(absolute, "");
  return found.sort();
}

/** Markdown links that point at another file in the same package. */
function markdownLinks(text: string): { path: string; fragment: string }[] {
  const links: { path: string; fragment: string }[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) {
      if (target.startsWith("#")) links.push({ path: "", fragment: target.slice(1) });
      continue;
    }
    const [path, fragment = ""] = target.split("#");
    links.push({ path, fragment });
  }
  return links;
}

async function readPackageSources(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  const add = (path: string, data: Uint8Array): void => {
    assertRelative(path, "package file");
    if (files.has(path)) fail(`duplicate package path: ${path}`);
    files.set(path, data);
  };

  // The package's own manifest and README.
  for (const source of ["adapters/omp/package/package.json", "adapters/omp/package/README.md"]) {
    add(source.slice("adapters/omp/package/".length), new Uint8Array(await readFile(join(root, source))));
  }

  // The ensemble skill for this path, assembled in memory by the content builder.
  const built = await build("omp", { root });
  for (const file of built.files) {
    add(posix.join("skills/ensemble", file.path), file.content);
  }

  // Existing skills, copied byte for byte.
  for (const dir of VERBATIM_SKILLS) {
    const found = await listFiles(root, dir);
    if (found.length === 0) fail(`no files found in ${dir}`);
    for (const file of found) {
      add(posix.join(dir, file), new Uint8Array(await readFile(join(root, dir, file))));
    }
  }

  // Task roles, copied byte for byte.
  for (const dir of VERBATIM_ROLES) {
    const found = await listFiles(root, dir);
    if (found.length === 0) fail(`no files found in ${dir}`);
    for (const file of found) {
      add(posix.join(dir, file), new Uint8Array(await readFile(join(root, dir, file))));
    }
  }

  // The checkpoint tool.
  add(PACKAGED_EXTENSION, new Uint8Array(await readFile(join(root, ADAPTER_SOURCE))));

  return files;
}

/** Read the frontmatter block of a Markdown file, as a flat key list. */
function frontmatterKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  if (!text.startsWith("---\n")) return keys;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return keys;
  const block = text.slice(4, end);
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) keys.set(match[1], match[2].trim());
  }
  return keys;
}

/** Parse `autoloadSkills: [a, b]` or `autoloadSkills: a, b`. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return trimmed
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map(entry => entry.trim().replace(/^["']|["']$/g, ""))
      .filter(entry => entry.length > 0);
  }
  return trimmed
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function validatePackage(files: Map<string, Uint8Array>): void {
  const text = (path: string): string => new TextDecoder("utf-8").decode(files.get(path)!);

  // 1. Content markers. Only skills/ and agents/ Markdown is scanned; the
  //    package manifest is exempt because its name field carries the identity.
  for (const path of files.keys()) {
    if (!path.endsWith(".md")) continue;
    if (!path.startsWith("skills/") && !path.startsWith("agents/")) continue;
    const body = text(path);
    for (const marker of FORBIDDEN_MARKERS) {
      const match = marker.pattern.exec(body);
      if (match) fail(`${path}: contains ${marker.what}: ${match[0]}`);
    }
  }

  // 2. No packaged instruction may tell a user to install a tarball, and no
  //    packaged instruction may point at a source-repository-only path.
  for (const path of files.keys()) {
    if (!path.endsWith(".md")) continue;
    const body = text(path);
    for (const marker of [...FORBIDDEN_TARBALL_INSTALL, ...FORBIDDEN_MOTHER_REPO_PATH]) {
      const match = marker.pattern.exec(body);
      if (match) fail(`${path}: contains ${marker.what}: ${match[0]}`);
    }
  }

  // 3. Skill discovery shape: every skill directory holds a SKILL.md.
  const skillNames = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith("skills/")) continue;
    const parts = path.split("/");
    if (parts.length < 3) continue;
    const name = parts[1];
    skillNames.add(name);
    if (parts[2] !== "SKILL.md" && parts.length > 3) {
      fail(`${path}: skill files must sit next to SKILL.md inside skills/${name}/`);
    }
  }
  for (const name of skillNames) {
    if (!files.has(`skills/${name}/SKILL.md`)) fail(`skills/${name}: missing SKILL.md`);
  }
  if (!skillNames.has("ensemble")) fail("package must ship the ensemble skill");

  // 3. Role autoload targets exist in the package.
  for (const path of files.keys()) {
    if (!path.startsWith("agents/") || !path.endsWith(".md")) continue;
    const keys = frontmatterKeys(text(path));
    for (const target of parseList(keys.get("autoloadSkills"))) {
      if (!skillNames.has(target)) fail(`${path}: autoloadSkills names an unknown skill: ${target}`);
    }
    if (!keys.has("name")) fail(`${path}: agent file has no name`);
  }

  // 4. Every relative Markdown link resolves inside the package.
  for (const path of files.keys()) {
    if (!path.endsWith(".md")) continue;
    for (const link of markdownLinks(text(path))) {
      if (link.path === "") continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), link.path));
      if (resolved.startsWith("..") || posix.isAbsolute(resolved)) {
        fail(`${path}: link escapes the package: ${link.path}`);
      }
      if (!files.has(resolved)) fail(`${path}: link target is not part of the package: ${link.path}`);
    }
  }

  // 5. No reference to the mother repository or the absolute local path.
  for (const path of files.keys()) {
    if (!path.endsWith(".md")) continue;
    const body = text(path);
    if (body.includes("/home/")) fail(`${path}: contains an absolute local path`);
    if (body.includes("content/ensemble")) fail(`${path}: refers to the maintained source tree`);
  }

  // 6. The package manifest declares an allowlist that covers every file.
  const manifest = JSON.parse(text("package.json")) as {
    name?: string;
    version?: string;
    files?: string[];
    omp?: { extensions?: string[] };
  };
  if (manifest.name !== PACKAGE_NAME) fail(`package.json: name must be ${PACKAGE_NAME}`);
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    fail("package.json: missing version");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("package.json: missing files allowlist");
  const allowed = manifest.files.map(entry => entry.replace(/\/$/, ""));
  for (const path of files.keys()) {
    if (path === "package.json") continue;
    const covered = allowed.some(entry => path === entry || path.startsWith(`${entry}/`));
    if (!covered) fail(`package.json: files allowlist does not cover ${path}`);
  }
  for (const entry of allowed) {
    const prefix = `${entry}/`;
    const hit = [...files.keys()].some(path => path === entry || path.startsWith(prefix));
    if (!hit) fail(`package.json: files allowlist names a missing path: ${entry}`);
  }
  if (!manifest.omp?.extensions?.includes(`./${PACKAGED_EXTENSION}`)) {
    fail(`package.json: omp.extensions must declare ./${PACKAGED_EXTENSION}`);
  }
}

async function writeStaging(stagingRoot: string, files: Map<string, Uint8Array>): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  for (const [path, data] of files) {
    const absolute = join(stagingRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, data);
  }
}

/** List the paths inside a tarball produced by `npm pack`. */
export async function listTarball(tarball: string): Promise<string[]> {
  const result = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`tar -tzf ${tarball} failed with status ${result.status}: ${result.stderr ?? ""}`);
  }
  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.replace(/^package\//, ""));
}

/**
 * Stage the OMP package and, unless `pack` is false, produce its tarball.
 */
export async function packOmp(options: PackOptions = {}): Promise<PackResult> {
  const root = resolve(options.root ?? join(import.meta.dir, ".."));
  const outputDir = resolve(options.outputDir ?? join(root, "build/pack/omp"));
  const stagingRoot = resolve(options.stagingRoot ?? join(outputDir, "staging"));

  const files = await readPackageSources(root);
  validatePackage(files);

  await writeStaging(stagingRoot, files);

  const entries: PackFile[] = [...files.entries()]
    .map(([path, data]) => ({ path, sha256: sha256(data), bytes: data.byteLength }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = `${JSON.stringify({ target: "omp", files: entries }, null, 2)}\n`;

  const manifestJson = JSON.parse(new TextDecoder("utf-8").decode(files.get("package.json")!)) as {
    name: string;
    version: string;
  };

  let tarball: string | null = null;
  if (options.pack !== false) {
    await mkdir(outputDir, { recursive: true });
    // npm needs a writable cache and config home; the sandbox home may not
    // have one, and npm must not touch the user's real cache.
    const cache = await mkdtemp(join(tmpdir(), "omp-npm-cache-"));
    await mkdir(cache, { recursive: true });
    const result = spawnSync("npm", ["pack", "--pack-destination", outputDir], {
      cwd: stagingRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" },
    });
    if (result.status !== 0) {
      fail(`npm pack failed with status ${result.status}: ${result.stderr ?? ""}`);
    }
    const name = `${manifestJson.name.replace("@", "").replace("/", "-")}-${manifestJson.version}.tgz`;
    const produced = join(outputDir, name);
    if (!(await stat(produced).catch(() => undefined))) {
      fail(`npm pack reported success but ${produced} is missing`);
    }
    tarball = produced;
  }

  return {
    stagingRoot,
    files: entries,
    manifest,
    tarball,
    name: manifestJson.name,
    version: manifestJson.version,
  };
}

/** Extract a tarball into a fresh temporary directory and return its path. */
export async function extractToTemp(tarball: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), "omp-package-"));
  const result = spawnSync("tar", ["-xzf", tarball, "-C", target], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`tar -xzf failed with status ${result.status}: ${result.stderr ?? ""}`);
  }
  return target;
}

/** Relative paths of the files inside an extracted package. */
export async function listExtracted(root: string): Promise<string[]> {
  return listFiles(root, ".");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: { root?: string; outputDir?: string; pack?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") options.root = args[++i];
    else if (args[i] === "--out") options.outputDir = args[++i];
    else if (args[i] === "--no-pack") options.pack = false;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  try {
    const result = await packOmp(options);
    console.log(`staged ${result.files.length} files in ${relative(process.cwd(), result.stagingRoot)}`);
    console.log(`package ${result.name}@${result.version}`);
    if (result.tarball) console.log(`tarball ${relative(process.cwd(), result.tarball)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
