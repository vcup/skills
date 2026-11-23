/**
 * Host preflight for the authenticated-UI gate: ask the running Host, over the
 * real authenticated transport, the same questions the browser is about to ask.
 *
 * Why this exists as its own module:
 *
 * - It separates "the fixture is not serving what the gate needs" from "the UI is
 *   broken". A gate that reported both as one red would send a reader to the
 *   wrong file. Preflight disagreements are prerequisite failures; the browser
 *   phase is the evidence.
 * - It uses the **installed** package's own transport (`lib/transport.bundle.mjs`)
 *   with the Host-issued cookie and nothing else: no gateway, no Peer, no
 *   principal. If preflight succeeds, the cookie, the archive and the Remote are
 *   genuinely live, so a later browser failure is about the page, not the Host.
 *
 * It asserts nothing about rendering. It is not a substitute for the browser
 * phase and must never be reported as UI evidence.
 *
 * @module adapters/dsh/client/host-preflight
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** A live Host answer the browser phase will rely on. */
export interface Preflight {
  readonly projectCount: number;
  readonly projectId?: string;
  readonly head?: string;
  readonly epoch?: number;
  /** True when the authenticated owner has no project yet: the UI must initialize one. */
  readonly fresh: boolean;
  /** Native Workspaces the Host registry actually holds, for the source picker. */
  readonly workspaces: readonly { readonly workspaceId: string; readonly path: string }[];
}

/** The transport surface this module consumes (the shipped one, not a stub). */
interface Transport {
  readonly call: (endpoint: string, payload: unknown) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

/**
 * Unwrap the gateway envelope and the domain refusal separately, so a refusal is
 * reported by its domain code rather than as a transport fault.
 * @param value - answer from one Remote call.
 * @returns the business value.
 */
export function business(value: unknown): Record<string, unknown> {
  const record = (input: unknown): input is Record<string, unknown> => typeof input === "object" && input !== null && !Array.isArray(input);
  if (!record(value)) throw new Error("the Host answered with a non-object value");
  if (value.ok === false) {
    const error = record(value.error) ? value.error : value;
    throw new Error(`the Host refused: ${String(error.code ?? "unknown")} ${String(error.message ?? "")}`.trim());
  }
  if (value.ok === true && "value" in value) {
    const inner = value.value;
    return record(inner) ? inner : { value: inner };
  }
  return value;
}

/**
 * Ask the live Host for the owner catalogue and the selected project's head.
 *
 * The assertions mirror what the browser phase needs rather than what is merely
 * convenient: at least one project (otherwise the UI has nothing to select) and a
 * pinned read revision (otherwise the fixed-snapshot claim is untestable).
 *
 * The catalogue/`context` cross-check is a *pre-write* consistency check: it proves the
 * archive answers the head the catalogue just named. It is therefore only meaningful
 * before the gate itself writes, because a committed write legitimately advances the
 * head and the next `context` read then returns the new revision. Pass
 * `expectStableHead: false` for a post-write read, where the caller wants the *live*
 * head and will compare it itself.
 * @param options - installed package root, Host origin, session cookie header and whether
 *   the head is still expected to equal the catalogue's revision.
 * @returns the live facts the browser phase will compare against.
 */
export async function preflight(options: { packageRoot: string; origin: string; cookie: string; expectStableHead?: boolean }): Promise<Preflight> {
  const transport = await import(pathToFileURL(join(options.packageRoot, "lib", "transport.bundle.mjs")).href) as {
    connect(input: { url: string; cookie: string }): Promise<Transport>;
  };
  const connection = await transport.connect({ url: options.origin, cookie: options.cookie });
  try {
    const owner = business(await connection.call("ensembleArchive/projects", { request: {} }));
    const projects = Array.isArray(owner.projects) ? owner.projects.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
    // A fresh Host is a supported starting state, not a failure: the owner has no
    // project and the UI's first job is to initialize one. The gate proves that
    // journey through the browser rather than refusing it here.
    if (projects.length === 0) {
      const workspaces = await nativeWorkspaces(options.packageRoot, options.origin, options.cookie);
      return { projectCount: 0, fresh: true, workspaces };
    }
    const project = projects[0]!;
    const projectId = typeof project.project_id === "string" ? project.project_id : undefined;
    if (projectId === undefined) throw new Error("the owner catalogue entry carries no project_id");
    const readRevision = typeof project.read_revision === "string" ? project.read_revision : undefined;
    if (readRevision === undefined) throw new Error("the owner catalogue entry carries no read_revision");
    const epoch = typeof project.authorization_epoch === "number" ? project.authorization_epoch : undefined;
    // `context` is the owner's opening read and it carries no revision field by
    // contract (the closed decoder refuses one), so the check is that the archive
    // answers the same head the catalogue just named. After the gate's own committed
    // write the head legitimately differs, so the check is opt-out rather than always on.
    const page = business(await connection.call("ensembleArchive/query", { request: { kind: "context", project_id: projectId } }));
    if (options.expectStableHead !== false && page.read_revision !== readRevision) throw new Error(`the archive answered ${String(page.read_revision)} while the catalogue named ${readRevision}`);
    const liveHead = typeof page.read_revision === "string" ? page.read_revision : readRevision;
    const workspaces = await nativeWorkspaces(options.packageRoot, options.origin, options.cookie);
    return { projectCount: projects.length, projectId, head: liveHead, epoch, fresh: false, workspaces };
  } finally {
    await connection.close();
  }
}

/**
 * Read the native Workspace registry through its own public Remote.
 *
 * Binding an archive needs a real Workspace id and its directory, and the Client
 * picker reads them from here rather than letting a person type them. A Host that
 * does not compose the registry returns an empty list — which is a fact the gate
 * reports, not an error: on such a Host the picker correctly says it cannot bind.
 * @param packageRoot - installed package root (for the transport).
 * @param origin - Host origin.
 * @param cookie - API session cookie header.
 * @returns the registry rows the Host holds.
 */
async function nativeWorkspaces(packageRoot: string, origin: string, cookie: string): Promise<readonly { workspaceId: string; path: string }[]> {
  const transport = await import(pathToFileURL(join(packageRoot, "lib", "transport.bundle.mjs")).href) as {
    connect(input: { url: string; cookie: string }): Promise<Transport>;
  };
  const connection = await transport.connect({ url: origin, cookie });
  try {
    const answer = await connection.call("workspace/follow", { request: {} });
    const record = (input: unknown): input is Record<string, unknown> => typeof input === "object" && input !== null && !Array.isArray(input);
    const baseline = record(answer) && record(answer.value) && Array.isArray((answer.value as Record<string, unknown>).workspaces) ? (answer.value as Record<string, unknown>).workspaces as unknown[] : [];
    return baseline.flatMap(item => {
      if (!record(item)) return [];
      const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId : undefined;
      const path = typeof item.path === "string" ? item.path : undefined;
      return workspaceId === undefined || path === undefined ? [] : [{ workspaceId, path }];
    });
  } catch {
    // The registry is optional composition; an absent one is reported as empty.
    return [];
  } finally {
    await connection.close();
  }
}
