/**
 * The one place that decides which DSH releases this probe supports.
 *
 * Every consumer reads this module: the package manifest (`engines.dsh`, peer
 * ranges), the Host type gate, the profile gate, the isolation gate, the
 * Makefile's install precheck and the packaging allowlist. Nothing else may
 * restate a version literal, because a second copy is how the repository ended
 * up claiming support for one release in six places at once.
 *
 * The set is an *exact* enumeration of releases that were actually exercised
 * here. It is deliberately not a range: `semver.satisfies(runtime, range,
 * { includePrerelease: true })` is what DSH's own compatibility gate runs, and
 * under `includePrerelease` every open range (`>=0.2.2-rc.4`, `^0.2.2-rc.4`)
 * silently admits future prereleases that nobody tested. A closed set fails
 * closed instead: an unknown or future release is refused until it is added
 * here on purpose, with a matrix run behind it.
 *
 * This module imports nothing, so the repository's own `bun test` run and the
 * packaging script can read every constant without a DSH installation.
 *
 * @module adapters/dsh/compatibility
 */

/**
 * DSH releases this probe was built and exercised against, oldest first.
 *
 * Adding a release is a deliberate act: run the full matrix against a real
 * install of it, then add it here. Never add a version merely because it is
 * the current `latest` tag.
 */
export const SUPPORTED_DSH_VERSIONS = ["0.2.2-rc.4", "0.2.2-rc.5"] as const;

/** One supported DSH release. */
export type SupportedDshVersion = (typeof SUPPORTED_DSH_VERSIONS)[number];

/** The release a fresh install, package or document should use by default. */
export const DEFAULT_DSH_VERSION: SupportedDshVersion = "0.2.2-rc.5";

/**
 * `engines.dsh` for the packaged probe, derived from the supported set.
 *
 * DSH's compatibility gate lets an own `engines.dsh` decide alone (peers are
 * then ignored for that gate), and it accepts a semver disjunction of exact
 * versions. Deriving the string from the array means the manifest can never
 * claim a different set than the gates check.
 */
export const ENGINES_DSH: string = SUPPORTED_DSH_VERSIONS.join(" || ");

/**
 * Peer range for the DSH packages the plugin shares with its host.
 *
 * Same value as `engines.dsh`, for a different reason: `dsh plugin add` runs
 * pnpm inside the profile, so an exact-`rc.4` peer would make pnpm install a
 * private `rc.4` copy beside an `rc.5` host. The disjunction lets pnpm dedupe
 * to the host's copy, which is what the shared-instance contract requires.
 */
export const DSH_PEER_RANGE: string = ENGINES_DSH;

/** The DSH runtime package; its version is the release the host runs. */
export const DSH_RUNTIME_PACKAGE = "@deepseek-ai/dsh";

/** DSH packages the plugin shares with its host (shared instances, one copy). */
export const DSH_PEER_PACKAGES = ["@deepseek-ai/dsh-skill", "@deepseek-ai/dsh-tools"] as const;

/**
 * The DSH packages the packaged Host entry actually imports.
 *
 * Declared because the manifest must name every bare specifier the entry leaves
 * external. The Host's runtime resolver can fall back to these, but a manifest
 * that omits one is still wrong: it documents a smaller dependency surface than
 * the code has, and an installer reading it would not know the plugin needs the
 * local subprocess/sandbox providers or the Typert protocol.
 *
 * The local providers are imported by the plugin itself, because the archive's
 * isolated group mounts them; `dsh-typert-protocol` is reached through
 * `dsh-tools`. All four move with the DSH release, so they carry the same
 * disjunction as `engines.dsh`.
 *
 * `@deepseek-ai/dsh-client-connection` is deliberately **not** here. The Host
 * entry does not import it: the CLI does, and the CLI carries its own private
 * bundle of that transport. Declaring it as a dependency made pnpm install an
 * ordinary client package into the profile, which is what shadowed the Host's
 * own connection.
 */
export const DSH_HOST_IMPORT_PACKAGES = [
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-subprocess-local",
  "@deepseek-ai/dsh-sandbox-local",
  "@deepseek-ai/dsh-typert-protocol",
] as const;

/** Every package whose version must agree with the running DSH release. */
export const DSH_RELEASE_PACKAGES = [DSH_RUNTIME_PACKAGE, ...DSH_PEER_PACKAGES] as const;

/** Packages an upstream-version check must be able to resolve at a given release. */
export const DSH_REGISTRY_PACKAGES = DSH_RELEASE_PACKAGES;

/**
 * A shared instance that is *not* a DSH release.
 *
 * `@deepseek-ai/cordis` is pinned to `~4.1.0` independently of the DSH version
 * and legitimately differs between packages. It is named here so a consistency
 * check cannot mistake it for a mixed DSH install.
 */
export const SHARED_INSTANCE_PACKAGE = "@deepseek-ai/cordis";

/**
 * Whether an observed version string is one of the tested releases.
 *
 * Exact membership only: no prefix, range or `latest` matching, so an
 * unreadable, missing or future version is false rather than "close enough".
 * @param value - any value read from a manifest or registry.
 * @returns true only for an exact member of {@link SUPPORTED_DSH_VERSIONS}.
 */
export function isSupportedDshVersion(value: unknown): value is SupportedDshVersion {
  return typeof value === "string" && (SUPPORTED_DSH_VERSIONS as readonly string[]).includes(value);
}

/** The supported set as one human-readable phrase: `a or b`. */
export function supportedVersionsText(): string {
  return SUPPORTED_DSH_VERSIONS.join(" or ");
}

/** One package version read from an install tree or a registry document. */
export interface ReleaseReading {
  readonly package: string;
  /** `undefined` when the package is absent or its manifest is unreadable. */
  readonly version: string | undefined;
}

/** The outcome of judging a set of readings; `problems` is empty only when `ok`. */
export interface ReleaseVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Judge the DSH packages found in one install tree.
 *
 * Three failures, all closed:
 * - a required package is absent or has no readable version;
 * - a present package is outside the tested set (unknown, future or malformed);
 * - two present packages report different releases (a mixed install, e.g. a
 *   probe-private `rc.4` copy beside an `rc.5` host).
 *
 * `require` names only what the caller actually needs: the Makefile precheck
 * anchors on `dsh-skill`, the type gate needs all three, and the Loader gate
 * does not need `typescript`.
 * @param readings - versions read for the packages of interest.
 * @param options.require - package names that must be present and readable.
 * @returns the verdict and one message per problem.
 */
export function judgeReleases(
  readings: readonly ReleaseReading[],
  options: { readonly require?: readonly string[] } = {},
): ReleaseVerdict {
  const problems: string[] = [];
  const seen = new Map<string, string | undefined>();
  for (const reading of readings) seen.set(reading.package, reading.version);

  for (const name of options.require ?? []) {
    if (!seen.has(name)) {
      problems.push(`${name} is not installed in this directory`);
      continue;
    }
    if (seen.get(name) === undefined) problems.push(`${name} has no readable version`);
  }

  const present = readings.filter(
    (reading): reading is { readonly package: string; readonly version: string } =>
      reading.version !== undefined,
  );
  for (const reading of present) {
    if (isSupportedDshVersion(reading.version)) continue;
    problems.push(
      `${reading.package}@${reading.version} is outside the tested DSH set (${supportedVersionsText()})`,
    );
  }

  const distinct = [...new Set(present.map((reading) => reading.version))];
  if (distinct.length > 1) {
    problems.push(
      `mixed DSH releases in one install: ${present.map((r) => `${r.package}@${r.version}`).join(", ")}`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Judge the private peer copies a package manager may have placed inside the
 * probe package instead of deduping to the host's copy.
 *
 * A nested copy is the concrete shape of a mixed install: the plugin's own
 * `import "@deepseek-ai/dsh-skill"` would resolve to that copy, so the plugin
 * would run against a different release than the host it was loaded into.
 * `@deepseek-ai/cordis` is not a DSH release and is never passed here.
 * @param host - versions the install tree provides.
 * @param shadow - versions found inside the probe package.
 * @returns the verdict; empty when there are no nested copies.
 */
export function judgeProbeShadow(
  host: readonly ReleaseReading[],
  shadow: readonly ReleaseReading[],
): ReleaseVerdict {
  const problems: string[] = [];
  const hostVersions = new Map<string, string | undefined>();
  for (const reading of host) hostVersions.set(reading.package, reading.version);

  for (const reading of shadow) {
    if (reading.version === undefined) continue;
    const provided = hostVersions.get(reading.package);
    if (provided === reading.version) continue;
    problems.push(
      `dsh-ensemble-probe has a private ${reading.package}@${reading.version} copy while the install ` +
        `provides ${provided === undefined ? "no copy" : `${reading.package}@${provided}`}; ` +
        "the plugin would load a different DSH release than the host",
    );
  }
  return { ok: problems.length === 0, problems };
}
