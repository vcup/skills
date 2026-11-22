#!/usr/bin/env bun
/**
 * Pack the DSH subagent-wait plugin into an installable bundle.
 *
 * This script is independent of `pack-dsh.ts` on purpose: the two plugins ship
 * as separate packages so their lifecycles and manifests cannot tangle. It
 * derives every release claim from this package’s own `meta.ts` and uses the
 * same `tsc`-then-`Bun.build` emit order the ensemble probe uses, because the
 * same two constraints apply:
 *
 * 1. the entry imports `@deepseek-ai/*`, which are not root dependencies;
 * 2. `Bun.build` must not transpile decorators for the Typert Gateway to parse.
 *
 *   bun scripts/pack-dsh-agent-wait.ts            # stage + tarball
 *   bun scripts/pack-dsh-agent-wait.ts --stage    # stage only
 *
 * The staging root is `build/pack/dsh-agent-wait` (git-ignored). Nothing is
 * published.
 *
 * @module scripts/pack-dsh-agent-wait
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_STATUS,
  DEFAULT_DSH_VERSION,
  ENGINES_DSH,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PEER_DEPENDENCIES,
  STAGING_DIR,
  SUPPORTED_DSH_VERSIONS,
  TOOL_NAME,
  supportedVersionsText,
} from "../adapters/dsh-agent-wait/meta.ts";

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
 * Every entry is produced by this script; nothing is discovered by scanning, so
 * an accidental extra file in `adapters/dsh-agent-wait` cannot enter the
 * package. The staged file set is compared against this list exactly.
 */
export function packageAllowlist(): string[] {
  return [
    "README.md",
    "bundle-manifest.json",
    "cordis.patch.yml",
    "index.js",
    "package.json",
  ].sort();
}

/** The bundle patch: one row naming this package. */
export function bundlePatch(): string {
  return [
    "# dsh-agent-wait bundle layer.",
    "# One Host plugin row: registers the `wait_subagents` model tool.",
    "# No skill row, no Client row, no archive row.",
    "- insert:",
    `    - id: ${PACKAGE_NAME}`,
    `      name: ${PACKAGE_NAME}`,
    "",
  ].join("\n");
}

/** The package manifest for the staged bundle. */
export function packageManifest(): Record<string, unknown> {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    repository: {
      type: "git",
      url: "git+https://github.com/vcup/skills.git",
      directory: "adapters/dsh-agent-wait",
    },
    description:
      "A bounded DSH plugin registering one model tool, `" + TOOL_NAME +
      "`, that waits without ending the caller's turn until subagents in the " +
      "caller's own tree change status (or are idle, on request), a deadline " +
      "elapses, or the call is cancelled. " +
      `Tested against DSH ${supportedVersionsText()}. Not a coordination product.`,
    type: "module",
    main: "index.js",
    exports: {
      ".": "./index.js",
      "./package.json": "./package.json",
    },
    files: ["index.js", "cordis.patch.yml", "bundle-manifest.json", "README.md"],
    engines: { node: ">=24.9.0", dsh: ENGINES_DSH },
    peerDependencies: { ...PEER_DEPENDENCIES },
    devDependencies: { ...PEER_DEPENDENCIES },
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    wait: {
      status: "local-production-candidate",
      capabilities: { ...CAPABILITY_STATUS },
      tool: TOOL_NAME,
      supportedDsh: [...SUPPORTED_DSH_VERSIONS],
      defaultDsh: DEFAULT_DSH_VERSION,
    },
  };
}

/** Forbidden tokens: another consumption path's names must not leak into this package. */
const FORBIDDEN_TOKENS: readonly RegExp[] = [
  /ensemble_state/,
  /\.ensemble\//,
  /npx skills/,
  /vcup\/skills/,
  /omp install/i,
  /dsh-ensemble-probe/,
];

/**
 * Assert that a generated package file names no other path.
 * @param path - package-relative path, used in the failure message.
 * @param text - file contents.
 */
export function assertNoCrossPathTokens(path: string, text: string): void {
  // Repository provenance is metadata, not a dependency on the source checkout.
  const checked = path === "package.json"
    ? text.replace('"url": "git+https://github.com/vcup/skills.git"', '"url": "<repository>"')
    : text;
  for (const token of FORBIDDEN_TOKENS) {
    if (token.test(checked)) fail(`${path}: contains another consumption path's token ${token}`);
  }
}

/**
 * The modules the packaged entry is emitted from.
 *
 * All runtime modules and release claims belong to this plugin; packaging
 * does not read another plugin's compatibility module.
 */
const PACKAGED_MODULES = [
  { source: "index.ts", target: "adapters/dsh-agent-wait/index.ts" },
  { source: "wait.ts", target: "adapters/dsh-agent-wait/wait.ts" },
  { source: "meta.ts", target: "adapters/dsh-agent-wait/meta.ts" },
] as const;

/**
 * Emit the plugin entry to one ESM file with `tsc`, then bundle that output.
 *
 * Same two-step order as `pack-dsh.ts`, for the same reason: `Bun.build`
 * transpiles TC39 decorators into a form the Typert Gateway's parameter parser
 * cannot read, so the entry is first emitted with `tsc` (which keeps standard
 * class-method syntax) and then bundled. This plugin has no Remote methods, so
 * the decorator concern is defensive rather than load-bearing, but the emit
 * order is kept identical to avoid two packaging dialects in one repository.
 *
 * `--noCheck` because the Host modules need `@deepseek-ai/*` types that are not
 * root dependencies; `adapters/dsh-agent-wait/tsconfig.host.json` is the gate
 * that checks them against a real install.
 * @param root - repository root.
 * @returns the bundled entry source.
 */
async function buildEntry(root: string): Promise<string> {
  const typescript = join(root, "node_modules/typescript/bin/tsc");
  if (!existsSync(typescript)) fail("packaging needs typescript; run `make setup` first");

  const scratch = await mkdtemp(join(tmpdir(), "pack-dsh-agent-wait-emit-"));
  try {
    const inputs: string[] = [];
    for (const item of PACKAGED_MODULES) {
      const destination = join(scratch, item.target);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(root, "adapters/dsh-agent-wait", item.source), destination);
      inputs.push(destination);
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
        ...inputs,
      ],
      { cwd: scratch, stdout: "pipe", stderr: "pipe" },
    );
    if (emitted.exitCode !== 0) {
      fail(`tsc could not emit adapters/dsh-agent-wait: ${emitted.stderr.toString() || emitted.stdout.toString()}`);
    }

    const bundled = await Bun.build({
      entrypoints: [join(scratch, "out", "index.js")],
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
    const text = await output.text();

    // Bun emits one leading source-map comment per original module with the
    // scratch tmpdir in it; the path differs on every run, which makes the
    // tarball non-deterministic. Strip only the generated labels, at any relative/absolute depth,
    // so two packs of identical sources are byte-identical.
    const deterministic = text
      .split("\n")
      .filter((line) => !/^\/\/\s+(?:[^\r\n]*\/)?pack-dsh-agent-wait-emit-[^/\r\n]+\/out\/[^\r\n]+$/.test(line))
      .join("\n");

    if (/async\s*\[\s*\(/.test(text) || /\[_dec\$?\d*\s*=/.test(text)) {
      fail("the emitted entry contains transpiled decorator syntax the Typert Gateway cannot parse");
    }

    const foreign = [...text.matchAll(/from\s+"([^"]+)"/g)]
      .map((match) => match[1] as string)
      .filter(
        (specifier) =>
          !specifier.startsWith("node:") &&
          !specifier.startsWith("@deepseek-ai/") &&
          !specifier.startsWith("./"),
      );
    if (foreign.length > 0) {
      fail(`bundled entry has unexpected external imports: ${foreign.join(", ")}`);
    }
    return deterministic;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Refuse destructive output mistakes before any build or removal. */
export async function assertStagingDirectory(root: string, stagingDir: string): Promise<void> {
  const source = resolve(root);
  const target = resolve(stagingDir);
  const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
  const allowed = join(source, STAGING_DIR);
  if (within(target, source) || (within(source, target) && !within(allowed, target))) {
    fail("unsafe staging path: choose this package's build directory or a dedicated external directory");
  }
  // Check the target AND ancestors, including parents of a not-yet-created path.
  for (let path = target; ; path = dirname(path)) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) fail("unsafe staging path: symlink in output or parent");
      if (!info.isDirectory()) fail("unsafe staging path: output or parent is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(path) === path) break;
  }
  if (!existsSync(target) || (await readdir(target)).length === 0) return;
  let marker: { package?: unknown };
  try { marker = JSON.parse(await readFile(join(target, "bundle-manifest.json"), "utf8")); }
  catch { fail("refusing nonempty staging directory without this package's bundle-manifest.json"); }
  if (marker.package !== PACKAGE_NAME) fail("refusing nonempty staging directory owned by another package");
}

/**
 * Stage the package into `build/pack/dsh-agent-wait`.
 *
 * Clears only that directory, writes the bundle, and re-reads the result so the
 * allowlist assertion runs against bytes on disk rather than intended output.
 * @param options - repository root and staging root overrides (tests).
 * @returns staged paths.
 */
export async function stage(
  options: { root?: string; stagingDir?: string } = {},
): Promise<StageResult> {
  const root = resolve(options.root ?? REPO_ROOT);
  const stagingDir = resolve(options.stagingDir ?? join(root, STAGING_DIR));

  await assertStagingDirectory(root, stagingDir);
  const entry = await buildEntry(root);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const staged: string[] = [];

  const readme = await readFile(join(root, "adapters/dsh-agent-wait/package-readme.md"), "utf8");
  assertNoCrossPathTokens("README.md", readme);
  await writeFile(join(stagingDir, "README.md"), readme);
  staged.push("README.md");

  const manifestText = `${JSON.stringify(packageManifest(), null, 2)}\n`;
  assertNoCrossPathTokens("package.json", manifestText);
  await writeFile(join(stagingDir, "package.json"), manifestText);
  staged.push("package.json");

  const patch = bundlePatch();
  await writeFile(join(stagingDir, "cordis.patch.yml"), patch);
  staged.push("cordis.patch.yml");

  const bundleManifest = {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    engines: { node: ">=24.9.0", dsh: ENGINES_DSH },
    capabilities: { ...CAPABILITY_STATUS },
    supportedDsh: [...SUPPORTED_DSH_VERSIONS],
    defaultDsh: DEFAULT_DSH_VERSION,
  };
  const bundleManifestText = `${JSON.stringify(bundleManifest, null, 2)}\n`;
  assertNoCrossPathTokens("bundle-manifest.json", bundleManifestText);
  await writeFile(join(stagingDir, "bundle-manifest.json"), bundleManifestText);
  staged.push("bundle-manifest.json");

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

  return { stagingDir, files: onDisk, manifest: packageManifest() };
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
