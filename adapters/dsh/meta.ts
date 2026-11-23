/** Package identity and installed capability declarations. No DSH runtime imports. */
import {
  DSH_HOST_IMPORT_PACKAGES,
  DSH_PEER_RANGE,
  ENGINES_DSH,
  SHARED_INSTANCE_PACKAGE,
} from "./compatibility.ts";

export const PACKAGE_NAME = "dsh-ensemble";
export const PACKAGE_VERSION = "1.0.0";
/** Source compatibility during the package transition; not a second product. */
export const PROBE_PACKAGE_NAME = PACKAGE_NAME;
export const PROBE_VERSION = PACKAGE_VERSION;
export { ENGINES_DSH };

export const SKILL_NAME = "ensemble";
export const PROVIDER_NAME = "ensemble";
export const PEER_DEPENDENCIES: Readonly<Record<string, string>> = {
  [SHARED_INSTANCE_PACKAGE]: "~4.1.0",
  "@deepseek-ai/schemastery": "~3.19.0",
  ...Object.fromEntries(DSH_HOST_IMPORT_PACKAGES.map((name) => [name, DSH_PEER_RANGE])),
};

/** Public Client composition dependencies, resolved by DSH's module loader. */
export const CLIENT_INJECT = [
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-sidebar",
] as const;

export const SKILL_DIR = "skills/ensemble";
export const SKILL_FILE = "SKILL.md";
/** Standard DSH bundled-skill rank; local project definitions may override it. */
export const SKILL_RANK = 600;
export const REFERENCE_RESOURCES = [
  "EVOLUTION-TEMPLATE.md",
  "GLOSSARY.md",
  "PATTERNS.md",
  "README.md",
  "STATE-TEMPLATE.md",
] as const;
export type ReferenceResource = (typeof REFERENCE_RESOURCES)[number];
export const OUTPUT_BUDGET_BYTES = 64 * 1024;
export const REFERENCE_TOOL_NAME = "ensemble_reference";

/** Declares the intended installed interfaces, not evidence of release acceptance. */
export const CAPABILITY_STATUS = {
  authorization: "current-owner-and-scoped-session-grants",
  hostRunner: "isolated-local",
  client: "web-and-authenticated-cli",
  modelTools: ["ensemble_work", "ensemble_learn", "ensemble_read", "ensemble_upload"],
  lifecycle: "managed",
  archiveFormat: "ensemble-archive/v2",
} as const;
export const STAGING_DIR = "build/pack/dsh";
