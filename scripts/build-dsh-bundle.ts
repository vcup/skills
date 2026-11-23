/**
 * Build the CLI's private transport bundle.
 *
 * ## Why a bundle at all
 *
 * `lib/transport.mjs` imports `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-client-connection/client` as bare specifiers. In the Host
 * those resolve through the Host's own resolver, but the CLI runs as a **Node
 * process started from the installed package**, outside any DSH profile, and
 * there is nothing there to resolve them: the profile tree has no `cordis`, and
 * an ordinary `dsh-client-connection` dependency installed *into* the profile is
 * exactly what shadows the Host's connection instance. So the CLI carries its
 * own copy, in one file, and imports nothing bare but Node builtins.
 *
 * ## What is in it, and what must not be
 *
 * The closure is small and closed:
 *
 * ```text
 * lib/transport.mjs
 *   @deepseek-ai/cordis/lib/index.js
 *     @deepseek-ai/cosmokit/lib/index.js
 *   @deepseek-ai/dsh-client-connection/lib/client.node.js
 *     @deepseek-ai/schemastery/lib/index.mjs
 * ```
 *
 * `client.node.js` is the only entry point that matters and its single bare
 * import is `@deepseek-ai/schemastery`; `cordis` pulls `cosmokit`. Nothing from
 * the Host side is in it — no gateway, no `Peer`, no credentials, no scope, no
 * brand — and `assertBundleClosure` fails the build if any of those appear,
 * because a client that could assemble its own principal would prove nothing
 * about the transport.
 *
 * Both supported releases ship a byte-identical `client.node.js` (same SHA-256),
 * so the bundle is version-independent; `assertBundleClosure` records the inputs
 * it was built from so a reader can check that claim instead of trusting it.
 *
 * ## Reproducibility
 *
 * The bundle is generated from **published package inputs**, never from a
 * private path. The inputs come from a DSH install tree the caller names
 * explicitly (`DSH_BUNDLE_INSTALL`), and the result is written to
 * `adapters/dsh/lib/transport.bundle.mjs` with its provenance in
 * `adapters/dsh/lib/transport.bundle.json`. `make pack` only *reads* the
 * committed bundle, so packaging stays offline and reproducible; regenerating is
 * an explicit act:
 *
 * ```bash
 * make dsh-bundle DSH_BUNDLE_INSTALL=<isolated DSH install>
 * ```
 *
 * A missing install is a loud failure, not a silent fallback to whatever
 * `node_modules` happens to exist.
 *
 * @module scripts/build-dsh-bundle
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The reviewed entry point of the bundle. */
export const BUNDLE_ENTRY = "adapters/dsh/lib/transport.mjs";
export const BUNDLE_GENERATOR = "scripts/build-dsh-bundle.ts";

/** Where the generated bundle and its provenance live. */
export const BUNDLE_OUTPUT = "adapters/dsh/lib/transport.bundle.mjs";
export const BUNDLE_PROVENANCE = "adapters/dsh/lib/transport.bundle.json";

/** The environment variable that names the install to build from. */
export const BUNDLE_INSTALL_ENV = "DSH_BUNDLE_INSTALL";

/**
 * An optional second install of the other supported release.
 *
 * When set, the build proves the bundle is byte-identical from both before
 * writing it: the committed artifact must not depend on which install a
 * maintainer happened to build from.
 */
export const BUNDLE_REFERENCE_ENV = "DSH_BUNDLE_REFERENCE_INSTALL";

/**
 * The complete set of packages the bundle may contain, in resolution order.
 *
 * Listed rather than discovered so a new transitive dependency shows up as a
 * build failure to review, not as an unnoticed extra copy of something.
 */
export const BUNDLE_PACKAGES = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/cosmokit",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/schemastery",
] as const;

/**
 * Packages whose presence in the bundle means the build is wrong.
 *
 * The client must not be able to construct a principal or reach into the Host,
 * and the Host-side packages are shared instances the CLI has no business
 * copying: if one appears, the entry point started pulling from the wrong side.
 */
export const FORBIDDEN_IN_BUNDLE = [
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-typert-protocol",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-subprocess-local",
  "@deepseek-ai/dsh-sandbox-local",
] as const;

/** A build or verification failure a maintainer must act on. */
export class BundleError extends Error {
  override readonly name = "BundleError";
}

function fail(message: string): never {
  throw new BundleError(message);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What the provenance file records about one build. */
export interface BundleProvenance {
  readonly entry: string;
  readonly entrySha256: string;
  readonly generatorSha256: string;
  readonly bunVersion: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Every package that contributed code, with the version and file resolved. */
  readonly inputs: readonly { readonly package: string; readonly version: string; readonly path: string; readonly sha256: string }[];
  /** Bare specifiers still present in the output; only `node:` builtins may appear. */
  readonly externals: readonly string[];
  /** The bundle format, so a reader can tell a regeneration from a reword. */
  readonly format: string;
}

/** The generated bundle and the provenance that describes it. */
export interface BundleResult {
  readonly code: string;
  readonly provenance: BundleProvenance;
}

/**
 * Resolve the install to build from, failing loudly when it is absent.
 *
 * Deliberately explicit: a relative value is resolved against this module, and
 * an install without `cordis` is not a DSH install. Silently falling back to the
 * repository's own `node_modules` would produce a bundle from an unrelated tree.
 * @param raw - the `DSH_BUNDLE_INSTALL` value.
 * @returns the absolute install directory.
 */
export function resolveBundleInstall(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    fail(
      `building the CLI bundle needs an isolated DSH install: set ${BUNDLE_INSTALL_ENV} to one ` +
        "(for example the install a supported release was tested against). " +
        "Nothing was built, so no bundle was written from an unknown tree.",
    );
  }
  const absolute = resolve(raw);
  if (!existsSync(join(absolute, "node_modules/@deepseek-ai/cordis/package.json"))) {
    fail(
      `${BUNDLE_INSTALL_ENV}=${absolute} is not an isolated DSH install: ` +
        "no @deepseek-ai/cordis in its node_modules",
    );
  }
  return absolute;
}

/** The version of one installed package, read from its own manifest. */
function installedVersion(install: string, name: string): string {
  const manifest = join(install, "node_modules", name, "package.json");
  if (!existsSync(manifest)) fail(`${name} is not installed in ${install}`);
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
  if (typeof parsed.version !== "string") fail(`${name} in ${install} has no version`);
  return parsed.version;
}

/**
 * Build the bundle from one named install.
 *
 * The resolver is pinned to that install, so a bare specifier can only resolve
 * to the tree the caller named — the repository's own `node_modules` cannot
 * satisfy it by accident.
 * @param options.install - absolute DSH install directory.
 * @returns the bundle source and its provenance.
 */
export async function buildBundle(options: { readonly install: string }): Promise<BundleResult> {
  const install = options.install;
  const require = createRequire(join(install, "package.json"));
  const resolved = new Map<string, string>();

  const built = await Bun.build({
    entrypoints: [join(REPO_ROOT, BUNDLE_ENTRY)],
    target: "node",
    format: "esm",
    external: [],
    plugins: [
      {
        name: "resolve-from-named-install",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            // Relative and absolute paths belong to the entry itself; Node
            // builtins must stay external or the bundle would inline them.
            if (args.path.startsWith(".") || args.path.startsWith("/") || args.path.startsWith("node:")) {
              return undefined;
            }
            let path: string;
            try {
              path = require.resolve(args.path);
            } catch {
              // Bun reports a plugin failure through a thrown value; a result
              // with an empty `path` is not a valid resolve result.
              throw new BundleError(
                `could not resolve ${args.path} from ${install}; is that the right install?`,
              );
            }
            resolved.set(args.path, path);
            return { path };
          });
        },
      },
    ],
  });
  if (!built.success || built.outputs.length !== 1) {
    fail(`bun build failed for ${BUNDLE_ENTRY}: ${built.logs.map(String).join("; ")}`);
  }
  const output = built.outputs[0];
  if (output === undefined) fail(`bun build produced no output for ${BUNDLE_ENTRY}`);
  const code = normaliseSourceComments(await output.text(), install);

  const externals = [...code.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']/g)]
    .map((match) => match[1] as string)
    .concat([...code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] as string))
    .filter((specifier) => !specifier.startsWith("."));
  const uniqueExternals = [...new Set(externals)].sort();

  const inputs = [...resolved.entries()]
    .map(([specifier, path]) => {
      // The package a resolved file belongs to: the segment after `node_modules`.
      const parts = path.split(/[/\\]node_modules[/\\]/);
      const tail = parts[parts.length - 1] as string;
      const segments = tail.split(/[/\\]/);
      const name = segments[0]?.startsWith("@") ? `${segments[0]}/${segments[1]}` : (segments[0] as string);
      return {
        package: name,
        version: installedVersion(install, name),
        path: path.slice(install.length + 1),
        sha256: sha256(readFileSync(path, "utf8")),
      };
    })
    .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));

  const provenance: BundleProvenance = {
    format: "dsh-cli-bundle/v2",
    entry: BUNDLE_ENTRY,
    entrySha256: sha256(readFileSync(join(REPO_ROOT, BUNDLE_ENTRY), "utf8")),
    generatorSha256: sha256(readFileSync(join(REPO_ROOT, BUNDLE_GENERATOR), "utf8")),
    bunVersion: Bun.version,
    bytes: Buffer.byteLength(code, "utf8"),
    sha256: sha256(code),
    inputs,
    externals: uniqueExternals,
  };

  assertBundleClosure(code, provenance);
  return { code, provenance };
}

/**
 * Strip the build machine's paths out of Bun's source comments.
 *
 * `Bun.build` prefixes each inlined module with a comment naming the file it
 * came from, rendered relative to the build's working directory. Keeping that
 * would make the committed bundle differ between two installs of the same
 * release — it would record where the maintainer happened to put the tree, and
 * publish a private path in a shipped artifact. Rewriting to the path inside the
 * install keeps the provenance readable and makes the bundle a function of the
 * inputs alone.
 * @param code - the raw bundle source.
 * @param install - the install the build resolved from.
 * @returns the bundle with install-relative source comments.
 */
export function normaliseSourceComments(code: string, install: string): string {
  const marker = "/node_modules/";
  return code
    .split("\n")
    .map((line) => {
      if (!line.startsWith("// ") || !line.includes(marker)) return line;
      const at = line.indexOf(marker);
      return `// node_modules/${line.slice(at + marker.length)}`;
    })
    .join("\n");
}

/**
 * Refuse a bundle that is not the closed transport closure.
 *
 * Three checks, each a different way the build goes wrong:
 * 1. a bare specifier survived, so the CLI would need a resolver it does not
 *    have — the original defect;
 * 2. a package outside {@link BUNDLE_PACKAGES} got in, which means the entry
 *    started importing something it should not;
 * 3. a {@link FORBIDDEN_IN_BUNDLE} package got in, which means the client can
 *    reach the Host side and the transport claim would be false.
 * @param code - the bundle source.
 * @param provenance - what the build resolved.
 */
export function assertBundleClosure(code: string, provenance: BundleProvenance): void {
  const actual = [...new Set(new Bun.Transpiler({ loader: "js" }).scanImports(code).map((item) => item.path))].sort();
  const bare = [...new Set([...provenance.externals, ...actual])].filter((specifier) => !specifier.startsWith("node:"));
  if (bare.length > 0) {
    fail(
      `the CLI bundle still needs ${bare.join(", ")} at run time; the package must import nothing bare ` +
        "but Node builtins, or it cannot run from an installed package outside a DSH profile",
    );
  }
  if (JSON.stringify(actual) !== JSON.stringify([...provenance.externals].sort())) {
    fail("the CLI bundle imports do not match its recorded externals");
  }
  const packages = provenance.inputs.map((input) => input.package);
  const forbidden = packages.filter((name) => (FORBIDDEN_IN_BUNDLE as readonly string[]).includes(name));
  if (forbidden.length > 0) {
    fail(
      `the CLI bundle contains ${forbidden.join(", ")}, which belongs to the Host side; ` +
        "a client that can construct a principal or reach the gateway proves nothing about the transport",
    );
  }
  const unexpected = [...new Set(packages)].filter((name) => !(BUNDLE_PACKAGES as readonly string[]).includes(name));
  if (unexpected.length > 0) {
    fail(
      `the CLI bundle resolved ${unexpected.join(", ")}, which is not part of the declared transport closure; ` +
        "review the entry point before adding it",
    );
  }
  for (const name of BUNDLE_PACKAGES) {
    if (!packages.includes(name)) fail(`the CLI bundle is missing the recorded input ${name}`);
  }
  if (!code.includes("installConnection")) {
    fail("the CLI bundle does not contain the client transport it exists to provide");
  }
}

/**
 * Refuse a build whose bytes depend on which supported release it came from.
 *
 * The bundle is committed, so two maintainers building from two supported
 * releases must get the same file or the repository churns for no reason. The
 * two releases ship a byte-identical `client.node.js`; if that ever stops being
 * true, this is where it surfaces — as a build failure to review, not as a
 * mystery diff.
 * @param result - the build under test.
 * @param reference - a build from the other supported release.
 */
export function assertInstallIndependent(result: BundleResult, reference: BundleResult): void {
  if (result.code !== reference.code) {
    const differing = result.provenance.inputs
      .filter((input) => {
        const other = reference.provenance.inputs.find((candidate) => candidate.package === input.package);
        return other === undefined || other.sha256 !== input.sha256;
      })
      .map((input) => input.package);
    fail(
      "the CLI bundle differs between the two supported releases, so it is not install-independent" +
        (differing.length > 0 ? `: ${differing.join(", ")} changed` : "") +
        "; a committed artifact cannot depend on which install built it",
    );
  }
}

/** Render the provenance as the committed JSON file. */
export function renderProvenance(provenance: BundleProvenance): string {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

/**
 * Render the bundle.
 *
 * The header deliberately names **no input version**. The bundle's whole claim
 * is that it does not depend on which supported release it was built from — the
 * two releases ship a byte-identical `client.node.js` — so putting the resolved
 * version in the file would make two maintainers produce different bytes from
 * the same source, and would turn a reproducibility property into a diff. The
 * versions, paths and digests of what was actually bundled live in
 * `transport.bundle.json`, which is the file to read when you want to know where
 * a build came from.
 *
 * The body digest stays: it is a function of the body alone, so it is stable
 * across installs and catches a hand edit.
 * @param result - the generated code and its provenance.
 * @returns the file to write.
 */
export function renderBundle(result: BundleResult): string {
  return [
    "// Generated by scripts/build-dsh-bundle.ts — do not edit.",
    "//",
    "// The CLI's private copy of the DSH client transport, so it can run from an",
    "// installed package as a plain Node process: no bare specifiers, no profile",
    "// resolver, and nothing from the Host side. The packages and versions this",
    "// was built from are recorded in transport.bundle.json.",
    `// sha256: ${result.provenance.sha256}`,
    "",
    result.code,
  ].join("\n");
}

/**
 * Read the committed bundle, failing when it is absent or has drifted.
 * @param options.root - repository root; defaults to this checkout.
 * @returns the bundle body and its provenance.
 */
export function readCommittedBundle(options: { readonly root?: string } = {}): {
  readonly code: string;
  readonly provenance: BundleProvenance;
} {
  const root = options.root ?? REPO_ROOT;
  const codePath = join(root, BUNDLE_OUTPUT);
  const provenancePath = join(root, BUNDLE_PROVENANCE);
  if (!existsSync(codePath) || !existsSync(provenancePath)) {
    fail(
      `the CLI bundle is not built: expected ${BUNDLE_OUTPUT} and ${BUNDLE_PROVENANCE}. ` +
        `Regenerate it with \`make dsh-bundle ${BUNDLE_INSTALL_ENV}=<isolated DSH install>\`.`,
    );
  }
  const code = readFileSync(codePath, "utf8");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as BundleProvenance;
  if (!provenance || provenance.format !== "dsh-cli-bundle/v2" || provenance.entry !== BUNDLE_ENTRY ||
      typeof provenance.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(provenance.sha256) ||
      !Number.isSafeInteger(provenance.bytes) || provenance.bytes < 0 ||
      !Array.isArray(provenance.inputs) || !provenance.inputs.every((input) => input &&
        typeof input.package === "string" && typeof input.version === "string" &&
        typeof input.path === "string" && typeof input.sha256 === "string" && /^[a-f0-9]{64}$/.test(input.sha256)) ||
      !Array.isArray(provenance.externals) || !provenance.externals.every((item) => typeof item === "string")) {
    fail("the CLI bundle provenance is malformed or unsupported; regenerate with make dsh-bundle");
  }
  for (const [path, expected, label] of [
    [BUNDLE_ENTRY, provenance.entrySha256, "reviewed transport source"],
    [BUNDLE_GENERATOR, provenance.generatorSha256, "generator"],
  ] as const) {
    if (!existsSync(join(root, path)) || sha256(readFileSync(join(root, path), "utf8")) !== expected) {
      fail(`the CLI bundle ${label} changed; regenerate with make dsh-bundle`);
    }
  }
  if (code.indexOf("\n\n") < 0) fail("the CLI bundle generated header is missing");
  const body = code.slice(code.indexOf("\n\n") + 2);
  if (sha256(body) !== provenance.sha256 || Buffer.byteLength(body, "utf8") !== provenance.bytes) {
    fail(
      `${BUNDLE_OUTPUT} does not match the digest in ${BUNDLE_PROVENANCE}: ` +
        `the file was edited by hand or half-written. Regenerate it with \`make dsh-bundle\`.`,
    );
  }
  assertBundleClosure(body, provenance);
  return { code: body, provenance };
}

/** Write the bundle and its provenance into the repository. */
export async function writeBundle(result: BundleResult): Promise<void> {
  await Bun.write(join(REPO_ROOT, BUNDLE_OUTPUT), renderBundle(result));
  await Bun.write(join(REPO_ROOT, BUNDLE_PROVENANCE), renderProvenance(result.provenance));
}

if (import.meta.main) {
  const install = resolveBundleInstall(process.env[BUNDLE_INSTALL_ENV]);
  const result = await buildBundle({ install });

  // When a second install is named, prove the bundle does not depend on which
  // supported release produced it before writing anything. This is the check
  // that keeps the committed artifact reproducible; a maintainer with both
  // installs available gets it for free.
  const other = process.env[BUNDLE_REFERENCE_ENV];
  if (other !== undefined && other.trim() !== "") {
    const reference = await buildBundle({ install: resolveBundleInstall(other) });
    assertInstallIndependent(result, reference);
    process.stdout.write("== dsh-bundle: identical across both named installs\n");
  }

  await writeBundle(result);
  process.stdout.write(
    `== dsh-bundle: wrote ${BUNDLE_OUTPUT} (${result.provenance.bytes} bytes, ${result.provenance.inputs.length} inputs)\n`,
  );
  for (const input of result.provenance.inputs) {
    process.stdout.write(`   ${input.package}@${input.version}  ${input.path}\n`);
  }
}
