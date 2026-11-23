/**
 * Resolve an attempt's recorded selection into the evidence request.
 *
 * `adapters/dsh/environment/selection.ts` turns a member's native log into the
 * `created` and `actual` stages. This module supplies the other half: the
 * `requested` route and the bound member Session, read from the archive record.
 *
 * Two properties matter and both are load-bearing:
 *
 * 1. **The archive is the only source.** The owner names an attempt id and
 *    nothing else. A model tool argument, a request payload or a caller's claim
 *    can therefore never introduce a route or point the collector at another
 *    Session. If the record does not carry the fact, the answer is a refusal —
 *    never a default, a guess, or a value echoed from the caller.
 * 2. **The current binding wins.** The member is the last entry of
 *    `binding_history`, not the planned `member_id`. After a `replace` the
 *    planned value names the *replaced* Session, and using it would attribute
 *    that Session's log to this attempt — the exact confusion three-stage
 *    evidence exists to prevent.
 *
 * Reads go through the archive registry's own owner admission and per-archive
 * lease, so this module adds no authority of its own; it only decides which two
 * fields may leave the record.
 *
 * @module adapters/dsh/native/selection
 */

import { failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import type { SelectionRequest } from "../environment/selection.ts";

/** The archive surface this resolver needs; narrower than the whole registry. */
export interface AttemptArchive {
  projects(actor: Actor, query: { readonly kind: "projects" }, signal: AbortSignal): Promise<Result<{ readonly items: readonly unknown[] }>>;
  readTarget(actor: Actor, projectId: string, signal: AbortSignal): Promise<Result<{ readonly archiveId: string }>>;
  withOwner<T>(actor: Actor, archiveId: string, signal: AbortSignal, run: (lease: AttemptLease) => Promise<Result<T>>): Promise<Result<T>>;
}

/** The one slice of a lease this resolver reads. */
export interface AttemptLease {
  readonly snapshot: { readonly objects: readonly AttemptRecord[] };
}

/** An attempt record, narrowed to the fields that are relevant. */
interface AttemptRecord {
  readonly id: string;
  readonly kind: string;
  readonly body?: unknown;
}

/**
 * What an archive can say about one attempt.
 *
 * `absent` and `unbound` are distinct on purpose: the first means "this archive
 * has never heard of that attempt", the second means "it exists, but nobody is
 * bound to it yet". They lead to different operator fixes, so they are not
 * collapsed into one refusal.
 */
type Lookup =
  | { readonly kind: "absent" }
  | { readonly kind: "unbound" }
  | { readonly kind: "bound"; readonly value: Omit<SelectionRequest, "evidence_id"> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one attempt's `requested_selection` and its current member.
 * @param archive - the archive registry, or a stand-in exposing this slice.
 * @param owner - the caller. Must already be the authenticated owner; the
 *   registry re-checks that on every call.
 * @param attemptId - the attempt to describe. Never trusted as a route or member.
 * @param signal - cancellation for every read this performs.
 * @returns the request for `collectSelectionEvidence`, or a refusal.
 */
export async function resolveAttemptSelection(
  archive: AttemptArchive,
  owner: Actor,
  attemptId: string,
  signal: AbortSignal,
): Promise<Result<Omit<SelectionRequest, "evidence_id">>> {
  if (typeof attemptId !== "string" || attemptId.trim() === "") return failure("invalid_input", "an attempt id is required");
  const catalog = await archive.projects(owner, { kind: "projects" }, signal);
  if (!catalog.ok) return catalog;
  for (const item of catalog.value.items) {
    if (!record(item) || typeof item.project_id !== "string") continue;
    signal.throwIfAborted();
    const target = await archive.readTarget(owner, item.project_id, signal);
    // A project this caller cannot read is simply not a candidate; a real
    // failure (cancellation, storage) still propagates from `projects` above.
    if (!target.ok) continue;
    const leased = await archive.withOwner<Lookup>(owner, target.value.archiveId, signal, async lease => {
      const attempt = lease.snapshot.objects.find(candidate => candidate.id === attemptId && candidate.kind === "attempt");
      if (attempt === undefined || !record(attempt.body)) return success({ kind: "absent" });
      const body = attempt.body;
      const history = body.binding_history;
      const last = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : undefined;
      if (!record(last) || typeof last.member_id !== "string" || last.member_id === "") return success({ kind: "unbound" });
      // Only these two fields travel: the requested route and the current member.
      const requested = record(body.requested_selection) ? body.requested_selection : {};
      const route: { provider?: string; model?: string; reasoning_effort?: string; preset?: string } = {};
      for (const key of ["provider", "model", "reasoning_effort", "preset"] as const) {
        const value = requested[key];
        if (typeof value === "string" && value !== "") route[key] = value;
      }
      return success({ kind: "bound", value: { attempt_id: attemptId, member_session_id: last.member_id, requested: route } });
    });
    if (!leased.ok) return leased;
    if (leased.value.kind === "absent") continue;
    if (leased.value.kind === "unbound") {
      return failure("not_found", "this attempt has no bound member Session yet; bind it before recording selection evidence");
    }
    return success(leased.value.value);
  }
  return failure("not_found", "no readable archive holds that attempt");
}
