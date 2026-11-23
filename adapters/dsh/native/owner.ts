/** Authenticated management and Client reads share one archive executor. */
import { decodeAdminEnvelope, decodeQuery } from "../../../modules/ensemble/codec.ts";
import { failure, success, type Actor, type AdminEnvelope, type OwnerContext, type ProjectSummary, type Query, type Result } from "../../../modules/ensemble/contracts.ts";
import { ownerVerdict, type InvocationLike } from "../owner.ts";
import { decodeApproval, type ApprovalRequest } from "./approvals.ts";
import type { LocationSelection } from "../maintenance/handles.ts";

/**
 * A deployment destination name, mirrored from the maintenance engine's grammar.
 *
 * Checked here so a URL or a filesystem path fails as `invalid_input` at the wire
 * edge instead of reaching the authorizer, where a model-supplied endpoint would
 * look like a plausible destination. The authoritative check stays in the engine.
 */
const DESTINATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * One row a destination picker can render.
 *
 * Exactly the two facts needed to make a selection: the deployment key to send
 * back as `destination_key`, and the identity the owner must then confirm in
 * `configure_replica`. No URL, no credential reference — a picker has no use for
 * them and a browser must never receive them.
 */
export interface ReplicaDestinationChoice {
  readonly key: string;
  readonly identity: string;
}

export interface OwnerProductDeps {
  readonly hostAuthorityId: string;
  readonly ownerId: string;
  readonly authorizationRefreshMs: number;
  environment?(actor: Actor, request: unknown, signal: AbortSignal): Promise<unknown>;
  projects(actor: Actor, signal: AbortSignal): Promise<Result<OwnerContext>>;
  query(actor: Actor, query: Query, signal: AbortSignal): Promise<unknown>;
  manage(actor: Actor, command: AdminEnvelope, signal: AbortSignal): Promise<unknown>;
  choose(actor: Actor, request: unknown, signal: AbortSignal): Promise<unknown>;
  /**
   * Declared network replica destinations, for a picker.
   *
   * Returns only what a chooser needs to *name* a destination: the deployment's
   * key and the identity the owner must then confirm. Deliberately no URL and no
   * credential reference — those are deployment facts that must not reach a
   * browser, and the owner never needs them to pick.
   */
  destinations?(actor: Actor, signal: AbortSignal): Promise<Result<readonly ReplicaDestinationChoice[]>>;
  approve(actor: Actor, request: ApprovalRequest, signal: AbortSignal): Promise<unknown>;
  /** Called only after committed publication. Cross-process changes are rechecked on the timer. */
  subscribe(listener: () => void): () => void;
}
export interface AuthorizationFrame { readonly project_id: string; readonly authorization_epoch: number; readonly read_revision: string }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function emptyRequest(request: unknown): boolean { return isRecord(request) && Object.keys(request).length === 0; }

export function createProductOwner(deps: OwnerProductDeps) {
  if (!deps.hostAuthorityId || !deps.ownerId || !Number.isSafeInteger(deps.authorizationRefreshMs) || deps.authorizationRefreshMs < 100) throw new Error("owner identity and authorization refresh interval must be configured");
  function actor(invocation: InvocationLike | undefined): Result<Actor> {
    const verdict = ownerVerdict(invocation);
    if (!verdict.ok) return failure("not_authorized", verdict.reason);
    return success({ kind: "owner", ownerId: deps.ownerId, hostAuthorityId: deps.hostAuthorityId, channel: "authenticated-remote" });
  }
  return {
    async environment(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      return deps.environment?.(caller.value, request, signal) ?? failure("storage_unavailable", "native Settings environment is not available");
    },
    async projects(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      if (!emptyRequest(request)) return failure("invalid_input", "projects accepts an empty request");
      return deps.projects(caller.value, signal);
    },
    async query(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      const decoded = decodeQuery(request); if (!decoded.ok) return decoded;
      return deps.query(caller.value, decoded.value, signal);
    },
    async manage(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      const decoded = decodeAdminEnvelope(request); if (!decoded.ok) return decoded;
      return deps.manage(caller.value, decoded.value, signal);
    },
    async choose(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      // Two mutually exclusive shapes, decided here so the wire contract is one
      // rule rather than something each caller re-derives:
      //   - a filesystem location: `kind` + `path` + `world`;
      //   - a network replica:      `kind: "replica"` + `destinationKey` + `world`,
      //     naming a destination the *deployment* declared. There is no path,
      //     because a remote has no local one.
      //
      // The wire name is `destinationKey` and it is deliberately **not** renamed on
      // the way in: the Client sends that spelling, so a conversion here would be a
      // second name for one thing and a place for the two to drift apart. It is a
      // different field from `destination_handle` (the opaque capability id that
      // `choose` returns) — and `deploymentKey` is the engine-internal name for the
      // same fact. Three names, three layers, each stated where it is used.
      //
      // The decoder only checks shape; whether the destination exists, and which
      // world it belongs to, is decided by the native authorizer that issues the
      // capability. A URL is refused here, so a model cannot introduce an endpoint.
      if (!isRecord(request) || typeof request.kind !== "string" || typeof request.world !== "string") {
        return failure("invalid_input", "choose requires a kind, a world and either a path or a destinationKey");
      }
      const unknown = Object.keys(request).filter(key => !["kind", "path", "world", "destinationKey"].includes(key));
      if (unknown.length > 0) return failure("invalid_input", `choose has unknown fields: ${unknown.join(", ")}`);
      const hasPath = typeof request.path === "string" && request.path !== "";
      const hasDestination = typeof request.destinationKey === "string" && request.destinationKey !== "";
      if (hasPath === hasDestination) {
        return failure("invalid_input", "choose requires exactly one of path or destinationKey: a filesystem location has a path, a network replica has a declared destination name and no path");
      }
      if (hasDestination) {
        if (request.kind !== "replica") return failure("invalid_input", "only a replica selection may name a declared destination");
        if (!DESTINATION_NAME.test(request.destinationKey as string)) return failure("invalid_input", "a declared destination is a plain name, not a URL or a path");
        return deps.choose(caller.value, { kind: request.kind, world: request.world, destinationKey: request.destinationKey as string } as LocationSelection, signal);
      }
      return deps.choose(caller.value, { kind: request.kind, path: request.path as string, world: request.world }, signal);
    },
    async destinations(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      // A read with no parameters. Anything else is a client bug worth naming
      // rather than ignoring, because this shapes a picker.
      if (!emptyRequest(request)) return failure("invalid_input", "destinations accepts an empty request");
      if (deps.destinations === undefined) return failure("storage_unavailable", "this Host declares no replica destinations");
      return deps.destinations(caller.value, signal);
    },
    async approve(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): Promise<unknown> {
      const caller = actor(invocation); if (!caller.ok) return caller;
      const decoded = decodeApproval(request); if (!decoded.ok) return decoded;
      return deps.approve(caller.value, decoded.value, signal);
    },
    async *watch(request: unknown, invocation: InvocationLike | undefined, signal: AbortSignal): AsyncGenerator<AuthorizationFrame | Result<never>> {
      const caller = actor(invocation); if (!caller.ok) { yield caller; return; }
      if (!isRecord(request) || Object.keys(request).length !== 1 || typeof request.project_id !== "string" || !request.project_id) { yield failure("invalid_input", "watch requires only project_id"); return; }
      let changed = 1;
      let wake: (() => void) | undefined;
      const notify = () => { changed++; wake?.(); };
      const unsubscribe = deps.subscribe(notify);
      const timer = setInterval(notify, deps.authorizationRefreshMs);
      signal.addEventListener("abort", notify, { once: true });
      let previous: string | undefined;
      try {
        while (!signal.aborted) {
          const generation = changed;
          const current = actor(invocation); if (!current.ok) { yield current; return; }
          const projects = await deps.projects(current.value, signal);
          if (!projects.ok) { yield projects; return; }
          const project: ProjectSummary | undefined = projects.value.projects.find(project => project.project_id === request.project_id);
          if (!project) { yield failure("not_authorized", "project access is no longer available"); return; }
          const frame = { project_id: project.project_id, authorization_epoch: project.authorization_epoch, read_revision: project.read_revision };
          const key = JSON.stringify(frame);
          if (key !== previous) { previous = key; yield frame; }
          if (signal.aborted) return;
          if (generation !== changed) continue;
          await new Promise<void>(resolve => { wake = resolve; if (generation !== changed || signal.aborted) resolve(); });
          wake = undefined;
        }
      } finally { clearInterval(timer); unsubscribe(); signal.removeEventListener("abort", notify); }
    },
  };
}
export type ProductOwner = ReturnType<typeof createProductOwner>;
