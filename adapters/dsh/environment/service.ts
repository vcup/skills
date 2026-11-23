/** Independent environment history and recoverable native Settings application. */
import { createHash, randomUUID } from "node:crypto";
import { failure, success, type Actor, type Applicability, type EnvironmentPreferences, type Result } from "../../../modules/ensemble/contracts.ts";
import { decodeEnvironmentState, decodePreferences, equalPreferences, mayReadEnvironment, preferencesSchema, recommendEnvironment, reduceEnvironment,
  type EnvironmentRequest, type EnvironmentSummary, type EnvironmentRecommendation, type Application, type ApplicationTarget, type EnvironmentCatalog, type EnvironmentMutation, type EnvironmentState, type Preferences, type SelectionEvidence } from "../../../modules/ensemble/environment.ts";
import { array, decode, integer, literal, object, str, union, type Schema } from "../../../modules/ensemble/validation.ts";
import { createVersionedLedger, type LedgerAnswer, type LedgerOptions, type VersionedLedger } from "../store/ledger.ts";
import type { NativePreferences, NativePreferenceState } from "./native.ts";
import { collectSelectionEvidence, type SelectionRequest, type SelectionSource } from "./selection.ts";
import { maintainEnvironment, type EnvironmentLocations } from "./maintenance.ts";

const id = str(1, 128, "^[A-Za-z0-9][A-Za-z0-9_.:-]*$");
const revision = str(40, 40, "^[0-9a-f]{40}$");
const expected = union(revision, literal("absent"));
const versioned = { expected_revision: expected, operation_id: id };
const settingsTarget = object({ target_id: id, expected_native_revision: integer() });
const grantSchema = object({ subject: object({ kind: literal("session"), sessionId: id, rootSessionId: id }) }, { expires_at: integer() });
export const environmentRequestSchema: Schema = union(
  object({ action: literal("environment_read") }, { revision }),
  object({ action: literal("environment_set"), ...versioned, preferences: preferencesSchema }),
  object({ action: literal("environment_restore"), ...versioned, historical_revision: revision }),
  object({ action: literal("environment_grant_read"), ...versioned, grants: array(grantSchema, 0, 256) }),
  object({ action: literal("environment_preview"), desired_revision: revision, target_ids: array(id, 1, 16) }),
  object({ action: literal("environment_apply"), ...versioned, desired_revision: revision, targets: array(settingsTarget, 1, 16) }),
  object({ action: literal("environment_reconcile"), ...versioned, application_id: id }),
  object({ action: literal("environment_backup"), expected_revision: revision, operation_id: id, destination_handle: id }),
  object({ action: literal("environment_recover"), expected_revision: literal("absent"), operation_id: id, backup_handle: id }),
  object({ action: literal("environment_history"), revision }, { offset: integer(), page_size: integer(1, 100) }),
  // Selection evidence: the owner names only the attempt. The requested route and
  // the bound member come from the archive record and that member's own native
  // log, so no wire input can claim a route or a member.
  object({ action: literal("environment_record_selection"), ...versioned, attempt_id: id }),
);
export function decodeEnvironmentRequest(input: unknown): Result<EnvironmentRequest> { return decode(input, environmentRequestSchema); }
/**
 * Closed decoder for every result this domain can commit to a ledger receipt.
 *
 * The store validates the receipt envelope but treats `result` as opaque, so a
 * rewritten receipt field would otherwise replay as a genuine business answer.
 * These are exactly the shapes the reducers below produce: an initial `set`
 * carries its desired sequence, a later `set` does not, `begin_apply` carries
 * its application id, and recovery carries the new identity with both replay
 * flags false. Anything else — extra, missing or retyped fields — is corrupt.
 */
const environmentResultSchema: Schema = union(
  object({ action: literal("set") }, { desired_sequence: integer(1) }),
  object({ action: literal("begin_apply"), application_id: id }),
  object({ action: literal("read_grants") }),
  object({ action: literal("observe_apply") }),
  object({ action: literal("record_selection") }),
  object({ action: literal("environment_recover"), previous_environment_id: id, environment_id: id, recovered_from: revision,
    read_grants_restored: literal(false), native_actions_replayed: literal(false) }),
);
export function decodeEnvironmentResult(value: unknown): Result<unknown> { return decode(value, environmentResultSchema, {}, 64 * 1024); }
export interface EnvironmentServiceOptions extends Omit<LedgerOptions<EnvironmentState>, "format" | "decodeState" | "authorize" | "decodeResult"> {
  readonly native: NativePreferences;
  readonly locations?: EnvironmentLocations;
  /** Trusted native collector. Ordinary owner requests cannot submit observed selection evidence. */
  readonly collectSelection?: (attemptId: string, signal: AbortSignal) => Promise<Result<SelectionEvidence>>;
  /**
   * Optional native wiring for the same evidence: `resolve` turns an attempt id
   * into the exact archive-recorded request (never model input) and the observed
   * member Session; `source` reads that Session's own log. Both are trusted Host
   * facts, so `collectSelection` and this hook are alternatives, not inputs.
   */
  readonly selection?: {
    readonly source: SelectionSource;
    resolve(attemptId: string, signal: AbortSignal): Promise<Result<Omit<SelectionRequest, "evidence_id">>>;
  };
}
const nativeEffect = "Applies Ensemble role advice only. Native Session route/preset authorization, root selection and fork options remain owned by DSH; changed authorization requires a new root to sample it.";
/** How many recent selection-evidence entries one summary read carries; the rest stay paged in history. */
const EVIDENCE_WINDOW = 8;
function bound<T>(value: T, limit = 32768): Result<T> { return new TextEncoder().encode(JSON.stringify(value)).length > limit ? failure("budget_exceeded", "Complete environment response exceeds its byte budget; select a role or read a history page.") : success(value); }
function requireOwner(actor: Actor, authority: string): Result<true> { return actor.kind === "owner" && actor.channel === "authenticated-remote" && actor.hostAuthorityId === authority ? success(true) : failure("not_authorized", "Authenticated current Host owner is required."); }
function compact(answer: LedgerAnswer<EnvironmentState>) { return { status: "committed" as const, committed_revision: answer.revision, head_revision: answer.head_revision, sequence: answer.sequence, replayed: answer.replayed, result: answer.result }; }

/** Passed as a spread so the store can make `decodeResult` required without breaking this call site. */
const resultCodec: { readonly decodeResult: (value: unknown) => Result<unknown> } = { decodeResult: decodeEnvironmentResult };

export class EnvironmentService {
  readonly #ledger: VersionedLedger<EnvironmentState>;
  readonly #options: EnvironmentServiceOptions;
  readonly #lifetime = new AbortController();
  constructor(options: EnvironmentServiceOptions) {
    this.#options = options;
    this.#ledger = createVersionedLedger({ ...options, ...resultCodec, responseBytes: 8 * 1024 * 1024, format: "ensemble-environment/v1", decodeState: decodeEnvironmentState,
      authorize: (actor, current, mode) => mode === "write" ? requireOwner(actor, options.hostAuthorityId) : current && mayReadEnvironment(current, actor, options.hostAuthorityId, Date.now()) ? success(true) : requireOwner(actor, options.hostAuthorityId) });
  }
  dispose(): void { this.#lifetime.abort(); this.#ledger.dispose(); }
  #signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.#lifetime.signal]); }
  #mutate(actor: Actor, expectedRevision: string, operationId: string, mutation: EnvironmentMutation, signal: AbortSignal, business?: unknown) {
    return this.#ledger.transact(actor, { expectedRevision, operationId, command: business ?? mutation }, (state, _command, context) => {
      const command = mutation;
      if (!state) {
        if (command.action !== "set") return failure("invalid_transition", "Initialize the environment by saving desired preferences first.");
        const preferences = decodePreferences(command.preferences); if (!preferences.ok) return preferences;
        const created: EnvironmentState = { format: "ensemble-environment/v1", environment_id: `environment-${randomUUID()}`, authorization_epoch: 1, read_grants: [],
          desired: { operation_id: command.operation_id, sequence: context.sequence, preferences: preferences.value, ...(command.restored_from ? { restored_from: command.restored_from } : {}) }, applications: [], evidence: [] };
        return success({ state: created, result: { action: command.action, desired_sequence: context.sequence } });
      }
      const result = reduceEnvironment(state, command, context.sequence);
      return result.ok ? success({ state: result.value, result: { action: command.action, ...(command.action === "begin_apply" ? { application_id: command.application.operation_id } : {}) } }) : result;
    }, signal);
  }
  /** The one owner control interface; every branch decodes the same closed wire schema. */
  async execute(actor: Actor, input: unknown, signal: AbortSignal): Promise<Result<unknown>> {
    const authorized = requireOwner(actor, this.#options.hostAuthorityId); if (!authorized.ok) return authorized;
    const decoded = decodeEnvironmentRequest(input); if (!decoded.ok) return decoded;
    const request = decoded.value; signal = this.#signal(signal);
    const run = async (signal: AbortSignal): Promise<Result<unknown>> => { try {
      signal.throwIfAborted();
      switch (request.action) {
        case "environment_read": return this.read(actor, request.revision, signal);
        case "environment_set": {
          const r = await this.#mutate(actor, request.expected_revision, request.operation_id, { action: "set", operation_id: request.operation_id, preferences: request.preferences }, signal);
          return r.ok ? bound(compact(r.value)) : r;
        }
        case "environment_restore": {
          const historical = await this.#ledger.read(actor, request.historical_revision, signal); if (!historical.ok) return historical;
          const r = await this.#mutate(actor, request.expected_revision, request.operation_id, { action: "set", operation_id: request.operation_id, preferences: historical.value.state.desired.preferences, restored_from: request.historical_revision }, signal);
          return r.ok ? bound(compact(r.value)) : r;
        }
        case "environment_grant_read": {
          const r = await this.#mutate(actor, request.expected_revision, request.operation_id, { action: "read_grants", grants: request.grants }, signal);
          return r.ok ? bound(compact(r.value)) : r;
        }
        case "environment_preview": return this.#preview(actor, request, signal);
        case "environment_apply": return this.#apply(actor, request, signal);
        case "environment_reconcile": return this.#reconcile(actor, request.application_id, request.expected_revision, request.operation_id, signal);
        case "environment_record_selection": return this.recordSelection(actor, request.expected_revision, request.operation_id, request.attempt_id, signal);
        case "environment_backup": case "environment_recover":
          return this.#options.locations ? maintainEnvironment(this, this.#options.root, this.#options.locations, actor, request, signal) : failure("storage_unavailable", "Native owner location handles are not mounted for environment maintenance.");
        case "environment_history": {
          const r = await this.#ledger.read(actor, request.revision, signal); if (!r.ok) return r;
          const items = [...r.value.state.applications.map(application => ({ kind: "application", application })), ...r.value.state.evidence.map(evidence => ({ kind: "selection_evidence", evidence }))];
          const offset = request.offset ?? 0, size = request.page_size ?? 20;
          if (offset > items.length) return failure("invalid_input", "History offset is outside this fixed revision.");
          const end = Math.min(items.length, offset + size);
          return bound({ read_revision: request.revision, items: items.slice(offset, end), completeness: end === items.length ? "complete" : "partial", ...(end < items.length ? { next_offset: end } : {}) });
        }
      }
    } catch { return failure(request.action === "environment_apply" || request.action === "environment_reconcile" ? "outcome_unknown" : "storage_unavailable", "Environment operation was interrupted; inspect its receipt and native application state before retrying."); } };
    // Selection evidence has no native effect, so it needs no effect lock; its ledger transaction takes the writer lock itself.
    return request.action === "environment_read" || request.action === "environment_preview" || request.action === "environment_history" || request.action === "environment_recover" || request.action === "environment_record_selection" ? run(signal) : this.#ledger.withEffectLock(actor, signal, run);
  }
  async read(actor: Actor, revision: string | undefined, signal: AbortSignal): Promise<Result<EnvironmentSummary>> {
    const r = await this.#ledger.read(actor, revision, this.#signal(signal)); if (!r.ok) return r;
    const desired = await this.#ledger.revisionAt(actor, r.value.state.desired.sequence, signal); if (!desired.ok) return desired;
    // Evidence is paged in `environment_history`; this read carries only the most
    // recent window plus the true total, so a long history cannot silently
    // truncate a response or claim completeness it does not have.
    const evidence = r.value.state.evidence.slice(-EVIDENCE_WINDOW);
    return bound({ environment_id: r.value.state.environment_id, read_revision: r.value.revision, desired_revision: desired.value,
      authorization_epoch: r.value.state.authorization_epoch, preferences: r.value.state.desired.preferences, applications: r.value.state.applications,
      native_targets: this.#options.native.targets, evidence, evidence_total: r.value.state.evidence.length,
      completeness: "complete", native_effect: nativeEffect });
  }
  async #preview(actor: Actor, request: Extract<EnvironmentRequest, { action: "environment_preview" }>, signal: AbortSignal): Promise<Result<unknown>> {
    const desired = await this.#ledger.read(actor, request.desired_revision, signal); if (!desired.ok) return desired;
    const desiredRevision = await this.#ledger.revisionAt(actor, desired.value.state.desired.sequence, signal); if (!desiredRevision.ok) return desiredRevision;
    if (desiredRevision.value !== request.desired_revision) return failure("revision_conflict", "Preview requires the commit that saved desired preferences.");
    if (new Set(request.target_ids).size !== request.target_ids.length) return failure("invalid_input", "Duplicate target id.");
    const targets = [];
    for (const targetId of request.target_ids) {
      const current = await this.#options.native.read(targetId, signal); if (!current.ok) return current;
      targets.push({ target_id: targetId, expected_native_revision: current.value.revision, before: current.value.preferences, desired: desired.value.state.desired.preferences,
        changed: !equalPreferences(current.value.preferences, desired.value.state.desired.preferences) });
    }
    return bound({ desired_revision: request.desired_revision, targets, native_effect: nativeEffect });
  }
  async #apply(actor: Actor, request: Extract<EnvironmentRequest, { action: "environment_apply" }>, signal: AbortSignal): Promise<Result<unknown>> {
    if (new Set(request.targets.map(t => t.target_id)).size !== request.targets.length) return failure("invalid_input", "Duplicate target id.");
    if (request.targets.some(t => !this.#options.native.targets.includes(t.target_id))) return failure("not_authorized", "Application target is not a registered Ensemble Settings instance.");
    const desired = await this.#ledger.read(actor, request.desired_revision, signal); if (!desired.ok) return desired;
    const desiredRevision = await this.#ledger.revisionAt(actor, desired.value.state.desired.sequence, signal); if (!desiredRevision.ok) return desiredRevision;
    if (desiredRevision.value !== request.desired_revision) return failure("revision_conflict", "Application requires the exact desired commit.");
    const application: Application = { operation_id: request.operation_id, desired_revision: request.desired_revision, preferences: desired.value.state.desired.preferences,
      targets: request.targets.map(t => ({ ...t, status: "pending", detail: "Durable intent saved before native Settings mutation." })) };
    const intent = await this.#mutate(actor, request.expected_revision, request.operation_id, { action: "begin_apply", desired_sequence: desired.value.state.desired.sequence, application }, signal);
    if (!intent.ok) return intent; // No native side effect until the intent publication is known.
    if (intent.value.replayed) {
      const current = await this.#ledger.read(actor, undefined, signal); if (!current.ok) return current;
      const previous = current.value.state.applications.find(a => a.operation_id === request.operation_id);
      if (!previous) return failure("archive_corrupt", "Committed native intent is missing from current environment history.");
      if (!previous.targets.some(t => t.status === "pending" || t.status === "unknown")) return bound({ ...compact(intent.value), application: previous, native_effect: nativeEffect });
      return this.#reconcile(actor, request.operation_id, current.value.revision, `reconcile-${randomUUID()}`, signal);
    }
    const targets: ApplicationTarget[] = [];
    for (const target of application.targets) {
      const before = await this.#options.native.read(target.target_id, signal);
      let outcome: Result<true>;
      if (!before.ok) outcome = before;
      else if (before.value.revision !== target.expected_native_revision) outcome = failure("revision_conflict", "Native Settings revision changed before apply.");
      else if (equalPreferences(before.value.preferences, application.preferences)) outcome = success(true);
      else outcome = await this.#options.native.apply(target.target_id, application.preferences, target.expected_native_revision, signal);
      // Even a lost native response is reconciled by reading, never by retrying the mutation.
      const observed = await this.#options.native.read(target.target_id, signal);
      targets.push(this.#observation(target, application.preferences, observed, outcome));
    }
    const settled = await this.#mutate(actor, intent.value.head_revision, `settle-${createHash("sha256").update(request.operation_id).digest("hex")}`, { action: "observe_apply", operation_id: request.operation_id, targets }, signal);
    return settled.ok ? bound({ ...compact(settled.value), application: { ...application, targets }, native_effect: nativeEffect }) : failure("outcome_unknown", "Native Settings may have changed; environment_reconcile the saved application before any new apply.");
  }
  /**
   * Settle one intent target from native readback. A definite refusal (any code
   * other than an unconfirmed outcome) proves no native write is pending, so the
   * intent is `failed` and the owner may start a new operation; `unknown` stays
   * reserved for readback loss and writes whose effect cannot be established.
   */
  #observation(target: ApplicationTarget, desired: Preferences, observed: Result<NativePreferenceState>, outcome?: Result<true>, resolveMismatch = false): ApplicationTarget {
    if (!observed.ok) return { ...target, status: "unknown", detail: "Native Settings readback unavailable; do not resend the native update." };
    if (equalPreferences(observed.value.preferences, desired)) return { ...target, observed_native_revision: observed.value.revision, status: "applied",
      detail: "Desired role advice read back from native Settings; model execution and Session authority are separate." };
    const code = outcome !== undefined && !outcome.ok ? outcome.error.code : undefined;
    const refused = code !== undefined && code !== "outcome_unknown" && code !== "storage_unavailable" ? code : undefined;
    if (refused !== undefined || resolveMismatch) return { ...target, observed_native_revision: observed.value.revision, status: "failed",
      detail: refused === "revision_conflict" ? "Native revision conflict; concurrent changes were not overwritten." : refused !== undefined ? `Native Settings refused this update (${refused}); current native values were preserved.` : "Readback shows native Settings differ from the saved intent; the intent is not retried and no further native write was sent." };
    return { ...target, observed_native_revision: observed.value.revision, status: "unknown", detail: "Native Settings differ from the saved intent; owner must review current values before a new operation." };
  }
  async #reconcile(actor: Actor, applicationId: string, expectedRevision: string, operationId: string, signal: AbortSignal): Promise<Result<unknown>> {
    const current = await this.#ledger.read(actor, undefined, signal); if (!current.ok) return current;
    const application = current.value.state.applications.find(a => a.operation_id === applicationId); if (!application) return failure("not_found", "Application intent not found.");
    // An explicit reconcile is the readback that ends uncertainty: a native
    // mismatch is a settled refusal, while an unreadable target stays unknown.
    const targets: ApplicationTarget[] = [];
    for (const target of application.targets) targets.push(this.#observation(target, application.preferences, await this.#options.native.read(target.target_id, signal), undefined, true));
    const r = await this.#mutate(actor, expectedRevision, operationId, { action: "observe_apply", operation_id: applicationId, targets }, signal, { action: "reconcile", application_id: applicationId });
    return r.ok ? bound({ ...compact(r.value), application: r.value.state.applications.find(a => a.operation_id === applicationId), native_effect: nativeEffect }) : r;
  }
  /** Model reads consume the live applied native field, never merely saved desired state. */
  async recommend(actor: Actor, role: string, taskContext: Applicability, catalog: EnvironmentCatalog, targetId: string, signal: AbortSignal): Promise<Result<EnvironmentRecommendation>> {
    const current = await this.#ledger.read(actor, undefined, this.#signal(signal)); if (!current.ok) return current;
    if (actor.kind !== "session" || catalog.session_id !== actor.sessionId) return failure("not_authorized", "Recommendations require the exact current native caller catalog.");
    const native = await this.#options.native.read(targetId, signal); if (!native.ok) return native;
    const desired = await this.#ledger.revisionAt(actor, current.value.state.desired.sequence, signal); if (!desired.ok) return desired;
    const answer: EnvironmentRecommendation = { ...recommendEnvironment(native.value.preferences, role, taskContext, catalog), environment_id: current.value.state.environment_id,
      read_revision: current.value.revision, desired_revision: desired.value, authorization_epoch: current.value.state.authorization_epoch,
      native_revision: native.value.revision, target_id: targetId, applied_status: equalPreferences(native.value.preferences, current.value.state.desired.preferences) ? "applied" : "pending" };
    // Recheck current authorization after asynchronous native reads, including expiry/revocation.
    const rechecked = await this.#ledger.read(actor, undefined, signal); if (!rechecked.ok) return rechecked;
    if (rechecked.value.state.authorization_epoch !== current.value.state.authorization_epoch) return failure("not_authorized", "Environment authorization changed during recommendation.");
    return bound(answer);
  }
  /** Compatibility projection for QueryFacts; richer callers should retain the full recommendation. */
  queryFacts(recommendation: EnvironmentRecommendation): EnvironmentPreferences {
    return { role: recommendation.role, desired_revision: recommendation.desired_revision, applied_status: recommendation.applied_status,
      candidates: recommendation.candidates.map(c => ({ selection: { provider: c.preference.provider, model: c.preference.model,
        ...(c.preference.effort.mode === "explicit" ? { reasoning_effort: c.preference.effort.value } : {}), ...(c.preference.preset ? { preset: c.preference.preset } : {}) },
        reason: c.reasons.join(" "), availability: c.availability === "allowed" ? "available" : c.availability })) };
  }
  /**
   * Record trusted native selection evidence for one attempt.
   *
   * The owner names only the attempt; the exact requested route and bound member
   * Session come from the archive record, and created/actual come from that
   * member's own native log. The evidence identity is the operation key, so an
   * identical retry replays the first commit and a different payload conflicts.
   */
  async recordSelection(actor: Actor, expectedRevision: string, operationId: string, attemptId: string, signal: AbortSignal): Promise<Result<unknown>> {
    const auth = requireOwner(actor, this.#options.hostAuthorityId); if (!auth.ok) return auth;
    let evidence: Result<SelectionEvidence>;
    if (this.#options.selection) {
      const resolved = await this.#options.selection.resolve(attemptId, signal); if (!resolved.ok) return resolved;
      evidence = await collectSelectionEvidence(this.#options.selection.source, { ...resolved.value, evidence_id: operationId }, signal);
    } else if (this.#options.collectSelection) evidence = await this.#options.collectSelection(attemptId, signal);
    else return failure("storage_unavailable", "Trusted native selection evidence collector is not mounted.");
    if (!evidence.ok) return evidence;
    if (evidence.value.attempt_id !== attemptId) return failure("invalid_input", "Collected evidence describes a different attempt.");
    const r = await this.#mutate(actor, expectedRevision, operationId, { action: "record_selection", evidence: evidence.value }, signal);
    return r.ok ? bound(compact(r.value)) : r;
  }
  /** Recover only into this deployment's empty independent environment root; never reactivate old grants or effects. */
  async restoreBackup(actor: Actor, bytes: Uint8Array, expectedHead: string, operationId: string, signal: AbortSignal): Promise<Result<unknown>> {
    return this.#ledger.withEffectLock(actor, this.#signal(signal), bounded => this.#ledger.restore(actor, { bytes, expectedHead, operationId }, (old, context) => {
      const state: EnvironmentState = { ...old, environment_id: `environment-${randomUUID()}`, authorization_epoch: old.authorization_epoch + 1, read_grants: [],
        desired: { operation_id: operationId, sequence: context.sequence, preferences: old.desired.preferences, restored_from: context.revision }, applications: [] };
      return success({ state, result: { action: "environment_recover", previous_environment_id: old.environment_id, environment_id: state.environment_id,
        recovered_from: context.revision, read_grants_restored: false, native_actions_replayed: false } });
    }, bounded)).then(r => r.ok ? bound(compact(r.value)) : r);
  }
  /** Complete history backup for the maintenance destination-handle executor, never a project export. */
  async backup(actor: Actor, signal: AbortSignal, expectedRevision?: string): Promise<Result<{ bytes: Uint8Array; revision: string; environment_id: string; digest: string }>> {
    return this.#ledger.withOwner(actor, this.#signal(signal), async lease => {
      if (!lease.current) return failure("not_found", "Environment is not initialized.");
      if (expectedRevision !== undefined && lease.current.revision !== expectedRevision) return failure("revision_conflict", "Backup revision is not the current locked environment head.");
      const bytes = await lease.kernel.backup(lease.root, lease.current.revision, lease.signal);
      await lease.kernel.verifyBundle(lease.root, bytes, lease.signal);
      return success({ bytes, revision: lease.current.revision, environment_id: lease.current.state.environment_id, digest: createHash("sha256").update(bytes).digest("hex") });
    });
  }
}
export function createEnvironmentService(options: EnvironmentServiceOptions): EnvironmentService { return new EnvironmentService(options); }

export type { EnvironmentRequest, EnvironmentSummary, EnvironmentRecommendation } from "../../../modules/ensemble/environment.ts";
