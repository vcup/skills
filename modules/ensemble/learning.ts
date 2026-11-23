import { ARCHIVE_FORMAT, actorIdentity, actorKey, failure, success, type DomainRecord, type LearnCommand, type LessonStatus, type MutationPlan, type ObjectKind, type ObjectRef, type RecordBodies, type RecordOf, type ReviewFinding, type Result, type Snapshot, type TrustedFacts, type ViewSelection } from "./contracts.ts";
import { decodeLearnCommand } from "./codec.ts";
import { authorizeCommand, isAssignedReviewer, isCurrentMember, mayReadObject, objectAt, sameRef } from "./policy.ts";
function current<K extends ObjectKind>(snapshot: Snapshot, id: string, kind: K): RecordOf<K> | undefined {
    return snapshot.objects.find(r => r.id === id && r.kind === kind) as RecordOf<K> | undefined;
}
function exact<K extends ObjectKind>(snapshot: Snapshot, target: ObjectRef, kind: K): RecordOf<K> | undefined {
    const record = objectAt(snapshot, target);
    return record?.kind === kind ? record as RecordOf<K> : undefined;
}
function objectRef(record: DomainRecord): ObjectRef { return { kind: "object", object_id: record.id, object_revision: record.object_revision }; }
function make<K extends ObjectKind>(snapshot: Snapshot, facts: TrustedFacts, kind: K, body: RecordBodies[K], prior?: RecordOf<K>): RecordOf<K> {
    return { format: ARCHIVE_FORMAT, kind, id: prior?.id ?? facts.newId(kind), object_revision: (prior?.object_revision ?? 0) + 1, created_sequence: prior?.created_sequence ?? snapshot.sequence + 1, updated_sequence: snapshot.sequence + 1, author: prior?.author ?? actorIdentity(facts.actor), body };
}
function plan(records: readonly DomainRecord[], views: readonly ViewSelection[] = []): Result<MutationPlan> { const record = records[0]; return success({ upserts: records, content: [], views, result: record ? { id: record.id, object_revision: record.object_revision } : {} }); }
function proposalReviews(snapshot: Snapshot, id: string): RecordOf<"review">[] { return snapshot.objects.filter((r): r is RecordOf<"review"> => r.kind === "review" && r.body.proposal_ref.object_id === id).sort((a, b) => a.updated_sequence - b.updated_sequence || a.id.localeCompare(b.id)); }
function publicationReady(snapshot: Snapshot, target: ObjectRef, selected: readonly ObjectRef[], facts: TrustedFacts): Result<RecordOf<"reflection">> {
    const proposal = exact(snapshot, target, "reflection");
    if (!proposal || current(snapshot, target.object_id, "reflection")?.object_revision !== target.object_revision)
        return failure("object_changed", "Publication requires the current exact draft");
    const reviews = proposalReviews(snapshot, proposal.id), latest = new Map<string, RecordOf<"review">>(), findings = new Map<string, boolean>();
    for (const review of reviews) {
        for (const finding of review.body.findings)
            if (finding.id)
                findings.set(finding.id, finding.blocking);
        if (sameRef(review.body.proposal_ref, target))
            latest.set(actorKey(review.author), review);
    }
    if ([...findings.values()].some(Boolean))
        return failure("invalid_transition", "Unresolved blocking review finding");
    const active = [...latest.values()].filter(r => actorKey(r.author) !== actorKey(proposal.author) && isAssignedReviewer(snapshot, r.author, target, facts.now));
    const reassignments = [...(snapshot.policy.reviewer_reassignments ?? []), ...(facts.reviewerReassignments ?? [])];
    const replaced = (r: RecordOf<"review">) => r.body.findings.filter(f => f.blocking).every(f => !!f.id && reassignments.some(assignment => assignment.proposalId === proposal.id && assignment.findingId === f.id && active.some(replacement => actorKey(replacement.author) === actorKey(assignment.reviewer) && replacement.updated_sequence > r.updated_sequence && replacement.body.verdict === "approve" && replacement.body.findings.some(answer => answer.id === f.id && !answer.blocking && answer.evidence_refs.length > 0))));
    if (active.some(r => r.body.verdict !== "approve" && !replaced(r)))
        return failure("invalid_transition", "Current review requires revision or rejects publication");
    if (!selected.length || selected.some(ref => !active.some(r => sameRef(objectRef(r), ref))))
        return failure("invalid_input", "Selected reviews must be current assigned reviews for the exact draft");
    if (!selected.some(ref => active.some(r => sameRef(objectRef(r), ref) && r.body.verdict === "approve")))
        return failure("invalid_transition", "Non-author approval is required");
    return success(proposal);
}
function domainEntries(snapshot: Snapshot, id: string): string[] {
    const domain = current(snapshot, id, "domain");
    if (domain?.body.primary_publication_ids)
        return [...domain.body.primary_publication_ids];
    const assigned = new Set(snapshot.objects.flatMap(r => r.kind === "domain" ? r.body.primary_publication_ids ?? [] : []));
    return snapshot.objects.filter((r): r is RecordOf<"publication"> => r.kind === "publication" && r.body.domain_id === id && !assigned.has(r.id)).map(r => r.id);
}
function nextPublicationSequence(snapshot: Snapshot): number { return snapshot.objects.reduce((maximum, r) => r.kind === "publication" ? Math.max(maximum, r.body.sequence) : maximum, 0) + 1; }
function lessonApplications(snapshot: Snapshot, target: ObjectRef): RecordOf<"application">[] { return snapshot.objects.filter((r): r is RecordOf<"application"> => r.kind === "application" && sameRef(r.body.lesson_ref, target)); }
function counterexampleDisposed(snapshot: Snapshot, target: ObjectRef, application: RecordOf<"application">): boolean {
    return snapshot.objects.some(r => r.kind === "challenge" && sameRef(r.body.target, target) && r.body.contradicting_refs.some(x => x.kind === "object" && sameRef(x, objectRef(application))) && r.body.resolution && (r.body.resolution.resolution === "dismissed" || r.body.resolution.resolution === "superseded") && r.body.resolution.evidence_refs.length > 0);
}
/** State belongs to the exact content revision; late evidence never rewrites retired or newer content. */
export function deriveLessonStatus(snapshot: Snapshot, lesson: RecordOf<"lesson">): LessonStatus {
    const target = objectRef(lesson), decisions = snapshot.objects.filter((r): r is RecordOf<"assessment"> => r.kind === "assessment" && sameRef(r.body.lesson_ref, target)).sort((a, b) => b.updated_sequence - a.updated_sequence || b.id.localeCompare(a.id));
    const latest = decisions[0];
    if (latest?.body.assessment.status === "retired")
        return "retired";
    const challenged = snapshot.objects.some(r => r.kind === "challenge" && sameRef(r.body.target, target) && (!r.body.resolution || r.body.resolution.resolution === "upheld"));
    const contradicted = lessonApplications(snapshot, target).some(a => a.body.assessment.result === "contradicts" && (!latest || a.updated_sequence > latest.updated_sequence || !counterexampleDisposed(snapshot, target, a)));
    return challenged || contradicted ? "contested" : latest?.body.assessment.status ?? "proposed";
}
/** Pure learning reducer. Archive runs this after current authorization, retry and CAS preconditions. */
function reduceLearning(snapshot: Snapshot, command: LearnCommand, facts: TrustedFacts): Result<MutationPlan> {
    const invocation = current(snapshot, command.payload.invocation_id, "invocation");
    if (!invocation)
        return failure("not_found", "Invocation not found", "invocation_id");
    switch (command.action) {
        case "record_coaching": {
            const p = command.payload, attempt = current(snapshot, p.attempt_id, "attempt");
            if (!attempt || attempt.body.invocation_id !== invocation.id)
                return failure("not_found", "Attempt not in invocation", "attempt_id");
            return plan([make(snapshot, facts, "coaching", p)], [{ kind: "checkpoint", invocation_id: invocation.id }]);
        }
        case "propose_reflection": {
            const p = command.payload, domain = current(snapshot, p.domain_id, "domain");
            if (!domain || domain.body.retired)
                return failure("invalid_transition", "Draft requires an active domain", "domain_id");
            if (!mayReadObject(snapshot, facts.actor, domain, facts.now))
                return failure("not_authorized", "Domain requires current read permission");
            if (p.amendment) {
                const original = exact(snapshot, p.amendment.target, "publication");
                if (!original || original.body.invocation_id !== invocation.id)
                    return failure("invalid_input", "Amendment must identify an exact publication in this invocation", "amendment.target");
            }
            const prior = p.reflection_id ? current(snapshot, p.reflection_id, "reflection") : undefined;
            if (p.reflection_id && !prior)
                return failure("not_found", "Reflection not found", "reflection_id");
            if (prior && (actorKey(prior.author) !== actorKey(facts.actor) || prior.body.invocation_id !== invocation.id))
                return failure("not_authorized", "Only the original author can revise this draft");
            if (prior && (prior.body.status === "published" || snapshot.objects.some(r => r.kind === "publication" && r.body.proposal_ref.object_id === prior.id)))
                return failure("invalid_transition", "Published prose requires a separately reviewed amendment");
            return plan([make(snapshot, facts, "reflection", { ...p, status: "draft" }, prior)], [{ kind: "reading", domain_id: p.domain_id }]);
        }
        case "review_reflection": {
            const p = command.payload, proposal = exact(snapshot, p.proposal_ref, "reflection");
            if (!proposal)
                return failure("object_changed", "Read the exact current draft", "proposal_ref");
            if (current(snapshot, proposal.id, "reflection")?.object_revision !== proposal.object_revision)
                return failure("object_changed", "Review targets a superseded draft");
            if (proposal.body.invocation_id !== invocation.id)
                return failure("not_authorized", "Proposal is outside invocation");
            if (snapshot.objects.some(r => r.kind === "publication" && r.body.proposal_ref.object_id === proposal.id))
                return failure("invalid_transition", "Published prose is challenged or amended, not reviewed as a mutable draft");
            if (actorKey(proposal.author) === actorKey(facts.actor))
                return failure("not_authorized", "An author cannot independently review their proposal");
            const reviews = proposalReviews(snapshot, proposal.id), known = new Map<string, RecordOf<"review">>();
            for (const r of reviews)
                for (const finding of r.body.findings)
                    if (finding.id && !known.has(finding.id))
                        known.set(finding.id, r);
            const id = facts.newId("review"), findings: ReviewFinding[] = [], seen = new Set<string>();
            for (const finding of p.findings) {
                const findingId = finding.id ?? facts.newId("review");
                if (seen.has(findingId))
                    return failure("invalid_input", "Duplicate finding response");
                seen.add(findingId);
                if (finding.id) {
                    const origin = known.get(finding.id);
                    if (!origin)
                        return failure("not_found", "Original blocking finding not found");
                    const reassigned = [...(snapshot.policy.reviewer_reassignments ?? []), ...(facts.reviewerReassignments ?? [])].some(r => r.proposalId === proposal.id && r.findingId === finding.id && actorKey(r.reviewer) === actorKey(facts.actor));
                    if (actorKey(origin.author) !== actorKey(facts.actor) && !reassigned)
                        return failure("not_authorized", "Only the original or owner-assigned reviewer can respond to this finding");
                    if (!finding.blocking && finding.evidence_refs.length === 0)
                        return failure("invalid_input", "Clearing a finding requires evidence");
                }
                findings.push({ ...finding, id: findingId });
            }
            if (p.verdict !== "approve" && !findings.some(f => f.blocking))
                findings.push({ id: facts.newId("review"), statement: `Unresolved review verdict: ${p.verdict}`, blocking: true, evidence_refs: p.evidence_refs });
            if (p.verdict === "approve" && findings.some(f => f.blocking))
                return failure("invalid_input", "Approval cannot include a blocking finding");
            const r = make(snapshot, { ...facts, newId: () => id }, "review", { ...p, findings });
            return plan([r], [{ kind: "reading", domain_id: proposal.body.domain_id }]);
        }
        case "publish_reflection": {
            const p = command.payload, approved = publicationReady(snapshot, p.proposal_ref, p.review_refs, facts);
            if (!approved.ok)
                return approved;
            const proposal = approved.value;
            if (proposal.body.invocation_id !== invocation.id)
                return failure("not_authorized", "Proposal is outside invocation");
            if (proposal.body.amendment)
                return failure("invalid_transition", "Amendment draft must be applied to its reviewed target");
            if (snapshot.objects.some(r => r.kind === "publication" && r.body.proposal_ref.object_id === proposal.id))
                return failure("invalid_transition", "Draft is already published");
            const domain = current(snapshot, proposal.body.domain_id, "domain");
            if (!domain || domain.body.retired)
                return failure("invalid_transition", "Publication needs an active domain");
            const publication = make(snapshot, facts, "publication", { ...p, domain_id: domain.id, sequence: nextPublicationSequence(snapshot), status: "current" });
            const mapping = make(snapshot, facts, "domain", { ...domain.body, primary_publication_ids: [...domainEntries(snapshot, domain.id), publication.id] }, domain);
            return plan([publication, mapping], [{ kind: "reading", domain_id: domain.id }]);
        }
        case "amend_publication": {
            const p = command.payload, original = exact(snapshot, p.target, "publication");
            if (!original || original.body.invocation_id !== invocation.id)
                return failure("invalid_input", "Amendment target must be an exact publication of this invocation", "target");
            if (snapshot.objects.some(r => r.kind === "publication" && r.body.supersedes && sameRef(r.body.supersedes, p.target)))
                return failure("object_changed", "Publication already has a correction or withdrawal; amend the latest entry");
            const approved = publicationReady(snapshot, p.proposal_ref, p.review_refs, facts);
            if (!approved.ok)
                return approved;
            const proposal = approved.value, scope = proposal.body.amendment;
            if (proposal.body.invocation_id !== invocation.id || !scope || !sameRef(scope.target, p.target) || scope.mode !== p.mode || scope.reason !== p.reason)
                return failure("invalid_input", "Reviewed amendment must cover this target, mode and reason");
            if (snapshot.objects.some(r => r.kind === "publication" && r.body.proposal_ref.object_id === proposal.id))
                return failure("invalid_transition", "Draft is already published");
            const domain = snapshot.objects.find((r): r is RecordOf<"domain"> => r.kind === "domain" && !r.body.retired && domainEntries(snapshot, r.id).includes(original.id));
            if (!domain)
                return failure("archive_corrupt", "Publication has no active primary domain");
            const publication = make(snapshot, facts, "publication", { invocation_id: invocation.id, proposal_ref: p.proposal_ref, review_refs: p.review_refs, domain_id: domain.id, sequence: nextPublicationSequence(snapshot), status: p.mode === "withdraw" ? "withdrawn" : "current", reason: p.reason, supersedes: p.target });
            const mapping = make(snapshot, facts, "domain", { ...domain.body, primary_publication_ids: [...domainEntries(snapshot, domain.id), publication.id] }, domain);
            return plan([publication, mapping], [{ kind: "reading", domain_id: domain.id }, { kind: "object", object_id: original.id }]);
        }
        case "propose_lesson": {
            const p = command.payload, prior = p.lesson_id ? current(snapshot, p.lesson_id, "lesson") : undefined;
            if (p.lesson_id && !prior)
                return failure("not_found", "Lesson not found");
            if (prior && (actorKey(prior.author) !== actorKey(facts.actor) || prior.body.invocation_id !== invocation.id))
                return failure("not_authorized", "Only the original author can revise a lesson in its original invocation");
            return plan([make(snapshot, facts, "lesson", p, prior)], [{ kind: "overview" }]);
        }
        case "assess_lesson": {
            const p = command.payload, lesson = exact(snapshot, p.lesson_ref, "lesson"), assessment = p.assessment;
            if (!lesson)
                return failure("not_found", "Exact lesson version not found");
            if (!mayReadObject(snapshot, facts.actor, lesson, facts.now))
                return failure("not_authorized", "Lesson requires current read permission");
            if (assessment.kind === "application") {
                const attempt = current(snapshot, assessment.attempt_id, "attempt");
                if (assessment.invocation_id !== invocation.id || !attempt || attempt.body.invocation_id !== invocation.id)
                    return failure("invalid_input", "Application must identify an attempt in this invocation");
                if (!isCurrentMember(snapshot, facts.actor, invocation.id, facts.now, assessment.attempt_id))
                    return failure("not_authorized", "Only the current bound application actor can report it");
                if (assessment.check_refs.some(ref => !exact(snapshot, ref, "check")))
                    return failure("not_found", "Application check not found");
                const record = make(snapshot, facts, "application", { invocation_id: invocation.id, lesson_ref: p.lesson_ref, assessment });
                const latest = current(snapshot, lesson.id, "lesson");
                const result = plan([record], [{ kind: "object", object_id: lesson.id }]);
                if (result.ok && latest?.object_revision !== lesson.object_revision)
                    return success({ ...result.value, result: { ...result.value.result, message: `Historical counterevidence retained; current lesson ${lesson.id} revision ${latest?.object_revision} requires an explicit challenge or new application.` } });
                return result;
            }
            if (current(snapshot, lesson.id, "lesson")?.object_revision !== lesson.object_revision)
                return failure("object_changed", "Decisions may only assess the current lesson version");
            if (deriveLessonStatus(snapshot, lesson) === "retired")
                return failure("invalid_transition", "Retired lesson requires an author-proposed new version");
            const review = exact(snapshot, assessment.review_ref, "check");
            if (!review || review.body.check.kind !== "execution" || !sameRef(review.body.check.target, p.lesson_ref))
                return failure("invalid_input", "Assessment requires an exact lesson execution check");
            if (!isAssignedReviewer(snapshot, review.author, p.lesson_ref, facts.now))
                return failure("not_authorized", "Assessment requires an assigned non-author reviewer");
            const applications: RecordOf<"application">[] = [];
            for (const ref of assessment.application_refs) {
                const a = exact(snapshot, ref, "application");
                if (!a || !sameRef(a.body.lesson_ref, p.lesson_ref))
                    return failure("invalid_input", "Assessment applications must target the same lesson revision");
                applications.push(a);
            }
            if (assessment.status === "supported") {
                if (review.body.check.result !== "passed" || review.body.check.evidence_refs.length === 0)
                    return failure("invalid_transition", "Support requires a passed non-author observation with evidence");
                const related = applications.some(a => a.body.assessment.result === "supports" && (a.body.assessment.case_kind !== "original" && (a.body.invocation_id !== lesson.body.invocation_id || (a.body.assessment.case_kind === "unseen" && !snapshot.objects.some(c => c.kind === "coaching" && c.body.attempt_id === a.body.assessment.attempt_id)))) && (a.body.assessment.check_refs.some(ref => sameRef(ref, assessment.review_ref)) || review.body.check.kind === "execution" && review.body.check.evidence_refs.some(ref => ref.kind === "object" && sameRef(ref, objectRef(a)))));
                if (!related)
                    return failure("invalid_transition", "Support requires reviewed application beyond the original task; publication or original-case repair alone is insufficient");
                const contradictions = lessonApplications(snapshot, p.lesson_ref).filter(a => a.body.assessment.result === "contradicts");
                if (contradictions.some(a => !applications.some(b => b.id === a.id) || !counterexampleDisposed(snapshot, p.lesson_ref, a) || review.updated_sequence <= a.updated_sequence))
                    return failure("invalid_transition", "Every counterexample requires explicit disposition and a fresh review");
                if (snapshot.objects.some(r => r.kind === "challenge" && sameRef(r.body.target, p.lesson_ref) && (!r.body.resolution || r.body.resolution.resolution === "upheld")))
                    return failure("invalid_transition", "Open or upheld lesson challenge prevents support");
            }
            return plan([make(snapshot, facts, "assessment", { invocation_id: invocation.id, lesson_ref: p.lesson_ref, assessment })], [{ kind: "object", object_id: lesson.id }]);
        }
        case "organize_domain": {
            const c = command.payload.change;
            if (c.kind === "create")
                return plan([make(snapshot, facts, "domain", { invocation_id: invocation.id, title: c.title, questions: c.questions, audience: c.audience, overview: c.overview, overview_author: actorIdentity(facts.actor), retired: false, primary_publication_ids: [], change_kind: "create" })], [{ kind: "overview" }]);
            if (c.kind === "move") {
                const publication = exact(snapshot, c.publication_ref, "publication"), from = current(snapshot, c.from_domain, "domain"), to = current(snapshot, c.to_domain, "domain");
                if (!publication || !from || !to)
                    return failure("not_found", "Publication or domain not found");
                if (!mayReadObject(snapshot, facts.actor, from, facts.now) || !mayReadObject(snapshot, facts.actor, to, facts.now))
                    return failure("not_authorized", "Moving a publication requires current read access to both domains");
                if (from.id === to.id || from.body.retired || to.body.retired || !domainEntries(snapshot, from.id).includes(publication.id))
                    return failure("invalid_transition", "Move requires distinct active domains and current primary ownership");
                return plan([make(snapshot, facts, "domain", { ...from.body, change_kind: "move", change_reason: c.reason, primary_publication_ids: domainEntries(snapshot, from.id).filter(id => id !== publication.id) }, from), make(snapshot, facts, "domain", { ...to.body, change_kind: "move", change_reason: c.reason, primary_publication_ids: [...domainEntries(snapshot, to.id), publication.id] }, to)], [{ kind: "reading", domain_id: from.id }, { kind: "reading", domain_id: to.id }]);
            }
            const domain = current(snapshot, c.domain_ref.object_id, "domain");
            if (!domain)
                return failure("not_found", "Domain not found");
            if (domain.object_revision !== c.domain_ref.object_revision)
                return failure("object_changed", "Domain definition or ownership changed");
            if (domain.body.retired)
                return failure("invalid_transition", "Domain is retired");
            if (c.kind === "revise") {
                const { change_reason: _priorReason, ...body } = domain.body;
                return plan([make(snapshot, facts, "domain", { ...body, title: c.title, questions: c.questions, audience: c.audience, overview: c.overview, overview_author: actorIdentity(facts.actor), change_kind: "revise" }, domain)], [{ kind: "reading", domain_id: domain.id }]);
            }
            const entries = domainEntries(snapshot, domain.id);
            if (c.kind === "retire") {
                const successor = current(snapshot, c.successor_id, "domain");
                if (!successor || successor.body.retired || successor.id === domain.id)
                    return failure("invalid_input", "Retirement requires a different active successor");
                if (!mayReadObject(snapshot, facts.actor, successor, facts.now))
                    return failure("not_authorized", "Successor domain requires current read permission");
                return plan([make(snapshot, facts, "domain", { ...domain.body, change_kind: "retire", change_reason: c.reason, retired: true, successor_id: successor.id, primary_publication_ids: [] }, domain), make(snapshot, facts, "domain", { ...successor.body, change_kind: "retire", change_reason: c.reason, primary_publication_ids: [...domainEntries(snapshot, successor.id), ...entries] }, successor)], [{ kind: "reading", domain_id: domain.id }, { kind: "reading", domain_id: successor.id }]);
            }
            const keys = c.new_domains.map(d => d.key), assignments = c.entry_assignments;
            if (keys.length < 2 || new Set(keys).size !== keys.length || assignments.length !== entries.length || new Set(assignments.map(a => a.publication_ref.object_id)).size !== entries.length || assignments.some(a => !entries.includes(a.publication_ref.object_id) || !keys.includes(a.domain_key) || !exact(snapshot, a.publication_ref, "publication")))
                return failure("invalid_input", "Split must assign every current publication exactly once to a unique new domain key");
            const domains = c.new_domains.map(d => make(snapshot, facts, "domain", { invocation_id: invocation.id, title: d.title, questions: d.questions, audience: d.audience, overview: d.overview, overview_author: actorIdentity(facts.actor), change_kind: "split", change_reason: c.reason, retired: false, primary_publication_ids: assignments.filter(a => a.domain_key === d.key).map(a => a.publication_ref.object_id) }));
            const result = plan([...domains, make(snapshot, facts, "domain", { ...domain.body, change_kind: "split", change_reason: c.reason, retired: true, primary_publication_ids: [] }, domain)], [{ kind: "reading", domain_id: domain.id }, ...domains.map(d => ({ kind: "reading" as const, domain_id: d.id }))]);
            return result.ok ? success({ ...result.value, result: { ...result.value.result, ids: Object.fromEntries(keys.map((key, i) => [key, domains[i]!.id])) } }) : result;
        }
        default: return failure("invalid_input", "Unknown Learning action");
    }
}
function validateReferences(snapshot: Snapshot, value: unknown, facts: TrustedFacts): Result<true> {
    if (!value || typeof value !== "object")
        return success(true);
    if (Array.isArray(value)) {
        for (const item of value) {
            const checked = validateReferences(snapshot, item, facts);
            if (!checked.ok)
                return checked;
        }
        return success(true);
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "object") {
        const object = objectAt(snapshot, candidate as ObjectRef);
        if (!object)
            return failure("not_found", "Exact referenced object is unavailable");
        if (!mayReadObject(snapshot, facts.actor, object, facts.now))
            return failure("not_authorized", "Referenced object is outside the current read grant");
    }
    else if (candidate.kind === "source") {
        if (!snapshot.bindings.some(b => b.bindingId === candidate.binding_id && b.active))
            return failure("not_found", "Source binding is unavailable");
    }
    else if (candidate.kind === "native_event") {
        if (![...(facts.observedEventRefs ?? []), ...(facts.nativeMembers ?? []).map(m => m.creationRef)].some(ref => ref.kind === "native_event" && ref.session_id === candidate.session_id && ref.event_seq === candidate.event_seq))
            return failure("not_found", "Native event has not been verified by the Adapter");
    }
    else if (candidate.kind === "native_task") {
        if (!facts.nativeTaskRefs?.some(ref => ref.root_session_id === candidate.root_session_id && ref.task_id === candidate.task_id && ref.task_revision === candidate.task_revision))
            return failure("not_found", "Native task revision has not been verified by the Adapter");
    }
    else if (candidate.kind === "external" && candidate.snapshot_ref) {
        if (objectAt(snapshot, candidate.snapshot_ref as ObjectRef)?.kind !== "artifact")
            return failure("invalid_input", "External snapshot must be an artifact");
    }
    for (const item of Object.values(candidate)) {
        const checked = validateReferences(snapshot, item, facts);
        if (!checked.ok)
            return checked;
    }
    return success(true);
}
export function applyLearning(snapshot: Snapshot, command: LearnCommand, facts: TrustedFacts): Result<MutationPlan> {
    const decoded = decodeLearnCommand(command);
    if (!decoded.ok)
        return decoded;
    const authorized = authorizeCommand(snapshot, decoded.value, facts);
    if (!authorized.ok)
        return authorized;
    const checked = validateReferences(snapshot, decoded.value.payload, facts);
    if (!checked.ok)
        return checked;
    const result = reduceLearning(snapshot, decoded.value, facts);
    if (!result.ok)
        return result;
    const allocated = new Set<string>();
    for (const record of result.value.upserts) {
        const prior = snapshot.objects.find(r => r.id === record.id);
        if (!record.id || allocated.has(record.id) || prior && (prior.kind !== record.kind || record.object_revision !== prior.object_revision + 1))
            return failure("invalid_input", "Program allocated duplicate or inconsistent object identities");
        allocated.add(record.id);
    }
    if (result.value.upserts.some(record => record.kind === "domain" || record.kind === "publication")) {
        const objects = [...snapshot.objects.filter(record => !allocated.has(record.id)), ...result.value.upserts];
        const domains = objects.filter((record): record is RecordOf<"domain"> => record.kind === "domain");
        const publications = objects.filter((record): record is RecordOf<"publication"> => record.kind === "publication");
        for (const domain of domains) {
            const ids = domain.body.primary_publication_ids ?? [];
            if (new Set(ids).size !== ids.length || domain.body.retired && ids.length || ids.some(id => !publications.some(publication => publication.id === id)))
                return failure("archive_corrupt", "Primary domain mapping contains duplicates, unknown entries or retired ownership");
        }
        for (const publication of publications) {
            const owners = domains.filter(domain => !domain.body.retired && (domain.body.primary_publication_ids?.includes(publication.id) ?? domain.id === publication.body.domain_id));
            if (owners.length !== 1)
                return failure("archive_corrupt", "Every publication must have exactly one active primary domain");
        }
    }
    return result;
}
export const Learning = { apply: applyLearning };
