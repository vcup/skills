import type { AdminPayloads } from "../../../modules/ensemble/contracts.ts";
import type { LocaleKey } from "./locales.ts";
import { json, type Fields, type Json } from "./protocol.ts";
export interface FormField { readonly name: string; readonly label: LocaleKey; readonly format?: "json" | "list" | "number"; readonly optional?: boolean; }
const f = (name: string, label: LocaleKey, format?: FormField["format"], optional?: boolean): FormField => ({ name, label, ...(format ? { format } : {}), ...(optional ? { optional } : {}) });
const reason = f("reason", "reason");

/** The authenticated owner's own subject, as the Host reports it. */
export interface OwnerSubject {
  readonly kind: "owner";
  readonly ownerId: string;
  readonly hostAuthorityId: string;
}

/**
 * The values a form must actually use, once defaults the Host requires are supplied.
 *
 * `initialize` refuses to run without at least one grant (`array(grantRequest, 1)` in the
 * Host's decoder), and a grant's subject must be the **authenticated owner** — which a
 * person must never type. So when the operator has not touched the field, the form supplies
 * the owner's own identity with the minimal `read`/`project` grant.
 *
 * The distinction that matters: this is a *default*, not an override. A value the operator
 * supplied — **including an empty string they deliberately cleared** — always wins, which is
 * why the test is `=== undefined` and not a truthiness check. Both the rendered control and
 * the submitted payload call this, so what is on screen is exactly what is sent; an earlier
 * version computed the grant and never used it, so the new candidate showed nothing and
 * submitted nothing.
 *
 * @param action - the selected management action.
 * @param values - the operator's current form values.
 * @param owner - the owner subject the Host reported, if any.
 * @returns the values to render and to submit.
 */
export function effectiveFields(
  action: string,
  values: Readonly<Record<string, string | undefined>>,
  owner: OwnerSubject | undefined,
): Readonly<Record<string, string | undefined>> {
  if (action !== "initialize") return values;
  if (values.initial_grants !== undefined) return values;
  // No owner reported yet: leave the field untouched rather than inventing a subject. The
  // form then cannot submit a legal initialize, which is the honest outcome — the Host's
  // decoder refuses an empty list, and that refusal is better than a fabricated actor.
  if (owner === undefined) return values;
  return {
    ...values,
    initial_grants: JSON.stringify([{ subject: owner, rights: ["read"], scope: { kind: "project" } }]),
  };
}
/** Forms describe owner operations only. They never invent model actors or infer owner approval. */
export const management = {
  initialize: [f("root_handle", "rootHandle"), f("source_descriptor", "sourceDescriptor", "json"), f("initial_grants", "grants", "json"), f("limits", "limits", "json")],
  bind: [f("source_descriptor", "sourceDescriptor", "json"), f("mapping_evidence", "mapping", "json"), reason],
  rebind: [f("source_descriptor", "sourceDescriptor", "json"), f("mapping_evidence", "mapping", "json"), reason],
  grant: [f("subject", "subject", "json"), f("rights", "rights", "list"), f("scope", "scope", "json"), f("expires_at", "expiresAt", "number", true), f("delegable_rights", "delegableRights", "list", true), reason],
  revoke: [f("grant_id", "identifier"), reason],
  takeover: [f("invocation_id", "invocationId"), f("new_lead_session_id", "newLead"), reason],
  assign_reviewer: [f("proposal_ref", "proposal", "json"), f("reviewer_session_id", "reviewer"), f("delegated_rights", "rights", "list")],
  pause: [reason], resume: [reason, f("diagnostic_ref", "diagnostic", "json")],
  inventory_import: [f("source_handle", "sourceHandle"), f("selection", "selection", "json"), f("budget", "budget", "number")],
  commit_import: [f("inventory_id", "inventory"), f("accepted_exceptions", "exceptions", "json"), f("approval_ref", "approval", "json")],
  export: [f("revision", "snapshot"), f("selection", "selection", "json"), f("destination_handle", "destination"), f("overwrite_approval", "approval", "json", true)],
  backup: [f("revision", "snapshot"), f("destination_handle", "destination")],
  restore: [f("backup_handle", "backupHandle"), f("mapping_evidence", "mapping", "json")],
  relocate: [f("destination_handle", "destination"), f("source_stop_evidence", "stopEvidence", "json"), f("mapping_evidence", "mapping", "json"), f("source_descriptor", "sourceDescriptor", "json"), f("initial_grants", "grants", "json"), f("approval_ref", "approval", "json")],
  activate_restore: [f("candidate_id", "candidate"), f("mode", "restoreMode"), f("source_descriptor", "sourceDescriptor", "json"), f("initial_grants", "grants", "json"), f("approval_ref", "approval", "json"), f("source_stop_evidence", "stopEvidence", "json"), f("final_head_ref", "approval", "json", true), f("loss_statement", "lossStatement", undefined, true)],
  plan_maintenance: [f("kind", "maintenanceKind"), f("backup_handle", "backupHandle", undefined, true), f("content_digests", "digest", "list", true), f("source_handle", "sourceHandle", undefined, true), f("target_format", "targetFormat", undefined, true), reason],
  upgrade: [f("target_format", "targetFormat"), f("migration_plan_ref", "plan", "json")],
  diagnose: [f("scope", "scope")], maintain: [f("plan_ref", "plan", "json"), f("approval_ref", "approval", "json")],
  configure_replica: [f("destination_handle", "destination"), f("credential_handle", "credential"), f("expected_remote_identity", "remoteIdentity")],
  push_replica: [f("replica_id", "replica"), f("local_revision", "snapshot")],
  fetch_replica: [f("replica_id", "replica"), f("expected_remote_revision", "remoteRevision")],

} as const satisfies Record<keyof AdminPayloads, readonly FormField[]> & Record<string, readonly FormField[]>;
export type ManagementAction = keyof typeof management;
export const accessActions: readonly ManagementAction[] = ["initialize", "bind", "rebind", "grant", "revoke", "takeover", "assign_reviewer", "pause", "resume"];
export const maintenanceActions = (Object.keys(management) as ManagementAction[]).filter(action => !accessActions.includes(action));
export function formPayload(action: ManagementAction, values: Readonly<Record<string, string>>): Fields {
  const result: Record<string, Json> = {};
  for (const field of management[action] as readonly FormField[]) {
    const value = (values[field.name] ?? "").trim();
    if (!value) { if (field.optional) continue; throw new Error(field.name); }
    if (field.format === "json") result[field.name] = json(JSON.parse(value));
    else if (field.format === "list") { const list = value.split(/[,\n]/u).map(item => item.trim()).filter(Boolean); if (!list.length) throw new Error(field.name); result[field.name] = list; }
    else if (field.format === "number") { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(field.name); result[field.name] = number; }
    else result[field.name] = value;
  }
  return result;
}
