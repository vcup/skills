/** Environment preferences are advice, never route authorization or model-quality rankings. */
import { actorKey, failure, success, type Actor, type ActorIdentity, type Applicability, type Result } from "./contracts.ts";
import { array, decode, enumeration, integer, literal, object, str, union, type Schema } from "./validation.ts";

export interface Route { readonly provider: string; readonly model: string }
export type Effort = { readonly mode: "default" | "inherit" } | { readonly mode: "explicit"; readonly value: string };
export interface Preference extends Route {
  readonly effort: Effort;
  readonly preset?: string;
  readonly applicability: Applicability;
  readonly reason: string;
}
export interface RolePreference { readonly role: string; readonly candidates: readonly Preference[] }
export interface Preferences { readonly roles: readonly RolePreference[] }
export type Availability = "allowed" | "unavailable" | "unknown";
export interface CatalogRoute extends Route {
  readonly availability: "available" | "unavailable" | "unknown";
  readonly efforts?: readonly string[];
}
/** These facts come from the live native caller and its recorded policy, not wire input. */
export interface EnvironmentCatalog {
  readonly session_id: string;
  readonly authorized_routes: readonly Route[];
  readonly selection_enabled: boolean;
  /** False when native trusted tool defaults may override the parent route. */
  readonly inheritance_known: boolean;
  readonly parent?: Route & { readonly reasoning_effort?: string };
  readonly routes: readonly CatalogRoute[];
  readonly presets: readonly { readonly id: string; readonly availability: "available" | "unavailable" | "unknown" }[];
  readonly allowed_presets: readonly string[];
  readonly observed_at: number;
}
export interface Recommendation {
  readonly preference: Preference;
  readonly availability: Availability;
  readonly applicability: "matched" | "mismatch" | "unknown";
  readonly reasons: readonly string[];
  /** Exact model-facing fresh-subagent fields; absent for refused/unknown candidates. */
  readonly request?: { readonly provider?: string; readonly model?: string; readonly reasoning_effort?: string; readonly agent_preset?: string };
}
export interface Recommendations {
  readonly role: string; readonly session_id: string; readonly observed_at: number;
  readonly candidates: readonly Recommendation[];
  readonly next_action: "choose_explicitly" | "resolve_gap";
}
export interface EnvironmentReadGrant {
  readonly subject: ActorIdentity; readonly expires_at?: number;
}
export type ApplyStatus = "pending" | "applied" | "failed" | "unknown";
export interface ApplicationTarget {
  readonly target_id: string;
  readonly expected_native_revision: number;
  readonly status: ApplyStatus;
  readonly observed_native_revision?: number;
  readonly detail: string;
}
export interface Application {
  readonly operation_id: string;
  readonly desired_revision: string;
  readonly preferences: Preferences;
  readonly targets: readonly ApplicationTarget[];
}
export interface SelectionEvidence {
  readonly evidence_id: string;
  readonly attempt_id: string;
  readonly requested: { readonly provider?: string; readonly model?: string; readonly reasoning_effort?: string; readonly preset?: string };
  readonly created: RouteEvidence;
  readonly actual: RouteEvidence;
}
export type RouteEvidence = {
  readonly status: "observed"; readonly session_id: string; readonly event_seq: number;
  readonly provider?: string; readonly model?: string; readonly reasoning_effort?: string;
} | { readonly status: "unknown" | "unavailable"; readonly reason: string };
export interface EnvironmentState {
  readonly format: "ensemble-environment/v1";
  readonly environment_id: string;
  readonly authorization_epoch: number;
  readonly read_grants: readonly EnvironmentReadGrant[];
  readonly desired: { readonly operation_id: string; readonly sequence: number; readonly preferences: Preferences; readonly restored_from?: string };
  readonly applications: readonly Application[];
  readonly evidence: readonly SelectionEvidence[];
}
export type EnvironmentMutation =
  | { readonly action: "set"; readonly operation_id: string; readonly preferences: Preferences; readonly restored_from?: string }
  | { readonly action: "read_grants"; readonly grants: readonly EnvironmentReadGrant[] }
  | { readonly action: "begin_apply"; readonly desired_sequence: number; readonly application: Application }
  | { readonly action: "observe_apply"; readonly operation_id: string; readonly targets: readonly ApplicationTarget[] }
  | { readonly action: "record_selection"; readonly evidence: SelectionEvidence };

const id = str(1, 128, "^[A-Za-z0-9][A-Za-z0-9_.:-]*$");
const name = str(1, 256, "^[^\\u0000-\\u001f]+$");
const revision = str(40, 40, "^[0-9a-f]{40}$");
const route = { provider: name, model: name };
const applicability = object({ task_types: array(name, 0, 64), interface_versions: array(name, 0, 64), required_capabilities: array(name, 0, 64) });
export const preferencesSchema: Schema = object({ roles: array(object({ role: id, candidates: array(object({ ...route,
  effort: union(object({ mode: enumeration("default", "inherit") }), object({ mode: literal("explicit"), value: name })),
  applicability, reason: str(1, 4096),
}, { preset: name }), 1, 32) }), 0, 32) });
const identity = union(object({ kind: literal("owner"), ownerId: name, hostAuthorityId: name }), object({ kind: literal("session"), sessionId: name, rootSessionId: name }));
const grants = array(object({ subject: identity }, { expires_at: integer() }), 0, 256);
const target = object({ target_id: id, expected_native_revision: integer(), status: enumeration("pending", "applied", "failed", "unknown"), detail: str(1, 2048) }, { observed_native_revision: integer() });
const application = object({ operation_id: id, desired_revision: revision, preferences: preferencesSchema, targets: array(target, 1, 16) });
const routeEvidence = union(object({ status: literal("observed"), session_id: name, event_seq: integer() }, { ...route, reasoning_effort: name }), object({ status: enumeration("unknown", "unavailable"), reason: str(1, 2048) }));
const evidence = object({ evidence_id: id, attempt_id: id, requested: object({}, { ...route, reasoning_effort: name, preset: name }), created: routeEvidence, actual: routeEvidence });
export const environmentStateSchema: Schema = object({ format: literal("ensemble-environment/v1"), environment_id: id, authorization_epoch: integer(1), read_grants: grants,
  desired: object({ operation_id: id, sequence: integer(1), preferences: preferencesSchema }, { restored_from: revision }), applications: array(application, 0, 1024), evidence: array(evidence, 0, 4096) });
const mutationSchema = union(
  object({ action: literal("set"), operation_id: id, preferences: preferencesSchema }, { restored_from: revision }),
  object({ action: literal("read_grants"), grants }), object({ action: literal("begin_apply"), desired_sequence: integer(1), application }),
  object({ action: literal("observe_apply"), operation_id: id, targets: array(target, 1, 16) }),
  object({ action: literal("record_selection"), evidence }),
);

export function decodePreferences(value: unknown): Result<Preferences> {
  const result = decode<Preferences>(value, preferencesSchema, {}, 128 * 1024);
  if (!result.ok) return result;
  if (new Set(result.value.roles.map(r => r.role)).size !== result.value.roles.length) return failure("invalid_input", "Duplicate role preference.");
  for (const role of result.value.roles) {
    const keys = role.candidates.map(c => JSON.stringify([c.provider, c.model, c.effort, c.preset ?? null]));
    if (new Set(keys).size !== keys.length) return failure("invalid_input", "Duplicate route/effort/preset candidate.");
  }
  return result;
}
export function decodeEnvironmentState(value: unknown): Result<EnvironmentState> {
  const result = decode<EnvironmentState>(value, environmentStateSchema, {}, 8 * 1024 * 1024);
  if (!result.ok) return result;
  const s = result.value;
  const preferences = decodePreferences(s.desired.preferences); if (!preferences.ok) return preferences;
  if (new Set(s.applications.map(a => a.operation_id)).size !== s.applications.length || new Set(s.evidence.map(e => e.evidence_id)).size !== s.evidence.length) return failure("invalid_input", "Duplicate durable environment identity.");
  for (const a of s.applications) {
    const p = decodePreferences(a.preferences); if (!p.ok) return p;
    if (new Set(a.targets.map(t => t.target_id)).size !== a.targets.length) return failure("invalid_input", "Duplicate application target.");
  }
  return result;
}
export function decodeEnvironmentMutation(value: unknown): Result<EnvironmentMutation> { return decode(value, mutationSchema); }
export function mayReadEnvironment(state: EnvironmentState, actor: Actor, hostAuthorityId: string, now: number): boolean {
  if (actor.kind === "owner") return actor.channel === "authenticated-remote" && actor.hostAuthorityId === hostAuthorityId;
  return state.read_grants.some(g => actorKey(g.subject) === actorKey(actor) && (g.expires_at === undefined || g.expires_at > now));
}
function matchesRoute(a: Route, b: Route): boolean { return a.provider === b.provider && a.model === b.model; }
function applicabilityOf(required: Applicability, context: Applicability): Recommendation["applicability"] {
  let unknown = false;
  for (const key of ["task_types", "interface_versions", "required_capabilities"] as const) {
    if (required[key].length === 0) continue;
    if (context[key].length === 0) { unknown = true; continue; }
    if (key === "required_capabilities" ? !required[key].every(v => context[key].includes(v)) : !required[key].some(v => context[key].includes(v))) return "mismatch";
  }
  return unknown ? "unknown" : "matched";
}
/** Preserves owner order. It never replaces an unavailable first choice with another route. */
export function recommendEnvironment(preferences: Preferences, role: string, context: Applicability, catalog: EnvironmentCatalog): Recommendations {
  const candidates = (preferences.roles.find(r => r.role === role)?.candidates ?? []).map((preference): Recommendation => {
    const reasons: string[] = [preference.reason];
    let availability: Availability = "allowed";
    const deny = (reason: string) => { availability = "unavailable"; reasons.push(reason); };
    const unknown = (reason: string) => { if (availability !== "unavailable") availability = "unknown"; reasons.push(reason); };
    const allowed = catalog.authorized_routes.some(r => matchesRoute(r, preference));
    if (!allowed) deny("This route is outside the calling Session's current native authorization.");
    const inherited = preference.effort.mode === "inherit";
    if (inherited && !catalog.inheritance_known) unknown("The tool instance's inherited defaults are not publicly confirmed; omission cannot promise the parent route.");
    if (inherited && (!catalog.parent || !matchesRoute(preference, catalog.parent))) deny("Inherit requires the actual parent route; route overrides clear inherited effort.");
    if (!inherited && !catalog.selection_enabled) deny("The visible fresh delegation tool does not permit explicit model selection.");
    const row = catalog.routes.find(r => matchesRoute(r, preference));
    if (!row || row.availability === "unknown") unknown("Native route availability could not be confirmed.");
    else if (row.availability === "unavailable") deny("The native adapter cannot currently resolve this route.");
    if (preference.effort.mode === "explicit") {
      if (row?.efforts === undefined) unknown("Native reasoning effort metadata is unavailable.");
      else if (!row.efforts.includes(preference.effort.value)) deny("The requested effort is not advertised by this exact native route.");
    }
    if (preference.preset !== undefined) {
      if (!catalog.allowed_presets.includes(preference.preset)) deny("Preset is not allowed by the visible fresh delegation tool.");
      const preset = catalog.presets.find(p => p.id === preference.preset);
      if (!preset || preset.availability === "unknown") unknown("Native preset availability could not be confirmed.");
      else if (preset.availability === "unavailable") deny("Native preset activation is unavailable.");
    }
    const applicability = applicabilityOf(preference.applicability, context);
    if (applicability !== "matched") reasons.push(`Task applicability is ${applicability}; this is not an affirmative recommendation.`);
    reasons.push(inherited ? "Omit all route/effort fields to inherit; this does not change parent or fork settings." : "Explicit provider/model with omitted effort uses that model's native default, not inherited effort.");
    const request = { ...(!inherited ? { provider: preference.provider, model: preference.model } : {}),
      ...(preference.effort.mode === "explicit" ? { reasoning_effort: preference.effort.value } : {}),
      ...(preference.preset !== undefined ? { agent_preset: preference.preset } : {}) };
    return { preference, availability, applicability, reasons, ...(availability === "allowed" && applicability === "matched" ? { request } : {}) };
  });
  return { role, session_id: catalog.session_id, observed_at: catalog.observed_at, candidates, next_action: candidates.some(c => c.request !== undefined) ? "choose_explicitly" : "resolve_gap" };
}
export function aggregateApplicationStatus(targets: readonly ApplicationTarget[]): ApplyStatus {
  return targets.some(t => t.status === "pending") ? "pending" : targets.some(t => t.status === "unknown") ? "unknown" : targets.some(t => t.status === "failed") ? "failed" : "applied";
}
/** Pure transitions. Current owner authorization and idempotent receipts live in the shared ledger. */
export function reduceEnvironment(state: EnvironmentState, input: EnvironmentMutation, sequence = state.desired.sequence + 1): Result<EnvironmentState> {
  const decoded = decodeEnvironmentMutation(input); if (!decoded.ok) return decoded;
  const mutation = decoded.value;
  const pending = state.applications.some(a => a.targets.some(t => t.status === "pending" || t.status === "unknown"));
  if (pending && mutation.action !== "observe_apply" && mutation.action !== "read_grants" && mutation.action !== "record_selection") return failure("invalid_transition", "Reconcile the pending native application before another environment mutation.");
  let next: EnvironmentState;
  switch (mutation.action) {
    case "set": {
      const preferences = decodePreferences(mutation.preferences); if (!preferences.ok) return preferences;
      next = { ...state, desired: { operation_id: mutation.operation_id, sequence, preferences: preferences.value, ...(mutation.restored_from ? { restored_from: mutation.restored_from } : {}) } }; break;
    }
    case "read_grants": next = { ...state, authorization_epoch: state.authorization_epoch + 1, read_grants: mutation.grants }; break;
    case "begin_apply": {
      if (state.desired.sequence !== mutation.desired_sequence) return failure("revision_conflict", "Only the current desired revision may be applied.");
      if (state.applications.some(a => a.operation_id === mutation.application.operation_id)) return failure("operation_key_conflict", "Application identity already exists.");
      if (mutation.application.targets.some(t => t.status !== "pending")) return failure("invalid_input", "Native apply must first record a pending intent.");
      if (!equalPreferences(state.desired.preferences, mutation.application.preferences)) return failure("revision_conflict", "Desired preferences changed before application.");
      next = { ...state, applications: [...state.applications, mutation.application] }; break;
    }
    case "observe_apply": {
      const old = state.applications.find(a => a.operation_id === mutation.operation_id);
      if (!old) return failure("not_found", "Application intent is absent.");
      if (mutation.targets.length !== old.targets.length || new Set(mutation.targets.map(t => t.target_id)).size !== old.targets.length || mutation.targets.some(t => !old.targets.some(p => p.target_id === t.target_id && p.expected_native_revision === t.expected_native_revision) || t.status === "pending")) return failure("invalid_input", "Observation must settle every exact intent target.");
      next = { ...state, applications: state.applications.map(a => a === old ? { ...a, targets: mutation.targets } : a) }; break;
    }
    case "record_selection": {
      if (state.evidence.some(e => e.evidence_id === mutation.evidence.evidence_id)) return failure("operation_key_conflict", "Selection evidence identity already exists.");
      const requested = mutation.evidence.requested;
      if ((requested.provider === undefined) !== (requested.model === undefined) || requested.reasoning_effort !== undefined && requested.provider === undefined) return failure("invalid_input", "Requested route fields must be paired; effort requires a route.");
      next = { ...state, evidence: [...state.evidence, mutation.evidence] }; break;
    }
  }
  return decodeEnvironmentState(next);
}
export function equalPreferences(a: Preferences, b: Preferences): boolean { const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value); return stable(a) === stable(b); }

export type EnvironmentRequest =
  | { action: "environment_read"; revision?: string }
  | { action: "environment_set"; expected_revision: string; operation_id: string; preferences: Preferences }
  | { action: "environment_restore"; expected_revision: string; operation_id: string; historical_revision: string }
  | { action: "environment_grant_read"; expected_revision: string; operation_id: string; grants: readonly EnvironmentReadGrant[] }
  | { action: "environment_preview"; desired_revision: string; target_ids: readonly string[] }
  | { action: "environment_apply"; expected_revision: string; operation_id: string; desired_revision: string; targets: readonly { target_id: string; expected_native_revision: number }[] }
  | { action: "environment_reconcile"; expected_revision: string; operation_id: string; application_id: string }
  | { action: "environment_backup"; expected_revision: string; operation_id: string; destination_handle: string }
  | { action: "environment_recover"; expected_revision: "absent"; operation_id: string; backup_handle: string }
  | { action: "environment_history"; revision: string; offset?: number; page_size?: number }
  /**
   * Record the three-stage native selection evidence for one attempt. The owner
   * names only the attempt; the requested route and bound member come from the
   * archive record, and created/actual from that member's own native log.
   */
  | { action: "environment_record_selection"; expected_revision: string; operation_id: string; attempt_id: string };
export interface EnvironmentSummary {
  readonly environment_id: string; readonly read_revision: string; readonly desired_revision: string;
  readonly authorization_epoch: number; readonly preferences: Preferences;
  readonly applications: readonly Application[]; readonly native_targets: readonly string[];
  /**
   * A bounded window of the most recent selection evidence (see
   * `evidence_total` for how many exist). The complete, paged record stays in
   * `environment_history`; this window keeps a single read inside its byte budget
   * instead of truncating silently.
   */
  readonly evidence: readonly SelectionEvidence[]; readonly evidence_total: number;
  readonly completeness: "complete"; readonly native_effect: string;
}
export interface EnvironmentRecommendation extends Recommendations {
  readonly environment_id: string; readonly read_revision: string; readonly desired_revision: string;
  readonly authorization_epoch: number; readonly native_revision: number; readonly target_id: string;
  readonly applied_status: "applied" | "pending" | "unknown";
}
