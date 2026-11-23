/**
 * Types for the delegated journey seam (`verify-product-context.mjs`).
 *
 * The module itself is plain ESM so a journey author can read it without a build
 * step; this declaration exists so a TypeScript consumer (the driver's own
 * regression test) is checked rather than left with implicit `any`. It is the
 * narrowest honest description: the objects are passed straight through to a live
 * Host, so only the fields that are actually used are typed.
 */

/** One live root Agent, as the driver hands it over. */
export interface JourneyAgent {
  readonly id: string;
}

/** A native Workspace the archive is bound to. */
export interface JourneyWorkspace {
  readonly id: string;
}

/** The bound project as the owner Remote reports it. */
export interface JourneyProject {
  readonly project_id: string;
}

/** What a journey may pass in. Both spellings are accepted. */
export interface ProductRunContextInput {
  /** The booted real profile context. */
  readonly ctx: object;
  /** Live root Agent (`agent`, or `root.agent`). */
  readonly agent?: JourneyAgent;
  readonly workspace?: JourneyWorkspace;
  readonly project?: JourneyProject;
  readonly source?: string;
  readonly root?: {
    readonly agent: JourneyAgent;
    readonly workspace: JourneyWorkspace;
    readonly project: JourneyProject;
    readonly source: string;
  };
  readonly remote: (method: string, request: unknown) => Promise<any>;
  readonly call: (name: string, args: unknown, id: string) => Promise<any>;
  readonly modelCall?: (name: string, args: unknown, id: string) => Promise<any>;
  readonly nativeCall?: (name: string, args: unknown, id: string) => Promise<any>;
  readonly phase: (name: string, body: () => Promise<any>) => Promise<any>;
  readonly evidence: Record<string, unknown>;
  readonly head?: () => Promise<string>;
  readonly spawnMember: (label: string, options?: Record<string, unknown>) => Promise<any>;
  readonly ownRoot: (label: string) => string;
  readonly selection?: { readonly provider: string; readonly model: string };
  readonly log?: (...args: unknown[]) => void;
  readonly timeoutMs?: number;
}

/** The frozen context a journey receives. */
export interface ProductRunContext {
  readonly ctx: object;
  readonly agent: JourneyAgent;
  readonly workspace: JourneyWorkspace;
  readonly project: JourneyProject;
  readonly projectId: string;
  readonly source: string;
  readonly selection: { readonly provider: string; readonly model: string };
  readonly remote: (method: string, request: unknown) => Promise<any>;
  readonly call: (name: string, args: unknown, id: string) => Promise<any>;
  readonly modelCall: (name: string, args: unknown, id: string) => Promise<any>;
  readonly phase: (name: string, body: () => Promise<any>) => Promise<any>;
  readonly evidence: Record<string, unknown>;
  readonly spawnMember: (label: string, options?: Record<string, unknown>) => Promise<any>;
  readonly log: (...args: unknown[]) => void;
  readonly timeoutMs: number;
  readonly head: () => Promise<string>;
  readonly actorFacts: () => Promise<{
    ok: boolean;
    code?: string;
    projectId?: string;
    authorizationEpoch?: number;
    readRevision?: string;
    rootSessionId?: string;
  }>;
  readonly ownRoot: (label: string) => string;
  readonly scratch: (label: string) => string;
}

/**
 * Build the context one journey module receives.
 * @param input - the driver's live objects.
 * @returns the frozen context.
 * @throws when a required field is missing.
 */
export function productRunContext(input: ProductRunContextInput): ProductRunContext;
