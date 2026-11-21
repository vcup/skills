/**
 * Identity and closed-set constants for the DSH ensemble probe.
 *
 * This module imports nothing from the DSH packages, so the repository's own
 * `bun test` run and the packaging script can read every declared name, peer,
 * resource and budget without a DSH installation present. `index.ts` is the
 * only file in this directory that imports `@deepseek-ai/*`.
 *
 * Which DSH releases are supported is *not* declared here: it lives in
 * `./compatibility.ts`, which every gate and the package manifest read. This
 * module re-exports the manifest-facing values so there is exactly one source
 * and no second list to keep in step.
 *
 * @module adapters/dsh/meta
 */

import {
  DSH_HOST_IMPORT_PACKAGES,
  DSH_PEER_RANGE,
  ENGINES_DSH,
  SHARED_INSTANCE_PACKAGE,
} from "./compatibility.ts";

/** Package name of the installable probe bundle. */
export const PROBE_PACKAGE_NAME = "dsh-ensemble-probe";

/**
 * Probe version. Independent of the ensemble content version.
 *
 * 0.1.1 added support for `0.2.2-rc.5`; 0.1.0 supported only `0.2.2-rc.4`. 0.2.0
 * added the owner archive surface and the independent Host-local runner seam.
 * 0.3.0 adds the `ensemble-archive` CLI, which is what makes that surface
 * reachable for someone who installed the package: until then the Remote existed
 * but only a hand-written client could call it.
 *
 * Every capability change ships under a new version, because `dsh plugin list`
 * cannot tell a same-version rebuild apart.
 */
export const PROBE_VERSION = "0.3.0";

/**
 * The `engines.dsh` range written into the package manifest: the tested set as
 * a semver disjunction of exact versions, so a future release is refused
 * instead of silently admitted.
 */
export { ENGINES_DSH };

/** Registered skill name. Matches the content build's frontmatter `name`. */
export const SKILL_NAME = "ensemble";

/** Skill provider name registered in `ctx.skills`. */
export const PROVIDER_NAME = "ensemble-probe";

/**
 * Shared-instance DSH packages the probe imports; must match the host's copies.
 *
 * Every package the packaged Host entry imports is listed, each carrying the
 * same disjunction as `engines.dsh` so pnpm dedupes to the host's copy rather
 * than installing a private one; `cordis` is a separate shared instance whose
 * range does not move with the DSH release.
 *
 * These stay peers, and `cordis` is *not* promoted to a normal dependency: the
 * Host supplies all of them through its runtime resolver, and the CLI gets
 * Cordis from its own private bundle. A normal dependency here would install a
 * second copy beside the host's, which is the mixed-install shape the whole
 * compatibility gate exists to refuse.
 */
export const PEER_DEPENDENCIES: Readonly<Record<string, string>> = {
  [SHARED_INSTANCE_PACKAGE]: "~4.1.0",
  ...Object.fromEntries(DSH_HOST_IMPORT_PACKAGES.map((name) => [name, DSH_PEER_RANGE])),
};

/** Bundled skill directory, relative to the installed package root. */
export const SKILL_DIR = "skills/ensemble";

/** Instruction file inside the bundled skill directory. */
export const SKILL_FILE = "SKILL.md";

/**
 * Precedence rank for a packaged skill provider.
 *
 * Source: `@deepseek-ai/dsh-skill`, `BUNDLED_SKILL_RANK = 600`
 * (`packages/skill/skill/src/index.ts` line 28), documented as the standard
 * rank for packaged providers and local bundled roots. The value is unchanged
 * across the supported releases. A project-local source (rank 100 in
 * `dsh-skill-filesystem`) therefore outranks this bundle, and the registry
 * keeps one winning definition per name instead of merging bodies.
 */
export const SKILL_RANK = 600;

/**
 * Model-facing reference resources, in the fixed enumeration order the
 * `ensemble_reference` tool exposes. The five non-instruction files of the
 * generated DSH artifact; `SKILL.md` is loaded through the skill provider and
 * is never addressable here.
 */
export const REFERENCE_RESOURCES = [
  "EVOLUTION-TEMPLATE.md",
  "GLOSSARY.md",
  "PATTERNS.md",
  "README.md",
  "STATE-TEMPLATE.md",
] as const;

/** One addressable reference resource name. */
export type ReferenceResource = (typeof REFERENCE_RESOURCES)[number];

/**
 * Maximum bytes returned by one `ensemble_reference` call. The probe has no
 * pagination: a larger resource fails explicitly rather than truncating.
 */
export const OUTPUT_BUDGET_BYTES = 64 * 1024;

/** Tool name registered for reading one enumerated reference. */
export const REFERENCE_TOOL_NAME = "ensemble_reference";

/**
 * What this package does and does not do, recorded in the manifest.
 *
 * These are explicit so a reader of the installed package cannot mistake the
 * owner archive surface for a complete product: `authorization` names the only
 * authority that exists (the authenticated owner), and `modelTools` records that
 * no model-facing domain tool is registered in this version.
 */
export const CAPABILITY_STATUS = {
  /** Only an authenticated owner Remote call may manage the archive. */
  authorization: "owner-only",
  /** Git runs in the plugin's own isolated local subprocess/sandbox group. */
  hostRunner: "isolated",
  /** A packaged CLI reaches the Remote over the Host's own client transport. */
  client: "bin/ensemble-archive",
  /** No model tool acts as owner, and no model domain write exists yet. */
  modelTools: "none",
  /** The product surface is still bounded; see the package README. */
  lifecycle: "bounded",
} as const;

/** Staging directory of the packaged artifact, relative to the repository root. */
export const STAGING_DIR = "build/pack/dsh";
