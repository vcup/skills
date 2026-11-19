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
 * @module scripts/pack-dsh
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINES_DSH,
  PEER_DEPENDENCIES,
  PROBE_PACKAGE_NAME,
  PROBE_VERSION,
  REFERENCE_RESOURCES,
  SKILL_DIR,
  SKILL_FILE,
  STAGING_DIR,
} from "../adapters/dsh/meta.ts";
import { build, type BuildFile } from "./build-ensemble.ts";

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
 * @returns the sorted allowlist.
 */
export function packageAllowlist(): string[] {
  return [
    "README.md",
    "bundle-manifest.json",
    "cordis.patch.yml",
    "index.js",
    "package.json",
    ...REFERENCE_RESOURCES.map((name) => `${SKILL_DIR}/${name}`),
    `${SKILL_DIR}/${SKILL_FILE}`,
  ].sort();
}

/** The bundle patch: one row naming this package. */
export function bundlePatch(): string {
  return [
    "# dsh-ensemble-probe bundle layer.",
    "# One Host plugin row: it registers the bundled `ensemble` skill provider",
    "# (user-invocable only) and the `ensemble_reference` read-back tool.",
    "# No Client row, no archive row, no model-selection row.",
    "- insert:",
    `    - id: ${PROBE_PACKAGE_NAME}`,
    `      name: ${PROBE_PACKAGE_NAME}`,
    "",
  ].join("\n");
}

/** The package manifest for the staged bundle. */
export function packageManifest(contentFiles: readonly BuildFile[]): Record<string, unknown> {
  return {
    name: PROBE_PACKAGE_NAME,
    version: PROBE_VERSION,
    private: true,
    description:
      "Host-only DSH probe: user-invocable ensemble skill plus a fixed-enumeration reference reader. Not the ensemble product.",
    type: "module",
    main: "index.js",
    files: ["index.js", "cordis.patch.yml", "bundle-manifest.json", "README.md", `${SKILL_DIR}/`],
    engines: { dsh: ENGINES_DSH },
    peerDependencies: { ...PEER_DEPENDENCIES },
    devDependencies: { ...PEER_DEPENDENCIES },
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    probe: {
      status: "host-only-probe",
      skill: SKILL_FILE,
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
  const stagingDir = options.stagingDir ?? join(root, STAGING_DIR);

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
    package: PROBE_PACKAGE_NAME,
    version: PROBE_VERSION,
    engines: { dsh: ENGINES_DSH },
    contentDigest,
    files: content.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  };
  const bundleManifestText = `${JSON.stringify(bundleManifest, null, 2)}\n`;
  assertNoCrossPathTokens("bundle-manifest.json", bundleManifestText);
  await writeFile(join(stagingDir, "bundle-manifest.json"), bundleManifestText);
  staged.push("bundle-manifest.json");

  const entry = await buildEntry(root);
  await writeFile(join(stagingDir, "index.js"), entry);
  staged.push("index.js");

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

/**
 * Transpile the plugin entry to one ESM file.
 *
 * `@deepseek-ai/*` stays external: the host supplies those instances, and
 * bundling a second copy would break service identity.
 * @param root - repository root.
 * @returns the bundled entry source.
 */
async function buildEntry(root: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, "adapters/dsh/index.ts")],
    target: "node",
    format: "esm",
    external: ["@deepseek-ai/*"],
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    fail(`bun build failed for adapters/dsh/index.ts: ${result.logs.map(String).join("; ")}`);
  }
  const output = result.outputs[0];
  if (output === undefined) fail("bun build produced no output for adapters/dsh/index.ts");
  const text = await output.text();
  const foreign = [...text.matchAll(/from\s+"([^"]+)"/g)]
    .map((match) => match[1] as string)
    .filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("@deepseek-ai/") && !specifier.startsWith("./"));
  if (foreign.length > 0) {
    fail(`bundled entry has unexpected external imports: ${foreign.join(", ")}`);
  }
  return text;
}

/**
 * Create the tarball from the staged directory with `npm pack`.
 *
 * `npm pack` (not a hand-rolled archive) is used on purpose: it is the same
 * packaging path an installer consumes, it honours the staged `files`
 * allowlist, and it produces the `package/`-prefixed gzip tarball that
 * `dsh plugin add ./x.tgz` expects.
 * @param options - repository root and staging root overrides (tests).
 * @returns the tarball path and its sha256.
 */
export async function pack(
  options: { root?: string; stagingDir?: string } = {},
): Promise<{ tarball: string; sha256: string; staged: StageResult }> {
  const root = options.root ?? REPO_ROOT;
  const staged = await stage({ ...options, root });
  const tarball = join(staged.stagingDir, `${PROBE_PACKAGE_NAME}-${PROBE_VERSION}.tgz`);

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
  if (produced.length !== 1 || produced[0] !== `${PROBE_PACKAGE_NAME}-${PROBE_VERSION}.tgz`) {
    fail(`npm pack produced unexpected archives: ${produced.join(", ") || "(none)"}`);
  }
  // `npm pack` writes its cache beside the tarball only when asked; remove it so
  // the staging directory holds exactly the allowlisted files plus the tarball.
  await rm(join(staged.stagingDir, ".npm-cache"), { recursive: true, force: true });
  if (!(await Bun.file(tarball).exists())) fail(`npm pack did not create ${tarball}`);

  return { tarball, sha256: sha256(await readFile(tarball)), staged };
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
  }
}
