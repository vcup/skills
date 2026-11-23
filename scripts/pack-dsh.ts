#!/usr/bin/env bun
/**
 * Pack the DSH ensemble probe into an installable bundle.
 *
 * The content of the bundled skill comes from the in-memory DSH artifact
 * (`build('dsh')` in `scripts/build-ensemble.ts`): this script never reads the
 * ignored default staging directory, so a stale checkout cannot leak into a
 * package. Everything else — the manifest, the bundle patch, the README — is
 * generated here from `adapters/dsh` declarations, and the resulting file set
 * is checked against one explicit allowlist.
 *
 *   bun scripts/pack-dsh.ts            # stage + tarball under build/pack/dsh
 *   bun scripts/pack-dsh.ts --stage    # stage only, no tarball
 *
 * The staging root is `build/pack/dsh` (git-ignored). Nothing is published.
 *
 * A successful run also prints two things that are part of the contract, not
 * decoration: an immutable digest-addressed copy under `build/pack/candidates/`,
 * and the sha256 of the packaged `index.js`, `client.js` and CLI. Quoting those
 * is how a verification result can be tied to exact bytes even after the next
 * repack rewrites the shared path.
 *
 * @module scripts/pack-dsh
 */

import { createHash } from "node:crypto";
import ts from "typescript";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DSH_VERSION,
  ENGINES_DSH,
  SUPPORTED_DSH_VERSIONS,
  supportedVersionsText,
} from "../adapters/dsh/compatibility.ts";
import {
  CAPABILITY_STATUS,
  CLIENT_INJECT,
  PEER_DEPENDENCIES,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  REFERENCE_RESOURCES,
  SKILL_DIR,
  SKILL_FILE,
  STAGING_DIR,
} from "../adapters/dsh/meta.ts";
import { build, type BuildFile } from "./build-ensemble.ts";
import { readCommittedBundle, renderBundle, renderProvenance } from "./build-dsh-bundle.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A staged file: repo-relative source path and package-relative destination. */
interface StagedFile {
  readonly source: string;
  readonly target: string;
}

/** Result of one staging run. */
export interface StageResult {
  readonly stagingDir: string;
  /** Package-relative paths of every staged file, sorted. */
  readonly files: readonly string[];
  /** `package.json` contents as staged. */
  readonly manifest: Record<string, unknown>;
  /** Digest of the staged content artifact (`{target, files:[...]}`). */
  readonly contentDigest: string;
}

/** A staging or packaging invariant failed. */
export class PackError extends Error {
  override readonly name = "PackError";
}

function fail(message: string): never {
  throw new PackError(message);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The complete package file allowlist, relative to the package root.
 *
 * Every entry is produced by this script or by `build('dsh')`; nothing is
 * discovered by scanning, so an accidental extra file in `adapters/dsh` cannot
 * enter the package.
 *
 * The CLI is listed explicitly and the staging step compares this list to what
 * landed on disk, so forgetting an entry fails the pack instead of shipping a
 * package whose bin is missing or half-present.
 * @returns the sorted allowlist.
 */
export function packageAllowlist(): string[] {
  return [
    "README.md",
    "bin/ensemble-archive.js",
    "bundle-manifest.json",
    "cordis.patch.yml",
    "index.js",
    "client.js",
    "lib/cookie-jar.mjs",
    "lib/transport.bundle.json",
    "lib/transport.bundle.mjs",
    "package.json",
    ...REFERENCE_RESOURCES.map((name) => `${SKILL_DIR}/${name}`),
    `${SKILL_DIR}/${SKILL_FILE}`,
  ].sort();
}

/** The bundle patch: one row naming this package. */
export function bundlePatch(): string {
  return [
    "# dsh-ensemble Host and web Client bundle layer.",
    "- insert:",
    `    - id: ${PACKAGE_NAME}`,
    `      name: ${PACKAGE_NAME}`,
    "",
  ].join("\n");
}

/** The package manifest for the staged bundle. */
export function packageManifest(contentFiles: readonly BuildFile[]) {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    description: `Managed ensemble coordination, versioned archives and reviewed learning for DSH ${supportedVersionsText()}.`,
    repository: { type: "git", url: "https://github.com/vcup/skills.git" },
    type: "module",
    main: "index.js",
    // The CLI is the reason this package has a `bin` at all: the owner archive
    // Remote is only reachable from an authenticated owner Peer, so without a
    // client an installer has no way to call it.
    bin: { "ensemble-archive": "./bin/ensemble-archive.js" },
    exports: {
      ".": "./index.js",
      "./client": "./client.js",
      "./transport": "./lib/transport.bundle.mjs",
      "./cookie": "./lib/cookie-jar.mjs",
      "./package.json": "./package.json",
    },
    files: [
      "index.js",
      "client.js",
      "cordis.patch.yml",
      "bundle-manifest.json",
      "README.md",
      "bin/",
      "lib/",
      `${SKILL_DIR}/`,
    ],
    engines: { dsh: ENGINES_DSH, node: ">=24.9.0" },
    // Every package the Host entry imports is a peer, and there is no ordinary
    // `dependencies` entry at all. That is the point: the Host supplies these
    // shared instances through its own resolver, and the CLI carries its own
    // private copy of the client transport in `lib/transport.bundle.mjs`. An
    // ordinary dependency on the client package is what made pnpm install a
    // second connection into the profile, shadowing the Host's.
    peerDependencies: { ...PEER_DEPENDENCIES },
    devDependencies: { ...PEER_DEPENDENCIES },
    dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web", inject: [...CLIENT_INJECT] } },
    ensemble: {
      // What this version actually does, stated in the installed manifest so a
      // reader does not have to infer it from the source.
      capabilities: { ...CAPABILITY_STATUS },
      skill: SKILL_FILE,
      supportedDsh: [...SUPPORTED_DSH_VERSIONS],
      defaultDsh: DEFAULT_DSH_VERSION,
      references: contentFiles.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    },
  };
}

/**
 * Build the DSH content artifact and assert its shape.
 *
 * The probe's fixed enumeration and the artifact must agree exactly: a missing
 * or additional content file means the package would ship a reference the tool
 * cannot read, or read one the artifact does not contain.
 * @returns the artifact files sorted by path.
 */
export async function dshContent(): Promise<readonly BuildFile[]> {
  const result = await build("dsh", { root: REPO_ROOT });
  const expected = [`${SKILL_FILE}`, ...REFERENCE_RESOURCES].sort();
  const actual = result.files.map((file) => file.path).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    fail(
      `build('dsh') file set changed; expected exactly ${expected.join(", ")}, got ${actual.join(", ") || "(none)"}`,
    );
  }
  for (const file of result.files) {
    if (file.content.byteLength !== file.bytes) {
      fail(`build('dsh') reported ${file.bytes} bytes for ${file.path} but supplied ${file.content.byteLength}`);
    }
    if (sha256(file.content) !== file.sha256) {
      fail(`build('dsh') digest mismatch for ${file.path}`);
    }
  }
  return result.files;
}

/** Forbidden tokens: another consumption path's names must not leak into this package. */
const FORBIDDEN_TOKENS: readonly RegExp[] = [
  /ensemble_state/,
  /\.ensemble\//,
  /npx skills/,
  /vcup\/skills/,
  /omp install/i,
];

/**
 * Assert that a generated package file names no other path.
 * @param path - package-relative path, used in the failure message.
 * @param text - file contents.
 */
export function assertNoCrossPathTokens(path: string, text: string): void {
  for (const token of FORBIDDEN_TOKENS) {
    if (token.test(text)) fail(`${path}: contains another consumption path's token ${token}`);
  }
}

/** Verify the exact output before any recursive removal. */
async function validateOutput(root: string, output: string): Promise<void> {
  const source = resolve(root);
  const target = resolve(output);
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
  };
  if (inside(target, source)) fail("staging output cannot be the source root or one of its ancestors");
  if (inside(source, target) && target !== join(source, STAGING_DIR)) {
    fail(`staging inside the source is limited to ${STAGING_DIR}`);
  }
  for (let path = target; ; path = dirname(path)) {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) fail(`staging output has a symbolic link at ${path}`);
      if (!entry.isDirectory()) fail(`staging output ancestor is not a directory: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(path) === path) break;
  }
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length === 0) return;
  try {
    const marker = join(target, "bundle-manifest.json");
    const entry = await lstat(marker);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a regular marker");
    const manifest = JSON.parse(await readFile(marker, "utf8")) as { package?: unknown };
    if (manifest.package !== PACKAGE_NAME && manifest.package !== "dsh-ensemble-probe") throw new Error("different package");
  } catch {
    fail(`refusing to replace an unmanaged nonempty staging directory: ${target}`);
  }
}

/**
 * Stage the package into `build/pack/dsh`.
 *
 * Clears only that directory, writes the bundle, and re-reads the result so the
 * allowlist assertion runs against bytes on disk rather than intended output.
 * @param options - repository root and staging root overrides (tests).
 * @returns staged paths and the digest of the content artifact.
 */
export async function stage(
  options: { root?: string; stagingDir?: string } = {},
): Promise<StageResult> {
  const root = options.root ?? REPO_ROOT;
  const stagingDir = resolve(options.stagingDir ?? join(root, STAGING_DIR));
  await validateOutput(root, stagingDir);

  const content = await dshContent();

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(join(stagingDir, SKILL_DIR), { recursive: true });

  const staged: string[] = [];
  for (const file of content) {
    const target = `${SKILL_DIR}/${file.path}`;
    await writeFile(join(stagingDir, target), file.content);
    staged.push(target);
  }

  const readme = await readFile(join(root, "adapters/dsh/package-readme.md"), "utf8");
  assertNoCrossPathTokens("README.md", readme);
  await writeFile(join(stagingDir, "README.md"), readme);
  staged.push("README.md");

  const manifestText = `${JSON.stringify(packageManifest(content), null, 2)}\n`;
  await writeFile(join(stagingDir, "package.json"), manifestText);
  staged.push("package.json");

  const patch = bundlePatch();
  await writeFile(join(stagingDir, "cordis.patch.yml"), patch);
  staged.push("cordis.patch.yml");

  const contentDigest = sha256(
    new TextEncoder().encode(
      JSON.stringify({ target: "dsh", files: content.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }),
    ),
  );
  const bundleManifest = {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    engines: { dsh: ENGINES_DSH, node: ">=24.9.0" },
    capabilities: { ...CAPABILITY_STATUS },
    // The tested set is recorded in the artifact so an installed package can be
    // audited without reading this repository: `engines.dsh` alone does not say
    // which releases were exercised, only which are permitted.
    supportedDsh: [...SUPPORTED_DSH_VERSIONS],
    defaultDsh: DEFAULT_DSH_VERSION,
    contentDigest,
    files: content.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  };
  const bundleManifestText = `${JSON.stringify(bundleManifest, null, 2)}\n`;
  assertNoCrossPathTokens("bundle-manifest.json", bundleManifestText);
  await writeFile(join(stagingDir, "bundle-manifest.json"), bundleManifestText);
  staged.push("bundle-manifest.json");

  const entry = await buildEntry(root);
  await writeFile(join(stagingDir, "index.js"), entry);
  await writeFile(join(stagingDir, "client.js"), await buildClient(root));
  staged.push("index.js", "client.js");

  // The CLI and its cookie reader are copied verbatim: they are Node ESM already,
  // and rewriting them would put a build step between the reviewed source and
  // what an installer runs. The transport is the exception, and the reason is in
  // `scripts/build-dsh-bundle.ts`: its reviewed source has bare imports a plain
  // Node process cannot resolve, so the package ships the generated bundle. The
  // bundle is read through `readCommittedBundle`, which re-checks its digest and
  // closure, so a hand-edited or stale artifact fails the pack instead of
  // shipping.
  const bundle = readCommittedBundle();
  for (const target of ["bin/ensemble-archive.js", "lib/cookie-jar.mjs"]) {
    await mkdir(join(stagingDir, dirname(target)), { recursive: true });
    await copyFile(join(root, "adapters/dsh", target), join(stagingDir, target));
    staged.push(target);
  }
  await mkdir(join(stagingDir, "lib"), { recursive: true });
  await writeFile(
    join(stagingDir, "lib", "transport.bundle.mjs"),
    renderBundle({ code: bundle.code, provenance: bundle.provenance }),
  );
  await writeFile(join(stagingDir, "lib", "transport.bundle.json"), renderProvenance(bundle.provenance));
  staged.push("lib/transport.bundle.mjs", "lib/transport.bundle.json");

  const onDisk = (await listFiles(stagingDir)).sort();
  const allowlist = packageAllowlist();
  if (onDisk.join("\n") !== allowlist.join("\n")) {
    fail(
      `staged file set does not match the allowlist\n  staged:    ${onDisk.join(", ")}\n  allowlist: ${allowlist.join(", ")}`,
    );
  }

  for (const path of onDisk) {
    if (!path.endsWith(".md")) continue;
    assertNoCrossPathTokens(path, await readFile(join(stagingDir, path), "utf8"));
  }

  return { stagingDir, files: onDisk, manifest: packageManifest(content), contentDigest };
}

/** Relative imports determine the source closure; no scratch or test source can enter. */
async function sourceClosure(root: string, entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    if ((!name.startsWith("adapters/dsh/") && !name.startsWith("modules/ensemble/")) ||
        name.includes("/client/") || name.includes("/probes/") || name.endsWith(".test.ts")) {
      fail(`Host source import escapes its maintained module trees: ${name}`);
    }
    const path = join(root, name);
    if (!(await lstat(path)).isFile() || await realpath(path) !== resolve(path)) fail(`source is not a regular file without symlink ancestors: ${name}`);
    seen.add(name);
    const source = await readFile(path, "utf8");
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = resolve(dirname(path), imported.fileName);
      if (!target.endsWith(".ts")) fail(`unreviewed relative Host import: ${imported.fileName}`);
      pending.push(relative(root, target).split(sep).join("/"));
    }
  }
  return [...seen].sort();
}

async function buildClient(root: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, "adapters/dsh/client/index.tsx")], target: "browser", format: "cjs",
    jsx: { runtime: "automatic", development: false },
    external: ["@deepseek-ai/*", "react", "react/jsx-runtime"], minify: false,
  });
  if (!result.success || result.outputs.length !== 1) fail(`Client build failed: ${result.logs.map(String).join("; ")}`);
  const code = await result.outputs[0]!.text();
  return `window.__ModuleLoader__.load({id:${JSON.stringify(PACKAGE_NAME)},factory(require){const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`;
}

/**
 * Emit the plugin entry to one ESM file with `tsc`, then bundle that output.
 *
 * The two-step order is not a preference. DSH's Typert Gateway derives each
 * Remote endpoint's wire descriptor by reading the method's source text through
 * `Function.prototype.toString`. `Bun.build` transpiles TC39 decorators into
 * `async[(_dec = [Remote], "status")](request)`, whose source text the gateway's
 * parameter parser cannot read, so every method fails with
 * `gateway/signature-invalid` **before its body runs** — the guard never gets a
 * chance, and the packaged artifact behaves differently from the source it was
 * built from. `tsc` keeps standard class-method syntax, so the emitted source is
 * what the gateway parses; bundling the emitted JavaScript afterwards keeps the
 * single-file package without re-transpiling the decorators.
 *
 * `--noCheck` because the Host modules need `@deepseek-ai/*` types that are not
 * root dependencies; `adapters/dsh/typecheck-host.ts` is the gate that checks
 * them properly against a real install.
 * @param root - repository root.
 * @returns the bundled entry source.
 */
async function buildEntry(root: string): Promise<string> {
  const typescript = join(root, "node_modules/typescript/bin/tsc");
  if (!existsSync(typescript)) fail("packaging needs typescript; run `make setup` first");

  const scratch = await mkdtemp(join(tmpdir(), "pack-dsh-emit-"));
  try {
    const modules = await sourceClosure(root, "adapters/dsh/index.ts");
    for (const name of modules) {
      await mkdir(dirname(join(scratch, name)), { recursive: true });
      await copyFile(join(root, name), join(scratch, name));
    }
    await writeFile(join(scratch, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

    const emitted = Bun.spawnSync(
      [
        process.execPath,
        typescript,
        "--noCheck",
        "--target", "ES2022",
        "--module", "ES2022",
        "--moduleResolution", "Bundler",
        "--skipLibCheck",
        "--rewriteRelativeImportExtensions",
        "--outDir", join(scratch, "out"),
        "--rootDir", scratch,
        ...modules,
      ],
      { cwd: scratch, stdout: "pipe", stderr: "pipe" },
    );
    if (emitted.exitCode !== 0) {
      fail(`tsc could not emit adapters/dsh: ${emitted.stderr.toString() || emitted.stdout.toString()}`);
    }

    const bundled = await Bun.build({
      entrypoints: [join(scratch, "out", "adapters/dsh/index.js")],
      target: "node",
      format: "esm",
      external: ["@deepseek-ai/*"],
      minify: false,
    });
    if (!bundled.success || bundled.outputs.length !== 1) {
      fail(`bun build failed for the emitted entry: ${bundled.logs.map(String).join("; ")}`);
    }
    const output = bundled.outputs[0];
    if (output === undefined) fail("bun build produced no output for the emitted entry");
    // Bun emits source-location comments containing the random scratch root.
    // Normalize only those whole-line generated comments, never executable text.
    const text = (await output.text()).replace(
      /^\/\/ [^\r\n]*\/pack-dsh-emit-[^/\r\n]+\/out\/([^\r\n]+)$/gm,
      "// $1",
    );

    // A mangled decorator form is a packaging defect that only shows up when a
    // Remote is invoked, so refuse to ship it rather than discover it later.
    if (/async\s*\[\s*\(/.test(text) || /\[_dec\$?\d*\s*=/.test(text)) {
      fail(
        "the emitted entry contains transpiled decorator syntax the Typert Gateway cannot parse; " +
          "its Remote endpoints would fail with gateway/signature-invalid",
      );
    }

    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(text);
    const foreign = imports.map(item => item.path).filter(specifier =>
      !specifier.startsWith("node:") && !(specifier in PEER_DEPENDENCIES));
    if (foreign.length > 0) {
      fail(`bundled entry has unexpected external imports: ${foreign.join(", ")}`);
    }
    return text;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Where every produced tarball is additionally kept, addressed by its digest. */
export const CANDIDATES_DIR = "build/pack/candidates";

/**
 * Files whose digest must be quoted whenever a candidate is handed to someone
 * who will verify against it.
 *
 * A tarball digest alone has already caused a wasted round in this repository:
 * one report called the artifact "pre-fix" while a driver called the same path
 * "green", because the two were hashing different bytes at different times. The
 * digest of the files an installer or a Loader actually executes (the Host
 * entry, the Client factory, the CLI) cannot be ambiguous that way.
 */
export const IDENTITY_FILES = ["index.js", "client.js", "bin/ensemble-archive.js"] as const;

/** One file's identity, read from the tarball rather than from the staging tree. */
export interface EntryIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Read the identity of the packaged entry files out of the produced tarball.
 *
 * Reading from the archive — not from the staging directory — is the point: the
 * digests describe what an installer receives after unpacking.
 * @param tarball - the produced `.tgz`.
 * @returns one digest per {@link IDENTITY_FILES} entry.
 */
export function readEntryIdentity(tarball: string): EntryIdentity[] {
  return IDENTITY_FILES.map((path) => {
    const extracted = Bun.spawnSync(["tar", "-xzOf", tarball, `package/${path}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (extracted.exitCode !== 0) {
      fail(`could not read package/${path} from ${tarball}: ${extracted.stderr.toString()}`);
    }
    const bytes = new Uint8Array(extracted.stdout);
    return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
  });
}

/**
 * Keep an immutable copy of a produced tarball, addressed by its digest.
 *
 * The shared staging path (`build/pack/dsh/dsh-ensemble-1.0.0.tgz`) is rewritten
 * on every pack, so anyone who pinned its bytes can be invalidated by an
 * unrelated repack. A digest-addressed copy cannot be invalidated that way, and
 * writing it never destroys an earlier candidate: a different digest is a
 * different name. An existing name must hold the same bytes; a mismatch would
 * mean this script produced two archives under one digest.
 * @param root - repository root.
 * @param tarball - the packed tarball.
 * @param digest - the tarball's sha256.
 * @returns the candidate path.
 */
export async function keepCandidate(root: string, tarball: string, digest: string): Promise<string> {
  const dir = join(root, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const candidate = join(dir, `${PACKAGE_NAME}-${PACKAGE_VERSION}-${digest.slice(0, 12)}.tgz`);
  const bytes = await readFile(tarball);
  if (existsSync(candidate)) {
    if (sha256(await readFile(candidate)) !== digest) {
      fail(`candidate ${packageRelative(root, candidate)} already exists with different bytes`);
    }
    return candidate;
  }
  await writeFile(candidate, bytes);
  if (sha256(await readFile(candidate)) !== digest) {
    fail(`candidate copy ${packageRelative(root, candidate)} does not match the packed digest`);
  }
  return candidate;
}

/**
 * Create the tarball from the staged directory with `npm pack`.
 *
 * `npm pack` (not a hand-rolled archive) is used on purpose: it is the same
 * packaging path an installer consumes, it honours the staged `files`
 * allowlist, and it produces the `package/`-prefixed gzip tarball that
 * `dsh plugin add ./x.tgz` expects.
 * @param options - repository root and staging root overrides (tests).
 * @returns the tarball path, its sha256, the unpacked entry identity and the staged result.
 */
export async function pack(
  options: { root?: string; stagingDir?: string } = {},
): Promise<{
  tarball: string;
  sha256: string;
  entry: readonly EntryIdentity[];
  candidate: string;
  staged: StageResult;
}> {
  const root = options.root ?? REPO_ROOT;
  const staged = await stage({ ...options, root });
  const tarball = join(staged.stagingDir, `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`);

  const process = Bun.spawnSync(["npm", "pack", "--pack-destination", staged.stagingDir], {
    cwd: staged.stagingDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, npm_config_cache: join(staged.stagingDir, ".npm-cache") },
  });
  if (process.exitCode !== 0) {
    fail(`npm pack failed in ${staged.stagingDir}: ${process.stderr.toString() || process.stdout.toString()}`);
  }
  const produced = (await readdir(staged.stagingDir)).filter((entry) => entry.endsWith(".tgz"));
  if (produced.length !== 1 || produced[0] !== `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`) {
    fail(`npm pack produced unexpected archives: ${produced.join(", ") || "(none)"}`);
  }
  // `npm pack` writes its cache beside the tarball only when asked; remove it so
  // the staging directory holds exactly the allowlisted files plus the tarball.
  await rm(join(staged.stagingDir, ".npm-cache"), { recursive: true, force: true });
  if (!(await Bun.file(tarball).exists())) fail(`npm pack did not create ${tarball}`);

  const digest = sha256(await readFile(tarball));
  // Read identity and keep the immutable copy from the produced archive, so a
  // caller who quotes a digest is quoting what an installer receives.
  const entry = readEntryIdentity(tarball);
  const candidate = await keepCandidate(root, tarball, digest);
  return { tarball, sha256: digest, entry, candidate, staged };
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(dir, rel)));
    else found.push(rel);
  }
  return found;
}

/** Relative path of `absolute` under `base`, POSIX separators. */
export function packageRelative(base: string, absolute: string): string {
  return relative(base, absolute).split(sep).join("/");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--stage")) {
    const staged = await stage();
    console.log(
      `staged ${staged.files.length} files -> ${packageRelative(REPO_ROOT, staged.stagingDir)}`,
    );
  } else {
    const result = await pack();
    console.log(
      `packed ${result.staged.files.length} files -> ${packageRelative(REPO_ROOT, result.tarball)} (sha256 ${result.sha256})`,
    );
    console.log(`candidate ${packageRelative(REPO_ROOT, result.candidate)}`);
    for (const entry of result.entry) {
      console.log(`entry ${entry.path} sha256 ${entry.sha256} (${entry.bytes} bytes)`);
    }
  }
}
