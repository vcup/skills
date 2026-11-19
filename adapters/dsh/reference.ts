/**
 * Closed-enumeration reader for the packaged ensemble references.
 *
 * The tool exposed to a model accepts one of five fixed names and nothing
 * else. This module owns that closed set end to end: it validates the name
 * against the same enumeration the schema advertises, refuses any name that
 * could address another path, refuses symbolic links, and enforces the output
 * budget before returning bytes. Callers get either a complete resource or a
 * typed failure — never a truncated body and never a fallback to another
 * directory.
 *
 * It imports nothing from the DSH packages, so it is unit-tested directly by
 * the repository's own `bun test` run.
 *
 * @module adapters/dsh/reference
 */

import { lstat, open, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  OUTPUT_BUDGET_BYTES,
  REFERENCE_RESOURCES,
  type ReferenceResource,
} from "./meta.ts";

/** Failure codes the probe defines for itself; no native DSH code is assumed. */
export type ReferenceFailureCode =
  | "UNKNOWN_RESOURCE"
  | "RESOURCE_UNAVAILABLE"
  | "OUTPUT_BUDGET_EXCEEDED";

/** One explicit reference-read failure. */
export class ReferenceError extends Error {
  override readonly name = "ReferenceError";

  constructor(
    readonly code: ReferenceFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** A successfully read reference. */
export interface ReferenceContent {
  readonly resource: ReferenceResource;
  /** Exact byte length of `content`. */
  readonly bytes: number;
  readonly content: string;
}

/** Fixed enumeration as a plain array, for schema generation. */
export function referenceNames(): readonly ReferenceResource[] {
  return REFERENCE_RESOURCES;
}

/** Whether `value` is one of the enumerated resource names. */
export function isReferenceResource(value: unknown): value is ReferenceResource {
  return typeof value === "string" && (REFERENCE_RESOURCES as readonly string[]).includes(value);
}

/**
 * Reject a name that is not exactly one enumerated resource.
 *
 * The allowlist is the only admission rule: a separator, a traversal segment,
 * an absolute path, an unknown file or `SKILL.md` itself all fail here rather
 * than being resolved and contained afterwards.
 * @param name - candidate resource name, however malformed.
 * @returns the narrowed name.
 * @throws ReferenceError with code `UNKNOWN_RESOURCE`.
 */
export function assertReferenceResource(name: unknown): ReferenceResource {
  if (!isReferenceResource(name)) {
    throw new ReferenceError(
      "UNKNOWN_RESOURCE",
      `unknown reference resource ${JSON.stringify(name)}; expected one of ${REFERENCE_RESOURCES.join(", ")}`,
    );
  }
  return name;
}

/**
 * Create a reader bound to one packaged skill directory.
 *
 * The directory is resolved once and must be a real directory: a symbolic
 * link at the root would let the package point elsewhere, so it fails at
 * construction instead of at the first read.
 * @param skillDir - absolute path of the installed `skills/ensemble` directory.
 * @returns a reader exposing the fixed enumeration and one read operation.
 */
export async function createReferenceReader(skillDir: string): Promise<{
  readonly names: readonly ReferenceResource[];
  read(name: unknown): Promise<ReferenceContent>;
}> {
  const root = resolve(skillDir);
  const stats = await lstat(root).catch((error: unknown) => {
    throw new ReferenceError(
      "RESOURCE_UNAVAILABLE",
      `skill directory is not readable: ${root}: ${describe(error)}`,
    );
  });
  if (stats.isSymbolicLink()) {
    throw new ReferenceError("RESOURCE_UNAVAILABLE", `skill directory must not be a symbolic link: ${root}`);
  }
  if (!stats.isDirectory()) {
    throw new ReferenceError("RESOURCE_UNAVAILABLE", `skill directory is not a directory: ${root}`);
  }
  const realRoot = await realpath(root);

  return {
    names: REFERENCE_RESOURCES,
    async read(name: unknown): Promise<ReferenceContent> {
      const resource = assertReferenceResource(name);
      const target = join(realRoot, resource);
      if (!target.startsWith(`${realRoot}${sep}`)) {
        // Unreachable while the name is enumerated; kept so a future enum entry
        // containing a separator cannot silently escape the package root.
        throw new ReferenceError("UNKNOWN_RESOURCE", `reference resource escapes the package: ${resource}`);
      }

      const entry = await lstat(target).catch((error: unknown) => {
        throw new ReferenceError(
          "RESOURCE_UNAVAILABLE",
          `reference resource is missing: ${resource}: ${describe(error)}`,
        );
      });
      if (entry.isSymbolicLink()) {
        throw new ReferenceError("RESOURCE_UNAVAILABLE", `reference resource must not be a symbolic link: ${resource}`);
      }
      if (!entry.isFile()) {
        throw new ReferenceError("RESOURCE_UNAVAILABLE", `reference resource is not a regular file: ${resource}`);
      }
      if (entry.size > OUTPUT_BUDGET_BYTES) {
        throw new ReferenceError(
          "OUTPUT_BUDGET_EXCEEDED",
          `reference resource ${resource} is ${entry.size} bytes, over the ${OUTPUT_BUDGET_BYTES}-byte budget; this probe does not paginate`,
        );
      }

      // Read through a handle so the size check and the bytes come from one
      // opened file rather than from two independently resolved paths.
      const handle = await open(target, "r").catch((error: unknown) => {
        throw new ReferenceError(
          "RESOURCE_UNAVAILABLE",
          `reference resource is not readable: ${resource}: ${describe(error)}`,
        );
      });
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) {
          throw new ReferenceError("RESOURCE_UNAVAILABLE", `reference resource is not a regular file: ${resource}`);
        }
        if (opened.size > OUTPUT_BUDGET_BYTES) {
          throw new ReferenceError(
            "OUTPUT_BUDGET_EXCEEDED",
            `reference resource ${resource} is ${opened.size} bytes, over the ${OUTPUT_BUDGET_BYTES}-byte budget; this probe does not paginate`,
          );
        }
        const bytes = await handle.readFile();
        if (bytes.byteLength > OUTPUT_BUDGET_BYTES) {
          throw new ReferenceError(
            "OUTPUT_BUDGET_EXCEEDED",
            `reference resource ${resource} is ${bytes.byteLength} bytes, over the ${OUTPUT_BUDGET_BYTES}-byte budget; this probe does not paginate`,
          );
        }
        return { resource, bytes: bytes.byteLength, content: bytes.toString("utf8") };
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Read the packaged instruction file. Used by the skill provider, which needs
 * the body regardless of the model-facing enumeration.
 * @param skillDir - absolute path of the installed `skills/ensemble` directory.
 * @param fileName - instruction file name inside that directory.
 * @returns the instruction text.
 */
export async function readInstructionFile(skillDir: string, fileName: string): Promise<string> {
  return readFile(join(skillDir, fileName), "utf8");
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}
