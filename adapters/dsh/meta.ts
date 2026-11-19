/**
 * Identity and closed-set constants for the DSH ensemble probe.
 *
 * This module imports nothing from the DSH packages, so the repository's own
 * `bun test` run and the packaging script can read every declared name, peer,
 * resource and budget without a DSH installation present. `index.ts` is the
 * only file in this directory that imports `@deepseek-ai/*`.
 *
 * @module adapters/dsh/meta
 */

/** Package name of the installable probe bundle. */
export const PROBE_PACKAGE_NAME = "dsh-ensemble-probe";

/** Probe version. Independent of the ensemble content version. */
export const PROBE_VERSION = "0.1.0";

/**
 * The only DSH release this probe was built and exercised against.
 * IMPLEMENTATION.md §4 requires the first slice to lock `0.2.2-rc.4`; a
 * floating range would claim coverage no run supports.
 */
export const ENGINES_DSH = "0.2.2-rc.4";

/** Shared-instance DSH packages the probe imports; must match the host's copies. */
export const PEER_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@deepseek-ai/cordis": "~4.1.0",
  "@deepseek-ai/dsh-skill": "0.2.2-rc.4",
  "@deepseek-ai/dsh-tools": "0.2.2-rc.4",
};

/** Registered skill name. Matches the content build's frontmatter `name`. */
export const SKILL_NAME = "ensemble";

/** Skill provider name registered in `ctx.skills`. */
export const PROVIDER_NAME = "ensemble-probe";

/** Bundled skill directory, relative to the installed package root. */
export const SKILL_DIR = "skills/ensemble";

/** Instruction file inside the bundled skill directory. */
export const SKILL_FILE = "SKILL.md";

/**
 * Precedence rank for a packaged skill provider.
 *
 * Source: rc.4 `@deepseek-ai/dsh-skill`, `BUNDLED_SKILL_RANK = 600`
 * (`packages/skill/skill/src/index.ts` line 28), documented as the standard
 * rank for packaged providers and local bundled roots. A project-local source
 * (rank 100 in `dsh-skill-filesystem`) therefore outranks this bundle, and the
 * registry keeps one winning definition per name instead of merging bodies.
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

/** Staging directory of the packaged artifact, relative to the repository root. */
export const STAGING_DIR = "build/pack/dsh";
