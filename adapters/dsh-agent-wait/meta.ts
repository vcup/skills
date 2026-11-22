/**
 * Identity and closed-set constants for the DSH subagent-wait plugin.
 *
 * Like `adapters/dsh/meta.ts`, this module imports nothing from the DSH
 * packages, so the repository's own `bun test` run and the packaging script can
 * read every declared name, peer, and version without a DSH installation
 * present. `index.ts` is the only file in this directory that imports
 * `@deepseek-ai/*`.
 *
 * The supported DSH release set is **this plugin's own decision**, not the
 * ensemble probe's. Each plugin exercises its own matrix and may widen or drop
 * releases independently; borrowing the ensemble's array would make a future
 * ensemble-only change silently move this plugin's `engines.dsh`. Shared
 * runtime package identifiers carry no coupling to another plugin.
 *
 * @module adapters/dsh-agent-wait/meta
 */


/** Package name of the installable subagent-wait bundle. */
export const PACKAGE_NAME = "dsh-agent-wait";

/**
 * Plugin version. Independent of the ensemble probe and of the DSH release.
 *
 * A capability change must ship under a new version: `dsh plugin list` cannot
 * tell a same-version rebuild apart.
 */
export const PACKAGE_VERSION = "1.0.0";

/** Plugin name registered in the Cordis bundle. */
export const PLUGIN_NAME = "agent-wait";

/** Cordis service dependencies the plugin requires before `apply`. */
export const INJECT = ["tools", "subagents", "agents"];

/** The one model-facing tool this plugin registers. */
export const TOOL_NAME = "wait_subagents";

/**
 * DSH releases this plugin was built and exercised against, oldest first.
 *
 * This is an explicit enumeration, not a range: `semver.satisfies` with
 * `includePrerelease` would admit a future prerelease nobody tested. A new
 * release is added here only after this plugin's own matrix passes against it.
 * The list is deliberately independent of the ensemble probe's supported set.
 */
export const SUPPORTED_DSH_VERSIONS = ["0.2.2-rc.4", "0.2.2-rc.5"] as const;

/** One supported DSH release. */
export type SupportedDshVersion = (typeof SUPPORTED_DSH_VERSIONS)[number];

/** The release a fresh install should use by default. */
export const DEFAULT_DSH_VERSION: SupportedDshVersion = "0.2.2-rc.5";

/**
 * `engines.dsh` for the packaged plugin, derived from the supported set.
 *
 * DSH's compatibility gate lets an own `engines.dsh` decide alone, and it
 * accepts a semver disjunction of exact versions. Deriving the string from the
 * array means the manifest can never claim a different set than the matrix ran.
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

/**
 * Shared-instance DSH packages the plugin imports; must match the host's copies.
 *
 * `subagents` (the seam), `agent` (live status/disposal), `llm` (HarnessError)
 * and `tools` (tool definition + exec context) are the imported packages. They
 * carry the same disjunction as `engines.dsh` so pnpm dedupes to the host's
 * copy; `cordis` is a separate shared instance whose range does not move with
 * the DSH release.
 */
export const PEER_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@deepseek-ai/cordis": "~4.1.0",
  "@deepseek-ai/dsh-agent": DSH_PEER_RANGE,
  "@deepseek-ai/dsh-llm": DSH_PEER_RANGE,
  "@deepseek-ai/dsh-subagent": DSH_PEER_RANGE,
  "@deepseek-ai/dsh-tools": DSH_PEER_RANGE,
};

/**
 * What this package does, recorded in the installed manifest.
 *
 * `authorization` names the only trust surface: this plugin performs no
 * writes and no authority checks of its own, and reads only the caller's own
 * subagent tree, so it has no owner surface. `modelTools` records the single
 * model-facing tool. `lifecycle` is `wait-only`: version 1.0 does not claim
 * a complete coordination product.
 */
export const CAPABILITY_STATUS = {
  authorization: "caller-tree-only",
  hostRunner: "none",
  client: "none",
  modelTools: TOOL_NAME,
  lifecycle: "wait-only",
} as const;

/** Staging directory of the packaged artifact, relative to the repository root. */
export const STAGING_DIR = "build/pack/dsh-agent-wait";

/** Human-readable release list, derived only from this package’s matrix. */
export function supportedVersionsText(): string { return SUPPORTED_DSH_VERSIONS.join(" and "); }
