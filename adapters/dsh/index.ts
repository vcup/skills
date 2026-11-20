/**
 * DSH ensemble probe — a Host-only P1 technical probe.
 *
 * Supported DSH releases are declared once, in `./compatibility.ts`; the
 * package manifest's `engines.dsh` and every gate read that module.
 *
 * What this plugin does, and all it does:
 *
 * 1. registers one **user-invocable** skill provider (`ensemble`) whose body is
 *    the generated DSH artifact bundled in this package;
 * 2. registers one model-facing tool, `ensemble_reference`, that reads back a
 *    fixed enumeration of packaged reference files.
 *
 * It deliberately implements none of the managed product: there is no domain
 * tool set, no external archive, no Git access, no authorization board, no
 * learning publication, no Client/UI half, and no model-selection policy. The
 * bundled method text says the same thing in its `Capability status` section.
 *
 * Only this module imports `@deepseek-ai/*`; the parsing, allowlist and budget
 * logic live in dependency-free siblings so they are tested without a DSH
 * installation.
 *
 * @module adapters/dsh
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-skill";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  OUTPUT_BUDGET_BYTES,
  REFERENCE_RESOURCES,
  REFERENCE_TOOL_NAME,
  SKILL_DIR,
  SKILL_FILE,
} from "./meta.ts";
import { createReferenceReader, ReferenceError, type ReferenceContent } from "./reference.ts";
import { createSkillProvider } from "./skill.ts";

export const name = "ensemble-probe";
export const inject = ["skills", "tools"];

/**
 * Directory of the installed package.
 *
 * The packaging step bundles this plugin to `<package root>/index.js`, so the
 * module directory is the package root. Reading it from the module URL keeps
 * the plugin free of any hard-coded installation path.
 * @param moduleUrl - module URL to anchor on; defaults to this module.
 * @returns the absolute directory containing the entry module.
 */
export function packageRoot(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL(".", moduleUrl));
}

/** Resource-base wording shown to the model; it carries no host path. */
export const RESOURCE_DESCRIPTION =
  `this package's ${SKILL_DIR} directory: ${REFERENCE_RESOURCES.length} reference files, ` +
  `readable through ${REFERENCE_TOOL_NAME} (fixed enumeration; no path input)`;

/** Where the plugin reads its bundled artifact from. */
export interface ApplyOptions {
  /** Absolute path of the installed `skills/ensemble` directory. */
  readonly skillDir: string;
}

/**
 * Register the bundled skill provider and the reference reader tool.
 *
 * Both registrations are Cordis effects of this plugin's fiber: unloading the
 * plugin disposes them, and a second plugin instance in the same layer fails
 * loudly instead of silently merging two skill sources.
 * @param ctx - plugin context; `skills` and `tools` are ready before `apply`.
 * @param options - installed skill directory; defaults to this package's copy.
 */
export function applyWith(ctx: Context, options: ApplyOptions): void {
  ctx.skills.registerProvider(() =>
    createSkillProvider({
      skillDir: options.skillDir,
      skillFile: SKILL_FILE,
      resourceDescription: RESOURCE_DESCRIPTION,
    }),
  );

  // One reader per plugin instance. Construction is lazy so a missing package
  // directory surfaces as a tool failure naming the resource, rather than as a
  // boot failure that hides which capability is unavailable.
  let reader: ReturnType<typeof createReferenceReader> | undefined;
  const references = async () => (reader ??= createReferenceReader(options.skillDir));

  ctx.tools.register(
    defineTool({
      name: REFERENCE_TOOL_NAME,
      description:
        "Read one reference file of the bundled ensemble method. " +
        `Accepts exactly one of: ${REFERENCE_RESOURCES.join(", ")}. ` +
        `Returns the complete file (budget ${OUTPUT_BUDGET_BYTES} bytes, no pagination). ` +
        "It reads packaged reference text only; it is not a records, archive, or file tool.",
      parameters: {
        resource: {
          type: "string",
          required: true,
          enum: REFERENCE_RESOURCES,
          description: "Exact reference file name from the fixed enumeration.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            resource: { type: "string", required: true },
            bytes: { type: "integer", required: true },
            content: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.content }],
      },
      async execute(args, exec): Promise<ReferenceContent> {
        if (exec.signal.aborted) {
          throw new Error("ABORTED: reference read cancelled");
        }
        const handle = await references();
        try {
          return await handle.read(args.resource);
        } catch (error) {
          if (error instanceof ReferenceError) {
            // Explicit, model-readable failure: the code names the class of
            // failure and the message names the enumeration. Never truncated.
            throw new Error(`${error.code}: ${error.message}`);
          }
          throw error;
        }
      },
    }),
  );
}

/**
 * Plugin entry point: read the artifact from this installed package.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  applyWith(ctx, { skillDir: join(packageRoot(), SKILL_DIR) });
}

export default { name, inject, apply };

/**
 * Re-exported for the real-Loader verification script, which exercises the
 * allowlist and budget rules against a temporary artifact directory without
 * registering a second tool. It is not part of the plugin surface.
 */
export { createReferenceReader } from "./reference.ts";
export type { ReferenceContent, ReferenceError as ReferenceFailure } from "./reference.ts";
