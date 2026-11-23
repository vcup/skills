import { describe, expect, test } from "bun:test";
import { ARCHIVE_FORMAT, actorIdentity, type Actor, type DomainRecord, type LearnCommand, type MutationPlan, type ObjectKind, type ObjectRef, type RecordBodies, type RecordOf, type Result, type Snapshot, type TrustedFacts } from "./contracts.ts";
import { applyCoordination } from "./coordination.ts";
import { decodeSnapshot } from "./codec.ts";
import { querySnapshot } from "./query.ts";
import { LEARN_ACTIONS, type DomainCommand, type WorkCommand } from "./contracts.ts";
import { applyLearning, deriveLessonStatus } from "./learning.ts";
const lead: Actor = { kind: "session", sessionId: "lead", rootSessionId: "root", workspaceRef: "workspace", callId: "call" };
const author: Actor = { ...lead, sessionId: "author" };
const reviewer: Actor = { ...lead, sessionId: "reviewer" };
const second: Actor = { ...lead, sessionId: "second" };
let nextId = 0;
const ref = (id: string, object_revision = 1): ObjectRef => ({ kind: "object", object_id: id, object_revision });
function record<K extends ObjectKind>(kind: K, id: string, body: RecordBodies[K], actor: Actor = lead): RecordOf<K> { return { format: ARCHIVE_FORMAT, kind, id, object_revision: 1, created_sequence: 1, updated_sequence: 1, author: actorIdentity(actor), body }; }
function initial(): Snapshot { return { archiveId: "archive", projectId: "project", title: "Learning", revision: "commit-1", sequence: 1, formatVersion: 2, rendererVersion: "1", bindings: [], policy: { epoch: 1, paused: false, grants: [lead, author, reviewer, second].map((a) => ({ id: a.kind === 'session' ? a.sessionId : 'owner', subject: actorIdentity(a), rights: a === lead ? ["read", "lead", "organize"] : ["read", "member-submit", "review"], scope: { kind: "project" }, revoked: false })) }, objects: [record("invocation", "invocation", { title: "Teaching", goal: "Separate receipt and completion", deliverable: "Verified approach", subject: "Async tools", constraints: "Preserve unknowns", exclusions: "No global claims", frame_revision: 1, lead: actorIdentity(lead), lifecycle: "completed", coverage_ids: [], criterion_ids: [], lifecycle_history: [] }), record("domain", "domain", { invocation_id: "invocation", title: "Async", questions: "What completed?", audience: "Maintainers", overview: "Evidence first", retired: false }), record("attempt", "attempt", { invocation_id: "invocation", question: "Trace task", baseline_refs: [], coverage_ids: [], difference_or_redundancy: "Independent evidence", context_plan: { mode: "fresh", relevance: "new case", exposure: "spec only" }, expected_output: "event trace", early_slice: "first event", write_scope_claims: [], purpose: "produce", member_id: "author", progress: "returned", binding_history: [] })] }; }
const facts = (actor: Actor): TrustedFacts => ({ actor, now: 100, newId: kind => `${kind}-${++nextId}` });
function accept(snapshot: Snapshot, command: LearnCommand, actor: Actor = lead, extra: Partial<TrustedFacts> = {}): [
    Snapshot,
    MutationPlan
] { const result = applyLearning(snapshot, command, { ...facts(actor), ...extra }); if (!result.ok)
    throw new Error(JSON.stringify(result.error)); const ids = new Set(result.value.upserts.map(r => r.id)); return [{ ...snapshot, revision: `commit-${snapshot.sequence + 1}`, sequence: snapshot.sequence + 1, objectHistory: [...(snapshot.objectHistory ?? []), ...snapshot.objects.filter(r => ids.has(r.id))], objects: [...snapshot.objects.filter(r => !ids.has(r.id)), ...result.value.upserts] }, result.value]; }
const reflection = (reflection_id?: string): LearnCommand => ({ action: "propose_reflection", payload: { invocation_id: "invocation", domain_id: "domain", title: "Receipt is not completion", problem: "Accepted mistaken for done", actions_and_evidence: "Observed new example and negative case", judgment_change: "Wait for execution evidence", limits: "Only asynchronous tools", next_test: "Cancel after receipt", fact_refs: [], retrospective: false, ...(reflection_id ? { reflection_id } : {}) } });
function code(result: Result<MutationPlan>) { return result.ok ? "accepted" : result.error.code; }
function assign(state: Snapshot, proposal: ObjectRef, actor: Actor): Snapshot { return { ...state, policy: { ...state.policy, grants: [...state.policy.grants, { id: `review-${actorKeyForTest(actor)}-${proposal.object_id}-${proposal.object_revision}`, subject: actorIdentity(actor), rights: ["read", "review"], scope: { kind: "proposal", proposal_ref: proposal }, revoked: false }] } }; }
function actorKeyForTest(actor: Actor) { return actor.kind === 'session' ? actor.sessionId : actor.ownerId; }
const review = (proposal: ObjectRef, verdict: "approve" | "revise" | "reject", findings: Extract<LearnCommand, {
    action: "review_reflection";
}>['payload']['findings'] = []): LearnCommand => ({ action: "review_reflection", payload: { invocation_id: "invocation", proposal_ref: proposal, verdict, findings, evidence_refs: [] } });
const publish = (proposal: ObjectRef, reviews: ObjectRef[]): LearnCommand => ({ action: "publish_reflection", payload: { invocation_id: "invocation", proposal_ref: proposal, review_refs: reviews } });
test("non-author review cannot bypass a blocker with another approval or a revised draft", () => {
    let [state, draftPlan] = accept(initial(), reflection(), author);
    const draft = draftPlan.upserts[0]!;
    state = assign(assign(assign(state, ref(draft.id), author), ref(draft.id), reviewer), ref(draft.id), second);
    expect(code(applyLearning(state, review(ref(draft.id), "approve"), facts(author)))).toBe("not_authorized");
    let blocking: MutationPlan, approved: MutationPlan;
    [state, blocking] = accept(state, review(ref(draft.id), "revise", [{ statement: "No unseen case", blocking: true, evidence_refs: [] }]), reviewer);
    [state, approved] = accept(state, review(ref(draft.id), "approve"), second);
    expect(code(applyLearning(state, publish(ref(draft.id), [ref(approved.upserts[0]!.id)]), facts(lead)))).toBe("invalid_transition");
    [state] = accept(state, reflection(draft.id), author);
    state = assign(assign(state, ref(draft.id, 2), second), ref(draft.id, 2), reviewer);
    [state, approved] = accept(state, review(ref(draft.id, 2), "approve"), second);
    expect(code(applyLearning(state, publish(ref(draft.id, 2), [ref(approved.upserts[0]!.id)]), facts(lead)))).toBe("invalid_transition");
    const blocked = blocking.upserts[0] as RecordOf<'review'>, finding = blocked.body.findings[0]!;
    const response = { id: finding.id, statement: "Unseen case now checked", blocking: false, evidence_refs: [ref(blocked.id)] };
    expect(code(applyLearning(state, review(ref(draft.id, 2), "approve", [response]), facts(second)))).toBe("not_authorized");
    [state, approved] = accept(state, review(ref(draft.id, 2), "approve", [response]), reviewer);
    const published = applyLearning(state, publish(ref(draft.id, 2), [ref(approved.upserts[0]!.id)]), facts(lead));
    expect(published.ok).toBe(true);
    if (published.ok)
        expect(published.value.upserts.find(r => r.kind === 'publication')?.body.proposal_ref).toEqual(ref(draft.id, 2));
});
describe("Learning public Interface", () => {
    test("completed work permits coaching and an author-owned exact reflection draft", () => {
        let state = initial();
        let plan: MutationPlan;
        [state, plan] = accept(state, { action: "record_coaching", payload: { invocation_id: "invocation", attempt_id: "attempt", observed_problem: "Receipt reported as done", diagnosis: "Two events conflated", instruction: "Wait for completion and verify artifact", exposure_refs: [], intended_transfer: "Unseen async tool" } });
        expect(plan.upserts[0]?.kind).toBe("coaching");
        [state, plan] = accept(state, reflection(), author);
        const draft = plan.upserts[0]!;
        expect(draft.author).toEqual(actorIdentity(author));
        expect(draft.object_revision).toBe(1);
        expect(code(applyLearning(state, reflection(draft.id), facts(lead)))).toBe("not_authorized");
        [state, plan] = accept(state, reflection(draft.id), author);
        expect(plan.upserts[0]?.object_revision).toBe(2);
        expect(initial().objects).toHaveLength(3);
    });
});
function published(state = initial()): [
    Snapshot,
    RecordOf<"publication">
] {
    let draft: MutationPlan, approved: MutationPlan, pub: MutationPlan;
    [state, draft] = accept(state, reflection(), author);
    const target = ref(draft.upserts[0]!.id);
    state = assign(state, target, reviewer);
    [state, approved] = accept(state, review(target, "approve"), reviewer);
    [state, pub] = accept(state, publish(target, [ref(approved.upserts[0]!.id)]));
    return [state, pub.upserts[0] as RecordOf<"publication">];
}
test("correction and withdrawal review the exact target, mode and reason without rewriting original prose", () => {
    let [state, original] = published();
    const originalDraft = state.objects.find(r => r.id === original.body.proposal_ref.object_id)!;
    let draft: MutationPlan, approved: MutationPlan, amended: MutationPlan;
    const proposal = reflection();
    if (proposal.action !== "propose_reflection")
        throw Error();
    [state, draft] = accept(state, { ...proposal, payload: { ...proposal.payload, amendment: { target: ref(original.id), mode: "correct", reason: "Restrict claim to asynchronous interfaces" } } }, author);
    const target = ref(draft.upserts[0]!.id);
    state = assign(state, target, reviewer);
    [state, approved] = accept(state, review(target, "approve"), reviewer);
    const amendment: Extract<LearnCommand, {
        action: "amend_publication";
    }> = { action: "amend_publication", payload: { invocation_id: "invocation", target: ref(original.id), proposal_ref: target, review_refs: [ref(approved.upserts[0]!.id)], reason: "Restrict claim to asynchronous interfaces", mode: "correct" } };
    expect(code(applyLearning(state, { ...amendment, payload: { ...amendment.payload, mode: "withdraw" } }, facts(lead)))).toBe("invalid_input");
    expect(code(applyLearning(state, publish(target, [ref(approved.upserts[0]!.id)]), facts(lead)))).toBe("invalid_transition");
    [state, amended] = accept(state, amendment);
    expect(state.objects.find(r => r.id === original.id)).toEqual(original);
    expect(state.objects.find(r => r.id === originalDraft.id)).toEqual(originalDraft);
    const correction = amended.upserts[0] as RecordOf<"publication">;
    expect(correction.body.supersedes).toEqual(ref(original.id));
    expect(code(applyLearning(state, reflection(originalDraft.id), facts(author)))).toBe("invalid_transition");
    [state, draft] = accept(state, { ...proposal, payload: { ...proposal.payload, amendment: { target: ref(correction.id), mode: "withdraw", reason: "New evidence contradicts the remaining claim" } } }, author);
    const withdrawnTarget = ref(draft.upserts[0]!.id);
    state = assign(state, withdrawnTarget, reviewer);
    [state, approved] = accept(state, review(withdrawnTarget, "approve"), reviewer);
    [state, amended] = accept(state, { action: "amend_publication", payload: { invocation_id: "invocation", target: ref(correction.id), proposal_ref: withdrawnTarget, review_refs: [ref(approved.upserts[0]!.id)], reason: "New evidence contradicts the remaining claim", mode: "withdraw" } });
    expect((amended.upserts[0] as RecordOf<"publication">).body.status).toBe("withdrawn");
});
const lesson = (lesson_id?: string): LearnCommand => ({ action: "propose_lesson", payload: { invocation_id: "invocation", title: "Wait for actual completion", trigger: "Asynchronous receipt", action: "Inspect execution and output", supporting_refs: [], counterexamples: "Synchronous tools already return final results", applicability: { task_types: ["async"], interface_versions: ["v1"], required_capabilities: ["events"] }, invalidation_condition: "Interface returns final results synchronously", ...(lesson_id ? { lesson_id } : {}) } });
function nextTask(state: Snapshot): Snapshot {
    const old = state.objects.find(r => r.id === 'invocation') as RecordOf<'invocation'>;
    const attempt = state.objects.find(r => r.id === 'attempt') as RecordOf<'attempt'>;
    return { ...state, objects: [...state.objects, record('invocation', 'next-task', { ...old.body, lifecycle: 'active' }), record('attempt', 'next-attempt', { ...attempt.body, invocation_id: 'next-task', context_plan: { mode: 'fresh', relevance: 'unseen tool', exposure: 'general method only' } })] };
}
function applyLesson(target: ObjectRef, result: 'supports' | 'contradicts' | 'inconclusive', check_refs: ObjectRef[] = []): LearnCommand { return { action: 'assess_lesson', payload: { invocation_id: 'next-task', lesson_ref: target, assessment: { kind: 'application', invocation_id: 'next-task', attempt_id: 'next-attempt', context: 'Previously unseen tool', action_taken: 'Read completion event and final artifact', result, check_refs, limits: 'One tool; no global effectiveness claim' } } }; }
test("lesson support requires a new application and assigned non-author exact check; old counterexamples do not poison new or retired versions", () => {
    let state = initial(), proposed: MutationPlan, application: MutationPlan, assessed: MutationPlan;
    [state, proposed] = accept(state, lesson(), author);
    const id = proposed.upserts[0]!.id;
    state = nextTask(state);
    const target = ref(id);
    state = assign(state, target, reviewer);
    const check = record('check', 'new-example-check', { invocation_id: 'next-task', frame_revision: 1, provenance: 'reported', check: { kind: 'execution', target, criterion_ids: [], method: 'Unseen example and negative case', action: 'Trace actual completion', result: 'passed', evidence_refs: [{ kind: 'reported', statement: 'Final event inspected', source_label: 'test observer', supporting_refs: [] }], limits: 'No causal improvement claim' } }, reviewer);
    state = { ...state, objects: [...state.objects, check] };
    const decision = (applications: ObjectRef[], status: 'supported' | 'contested' | 'retired' = 'supported'): LearnCommand => ({ action: 'assess_lesson', payload: { invocation_id: 'next-task', lesson_ref: target, assessment: { kind: 'decision', status, reason: 'Application and review evaluated', application_refs: applications, review_ref: ref(check.id) } } });
    expect(code(applyLearning(state, decision([]), facts(lead)))).toBe('invalid_transition');
    [state, application] = accept(state, applyLesson(target, 'supports', [ref(check.id)]), author);
    [state, assessed] = accept(state, decision([ref(application.upserts[0]!.id)]));
    expect(deriveLessonStatus(state, state.objects.find(r => r.id === id) as RecordOf<'lesson'>)).toBe('supported');
    [state] = accept(state, applyLesson(target, 'contradicts', [ref(check.id)]), author);
    expect(deriveLessonStatus(state, state.objects.find(r => r.id === id) as RecordOf<'lesson'>)).toBe('contested');
    expect(code(applyLearning(state, decision([ref(application.upserts[0]!.id)]), facts(lead)))).toBe('invalid_transition');
    [state] = accept(state, lesson(id), author);
    [state] = accept(state, applyLesson(target, 'contradicts', [ref(check.id)]), author);
    const revised = state.objects.find(r => r.id === id) as RecordOf<'lesson'>;
    expect(revised.object_revision).toBe(2);
    expect(deriveLessonStatus(state, revised)).toBe('proposed');
    const newCheck = record('check', 'new-revision-check', { ...check.body, check: { ...check.body.check, target: ref(id, 2) } as RecordOf<'check'>['body']['check'] }, reviewer);
    state = assign({ ...state, objects: [...state.objects, newCheck] }, ref(id, 2), reviewer);
    [state] = accept(state, { action: 'assess_lesson', payload: { invocation_id: 'next-task', lesson_ref: ref(id, 2), assessment: { kind: 'decision', status: 'retired', reason: 'Advice no longer useful', application_refs: [], review_ref: ref(newCheck.id) } } });
    [state] = accept(state, applyLesson(ref(id, 2), 'contradicts', [ref(newCheck.id)]), author);
    expect(deriveLessonStatus(state, revised)).toBe('retired');
    expect(state.objects.filter(r => r.kind === 'application')).toHaveLength(4);
});
test("domain split rejects missing or duplicate assignments and move/retire preserve publication identity", () => {
    let [state, pub] = published();
    let changed: MutationPlan;
    const domain = () => state.objects.find(r => r.id === 'domain') as RecordOf<'domain'>;
    const organize = (change: Extract<LearnCommand, {
        action: 'organize_domain';
    }>['payload']['change']): LearnCommand => ({ action: 'organize_domain', payload: { invocation_id: 'invocation', change } });
    const split: Extract<LearnCommand, {
        action: 'organize_domain';
    }>['payload']['change'] = { kind: 'split', domain_ref: ref('domain', domain().object_revision), new_domains: [{ key: 'events', title: 'Events', questions: 'Which event?', audience: 'Callers', overview: 'Check receipt and completion' }, { key: 'errors', title: 'Errors', questions: 'What failed?', audience: 'Maintainers', overview: 'Keep failures visible' }], entry_assignments: [], reason: 'Readers need distinct questions' };
    expect(code(applyLearning(state, organize(split), facts(lead)))).toBe('invalid_input');
    expect(code(applyLearning(state, organize({ ...split, entry_assignments: [{ publication_ref: ref(pub.id), domain_key: 'events' }, { publication_ref: ref(pub.id), domain_key: 'errors' }] }), facts(lead)))).toBe('invalid_input');
    [state, changed] = accept(state, organize({ ...split, entry_assignments: [{ publication_ref: ref(pub.id), domain_key: 'events' }] }));
    const domains = changed.upserts.filter((r): r is RecordOf<'domain'> => r.kind === 'domain' && !r.body.retired);
    const events = domains.find(r => r.body.title === 'Events')!, errors = domains.find(r => r.body.title === 'Errors')!;
    expect(domains.flatMap(r => r.body.primary_publication_ids ?? [])).toEqual([pub.id]);
    [state] = accept(state, organize({ kind: 'move', publication_ref: ref(pub.id), from_domain: events.id, to_domain: errors.id, reason: 'Evidence concerns failure' }));
    const currentErrors = state.objects.find(r => r.id === errors.id) as RecordOf<'domain'>;
    [state] = accept(state, organize({ kind: 'retire', domain_ref: ref(errors.id, currentErrors.object_revision), successor_id: events.id, reason: 'Consolidate reader path' }));
    expect(state.objects.filter((r): r is RecordOf<'domain'> => r.kind === 'domain' && !r.body.retired).flatMap(r => r.body.primary_publication_ids ?? [])).toEqual([pub.id]);
    expect(state.objects.find(r => r.id === pub.id)).toEqual(pub);
    expect((state.objects.find(r => r.id === errors.id) as RecordOf<"domain">).body.change_reason).toBe("Consolidate reader path");
    [state, changed] = accept(state, organize({ kind: 'create', title: 'Other', questions: 'Other questions', audience: 'Reviewers', overview: 'Pending ideas remain unverified' }));
    const created = changed.upserts[0]!;
    [state, changed] = accept(state, organize({ kind: 'revise', domain_ref: ref(created.id), title: 'Other revised', questions: 'Sharper questions', audience: 'Reviewers', overview: 'No automatic lesson support' }));
    expect(changed.upserts[0]!.object_revision).toBe(2);
    expect(code(applyLearning(state, organize({ kind: 'retire', domain_ref: ref(created.id), successor_id: events.id, reason: 'stale' }), facts(lead)))).toBe('object_changed');
});
test('owner reassignment resolves the specific blocker; mere revocation or another approval does not', () => {
    let [state, draft] = accept(initial(), reflection(), author);
    const proposal = ref(draft.upserts[0]!.id);
    state = assign(assign(state, proposal, reviewer), proposal, second);
    let blocked: MutationPlan, approval: MutationPlan;
    [state, blocked] = accept(state, review(proposal, 'reject', [{ statement: 'Overbroad causal claim', blocking: true, evidence_refs: [] }]), reviewer);
    const original = blocked.upserts[0] as RecordOf<'review'>, findingId = original.body.findings[0]!.id!;
    [state, approval] = accept(state, review(proposal, 'approve'), second);
    const revoked = { ...state, policy: { ...state.policy, grants: state.policy.grants.map(g => g.subject.kind === 'session' && g.subject.sessionId === 'reviewer' ? { ...g, revoked: true } : g) } };
    expect(code(applyLearning(revoked, publish(proposal, [ref(approval.upserts[0]!.id)]), facts(lead)))).toBe('invalid_transition');
    state = { ...state, policy: { ...state.policy, reviewer_reassignments: [{ proposalId: proposal.object_id, findingId, reviewer: actorIdentity(second) }] } };
    [state, approval] = accept(state, review(proposal, 'approve', [{ id: findingId, statement: 'Claim now explicitly limited and independently checked', blocking: false, evidence_refs: [ref(original.id)] }]), second);
    expect(applyLearning(state, publish(proposal, [ref(approval.upserts[0]!.id)]), facts(lead)).ok).toBe(true);
});
test('public reducer rejects forged authority fields and unverified native evidence', () => {
    const forged = reflection();
    expect(code(applyLearning(initial(), { ...forged, payload: { ...forged.payload, author: 'somebody' } } as unknown as LearnCommand, facts(author)))).toBe('invalid_input');
    if (forged.action !== 'propose_reflection')
        throw Error();
    const native = { ...forged, payload: { ...forged.payload, fact_refs: [{ kind: 'native_event' as const, session_id: 'invented', event_seq: 123 }] } };
    expect(code(applyLearning(initial(), native, facts(author)))).toBe('not_found');
});
test('real Work → teaching → reviewed publication → next-task application → counterexample disposition journey', () => {
    let state: Snapshot = { ...initial(), objects: [], sequence: 0, revision: '0'.repeat(40), policy: { epoch: 1, paused: false, grants: [{ id: 'leader', subject: actorIdentity(lead), rights: ['read', 'open', 'organize'], scope: { kind: 'project' }, revoked: false, delegable_rights: ['member-submit', 'review'] }, ...[author, reviewer].map((actor) => ({ id: actorKeyForTest(actor), subject: actorIdentity(actor), rights: ['read', 'member-submit'] as const, scope: { kind: 'project' as const }, revoked: false }))] } };
    const evidence = { kind: 'reported' as const, statement: 'Deterministic native-event fixture observed; no paid model improvement claim', source_label: 'Interface test', supporting_refs: [] };
    const creation = { kind: 'native_event' as const, session_id: 'root', event_seq: 1 };
    const step = (command: DomainCommand, actor: Actor = lead) => {
        const trusted = { ...facts(actor), nativeMembers: [{ sessionId: 'author', rootSessionId: 'root', name: 'author', contextMode: 'fresh' as const, creationRef: creation }, { sessionId: 'reviewer', rootSessionId: 'root', name: 'reviewer', contextMode: 'fresh' as const, creationRef: creation }], observedEventRefs: [creation] };
        const result = (LEARN_ACTIONS as readonly string[]).includes(command.action) ? applyLearning(state, command as LearnCommand, trusted) : applyCoordination(state, command as WorkCommand, trusted);
        if (!result.ok)
            throw Error(`${command.action}: ${JSON.stringify(result.error)}`);
        const changed = new Set(result.value.upserts.map(r => r.id));
        state = { ...state, sequence: state.sequence + 1, revision: (state.sequence + 1).toString(16).padStart(40, '0'), policy: result.value.policy ?? state.policy, objectHistory: [...(state.objectHistory ?? []), ...state.objects.filter(r => changed.has(r.id))], objects: [...state.objects.filter(r => !changed.has(r.id)), ...result.value.upserts] };
        const valid = decodeSnapshot(state);
        if (!valid.ok)
            throw Error(`Snapshot: ${JSON.stringify(valid.error)}`);
        return result.value;
    };
    const open = () => step({ action: 'open', payload: { title: 'Async work', goal: 'Verify completed output', deliverable: 'Reviewed evidence', subject: 'Async Interface', constraints: 'Preserve evidence modality', exclusions: 'No effectiveness claim', coverage: [{ key: 'events', title: 'Completion', requirement: 'Distinguish receipt and completion', required: true, authority_refs: [] }], criteria: [{ key: 'case', coverage_targets: [{ kind: 'request_key', key: 'events' }], statement: 'Unseen and counterexample checked', critical: true, method: 'Trace events' }] } }).upserts.find(r => r.kind === 'invocation')!.id;
    const attempt = (invocation_id: string, member_id: string) => step({ action: 'plan_attempt', payload: { invocation_id, question: 'Inspect event ordering', baseline_refs: [evidence], coverage_ids: [], difference_or_redundancy: 'Independent new tool', context_plan: { mode: 'fresh', relevance: 'Unseen task', exposure: 'General method only' }, expected_output: 'Evidence and limitations', early_slice: 'One event trace', write_scope_claims: [], purpose: member_id === 'reviewer' ? 'review' : 'produce', member_id } }).upserts.find(r => r.kind === 'attempt')!.id;
    const first = open(), firstAttempt = attempt(first, 'author');
    const domain = step({ action: 'organize_domain', payload: { invocation_id: first, change: { kind: 'create', title: 'Async evidence', questions: 'What completed?', audience: 'Maintainers', overview: 'Preserve gaps' } } }).upserts[0]!.id;
    const coaching = step({ action: 'record_coaching', payload: { invocation_id: first, attempt_id: firstAttempt, observed_problem: 'Receipt interpreted as completion', diagnosis: 'Events conflated', instruction: 'Inspect final execution event and artifact', exposure_refs: [evidence], intended_transfer: 'Unseen async tool' } }).upserts[0]!;
    const proposal = step({ action: 'propose_reflection', payload: { invocation_id: first, domain_id: domain, title: 'Separate receipt and completion', problem: 'Early completion claim', actions_and_evidence: 'Original repair, unseen example and negative case', judgment_change: 'Wait for execution evidence', limits: 'Async Interface only', next_test: 'Cancellation after receipt', fact_refs: [ref(coaching.id)], retrospective: false } }, author).upserts[0]!;
    state = assign(state, ref(proposal.id), reviewer);
    const reviewed = step({ action: 'review_reflection', payload: { invocation_id: first, proposal_ref: ref(proposal.id), verdict: 'approve', findings: [], evidence_refs: [evidence] } }, reviewer).upserts[0]!;
    const publication = step({ action: 'publish_reflection', payload: { invocation_id: first, proposal_ref: ref(proposal.id), review_refs: [ref(reviewed.id)] } }).upserts[0]!;
    const proposed = step({ action: 'propose_lesson', payload: { invocation_id: first, title: 'Inspect completion', trigger: 'Async receipt', action: 'Read final event and artifact', supporting_refs: [ref(publication.id)], counterexamples: 'Synchronous completion', applicability: { task_types: ['async'], interface_versions: ['v1'], required_capabilities: ['events'] }, invalidation_condition: 'Tool already returns final output' } }, author).upserts[0] as RecordOf<'lesson'>;
    const next = open(), applicationAttempt = attempt(next, 'author');
    attempt(next, 'reviewer');
    state = assign(state, ref(proposed.id), reviewer);
    const check = (evidence_refs: typeof evidence[] | ObjectRef[]) => step({ action: 'record_check', payload: { invocation_id: next, check: { kind: 'execution', target: ref(proposed.id), criterion_ids: [], method: 'Unseen and negative case', action: 'Run deterministic cases', result: 'passed', evidence_refs, limits: 'Reported fixture observations only' } } }, reviewer).upserts[0]!;
    let observed = check([evidence]);
    const application = (result: 'supports' | 'contradicts') => step({ action: 'assess_lesson', payload: { invocation_id: next, lesson_ref: ref(proposed.id), assessment: { kind: 'application', invocation_id: next, attempt_id: applicationAttempt, context: 'New tool Interface', action_taken: 'Wait and inspect final event', result, check_refs: [ref(observed.id)], limits: 'No population-level improvement claim', case_kind: result === 'supports' ? 'unseen' : 'counterexample' } } }, author).upserts[0]!;
    const supported = application('supports');
    const decision = (application_refs: ObjectRef[]) => step({ action: 'assess_lesson', payload: { invocation_id: next, lesson_ref: ref(proposed.id), assessment: { kind: 'decision', status: 'supported', reason: 'New example and independent check', application_refs, review_ref: ref(observed.id) } } });
    decision([ref(supported.id)]);
    const task_context = { task_types: ['async'], interface_versions: ['v1'], required_capabilities: ['events'] };
    const recommendations = () => querySnapshot(state, { kind: 'lessons', domain_id: domain, task_context }, { actor, now: 100, nextCursor: n => `cursor:${n}` });
    const actor = lead;
    let results = recommendations();
    expect(results.ok && results.value.items).toHaveLength(1);
    const contrary = application('contradicts');
    results = recommendations();
    expect(results.ok && results.value.items).toHaveLength(0);
    const challenge = step({ action: 'record_challenge', payload: { invocation_id: next, target: ref(proposed.id), statement: 'Synchronous tool is a counterexample', contradicting_refs: [ref(contrary.id)], impact: 'Remove default recommendation' } }).upserts[0]!;
    step({ action: 'resolve_challenge', payload: { invocation_id: next, challenge_id: challenge.id, resolution: 'dismissed', reason: 'Confirmed outside the explicitly asynchronous applicability', evidence_refs: [evidence] } });
    observed = check([ref(supported.id), ref(contrary.id)]);
    decision([ref(supported.id), ref(contrary.id)]);
    results = recommendations();
    expect(results.ok && results.value.items).toHaveLength(1);
    const reading = querySnapshot(state, { kind: 'reading', domain_id: domain }, { actor: lead, now: 100, nextCursor: n => `cursor:${n}` });
    expect(reading.ok && reading.value.items.length).toBe(2);
    expect(state.objects.filter((r): r is RecordOf<'check'> => r.kind === 'check').every(r => r.body.provenance === 'reported')).toBe(true);
});
test('an exact proposal read/review assignment does not require broad invocation access', () => {
    let [state, draft] = accept(initial(), reflection(), author);
    const proposal = ref(draft.upserts[0]!.id);
    state = { ...state, policy: { ...state.policy, grants: state.policy.grants.filter(g => g.subject.kind !== 'session' || g.subject.sessionId !== 'reviewer') } };
    state = assign(state, proposal, reviewer);
    expect(applyLearning(state, review(proposal, 'approve'), facts(reviewer)).ok).toBe(true);
});

test('published proposals require challenge/amendment and malformed domain maps cannot be committed',()=>{
 let [state,pub]=published();
 expect(code(applyLearning(state,review(pub.body.proposal_ref,'approve'),facts(reviewer)))).toBe('invalid_transition');
 const domain=state.objects.find(r=>r.id==='domain') as RecordOf<'domain'>;
 const corrupt={...state,objects:[...state.objects,{...domain,id:'duplicate-domain',body:{...domain.body,primary_publication_ids:[pub.id]}}]};
 const changed=applyLearning(corrupt,{action:'organize_domain',payload:{invocation_id:'invocation',change:{kind:'revise',domain_ref:ref(domain.id,domain.object_revision),title:'Revised',questions:'Same question',audience:'Same readers',overview:'Only navigation'}}},facts(lead));
 expect(code(changed)).toBe('archive_corrupt');
});
