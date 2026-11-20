/**
 * Bundled skill provider: one user-invocable `ensemble` skill read from the
 * installed package.
 *
 * The generated DSH artifact's `SKILL.md` starts with YAML frontmatter
 * (`name`, `description`, `disable-model-invocation: true`). The filesystem
 * provider in rc.4 parses that frontmatter and derives the invocation policy
 * (`packages/skill/skill-filesystem/src/index.ts` lines 1015–1021:
 * `disable-model-invocation: true` ⇒ `modelInvocable: false`), and loads the
 * body with the frontmatter removed. This module does the same for one
 * packaged directory so the probe does not depend on the filesystem provider
 * scanning an extension root.
 *
 * It declares the provider shapes structurally (unchanged across the tested
 * releases) and imports nothing from
 * `@deepseek-ai/*`, so the parsing and policy derivation are unit-tested in
 * this repository; `index.ts` passes the resulting object to
 * `ctx.skills.registerProvider`, which is where the real type check happens.
 *
 * @module adapters/dsh/skill
 */

import { SKILL_RANK, PROVIDER_NAME } from "./meta.ts";
import { readInstructionFile } from "./reference.ts";

/** Structural copy of rc.4 `SkillInvocationPolicy`. */
export interface InvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

/** Structural copy of rc.4 `SkillResourceBase`. */
export type ResourceBase =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "opaque"; readonly description: string };

/** Structural copy of the rc.4 candidate fields this provider sets. */
export interface SkillCandidateLike {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: InvocationPolicy;
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: ResourceBase;
  readonly rank: number;
  readonly locator: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Structural copy of rc.4 `SkillDefinition`. */
export interface SkillDefinitionLike extends Omit<SkillCandidateLike, "rank" | "locator"> {
  readonly content: string;
}

/** Structural copy of rc.4 `SkillProvider`. */
export interface SkillProviderLike {
  readonly name: string;
  readonly list: (options: { cwd?: string | undefined; signal?: AbortSignal | undefined }) =>
    Promise<readonly SkillCandidateLike[]>;
  readonly get: (
    candidate: SkillCandidateLike,
    options: { cwd?: string | undefined; signal?: AbortSignal | undefined },
  ) => Promise<SkillDefinitionLike | undefined>;
}

/** Parsed instruction file: routing metadata plus the body a consumer renders. */
export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: InvocationPolicy;
  readonly body: string;
}

/** A malformed packaged instruction file. */
export class SkillFrontmatterError extends Error {
  override readonly name = "SkillFrontmatterError";
}

const FRONTMATTER_FENCE = "---";
const MAX_NAME = 64;

/**
 * Frontmatter keys this provider understands.
 *
 * An unknown key is rejected rather than ignored: a future content edit that
 * introduces a policy key (for example a renamed invocation switch) must fail
 * loudly here, not silently fall back to a permissive default.
 */
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "whenToUse",
  "when-to-use",
  "disable-model-invocation",
  "user-invocable",
]);

/**
 * Parse the instruction file of the generated DSH artifact.
 *
 * Supports the subset the content build emits: a leading `---` fence, scalar
 * `key: value` lines, and a closing fence. It rejects anything else instead of
 * guessing, because a silent misparse would change which surface may invoke
 * the skill.
 * @param text - complete instruction file text.
 * @returns the routing metadata and the body without frontmatter.
 * @throws SkillFrontmatterError when the frontmatter is absent or unsupported.
 */
export function parseSkillFile(text: string): ParsedSkill {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    throw new SkillFrontmatterError("instruction file must start with a `---` frontmatter fence");
  }
  const end = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (end < 0) {
    throw new SkillFrontmatterError("instruction file has no closing `---` frontmatter fence");
  }
  const frontmatter = normalized.slice(FRONTMATTER_FENCE.length + 1, end);
  const body = normalized.slice(end + FRONTMATTER_FENCE.length + 2);

  const fields = new Map<string, string>();
  for (const [index, line] of frontmatter.split("\n").entries()) {
    if (line.trim() === "") continue;
    const match = /^([a-z][a-z0-9-]*):[ \t]+(.+)$/.exec(line);
    if (match === null) {
      throw new SkillFrontmatterError(
        `unsupported frontmatter line ${index + 2}: ${JSON.stringify(line)}; only scalar \`key: value\` lines are supported`,
      );
    }
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (!KNOWN_KEYS.has(key)) {
      throw new SkillFrontmatterError(`unsupported frontmatter key: ${key}`);
    }
    if (fields.has(key)) {
      throw new SkillFrontmatterError(`duplicate frontmatter key: ${key}`);
    }
    fields.set(key, rawValue.trim());
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || name === "") {
    throw new SkillFrontmatterError("frontmatter is missing `name`");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > MAX_NAME) {
    throw new SkillFrontmatterError(`frontmatter \`name\` is not a kebab-case skill name: ${JSON.stringify(name)}`);
  }
  if (description === undefined || description === "") {
    throw new SkillFrontmatterError("frontmatter is missing `description`");
  }

  const disableModelInvocation = parseFrontmatterBoolean(fields.get("disable-model-invocation"), "disable-model-invocation");
  const userInvocable = parseFrontmatterBoolean(fields.get("user-invocable"), "user-invocable");
  const whenToUse = fields.get("when-to-use") ?? fields.get("whenToUse");

  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    // rc.4 filesystem provider: omitted keys default to permitting their surface.
    invocation: {
      modelInvocable: disableModelInvocation !== true,
      userInvocable: userInvocable !== false,
    },
    body,
  };
}

/**
 * Derive the invocation policy for one frontmatter key set.
 *
 * Kept separate so the mapping can be asserted without a file: rc.4 treats
 * `disable-model-invocation: true` as model-invisible and everything else as
 * model-visible; `user-invocable: false` is the only way to hide the human
 * surface.
 * @param disableModelInvocation - parsed `disable-model-invocation` value.
 * @param userInvocable - parsed `user-invocable` value.
 * @returns the resolved policy.
 */
export function invocationPolicy(
  disableModelInvocation: boolean | undefined,
  userInvocable: boolean | undefined,
): InvocationPolicy {
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  };
}

function parseFrontmatterBoolean(raw: string | undefined, key: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  throw new SkillFrontmatterError(`frontmatter \`${key}\` is not a boolean: ${JSON.stringify(raw)}`);
}

/** Options for {@link createSkillProvider}. */
export interface SkillProviderOptions {
  /** Absolute path of the installed `skills/ensemble` directory. */
  readonly skillDir: string;
  /** Instruction file name inside that directory. */
  readonly skillFile: string;
  /** Opaque description of the resource base shown to the model. */
  readonly resourceDescription: string;
}

/**
 * Build the rc.4 skill provider for the packaged artifact.
 *
 * `list()` re-reads the instruction file so a changed package (or a changed
 * frontmatter) is observed on the next catalog refresh instead of being
 * cached forever; `get()` re-validates the candidate name so a stale selection
 * cannot load a different skill.
 * @param options - installed directory, instruction file, and resource wording.
 * @returns a provider ready for `ctx.skills.registerProvider`.
 */
export function createSkillProvider(options: SkillProviderOptions): SkillProviderLike {
  const resourceBase: ResourceBase = { kind: "opaque", description: options.resourceDescription };

  async function load(): Promise<{ parsed: ParsedSkill; candidate: SkillCandidateLike }> {
    const parsed = parseSkillFile(await readInstructionFile(options.skillDir, options.skillFile));
    return {
      parsed,
      candidate: {
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
        invocation: parsed.invocation,
        source: "bundled",
        provider: PROVIDER_NAME,
        resourceBase,
        rank: SKILL_RANK,
        locator: { kind: "bundled-instruction", file: options.skillFile },
      },
    };
  }

  return {
    name: PROVIDER_NAME,
    async list(lookup) {
      throwIfAborted(lookup.signal);
      return [(await load()).candidate];
    },
    async get(candidate, lookup) {
      throwIfAborted(lookup.signal);
      const loaded = await load();
      if (candidate.name !== loaded.candidate.name) return undefined;
      const { rank: _rank, locator: _locator, ...definition } = loaded.candidate;
      return { ...definition, content: loaded.parsed.body };
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("skill provider lookup aborted");
  }
}
