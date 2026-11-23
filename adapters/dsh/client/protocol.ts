/** Browser projection of the owner Remote. No Host paths, actors or credentials are inferred here. */
export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
export type Fields = Readonly<Record<string, Json>>;
import type { ProjectSummary, Query, AdminEnvelope, OwnerContext } from "../../../modules/ensemble/contracts.ts";
export type { Query };
export type OwnerRequest = AdminEnvelope;
export type { OwnerContext };
export interface ProjectCard extends ProjectSummary { readonly paused?: boolean; }
export interface Page {
  readonly read_revision: string;
  readonly authorization_epoch: number;
  readonly items: readonly Fields[];
  readonly content?: Json;
  readonly completeness: "complete" | "partial";
  readonly reason?: string;
  readonly next_cursor?: string;
}
export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly current_revision?: string;
}
export class ClientFailure extends Error {
  constructor(readonly failure: Failure) { super(failure.message); }
}
export interface WatchHandle extends AsyncIterable<unknown> { dispose(): void; }
/** One deployment-declared network replica destination, as the Host may tell a browser. */
export interface ReplicaDestination {
  /** The name to send back as `choose.destinationKey`. */
  readonly key: string;
  /** The remote identity the user later confirms as `expected_remote_identity`. */
  readonly identity: string;
}
export interface ArchiveRemote {
  projects(request: Fields): Promise<unknown>;
  query(request: Fields): Promise<unknown>;
  manage(request: Fields): Promise<unknown>;
  choose(request: Fields): Promise<unknown>;
  approve(request: Fields): Promise<unknown>;
  environment(request: Fields): Promise<unknown>;
  /** Declared replica destinations: `key`/`identity` only — never a URL or a credential. */
  destinations(request: Fields): Promise<unknown>;
  watch(request: Fields, signal?: AbortSignal): WatchHandle;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ClientFailure({ code: "invalid_response", message: "The archive returned an invalid response." }); }
export function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
/** Bound wire input before it can become render props. No implicit HTML, URL, or object evaluation. */
export function json(value: unknown, depth = 0): Json {
  if (depth > 24) return invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 2_000_000) return value;
  if (Array.isArray(value) && value.length <= 1000) return value.map(item => json(item, depth + 1));
  if (record(value) && Object.keys(value).length <= 200) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)]));
  return invalid();
}
/** Unwrap the native gateway result and the domain refusal separately. */
export function unwrap(value: unknown): Record<string, unknown> {
  if (!record(value)) return invalid();
  if (value.ok === false || value.status === "refused" || value.status === "error") {
    const error = record(value.error) ? value.error : value;
    throw new ClientFailure({ code: text(error.code) ?? "not_authorized", message: text(error.message) ?? text(error.reason) ?? "The request was refused.", ...(typeof error.current_revision === "string" ? { current_revision: error.current_revision } : {}) });
  }
  if (value.ok === true && "value" in value) return unwrap(value.value);
  return value;
}
export function decodeProjects(response: unknown): readonly ProjectCard[] {
  const value = unwrap(response);
  if (!Array.isArray(value.projects) || value.projects.length > 1000) return invalid();
  const seen = new Set<string>();
  return value.projects.map(item => {
    if (!record(item) || typeof item.project_id !== "string" || !item.project_id || seen.has(item.project_id)
      || typeof item.title !== "string" || typeof item.read_revision !== "string" || !item.read_revision
      || !Number.isSafeInteger(item.authorization_epoch) || Number(item.authorization_epoch) < 0
      || !Array.isArray(item.capabilities) || !item.capabilities.every(cap => typeof cap === "string")) return invalid();
    seen.add(item.project_id);
    return { project_id: item.project_id, title: item.title, read_revision: item.read_revision,
      authorization_epoch: Number(item.authorization_epoch), capabilities: [...item.capabilities], paused: item.paused === true };
  });
}
/** The authenticated owner's own subject, as the Host reports it on the owner catalogue. */
export interface CurrentOwner {
  readonly kind: "owner";
  readonly ownerId: string;
  readonly hostAuthorityId: string;
}

export function decodeOwner(response: unknown): OwnerContext {
  const value = unwrap(response);
  for (const key of ["capabilities", "root_handles", "source_handles", "destination_handles"] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 1000 || !value[key].every(item => typeof item === "string")) return invalid();
  }
  // The Host reports who the authenticated caller is. It is the only legitimate source for
  // a grant subject: the Host derives it from the trusted connection, never from a request
  // payload, so the Client must not invent one or accept one from another source.
  //
  // Decoded closed and strict. `kind` must be exactly "owner" — this endpoint is
  // owner-guarded, so a session subject arriving here would mean the guard failed, and
  // silently accepting it would build a grant for the wrong actor.
  const subject = value.current_owner;
  if (!record(subject)) return invalid();
  // Closed, like the Host's own decoders: reject unknown keys instead of ignoring them.
  // An extra field is not harmless here — it could carry something the Host never put on
  // this projection, and the Client can only safely act on the three fields the contract
  // names. There is no backward-compatibility case to weigh: the Host emits exactly these
  // three, so anything else means one side is not speaking the settled contract.
  for (const key of Object.keys(subject)) if (!["kind", "ownerId", "hostAuthorityId"].includes(key)) return invalid();
  if (subject.kind !== "owner") return invalid();
  if (typeof subject.ownerId !== "string" || subject.ownerId === "") return invalid();
  if (typeof subject.hostAuthorityId !== "string" || subject.hostAuthorityId === "") return invalid();
  const current_owner: CurrentOwner = { kind: "owner", ownerId: subject.ownerId, hostAuthorityId: subject.hostAuthorityId };
  return { capabilities: value.capabilities as string[], root_handles: value.root_handles as string[], source_handles: value.source_handles as string[], destination_handles: value.destination_handles as string[], current_owner, projects: decodeProjects(value) };
}
export function decodePage(response: unknown): Page {
  const value = unwrap(response);
  if (typeof value.read_revision !== "string" || !value.read_revision || !Number.isSafeInteger(value.authorization_epoch)
    || Number(value.authorization_epoch) < 0 || !["complete", "partial"].includes(String(value.completeness))) return invalid();
  if (value.next_cursor !== undefined && (typeof value.next_cursor !== "string" || !value.next_cursor)) return invalid();
  const items = value.items === undefined ? [] : value.items;
  if (!Array.isArray(items) || items.length > 100 || !items.every(record)) return invalid();
  return { read_revision: value.read_revision, authorization_epoch: Number(value.authorization_epoch), items: items.map(item => json(item) as Fields),
    ...(value.content !== undefined ? { content: json(value.content) } : {}), completeness: value.completeness as Page["completeness"],
    ...(typeof value.partial_reason === "string" ? { reason: value.partial_reason } : {}), ...(typeof value.next_cursor === "string" ? { next_cursor: value.next_cursor } : {}) };
}
export function failureOf(error: unknown): Failure {
  return error instanceof ClientFailure ? error.failure : { code: "connection_lost", message: "The connection was interrupted. Reconnect and read the operation receipt before retrying a write." };
}
/**
 * Decode the declared replica destinations.
 *
 * Only `key` and `identity` are accepted and only those are returned: a URL or a
 * credential reference in a browser payload would be a deployment fact leak, so a
 * row carrying extra fields is refused rather than trimmed. The list is bounded so
 * a large deployment cannot blow up the page.
 * @param response - the Host's answer to `destinations({})`.
 * @returns the destinations, in the Host's order.
 */
export function decodeDestinations(response: unknown): readonly ReplicaDestination[] {
  // The business value is an array, so it is unwrapped here rather than through
  // `unwrap`, which is object-shaped by contract (it exists to reject malformed
  // *records*). A refusal still goes through the same `error.code` path.
  if (!record(response)) return invalid();
  if (response.ok === false || response.status === "refused" || response.status === "error") {
    const error = record(response.error) ? response.error : response;
    throw new ClientFailure({ code: text(error.code) ?? "not_authorized", message: text(error.message) ?? "The request was refused." });
  }
  const value = response.ok === true && "value" in response ? response.value : response;
  const rows = Array.isArray(value) ? value : record(value) && Array.isArray(value.destinations) ? value.destinations : invalid();
  if (rows.length > 100) return invalid();
  const seen = new Set<string>();
  return rows.map(item => {
    if (!record(item)) return invalid();
    for (const key of Object.keys(item)) if (!["key", "identity"].includes(key)) return invalid();
    const key = text(item.key), identity = text(item.identity);
    if (key === undefined || key === "" || identity === undefined || identity === "" || seen.has(key)) return invalid();
    seen.add(key);
    return { key, identity };
  });
}
