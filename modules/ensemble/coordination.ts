/** Complete pure coordination reducer. No persistence, native execution or path generation. */
import * as C from "./contracts.ts";
import { decodeWorkCommand } from "./codec.ts";
import { authorizeCommand, findDelegatingGrant, hasRight, isAssignedReviewer, isLead, mayReadObject, objectAt, sameActor, sameRef } from "./policy.ts";
class Refusal extends Error {
    constructor(readonly code: C.FailureCode, message: string) { super(message); }
}
function refuse(code: C.FailureCode, message: string): never { throw new Refusal(code, message); }
function requireThat(value: unknown, code: C.FailureCode, message: string): asserts value {
    if (!value)
        refuse(code, message);
}
const refOf = (o: C.DomainRecord): C.ObjectRef => ({
    kind: "object", object_id: o.id, object_revision: o.object_revision
});
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const sameOptionalRef = (a: C.ObjectRef | undefined, b: C.ObjectRef | undefined) => a === undefined ? b === undefined : b !== undefined && sameRef(a, b);
class Change {
    readonly upserts: C.DomainRecord[] = [];
    readonly content: C.ContentWrite[] = [];
    policy: C.PolicySnapshot | undefined;
    constructor(readonly snapshot: C.Snapshot, readonly facts: C.TrustedFacts) { }
    get<K extends C.ObjectKind>(id: string, kind: K): C.RecordOf<K> {
        const object = this.upserts.find(o => o.id === id) ?? this.snapshot.objects.find(o => o.id === id);
        requireThat(object && object.kind === kind, "not_found", `${kind} is unavailable.`);
        return object as C.RecordOf<K>;
    }
    exact(ref: C.ObjectRef, kinds?: readonly C.ObjectKind[], current = false): C.DomainRecord {
        const object = objectAt(this.snapshot, ref);
        requireThat(object && (!kinds || kinds.includes(object.kind)), "not_found", "Referenced object version is unavailable or has the wrong kind.");
        requireThat(mayReadObject(this.snapshot, this.facts.actor, object, this.facts.now), "not_authorized", "Referenced object is outside the current read grant.");
        if (current)
            requireThat(this.snapshot.objects.some(o => o.id === ref.object_id && o.object_revision === ref.object_revision), "object_changed", "Referenced object has changed; read and decide again.");
        return object;
    }
    refs(refs: readonly C.Ref[]): void {
        for (const ref of refs) {
            if (ref.kind === "object")
                this.exact(ref);
            else if (ref.kind === "external" && ref.snapshot_ref)
                this.exact(ref.snapshot_ref, ["artifact"]);
            else if (ref.kind === "reported")
                this.refs(ref.supporting_refs);
            else if (ref.kind === "source")
                requireThat(this.snapshot.bindings.some(b => b.bindingId === ref.binding_id), "not_found", "Source binding is unavailable.");
            else if (ref.kind === "native_task")
                requireThat(this.facts.nativeTaskRefs?.some(t => t.root_session_id === ref.root_session_id && t.task_id === ref.task_id && t.task_revision === ref.task_revision), "not_found", "Native task revision has not been verified.");
            else if (ref.kind === "native_event")
                requireThat(this.facts.observedEventRefs?.some(r => r.kind === "native_event" && r.session_id === ref.session_id && r.event_seq === ref.event_seq) || this.facts.nativeMembers?.some(m => m.creationRef.kind === "native_event" && m.creationRef.session_id === ref.session_id && m.creationRef.event_seq === ref.event_seq), "not_found", "Native event reference has not been verified.");
        }
    }
    make<K extends C.ObjectKind>(kind: K, body: C.RecordBodies[K]): C.RecordOf<K> {
        const id = this.facts.newId(kind);
        requireThat(id.length > 0 && !this.snapshot.objects.some(o => o.id === id) && !this.upserts.some(o => o.id === id), "invalid_input", "Program allocated a duplicate object id.");
        const object: C.RecordOf<K> = {
            format: C.ARCHIVE_FORMAT, kind, id, object_revision: 1, created_sequence: this.snapshot.sequence + 1, updated_sequence: this.snapshot.sequence + 1, author: C.actorIdentity(this.facts.actor), body
        };
        this.upserts.push(object as C.DomainRecord);
        return object;
    }
    update<K extends C.ObjectKind>(object: C.RecordOf<K>, body: C.RecordBodies[K]): C.RecordOf<K> {
        const updated = {
            ...object, body, object_revision: object.object_revision + 1, updated_sequence: this.snapshot.sequence + 1
        };
        const old = this.upserts.findIndex(o => o.id === object.id);
        if (old >= 0)
            this.upserts.splice(old, 1);
        this.upserts.push(updated as C.DomainRecord);
        return updated;
    }
    belongs(object: C.DomainRecord, invocationId: string): void {
        requireThat("invocation_id" in object.body && object.body.invocation_id === invocationId, "invalid_input", "Object belongs to a different invocation.");
    }
    approval(ref: C.AuthorityRef | undefined, invocationId: string, action: string): void {
        requireThat(ref && this.facts.approvals?.some(a => a.id === ref.approval_id && a.archiveId === this.snapshot.archiveId && (a.invocationId === undefined || a.invocationId === invocationId) && a.action === action && a.active && (a.expires_at === undefined || a.expires_at > this.facts.now)), "not_authorized", "This change needs a current owner approval for the exact action and invocation.");
    }
    finish(result: C.SemanticResult, invocationId: string): C.MutationPlan {
        return {
            upserts: this.upserts, content: this.content, views: [{
                    kind: "checkpoint", invocation_id: invocationId
                }], result, ...(this.policy ? {
                policy: this.policy
            } : {})
        };
    }
}
function requirements(change: Change, invocationId: string, input: C.Requirements, old?: C.RecordOf<"invocation">, approval?: C.AuthorityRef): {
    coverageIds: string[];
    criterionIds: string[];
    mapping: Record<string, string>;
} {
    requireThat(unique(input.coverage.map(c => c.key)) && unique(input.criteria.map(c => c.key)), "invalid_input", "Coverage and criterion keys must be unique.");
    requireThat(input.coverage.some(c => c.required), "invalid_input", "At least one required coverage is necessary.");
    const existingCoverage = (old?.body.coverage_ids ?? []).map(id => change.get(id, "coverage"));
    const existingCriteria = (old?.body.criterion_ids ?? []).map(id => change.get(id, "criterion"));
    const cids = input.coverage.flatMap(c => c.id ? [c.id] : []), kids = input.criteria.flatMap(c => c.id ? [c.id] : []);
    requireThat(unique(cids) && unique(kids), "invalid_input", "An existing requirement identity may occur only once.");
    requireThat(cids.every(id => existingCoverage.some(c => c.id === id)) && kids.every(id => existingCriteria.some(c => c.id === id)), "invalid_input", "Existing requirement identity is not part of this invocation.");
    let weakens = false;
    for (const previous of existingCoverage) {
        const next = input.coverage.find(c => c.id === previous.id);
        if (!next || previous.body.required && !next.required || next.requirement !== previous.body.requirement)
            weakens = true;
    }
    for (const item of input.criteria)
        for (const target of item.coverage_targets)
            requireThat(target.kind === "request_key" ? input.coverage.some(c => c.key === target.key) : input.coverage.some(c => c.id === target.id), "invalid_input", "Criterion target is outside the modified coverage set.");
    for (const previous of existingCriteria) {
        const next = input.criteria.find(c => c.id === previous.id);
        const targets = next?.coverage_targets.map(t => t.kind === "existing_id" ? t.id : input.coverage.find(c => c.key === t.key)?.id ?? `new:${t.key}`).sort();
        if (!next || previous.body.critical && !next.critical || next.statement !== previous.body.statement || next.method !== previous.body.method || JSON.stringify(targets) !== JSON.stringify([...previous.body.coverage_ids].sort()))
            weakens = true;
    }
    if (weakens && old)
        change.approval(approval, old.id, "amend_frame");
    const coverageIds: string[] = [], criterionIds: string[] = [], mapping: Record<string, string> = {};
    for (const item of input.coverage) {
        const body: C.CoverageBody = {
            invocation_id: invocationId, key: item.key, title: item.title, requirement: item.requirement, required: item.required, authority_refs: item.authority_refs, retired: false
        };
        const record = item.id ? change.update(change.get(item.id, "coverage"), body) : change.make("coverage", body);
        mapping[item.key] = record.id;
        coverageIds.push(record.id);
    }
    for (const item of input.criteria) {
        const targets = item.coverage_targets.map(t => t.kind === "request_key" ? mapping[t.key] : coverageIds.includes(t.id) ? t.id : undefined);
        requireThat(targets.length > 0 && targets.every((t): t is string => t !== undefined) && unique(targets), "invalid_input", "Criterion targets must resolve uniquely to the modified coverage set.");
        const body: C.CriterionBody = {
            invocation_id: invocationId, key: item.key, coverage_ids: targets, statement: item.statement, critical: item.critical, method: item.method, retired: false
        };
        const record = item.id ? change.update(change.get(item.id, "criterion"), body) : change.make("criterion", body);
        mapping[`criterion:${item.key}`] = record.id;
        criterionIds.push(record.id);
    }
    for (const coverage of input.coverage.filter(c => c.required))
        requireThat(change.upserts.some(o => o.kind === "criterion" && o.body.coverage_ids.includes(mapping[coverage.key]!)), "invalid_input", "Each required coverage needs a criterion.");
    for (const previous of existingCoverage)
        if (!coverageIds.includes(previous.id))
            change.update(previous, {
                ...previous.body, retired: true
            });
    for (const previous of existingCriteria)
        if (!criterionIds.includes(previous.id))
            change.update(previous, {
                ...previous.body, retired: true
            });
    return {
        coverageIds, criterionIds, mapping
    };
}
function validateCoverage(change: Change, ids: readonly string[], invocation: C.RecordOf<"invocation">): void {
    requireThat(unique(ids), "invalid_input", "Coverage references must be unique.");
    for (const id of ids) {
        const coverage = change.get(id, "coverage");
        change.belongs(coverage, invocation.id);
        requireThat(!coverage.body.retired && invocation.body.coverage_ids.includes(id), "object_changed", "Coverage is retired or no longer in the frame.");
    }
}
function bindMember(change: Change, invocation: C.RecordOf<"invocation">, attemptId: string, memberId: string, creationRef?: C.Ref): C.NativeMember {
    const actor = change.facts.actor;
    const member = change.facts.nativeMembers?.find(m => m.sessionId === memberId);
    requireThat(actor.kind === "session" && member && member.rootSessionId === actor.rootSessionId, "not_authorized", "Member must be verified in the caller's native tree.");
    if (creationRef)
        requireThat(creationRef.kind === "native_event" && member.creationRef.kind === "native_event" && creationRef.session_id === member.creationRef.session_id && creationRef.event_seq === member.creationRef.event_seq, "invalid_input", "Creation evidence does not match the verified native member.");
    const identity: C.ActorIdentity = {
        kind: "session", sessionId: member.sessionId, rootSessionId: member.rootSessionId
    };
    const scope: C.GrantScope = {
        kind: "attempt", attempt_id: attemptId
    };
    if (change.get(attemptId, "attempt").body.purpose === "review") {
        const reviewGranted = change.snapshot.policy.grants.some(g => sameActor(g.subject, identity)
            && hasRight(change.snapshot, identity, "review", g.scope, change.facts.now));
        const reviewDelegation = findDelegatingGrant(change.snapshot, actor, "review", {
            kind: "invocation", invocation_id: invocation.id
        }, change.facts.now);
        requireThat(reviewGranted || reviewDelegation, "not_authorized", "A review member binding also requires current review authority or a delegated review allowance.");
    }
    if (!hasRight(change.snapshot, identity, "member-submit", scope, change.facts.now)) {
        const delegation = findDelegatingGrant({
            ...change.snapshot, objects: [...change.snapshot.objects, ...change.upserts]
        }, actor, "member-submit", scope, change.facts.now);
        requireThat(delegation, "not_authorized", "Binding requires an existing member grant or an owner-delegated member-submit allowance.");
        const base = change.policy ?? change.snapshot.policy;
        change.policy = {
            ...base, epoch: change.snapshot.policy.epoch + 1, grants: [...base.grants, {
                    id: change.facts.newId("attempt"), subject: identity, rights: ["member-submit"], scope, revoked: false, delegated_from: delegation.id
                }]
        };
    }
    return member;
}
function prepareContent(change: Change, input: C.ArtifactContent): {
    descriptor: C.ContentDescriptor;
    write: C.ContentWrite;
} {
    const prepared = change.facts.contents?.find(c => c.input.kind === input.kind && (input.kind === "text" ? c.input.kind === "text" && c.input.text === input.text && c.input.media_type === input.media_type : c.input.kind === "upload" && c.input.upload_id === input.upload_id && c.input.digest === input.digest));
    requireThat(prepared, "storage_unavailable", "Archive must prepare and verify inline bytes or a sealed upload before reduction.");
    requireThat(prepared.digest === prepared.write.digest && prepared.media_type === prepared.write.media_type, "archive_corrupt", "Prepared content metadata disagrees.");
    if (prepared.write.kind === "inline")
        requireThat(prepared.bytes === prepared.write.bytes.byteLength, "archive_corrupt", "Prepared byte count disagrees.");
    else
        requireThat(prepared.bytes === prepared.write.bytes, "archive_corrupt", "Sealed byte count disagrees.");
    return {
        descriptor: {
            digest: prepared.digest, bytes: prepared.bytes, media_type: prepared.media_type
        }, write: prepared.write
    };
}
function checkContext(invocation: C.RecordOf<"invocation">): C.DecisionContext {
    return {
        frame_revision: invocation.body.frame_revision, ...(invocation.body.candidate_ref ? {
            candidate_ref: invocation.body.candidate_ref
        } : {})
    };
}
function contextMatches(body: C.DecisionContext, invocation: C.RecordOf<"invocation">): boolean { return body.frame_revision === invocation.body.frame_revision && sameOptionalRef(body.candidate_ref, invocation.body.candidate_ref); }
function checkTarget(check: C.CheckInput): C.ObjectRef { return check.kind === "applicability" ? check.current_target : check.target; }
/** Withdrawing an exact observation also withdraws later uses of its criteria. */
function withdrawnObservation(snapshot: C.Snapshot, record: C.RecordOf<"check">, criterionId: string): boolean {
    const observation = record.body.check.kind === "applicability" ? record.body.check.prior_check : refOf(record);
    return snapshot.objects.some(o => o.kind === "check" && o.body.check.kind === "resolution"
        && o.body.check.conclusion === "invalid_observation"
        && o.body.check.criterion_ids.includes(criterionId)
        && o.body.check.conflicting_check_refs.some(ref => sameRef(ref, observation)))
        || snapshot.objects.some(o => o.kind === "challenge" && sameRef(o.body.target, observation)
            && o.body.resolution?.resolution === "superseded");
}
function effectiveResult(snapshot: C.Snapshot, record: C.RecordOf<"check">, criterionId: string): C.CheckResult | undefined {
    if (withdrawnObservation(snapshot, record, criterionId)) return undefined;
    const check = record.body.check;
    const basis = check.kind === "applicability" ? check.prior_check : refOf(record);
    const resolution = snapshot.objects.filter((o): o is C.RecordOf<"check"> => o.kind === "check"
        && o.body.check.kind === "resolution" && o.body.check.criterion_ids.includes(criterionId)
        && o.body.check.conflicting_check_refs.some(ref => sameRef(ref, basis) || sameRef(ref, refOf(record))))
        .sort((a, b) => b.created_sequence - a.created_sequence)[0]?.body.check;
    if (resolution?.kind === "resolution") return resolution.conclusion === "still_failing" ? "failed" : undefined;
    if (check.kind === "execution")
        return check.result;
    if (check.kind === "applicability") {
        const prior = objectAt(snapshot, check.prior_check);
        return prior?.kind === "check" && prior.body.check.kind === "execution" ? prior.body.check.result : undefined;
    }
    return undefined;
}
function validateCheck(change: Change, invocation: C.RecordOf<"invocation">, check: C.CheckInput): void {
    const target = change.exact(checkTarget(check), ["candidate", "finding", "lesson", "publication"]);
    if (target.kind === "candidate" || target.kind === "finding")
        change.belongs(target, invocation.id);
    requireThat(unique(check.criterion_ids), "invalid_input", "Duplicate criterion reference.");
    for (const id of check.criterion_ids) {
        const criterion = change.get(id, "criterion");
        change.belongs(criterion, invocation.id);
        requireThat(!criterion.body.retired, "object_changed", "Criterion is retired.");
    }
    if (check.kind === "execution") {
        requireThat(["not_run", "unavailable"].includes(check.result) || check.evidence_refs.length > 0, "invalid_input", "An execution observation requires evidence.");
        change.refs(check.evidence_refs);
        const actor = change.facts.actor;
        if (!isLead(change.snapshot, actor, invocation.id, change.facts.now) && target.kind === "lesson")
            requireThat(isAssignedReviewer(change.snapshot, actor, check.target, change.facts.now), "not_authorized", "A lesson check requires an exact independent review assignment.");
    }
    else if (check.kind === "applicability") {
        const prior = change.exact(check.prior_check, ["check"]);
        requireThat(prior.kind === "check" && prior.body.check.kind === "execution", "invalid_input", "Applicability must reference an execution, never another applicability.");
        change.belongs(prior, invocation.id);
        requireThat(!check.criterion_ids.some(id => withdrawnObservation(change.snapshot, prior as C.RecordOf<"check">, id)), "invalid_transition", "An invalid or superseded observation cannot support applicability; record a fresh execution.");
        requireThat(check.criterion_ids.every(id => prior.body.check.criterion_ids.includes(id)), "invalid_input", "Applicability may not invent unobserved criteria.");
        change.refs(check.impact_refs);
    }
    else {
        requireThat(unique(check.conflicting_check_refs.map(r => `${r.object_id}:${r.object_revision}`)), "invalid_input", "Conflict refs must be unique.");
        for (const ref of check.conflicting_check_refs) {
            const conflict = change.exact(ref, ["check"]);
            requireThat(conflict.kind === "check" && conflict.body.check.kind !== "resolution" && contextMatches(conflict.body, invocation) && sameRef(checkTarget(conflict.body.check), check.target) && check.criterion_ids.every(id => conflict.body.check.criterion_ids.includes(id)), "invalid_input", "Resolution must address applicable observations for its exact target and criteria.");
        }
        let actualReplacement = false;
        const latestConflict = Math.max(...check.conflicting_check_refs.map(r => change.exact(r, ["check"]).created_sequence));
        for (const ref of check.replacement_check_refs) {
            const replacement = change.exact(ref, ["check"]);
            requireThat(replacement.kind === "check" && replacement.body.check.kind === "execution" && sameRef(replacement.body.check.target, check.target) && contextMatches(replacement.body, invocation) && check.criterion_ids.every(id => replacement.body.check.criterion_ids.includes(id)), "invalid_input", "Replacement must be a current actual execution, not applicability.");
            requireThat(!check.conflicting_check_refs.some(c => sameRef(c, ref)), "invalid_input", "An observation cannot replace itself.");
            actualReplacement ||= replacement.created_sequence > latestConflict;
        }
        change.refs(check.evidence_refs);
        const independentEvidence = check.evidence_refs.some(e => e.kind !== "object" || !check.conflicting_check_refs.some(r => sameRef(r, e)));
        requireThat(check.conclusion === "still_failing" || independentEvidence || actualReplacement, "invalid_input", "Clearing a check conflict needs independent evidence or an actual replacement execution.");
        requireThat(check.conclusion !== "replaced" || actualReplacement, "invalid_input", "Replaced requires an actual replacement execution.");
    }
}
function checkCleared(snapshot: C.Snapshot, invocation: C.RecordOf<"invocation">, check: C.RecordOf<"check">, criterionId: string): boolean {
    if (withdrawnObservation(snapshot, check, criterionId)) return true;
    const resolutions = snapshot.objects.filter((o): o is C.RecordOf<"check"> => o.kind === "check" && o.body.check.kind === "resolution" && contextMatches(o.body, invocation) && o.body.check.criterion_ids.includes(criterionId) && o.body.check.conflicting_check_refs.some(r => sameRef(r, refOf(check)))).sort((a, b) => b.created_sequence - a.created_sequence);
    const last = resolutions[0]?.body.check;
    return last?.kind === "resolution" && last.conclusion !== "still_failing";
}
function coverageForDecision(change: Change, decision: C.RecordOf<"decision">): readonly string[] {
    const target = change.exact(decision.body.target, ["contribution", "finding"], true);
    if (target.kind === "finding")
        return target.body.coverage_ids;
    requireThat(target.kind === "contribution", "invalid_input", "Invalid decision target.");
    return change.get(target.body.attempt_id, "attempt").body.coverage_ids;
}
function complete(change: Change, invocation: C.RecordOf<"invocation">, completion: C.Completion): void {
    requireThat(invocation.body.candidate_ref && sameRef(completion.candidate_ref, invocation.body.candidate_ref), "object_changed", "Completion must name the current candidate.");
    requireThat(unique(completion.coverage.map(c => c.coverage_id)), "invalid_input", "Duplicate completion coverage.");
    requireThat(completion.coverage.length === invocation.body.coverage_ids.length && completion.coverage.every(c => invocation.body.coverage_ids.includes(c.coverage_id)), "invalid_input", "Completion must account for the complete current coverage set.");
    const selectedChecks = new Set<string>();
    for (const group of completion.coverage) {
        const coverage = change.get(group.coverage_id, "coverage");
        let accepted = false;
        for (const ref of group.decision_refs) {
            const decision = change.exact(ref, ["decision"]);
            requireThat(decision.kind === "decision", "invalid_input", "Expected decision.");
            change.belongs(decision, invocation.id);
            requireThat(contextMatches(decision.body, invocation) && coverageForDecision(change, decision).includes(coverage.id), "object_changed", "Decision is not applicable to this frame/candidate/coverage.");
            const later = change.snapshot.objects.some(o => o.kind === "decision" && sameRef(o.body.target, decision.body.target) && contextMatches(o.body, invocation) && o.created_sequence > decision.created_sequence);
            requireThat(!later, "object_changed", "A later decision supersedes the selected judgment.");
            accepted ||= decision.body.disposition === "accepted";
        }
        requireThat(!coverage.body.required || accepted, "invalid_transition", `Required coverage ${coverage.id} lacks a current accepted result.`);
        for (const ref of group.check_refs) {
            const check = change.exact(ref, ["check"]);
            requireThat(check.kind === "check" && contextMatches(check.body, invocation) && sameRef(checkTarget(check.body.check), completion.candidate_ref), "object_changed", "Completion check belongs to another candidate or frame.");
            selectedChecks.add(`${ref.object_id}:${ref.object_revision}`);
        }
    }
    for (const blocker of invocation.body.next?.blockers ?? []) {
        const critical = blocker.coverage_ids.length === 0 || blocker.coverage_ids.some(id => change.get(id, "coverage").body.required);
        requireThat(!critical || blocker.clearing_evidence_refs.length > 0, "invalid_transition", "An unresolved critical blocker prevents completion.");
    }
    const checks = change.snapshot.objects.filter((o): o is C.RecordOf<"check"> => o.kind === "check" && o.body.invocation_id === invocation.id && contextMatches(o.body, invocation) && sameRef(checkTarget(o.body.check), completion.candidate_ref) && o.body.check.kind !== "resolution");
    for (const id of invocation.body.criterion_ids) {
        const criterion = change.get(id, "criterion");
        if (!criterion.body.critical)
            continue;
        const applicable = checks.filter(c => c.body.check.criterion_ids.includes(id));
        const passing = applicable.filter(c => effectiveResult(change.snapshot, c, id) === "passed" && !checkCleared(change.snapshot, invocation, c, id));
        requireThat(passing.some(c => selectedChecks.has(`${c.id}:${c.object_revision}`)), "invalid_transition", `Critical criterion ${id} needs an explicitly referenced current passing execution or applicability.`);
        const conflict = applicable.some(c => effectiveResult(change.snapshot, c, id) !== "passed" && !checkCleared(change.snapshot, invocation, c, id));
        requireThat(!conflict, "invalid_transition", `Critical criterion ${id} has unresolved conflicting checks; selecting only a pass cannot hide them.`);
    }
    for (const record of change.snapshot.objects) {
        if (record.kind !== "challenge" || record.body.invocation_id !== invocation.id)
            continue;
        const target = objectAt(change.snapshot, record.body.target);
        let critical = false;
        if (target?.kind === "check") {
            critical = (contextMatches(target.body, invocation) && sameRef(checkTarget(target.body.check), completion.candidate_ref) || checks.some(c => c.body.check.kind === "applicability" && sameRef(c.body.check.prior_check, record.body.target))) && target.body.check.criterion_ids.some(id => change.get(id, "criterion").body.critical);
        }
        else if (target?.kind === "decision") {
            const currentTarget = change.snapshot.objects.some(o => o.id === target.body.target.object_id && o.object_revision === target.body.target.object_revision);
            critical = currentTarget && contextMatches(target.body, invocation) && coverageForDecision(change, target).some(id => change.get(id, "coverage").body.required);
        }
        const resolution = record.body.resolution;
        let validReplacement = resolution?.resolution === "superseded" && resolution.replacement_ref !== undefined;
        if (validReplacement && target?.kind === "check") {
            const replacement = objectAt(change.snapshot, resolution!.replacement_ref!);
            validReplacement = replacement?.kind === "check" && replacement.body.check.kind === "execution"
                && replacement.body.invocation_id === invocation.id
                && replacement.created_sequence > target.created_sequence
                && sameRef(checkTarget(replacement.body.check), checkTarget(target.body.check))
                && replacement.body.frame_revision === target.body.frame_revision
                && sameOptionalRef(replacement.body.candidate_ref, target.body.candidate_ref)
                && target.body.check.criterion_ids.every(id => replacement.body.check.criterion_ids.includes(id)
                    && effectiveResult(change.snapshot, replacement, id) === "passed");
        }
        requireThat(!critical || resolution?.resolution === "dismissed" || validReplacement,
            "invalid_transition", "A critical challenge has not been disposed with a currently valid replacement or dismissal.");
    }
}
/** The same public reducer is used by Archive and behavioral tests. */
export function applyCoordination(snapshot: C.Snapshot, command: C.WorkCommand, facts: C.TrustedFacts): C.Result<C.MutationPlan> {
    const decoded = decodeWorkCommand(command);
    if (!decoded.ok)
        return decoded;
    const authorized = authorizeCommand(snapshot, command, facts);
    if (!authorized.ok)
        return authorized;
    const change = new Change(snapshot, facts);
    try {
        if (command.action === "open") {
            const p = command.payload;
            const invocation = change.make("invocation", {
                title: p.title, goal: p.goal, deliverable: p.deliverable, subject: p.subject, constraints: p.constraints, exclusions: p.exclusions, frame_revision: 1, lead: C.actorIdentity(facts.actor), lifecycle: "active", coverage_ids: [], criterion_ids: [], lifecycle_history: [{
                        transition: "open", reason: p.goal, evidence_refs: []
                    }]
            });
            const r = requirements(change, invocation.id, p);
            // Creation and requirements are one atomic object revision, not two edits.
            const completeInvocation = {
                ...invocation, body: {
                    ...invocation.body, coverage_ids: r.coverageIds, criterion_ids: r.criterionIds
                }
            };
            change.upserts[change.upserts.findIndex(o => o.id === invocation.id)] = completeInvocation;
            return C.success(change.finish({
                id: invocation.id, invocation_id: invocation.id, object_revision: 1, ids: r.mapping, status: "active"
            }, invocation.id));
        }
        const invocation = change.get(command.payload.invocation_id, "invocation");
        const closed = invocation.body.lifecycle === "completed" || invocation.body.lifecycle === "abandoned";
        const closedAllowed = ["put_artifact", "record_finding", "record_check", "record_challenge", "resolve_challenge", "set_lifecycle"];
        requireThat(!closed || closedAllowed.includes(command.action), "invalid_transition", "Reopen before modifying a closed delivery.");
        if (invocation.body.lifecycle === "blocked")
            requireThat(!["amend_frame", "plan_attempt", "set_candidate"].includes(command.action) && !(command.action === "update_attempt" && command.payload.change.kind !== "progress"), "invalid_transition", "Resume before changing the delivery plan.");
        let result: C.SemanticResult = {
            invocation_id: invocation.id
        };
        switch (command.action) {
            case "amend_frame": {
                const p = command.payload;
                if (p.group === "requirements") {
                    const r = requirements(change, invocation.id, p.value, invocation, p.authority_ref);
                    change.update(invocation, {
                        ...invocation.body, frame_revision: invocation.body.frame_revision + 1, frame_history: [...(invocation.body.frame_history ?? []), {
                                frame_revision: invocation.body.frame_revision + 1, group: p.group, rationale: p.rationale, ...(p.authority_ref ? {
                                    authority_ref: p.authority_ref
                                } : {})
                            }], coverage_ids: r.coverageIds, criterion_ids: r.criterionIds
                    });
                    result = {
                        ...result, ids: r.mapping
                    };
                }
                else {
                    if (p.value !== invocation.body[p.group])
                        change.approval(p.authority_ref, invocation.id, "amend_frame");
                    change.update(invocation, {
                        ...invocation.body, [p.group]: p.value, frame_revision: invocation.body.frame_revision + 1, frame_history: [...(invocation.body.frame_history ?? []), {
                                frame_revision: invocation.body.frame_revision + 1, group: p.group, rationale: p.rationale, ...(p.authority_ref ? {
                                    authority_ref: p.authority_ref
                                } : {})
                            }]
                    });
                }
                break;
            }
            case "plan_attempt": {
                const p = command.payload;
                requireThat(invocation.body.lifecycle === "active", "invalid_transition", "Plan attempts only during active work.");
                validateCoverage(change, p.coverage_ids, invocation);
                change.refs(p.baseline_refs);
                if (p.task_ref)
                    change.refs([p.task_ref]);
                const attempt = change.make("attempt", {
                    ...p, progress: "planned", progress_history: [{
                            state: "planned", reason: "Planned attempt"
                        }], binding_history: []
                });
                if (p.member_id) {
                    const member = bindMember(change, invocation, attempt.id, p.member_id);
                    const bound = {
                        ...attempt, body: {
                            ...attempt.body, binding_history: [{
                                    member_id: member.sessionId, creation_ref: member.creationRef, exposure: p.context_plan.exposure, reason: "Initial verified binding"
                                }]
                        }
                    };
                    change.upserts[change.upserts.findIndex(o => o.id === attempt.id)] = bound;
                }
                result = {
                    ...result, id: attempt.id, object_revision: 1, status: "planned"
                };
                break;
            }
            case "update_attempt": {
                const p = command.payload, a = change.get(p.attempt_id, "attempt"), c = p.change;
                change.belongs(a, invocation.id);
                requireThat(a.body.progress !== "superseded", "invalid_transition", "A superseded attempt cannot accept new work.");
                if (c.kind === "progress") {
                    const allowed: Readonly<Record<C.AttemptProgress, readonly C.AttemptProgress[]>> = {
                        planned: ["running", "returned", "missing"], running: ["returned", "missing"], missing: ["planned"], returned: [], superseded: []
                    };
                    requireThat(allowed[a.body.progress].includes(c.state), "invalid_transition", "Invalid attempt progress transition.");
                    change.update(a, {
                        ...a.body, progress: c.state, progress_history: [...(a.body.progress_history ?? []), {
                                state: c.state, reason: c.reason
                            }]
                    });
                }
                else if (c.kind === "supersede") {
                    const other = change.get(c.replacement_attempt_id, "attempt");
                    change.belongs(other, invocation.id);
                    requireThat(other.id !== a.id && other.body.progress !== "superseded", "invalid_transition", "Replacement attempt must be distinct and current.");
                    change.update(a, {
                        ...a.body, progress: "superseded", replacement_attempt_id: other.id, progress_history: [...(a.body.progress_history ?? []), {
                                state: "superseded", reason: c.reason
                            }]
                    });
                }
                else {
                    requireThat(c.kind !== "bind" || a.body.member_id === undefined, "invalid_transition", "An existing binding must use replace.");
                    requireThat(c.kind !== "replace" || a.body.member_id !== undefined && a.body.member_id !== c.member_id, "invalid_transition", "Replace requires a different existing member.");
                    if (c.task_ref)
                        change.refs([c.task_ref]);
                    const member = bindMember(change, invocation, a.id, c.member_id, c.creation_ref);
                    if (c.kind === "replace") {
                        const base = change.policy ?? snapshot.policy;
                        change.policy = {
                            ...base, epoch: snapshot.policy.epoch + 1, grants: base.grants.map(g => g.scope.kind === "attempt" && g.scope.attempt_id === a.id && g.subject.kind === "session" && g.subject.sessionId === a.body.member_id ? {
                                ...g, revoked: true
                            } : g)
                        };
                    }
                    change.update(a, {
                        ...a.body, member_id: member.sessionId, ...(c.task_ref ? {
                            task_ref: c.task_ref
                        } : {}), binding_history: [...a.body.binding_history, {
                                member_id: member.sessionId, creation_ref: member.creationRef, exposure: c.context_exposure, reason: c.kind === "replace" ? c.reason : "Verified member binding"
                            }]
                    });
                }
                result = {
                    ...result, id: a.id, object_revision: a.object_revision + 1
                };
                break;
            }
            case "put_artifact": {
                const c = command.payload.change;
                requireThat(!closed || c.action === "create" || c.action === "correct", "invalid_transition", "Closed delivery accepts new artifacts/corrections; reopen to revise or retire old content.");
                if (c.action === "create") {
                    change.refs(c.refs);
                    for (const id of c.domains ?? [])
                        change.get(id, "domain");
                    const content = prepareContent(change, c.content);
                    change.content.push(content.write);
                    const artifact = change.make("artifact", {
                        invocation_id: invocation.id, kind: c.kind, title: c.title, content: content.descriptor, refs: c.refs, domains: c.domains ?? [], status: "current", editors: []
                    });
                    result = {
                        ...result, id: artifact.id, object_revision: 1
                    };
                }
                else {
                    const old = change.exact(c.target, ["artifact"], c.action !== "correct");
                    requireThat(old.kind === "artifact", "invalid_input", "Expected artifact.");
                    change.belongs(old, invocation.id);
                    const canEdit = sameActor(old.author, facts.actor) || old.body.editors.some(a => sameActor(a, facts.actor));
                    if (c.action === "retire") {
                        requireThat(canEdit || isLead(snapshot, facts.actor, invocation.id, facts.now), "not_authorized", "Only author/editor or current Lead may retire an artifact.");
                        const next = change.update(old, {
                            ...old.body, status: "retired", reason: c.reason
                        });
                        result = {
                            ...result, id: next.id, object_revision: next.object_revision
                        };
                    }
                    else {
                        if (c.action === "revise")
                            requireThat(canEdit, "not_authorized", "Only author or explicitly transferred editor may revise content.");
                        const content = prepareContent(change, c.content);
                        change.content.push(content.write);
                        if (c.action === "revise") {
                            change.refs(c.refs);
                            const next = change.update(old, {
                                ...old.body, title: c.title, content: content.descriptor, refs: c.refs, status: "current", reason: c.reason
                            });
                            result = {
                                ...result, id: next.id, object_revision: next.object_revision
                            };
                        }
                        else {
                            change.refs(c.evidence_refs);
                            const correction = change.make("artifact", {
                                ...old.body, content: content.descriptor, status: "current", refs: c.evidence_refs, editors: [], correction_of: c.target, reason: c.reason
                            });
                            result = {
                                ...result, id: correction.id, object_revision: 1
                            };
                        }
                    }
                }
                break;
            }
            case "submit_contribution": {
                const p = command.payload, a = change.get(p.attempt_id, "attempt");
                change.belongs(a, invocation.id);
                requireThat(p.source.kind === "external" || a.body.progress !== "superseded", "invalid_transition", "Superseded attempt accepts only a Lead-attributed external contribution.");
                requireThat(p.artifact_refs.length + p.evidence_refs.length > 0, "invalid_input", "A contribution needs a usable artifact or observation.");
                for (const r of p.artifact_refs)
                    change.exact(r, ["artifact"]);
                change.refs(p.evidence_refs);
                if (p.source.kind === "external")
                    change.refs(p.source.refs);
                let contribution: C.RecordOf<"contribution">;
                if (p.contribution_id) {
                    const old = change.get(p.contribution_id, "contribution");
                    change.belongs(old, invocation.id);
                    requireThat(old.body.attempt_id === a.id && sameActor(old.author, facts.actor), "not_authorized", "Contribution revisions retain original attempt and author.");
                    contribution = change.update(old, p);
                }
                else
                    contribution = change.make("contribution", p);
                if (a.body.progress !== "superseded" && a.body.progress !== "returned")
                    change.update(a, {
                        ...a.body, progress: "returned", progress_history: [...(a.body.progress_history ?? []), {
                                state: "returned", reason: "Contribution submitted with evidence"
                            }]
                    });
                result = {
                    ...result, id: contribution.id, object_revision: contribution.object_revision, status: "submitted"
                };
                break;
            }
            case "record_finding": {
                const p = command.payload;
                validateCoverage(change, p.coverage_ids, invocation);
                change.refs(p.evidence_refs);
                if (p.responsible_member_id)
                    requireThat(facts.nativeMembers?.some(m => m.sessionId === p.responsible_member_id), "not_found", "Responsible member has not been verified.");
                const record = change.make("finding", p);
                result = {
                    ...result, id: record.id, object_revision: 1, status: "open"
                };
                break;
            }
            case "decide": {
                const p = command.payload, target = change.exact(p.target, ["contribution", "finding"], true);
                change.belongs(target, invocation.id);
                change.refs(p.evidence_refs);
                const record = change.make("decision", {
                    ...p, ...checkContext(invocation)
                });
                result = {
                    ...result, id: record.id, object_revision: 1, status: p.disposition
                };
                break;
            }
            case "set_candidate": {
                const p = command.payload;
                requireThat(invocation.body.lifecycle === "active", "invalid_transition", "Candidate can change only during active work.");
                requireThat(p.source_ref.kind === "source" || p.source_ref.kind === "object", "invalid_input", "Candidate must reference a source baseline or an archived artifact.");
                if (p.source_ref.kind === "object")
                    change.exact(p.source_ref, ["artifact"]);
                else
                    change.refs([p.source_ref]);
                const candidate = change.make("candidate", {
                    ...p, frame_revision: invocation.body.frame_revision
                });
                change.update(invocation, {
                    ...invocation.body, candidate_ref: refOf(candidate)
                });
                result = {
                    ...result, id: candidate.id, object_revision: 1
                };
                break;
            }
            case "record_check": {
                requireThat(!closed || command.payload.check.kind === "execution", "invalid_transition", "Closed work accepts observations; reopen before changing applicability or conflict judgments.");
                validateCheck(change, invocation, command.payload.check);
                const check = change.make("check", {
                    ...command.payload, ...checkContext(invocation), provenance: "reported"
                });
                result = {
                    ...result, id: check.id, object_revision: 1
                };
                break;
            }
            case "record_challenge": {
                const p = command.payload;
                const target = change.exact(p.target, ["decision", "check", "publication", "lesson"]);
                if (target.kind === "decision" || target.kind === "check")
                    change.belongs(target, invocation.id);
                change.refs(p.contradicting_refs);
                const record = change.make("challenge", p);
                result = {
                    ...result, id: record.id, object_revision: 1, status: "open"
                };
                break;
            }
            case "resolve_challenge": {
                const p = command.payload, challenge = change.get(p.challenge_id, "challenge");
                change.belongs(challenge, invocation.id);
                change.refs(p.evidence_refs);
                if (p.replacement_ref) {
                    const original = change.exact(challenge.body.target, ["decision", "check", "publication", "lesson"]);
                    const replacement = change.exact(p.replacement_ref, [original.kind]);
                    requireThat(!sameRef(p.replacement_ref, challenge.body.target), "invalid_input", "A challenged judgment cannot supersede itself.");
                    if (original.kind === "check") {
                        requireThat(replacement.kind === "check" && sameRef(checkTarget(original.body.check), checkTarget(replacement.body.check)) && original.body.check.criterion_ids.every(id => replacement.body.check.criterion_ids.includes(id)), "invalid_input", "Replacement check does not address the challenged target and criteria.");
                        change.belongs(replacement, invocation.id);
                        requireThat(replacement.body.check.kind === "execution" && replacement.created_sequence > original.created_sequence,
                            "invalid_input", "A challenged observation needs a subsequent actual execution, not derived applicability.");
                        requireThat(!original.body.check.criterion_ids.some(id => withdrawnObservation(change.snapshot, replacement as C.RecordOf<"check">, id)),
                            "invalid_transition", "An invalid observation cannot replace a challenged check.");
                    }
                    if (original.kind === "decision")
                        requireThat(replacement.kind === "decision" && original.body.target.object_id === replacement.body.target.object_id, "invalid_input", "Replacement decision must address the challenged result.");
                }
                requireThat(p.resolution !== "superseded" || p.replacement_ref !== undefined, "invalid_input", "Superseded challenge needs a replacement judgment.");
                const { invocation_id: _, challenge_id: __, ...resolution } = p;
                change.update(challenge, {
                    ...challenge.body, resolution
                });
                result = {
                    ...result, id: challenge.id, object_revision: challenge.object_revision + 1, status: p.resolution
                };
                break;
            }
            case "set_next": {
                const p = command.payload;
                for (const b of p.blockers) {
                    validateCoverage(change, b.coverage_ids, invocation);
                    change.refs(b.clearing_evidence_refs);
                }
                for (const old of invocation.body.next?.blockers ?? [])
                    requireThat(old.clearing_evidence_refs.length > 0 || p.blockers.some(b => b.statement === old.statement), "invalid_input", "Record blocker clearing evidence before removing its current entry.");
                if (p.owner_id)
                    requireThat(facts.nativeMembers?.some(m => m.sessionId === p.owner_id) || facts.actor.kind === "session" && facts.actor.sessionId === p.owner_id, "not_found", "Next-action owner has not been verified.");
                change.update(invocation, {
                    ...invocation.body, next: p
                });
                break;
            }
            case "set_lifecycle": {
                const p = command.payload, state = invocation.body.lifecycle;
                const allowed: Readonly<Record<C.Lifecycle, readonly string[]>> = {
                    active: ["block", "complete", "abandon"], blocked: ["resume", "abandon"], completed: ["reopen"], abandoned: ["reopen"]
                };
                requireThat(allowed[state].includes(p.transition), "invalid_transition", "Lifecycle transition is not permitted.");
                change.refs(p.evidence_refs);
                if (p.transition === "resume")
                    requireThat(p.evidence_refs.length > 0 && (invocation.body.next?.blockers ?? []).every(b => b.clearing_evidence_refs.length > 0), "invalid_transition", "Resume needs clearing evidence and no unresolved blockers.");
                if (p.transition === "reopen")
                    requireThat(p.evidence_refs.some(r => r.kind === "object" && sameRef(r, refOf(invocation))) && p.evidence_refs.some(r => r.kind !== "object" || !sameRef(r, refOf(invocation))), "invalid_input", "Reopen must reference the old closed invocation and new evidence.");
                if (p.transition === "complete")
                    complete(change, invocation, p.completion);
                const lifecycle: C.Lifecycle = p.transition === "block" ? "blocked" : p.transition === "complete" ? "completed" : p.transition === "abandon" ? "abandoned" : "active";
                change.update(invocation, {
                    ...invocation.body, lifecycle, lifecycle_history: [...invocation.body.lifecycle_history, {
                            transition: p.transition, reason: p.reason, evidence_refs: p.evidence_refs, ...(p.transition === "complete" ? {
                                completion: p.completion
                            } : {})
                        }]
                });
                result = {
                    ...result, status: lifecycle
                };
                break;
            }
        }
        return C.success(change.finish(result, invocation.id));
    }
    catch (error) {
        if (error instanceof Refusal)
            return C.failure(error.code, error.message);
        throw error;
    }
}
export const apply = applyCoordination;
