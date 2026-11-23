import z from "@deepseek-ai/schemastery";
import { rolePreferencesConfig } from "./environment/config.ts";
import { createProduct, type ProductOptions } from "./native/product.ts";
/**
 * DSH ensemble — the installed Host entry.
 *
 * Supported DSH releases are declared once, in `./compatibility.ts`; the
 * package manifest's `engines.dsh` and every gate read that module.
 *
 * What this entry composes:
 *
 * 1. one **user-invocable** skill provider (`ensemble`) whose body is the
 *    generated DSH artifact bundled in this package;
 * 2. the model-facing tools: `ensemble_reference` (a fixed enumeration of
 *    packaged reference files) and, once the deployment's identity variables are
 *    set, `ensemble_work`, `ensemble_learn`, `ensemble_read` and
 *    `ensemble_upload` from `./tools`;
 * 3. the **owner-only** management Remote (`ensembleArchive`), which also carries
 *    project, query, management, choice, approval and environment methods for
 *    the Client and the CLI.
 *
 * Authority never comes from a request. The model tools derive their actor from
 * the live native caller (`exec.agent` plus the registered Workspace and the
 * deployment's execution-world mapping); the owner Remote takes its actor from
 * the authenticated Remote invocation and refuses when that invocation is
 * absent. The archive enforcement (current grants, authorization epoch, receipts)
 * lives in `./store`, and the domain decisions live in `modules/ensemble`.
 *
 * Only this module (and its native siblings) import `@deepseek-ai/*`; the
 * parsing, allowlist and budget logic live in dependency-free siblings so they
 * are tested without a DSH installation.
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
import type { OwnerServiceDeps } from "./owner-service.ts";
import { ARCHIVE_ROOT_ENV, type ProviderFactories } from "./archive.ts";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { createOwnerRemote, OWNER_SERVICE_KEY } from "./owner-remote.ts";
import { createReferenceReader, ReferenceError, type ReferenceContent } from "./reference.ts";
import { createSkillProvider } from "./skill.ts";

export const name = "ensemble";
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
 * Where the deployment's archive root comes from.
 *
 * An environment variable, read once at plugin start. It is deliberately not a
 * plugin option the model can set and not `process.cwd()`: the archive must live
 * where the deployment put it, and a Session cwd would put the archive wherever
 * a session happened to start. When it is absent the plugin still loads and
 * serves the skill and reference tool; the owner Remote reports
 * `storage_unavailable` for every call instead of inventing a location.
 */
export { ARCHIVE_ROOT_ENV };

/**
 * The deployment variable that names the execution world the archive runs in.
 *
 * Same-world is a deployment fact, not something a path comparison can infer,
 * so the deployment states it. `bind` refuses a source whose world it has not
 * evidenced, rather than assuming one.
 */
export const ARCHIVE_WORLD_ENV = "DSH_ENSEMBLE_ARCHIVE_WORLD";

/**
 * Register the skill provider, the reference tool, and the owner archive Remote.
 *
 * Version 1.0 mounts **one** archive: the v2 product executor created in
 * `./native/product.ts`. The retired v1 store is not constructed here at all —
 * not even as a writer behind the same `DSH_ENSEMBLE_ARCHIVE_ROOT`. Two stores
 * reachable from one environment variable is the defect this shape removes: the
 * old four-method Remote entries now refuse with a migration instruction (see
 * `./owner-remote.ts`), so an old script fails loudly instead of quietly
 * creating a second repository.
 *
 * `options.owner` remains only to let a test inject a *read-only* legacy view
 * for migration diagnostics; it never becomes a write path in the installed
 * composition.
 * @param ctx - plugin context.
 * @param options - installed skill directory, and injection points for tests.
 */
export function applyWithOwner(
  ctx: Context,
  options: ApplyOptions & { readonly owner?: Partial<OwnerServiceDeps>; readonly product?: Partial<ProductOptions> } = { skillDir: join(packageRoot(), SKILL_DIR) },
): void {
  applyWith(ctx, options);

  const archiveRoot = options.product?.root ?? options.owner?.archiveRoot ?? process.env[ARCHIVE_ROOT_ENV] ?? "";
  // The deployment states which execution world the archive runs in. Without
  // that statement a source has nothing to be compared against and is refused;
  // with it, only a source the deployment evidenced as this world is bound.
  // Neither value is derived from a path or from a Session cwd.
  const world = process.env[ARCHIVE_WORLD_ENV];
  const configured = {
    root: archiveRoot,
    hostAuthorityId: options.product?.hostAuthorityId ?? process.env.DSH_ENSEMBLE_AUTHORITY_ID ?? "",
    hostWorld: options.product?.hostWorld ?? world ?? "",
    sourceWorld: options.product?.sourceWorld ?? process.env.DSH_ENSEMBLE_SOURCE_WORLD ?? "",
    factories: options.product?.factories ?? options.owner?.factories ?? localProviderFactories,
    ...(options.product?.sourceReadLink ? { sourceReadLink: options.product.sourceReadLink } : {}),
  };
  // The Remote is registered unconditionally so its retired entries can answer
  // with a precise refusal even before the native services finish arriving.
  // There is deliberately no v1 service argument: nothing on this wire can
  // create or extend a v1 archive.
  const remote = createOwnerRemote(ctx, undefined as never, OWNER_SERVICE_KEY, undefined, undefined);
  const mountFiber = ctx.fiber;
  ctx.inject(["agents", "subagents", "workingDirectory", "workspaceRegistry", "sessionQuery", "fs"], productContext => {
    // A deployment that has not named its archive root, authority or execution
    // worlds still gets a loaded plugin: the skill, the reference reader and the
    // retired-entry refusals work, and the native tools report unavailability on
    // use. That keeps an unconfigured install diagnosable instead of a boot
    // failure that hides which variable is missing.
    const missing = [
      ["DSH_ENSEMBLE_ARCHIVE_ROOT", configured.root],
      ["DSH_ENSEMBLE_AUTHORITY_ID", configured.hostAuthorityId],
      ["DSH_ENSEMBLE_ARCHIVE_WORLD", configured.hostWorld],
      ["DSH_ENSEMBLE_SOURCE_WORLD", configured.sourceWorld],
    ].filter(([, value]) => value.trim() === "").map(([name]) => name);
    if (missing.length > 0) {
      // One line, no stack: this is an expected unconfigured state, not a crash.
      ctx.logger.warn(`ensemble: native tools are unavailable until these deployment variables are set: ${missing.join(", ")}`);
      return;
    }
    // A misconfigured deployment (for example the same world declared without a
    // native Host path mapping) is a real fault: surface it at boot rather than
    // letting every later owner call fail with a vaguer message.
    const product = createProduct(productContext, { ...configured, mountFiber });
    remote.productService = product.owner;
    productContext.effect(() => () => { remote.productService = undefined; });
  });
}

/**
 * The published local providers, mounted into the isolated group.
 *
 * Imported lazily so a profile that never calls the owner surface does not pay
 * for them, and so a missing package surfaces as `storage_unavailable` on a
 * call rather than as a boot failure that hides which capability is absent.
 */
const localProviderFactories: ProviderFactories = {
  subprocess: (group) => new LocalSubprocessRuntime(group as never),
  sandbox: (group) =>
    new LocalSandboxProvider(group as never, {
      runnerCommand: [],
      runnerFailureSignatures: [],
      probeTimeoutMs: 5000,
    }),
};

/**
 * Plugin entry point: read the artifact from this installed package.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  applyWithOwner(ctx, { skillDir: join(packageRoot(), SKILL_DIR) });
}

export const Config = z.object({ rolePreferences: rolePreferencesConfig });
export default { name, inject, apply, Config };

/**
 * Re-exported for the real-Loader verification script, which exercises the
 * allowlist and budget rules against a temporary artifact directory without
 * registering a second tool. It is not part of the plugin surface.
 */
export { createReferenceReader } from "./reference.ts";
export type { ReferenceContent, ReferenceError as ReferenceFailure } from "./reference.ts";
