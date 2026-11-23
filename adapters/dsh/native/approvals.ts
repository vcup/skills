/** Short-lived explicit owner approvals, distinct from durable project grants. */
import { randomUUID } from "node:crypto";
import { actorKey, failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
export interface ApprovalRequest {
  readonly project_id: string;
  readonly candidate_id?: string;
  readonly source_stop?: { readonly archive_id: string; readonly final_head: string; readonly mode: "current-host-paused" | "external-owner-handoff" };
  readonly action: "commit_import" | "upgrade" | "activate_restore" | "relocate" | "gc" | "purge" | "stopped-primary";
  readonly target_digest: string;
  readonly statement: string;
  readonly expires_after_ms: number;
}
const actions = new Set(["commit_import", "upgrade", "activate_restore", "relocate", "gc", "purge", "stopped-primary"]);
export function decodeApproval(value: unknown): Result<ApprovalRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("invalid_input", "approval must be an object");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !["project_id", "action", "target_digest", "statement", "expires_after_ms", "candidate_id", "source_stop"].includes(key)) || typeof request.project_id !== "string" || !request.project_id || typeof request.action !== "string" || !actions.has(request.action) || typeof request.target_digest !== "string" || !/^[a-f0-9]{40,64}$/.test(request.target_digest) || typeof request.statement !== "string" || request.statement.trim() === "" || request.statement.length > 4096 || !Number.isSafeInteger(request.expires_after_ms) || (request.expires_after_ms as number) < 1000 || (request.expires_after_ms as number) > 600000) return failure("invalid_input", "approval needs a project, supported action, exact digest, explicit statement and lifetime of 1–600 seconds");
  if (request.candidate_id !== undefined && (typeof request.candidate_id !== "string" || request.action !== "activate_restore")) return failure("invalid_input", "candidate_id is reserved for exact restore approval");
  if (request.source_stop !== undefined) {
    const stop = request.source_stop as Record<string, unknown>;
    if (!stop || typeof stop !== "object" || Array.isArray(stop) || request.action !== "stopped-primary" || Object.keys(stop).some(key => !["archive_id", "final_head", "mode"].includes(key)) || typeof stop.archive_id !== "string" || !stop.archive_id || typeof stop.final_head !== "string" || !/^[a-f0-9]{40}$/.test(stop.final_head) || !["current-host-paused", "external-owner-handoff"].includes(String(stop.mode))) return failure("invalid_input", "stopped-primary requires the exact source archive, final head and explicit handoff mode");
  } else if (request.action === "stopped-primary") return failure("invalid_input", "stopped-primary requires source_stop evidence");
  return success(request as unknown as ApprovalRequest);
}
export function createOwnerApprovals(now: () => number = Date.now) {
  const entries = new Map<string, { actor: string; archive: string; request: ApprovalRequest; expires: number }>();
  function issue(actor: Actor, archiveId: string, request: ApprovalRequest) {
    if (actor.kind !== "owner" || actor.channel !== "authenticated-remote") return failure("not_authorized", "approval requires the authenticated owner");
    for (const [id, entry] of entries) if (entry.expires <= now()) entries.delete(id);
    if (entries.size >= 1000) return failure("budget_exceeded", "too many outstanding approvals");
    const approval_id = `approval_${randomUUID()}`;
    const expires_at = now() + request.expires_after_ms;
    entries.set(approval_id, { actor: actorKey(actor), archive: archiveId, request, expires: expires_at });
    return success({ approval_id, action: request.action, target_digest: request.target_digest, statement: request.statement, expires_at });
  }
  async function verify(actor: Actor, archiveId: string, id: string, action: string, digest: string, signal: AbortSignal) {
    const entry = entries.get(id);
    return !signal.aborted && actor.kind === "owner" && actor.channel === "authenticated-remote" && entry !== undefined && entry.actor === actorKey(actor) && entry.archive === archiveId && entry.request.action === action && entry.request.target_digest === digest && entry.expires > now();
  }
  return { issue, verify, evidence: (id: string) => entries.get(id)?.request, dispose: () => entries.clear() };
}
