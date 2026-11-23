/** Identity admitted from native execution objects, never from model arguments. */
export interface NativeSession {
  readonly id: string;
}

export interface NativeAgent {
  readonly id: string;
  readonly session: NativeSession;
}

export interface NativeWorkspace {
  readonly id: string;
  readonly sessionIds: readonly string[];
  readonly path: string;
}

/** The native objects needed to identify one live caller. */
export interface IdentityRuntime<A extends NativeAgent> {
  readonly agents: { get(id: string): A | undefined };
  readonly subagents: { rootOf(agent: A): A };
  readonly workspaces: { list(): readonly NativeWorkspace[] };
  readonly workingDirectory: { get(session: A["session"]): string };
  /** Deployment-owned resolver over actual execution services, not caller text. */
  readonly worldOf: (agent: A) => string | undefined;
}

export interface NativeIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly workspaceId: string;
  readonly workspaceAddress: string;
  readonly worldIdentity: string;
  readonly currentDirectory: string;
}

export class NativeIdentityError extends Error {
  readonly code = "not_authorized";
  constructor(message: string) { super(message); this.name = "NativeIdentityError"; }
}

/** Capture current native authority; the archive rechecks its current grants separately. */
export function nativeIdentity<A extends NativeAgent>(runtime: IdentityRuntime<A>, caller: A | undefined): NativeIdentity {
  if (caller === undefined || runtime.agents.get(caller.id) !== caller || caller.session.id !== caller.id) {
    throw new NativeIdentityError("an exact live native Agent is required");
  }
  let root: A;
  try { root = runtime.subagents.rootOf(caller); }
  catch { throw new NativeIdentityError("the caller has no current native tree owner"); }
  if (runtime.agents.get(root.id) !== root || root.session.id !== root.id) {
    throw new NativeIdentityError("the native root is no longer live");
  }
  // Workspace membership is native registry state. A child's selected cwd does
  // not move its tree's project, and a cwd string cannot create a Workspace id.
  const workspaces = runtime.workspaces.list().filter((workspace) => workspace.sessionIds.includes(root.id));
  if (workspaces.length !== 1) {
    throw new NativeIdentityError("the native root must belong to exactly one registered Workspace");
  }
  const worldIdentity = runtime.worldOf(caller);
  if (worldIdentity === undefined || worldIdentity.trim() === "") {
    throw new NativeIdentityError("the caller's execution world has no deployment mapping");
  }
  return Object.freeze({
    sessionId: caller.session.id,
    rootSessionId: root.session.id,
    workspaceId: workspaces[0]!.id,
    workspaceAddress: workspaces[0]!.path,
    worldIdentity,
    currentDirectory: runtime.workingDirectory.get(caller.session),
  });
}

/** Match execution-world mappings by actual Cordis isolation labels, not paths or caller text. */
export function executionWorld<A>(
  mappings: readonly { readonly identity: string; readonly services: readonly (object | symbol)[] }[],
  servicesOf: (agent: A) => readonly (object | symbol)[],
): (agent: A) => string | undefined {
  return (agent) => {
    const services = servicesOf(agent);
    if (services.length === 0) return undefined;
    const matches = mappings.filter((entry) => entry.services.length === services.length &&
      entry.services.every((service, index) => service === services[index]));
    return matches.length === 1 ? matches[0]!.identity : undefined;
  };
}
