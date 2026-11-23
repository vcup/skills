/** Independent production acceptance. These assertions are requirements, not expected-failure tests.
 * Seams: coordination/learning public reducers, current-policy query, and persisted codec.
 * The harness only applies returned MutationPlans; it does not implement domain decisions.
 */
import { describe, expect, test } from "bun:test";
import * as C from "./contracts.ts";
import { applyCoordination } from "./coordination.ts";
import { applyLearning } from "./learning.ts";
import { querySnapshot } from "./query.ts";
import { decodeSnapshot, decodeWorkCommand } from "./codec.ts";
import { hasRight } from "./policy.ts";

type SessionActor = Extract<C.Actor, { kind: "session" }>;
const lead: SessionActor = { kind: "session", sessionId: "lead", rootSessionId: "root", workspaceRef: "workspace", callId: "call" };
const member: SessionActor = { ...lead, sessionId: "member" };
const reviewer: SessionActor = { ...lead, sessionId: "reviewer" };
const second: SessionActor = { ...lead, sessionId: "second" };
const reader: SessionActor = { ...lead, sessionId: "reader" };
const evidence: C.Ref = { kind: "reported", statement: "Fixture observation; no native verification claim", source_label: "independent acceptance", supporting_refs: [] };
const ref = (record: C.DomainRecord): C.ObjectRef => ({ kind: "object", object_id: record.id, object_revision: record.object_revision });
const frame: C.OpenPayload = {
  title: "Complete delivery", goal: "Meet both safety and functional requirements", deliverable: "Verified candidate", subject: "Production", constraints: "No silent scope reduction", exclusions: "No unrelated edits",
  coverage: [{ key: "delivery", title: "Delivery", requirement: "All requested behavior", required: true, authority_refs: [] }],
  criteria: ["functional", "safety"].map(key => ({ key, coverage_targets: [{ kind: "request_key" as const, key: "delivery" }], statement: `${key} verified`, critical: true, method: "independent observation" })),
};
function rejected(result: C.Result<unknown>, code?: C.FailureCode) {
  expect(result.ok).toBe(false);
  if (!result.ok && code) expect(result.error.code).toBe(code);
}
function value<T>(result: C.Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
class Journey {
  id = 0;
  snapshot: C.Snapshot = {
    archiveId: "archive", projectId: "project", title: "Acceptance", revision: "0".repeat(40), sequence: 0, formatVersion: 2, rendererVersion: "1",
    policy: { epoch: 1, paused: false, grants: [
      { id: "lead", subject: C.actorIdentity(lead), scope: { kind: "project" }, rights: ["open", "read", "organize"], delegable_rights: ["member-submit"], revoked: false },
      ...[member, reviewer, second].map(actor => ({ id: `read-${C.actorKey(actor)}`, subject: C.actorIdentity(actor), scope: { kind: "project" as const }, rights: ["read" as const], revoked: false })),
    ] },
    bindings: [{ bindingId: "source", worldIdentity: "container", canonicalAddress: "/source", nativeWorkspaceRef: "workspace", active: true }], objects: [],
  };
  facts(actor = lead): C.TrustedFacts {
    return { actor, now: 100, newId: kind => `${kind}-${++this.id}`, nativeMembers: [member, reviewer, second].map((a, i) => ({ sessionId: a.sessionId, rootSessionId: a.rootSessionId, name: a.sessionId, contextMode: "fresh", creationRef: { kind: "native_event", session_id: "root", event_seq: i + 1 } })) };
  }
  try(command: C.DomainCommand, actor = lead): C.Result<C.MutationPlan> {
    return C.LEARN_ACTIONS.includes(command.action as typeof C.LEARN_ACTIONS[number])
      ? applyLearning(this.snapshot, command as C.LearnCommand, this.facts(actor))
      : applyCoordination(this.snapshot, command as C.WorkCommand, this.facts(actor));
  }
  run(command: C.DomainCommand, actor = lead): C.MutationPlan {
    const plan = value(this.try(command, actor)), changed = new Set(plan.upserts.map(o => o.id));
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence, revision: sequence.toString(16).padStart(40, "0"), policy: plan.policy ?? this.snapshot.policy,
      objects: [...this.snapshot.objects.filter(o => !changed.has(o.id)), ...plan.upserts],
      objectHistory: [...this.snapshot.objectHistory ?? [], ...this.snapshot.objects.filter(o => changed.has(o.id))] };
    value(decodeSnapshot(this.snapshot));
    return plan;
  }
  get<K extends C.ObjectKind>(kind: K, id?: string): C.RecordOf<K> {
    const record = this.snapshot.objects.find(o => o.kind === kind && (id === undefined || id === o.id));
    if (!record) throw new Error(`Missing ${kind} ${id}`);
    return record as C.RecordOf<K>;
  }
  created<K extends C.ObjectKind>(plan: C.MutationPlan, kind: K): C.RecordOf<K> {
    const record = plan.upserts.find(o => o.kind === kind);
    if (!record) throw new Error(`No returned ${kind}`);
    return record as C.RecordOf<K>;
  }
  grant(actor: C.Actor, rights: C.Right[], scope: C.GrantScope, id = `owner-grant-${++this.id}`) {
    this.snapshot = { ...this.snapshot, policy: { ...this.snapshot.policy, epoch: this.snapshot.policy.epoch + 1, grants: [...this.snapshot.policy.grants, { id, subject: C.actorIdentity(actor), rights, scope, revoked: false }] } };
    return id;
  }
  revoke(id: string) {
    this.snapshot = { ...this.snapshot, policy: { ...this.snapshot.policy, epoch: this.snapshot.policy.epoch + 1, grants: this.snapshot.policy.grants.map(g => g.id === id ? { ...g, revoked: true } : g) } };
  }
  open() { return this.created(this.run({ action: "open", payload: frame }), "invocation").id; }
  attempt(invocation_id: string, actor = member) {
    return this.created(this.run({ action: "plan_attempt", payload: { invocation_id, question: "Exercise behavior", baseline_refs: [evidence], coverage_ids: this.get("invocation", invocation_id).body.coverage_ids, difference_or_redundancy: "Fresh reviewer", context_plan: { mode: "fresh", relevance: "Independent case", exposure: "Requirement only" }, expected_output: "Evidence", early_slice: "First observation", write_scope_claims: [], purpose: "produce", member_id: actor.sessionId } }), "attempt");
  }
  candidate(invocation_id: string, baseline = "candidate-1") {
    return this.created(this.run({ action: "set_candidate", payload: { invocation_id, source_ref: { kind: "source", binding_id: "source", source_handle: "tree", baseline }, description: baseline, dirty: false } }), "candidate");
  }
  check(invocation_id: string, target: C.ObjectRef, result: C.CheckResult = "passed", actor = lead, criterion_ids = this.get("invocation", invocation_id).body.criterion_ids) {
    return this.created(this.run({ action: "record_check", payload: { invocation_id, check: { kind: "execution", target, criterion_ids, method: "Run checks", action: "Inspect actual result", result, evidence_refs: [evidence], limits: "Fixture only" } } }, actor), "check");
  }
}
function ready() {
  const h = new Journey(), invocation_id = h.open(), candidate = h.candidate(invocation_id);
  const finding = h.created(h.run({ action: "record_finding", payload: { invocation_id, kind: "opportunity", statement: "Verified result meets coverage", impact: "Ready for decision", evidence_refs: [evidence], coverage_ids: h.get("invocation", invocation_id).body.coverage_ids } }), "finding");
  const decide = () => h.created(h.run({ action: "decide", payload: { invocation_id, target: ref(finding), disposition: "accepted", reason: "Review evidence", evidence_refs: [evidence], consequence: "Use result" } }), "decision");
  let decision = decide();
  const completion = (checks: C.ObjectRef[]): C.WorkCommand => ({ action: "set_lifecycle", payload: { invocation_id, transition: "complete", reason: "All criteria met", evidence_refs: [evidence], completion: { candidate_ref: h.get("invocation", invocation_id).body.candidate_ref!, coverage: h.get("invocation", invocation_id).body.coverage_ids.map(coverage_id => ({ coverage_id, decision_refs: [ref(decision)], check_refs: checks })) } } });
  return { h, invocation_id, candidate, completion, redecide: () => { decision = decide(); } };
}
function resolution(h: Journey, invocation_id: string, target: C.ObjectRef, conflict: C.ObjectRef, conclusion: "invalid_observation" | "still_failing") {
  return h.run({ action: "record_check", payload: { invocation_id, check: { kind: "resolution", target, criterion_ids: h.get("invocation", invocation_id).body.criterion_ids, conflicting_check_refs: [conflict], conclusion, replacement_check_refs: [], rationale: "Disposition based on separate observation", evidence_refs: [evidence] } } });
}
function applicability(h: Journey, invocation_id: string, prior: C.ObjectRef, target: C.ObjectRef) {
  return h.created(h.run({ action: "record_check", payload: { invocation_id, check: { kind: "applicability", prior_check: prior, current_target: target, criterion_ids: h.get("invocation", invocation_id).body.criterion_ids, scope: "Both criteria", rationale: "Changed documentation only", impact_refs: [evidence] } } }), "check");
}

describe("independent completion acceptance", () => {
  test("complete requires every critical criterion and preserves reported provenance", () => {
    const d = ready(), ids = d.h.get("invocation").body.criterion_ids;
    const first = d.h.check(d.invocation_id, ref(d.candidate), "passed", lead, [ids[0]!]);
    rejected(d.h.try(d.completion([ref(first)])), "invalid_transition");
    const secondCheck = d.h.check(d.invocation_id, ref(d.candidate), "passed", lead, [ids[1]!]);
    d.h.run(d.completion([ref(first), ref(secondCheck)]));
    expect(d.h.get("invocation").body.lifecycle).toBe("completed");
    expect(first.body.provenance).toBe("reported");
  });
  test("new candidate never inherits old checks and a later pass does not erase still_failing", () => {
    const d = ready(), old = d.h.check(d.invocation_id, ref(d.candidate));
    const next = d.h.candidate(d.invocation_id, "candidate-2"); d.redecide();
    rejected(d.h.try(d.completion([ref(old)])), "object_changed");
    const reused = applicability(d.h, d.invocation_id, ref(old), ref(next));
    const failure = d.h.check(d.invocation_id, ref(next), "failed");
    resolution(d.h, d.invocation_id, ref(next), ref(failure), "still_failing");
    const pass = d.h.check(d.invocation_id, ref(next));
    rejected(d.h.try(d.completion([ref(reused), ref(pass)])), "invalid_transition");
    resolution(d.h, d.invocation_id, ref(next), ref(failure), "invalid_observation");
    d.h.run(d.completion([ref(pass)]));
  });
  test("invalid_observation cannot be resurrected by applicability on a later candidate", () => {
    const d = ready(), invalid = d.h.check(d.invocation_id, ref(d.candidate));
    resolution(d.h, d.invocation_id, ref(d.candidate), ref(invalid), "invalid_observation");
    rejected(d.h.try(d.completion([ref(invalid)])), "invalid_transition");
    const next = d.h.candidate(d.invocation_id, "candidate-2"); d.redecide();
    const request: C.WorkCommand = { action: "record_check", payload: { invocation_id: d.invocation_id, check: { kind: "applicability", prior_check: ref(invalid), current_target: ref(next), criterion_ids: d.h.get("invocation").body.criterion_ids, scope: "Both criteria", rationale: "Same implementation", impact_refs: [evidence] } } };
    const reused = d.h.try(request);
    if (!reused.ok) return; // Rejecting reuse at admission is also safe.
    const accepted = d.h.created(d.h.run(request), "check");
    rejected(d.h.try(d.completion([ref(accepted)])), "invalid_transition");
  });
  test("critical challenge cannot be superseded by applicability derived from that challenged observation", () => {
    const d = ready(), pass = d.h.check(d.invocation_id, ref(d.candidate));
    const derived = applicability(d.h, d.invocation_id, ref(pass), ref(d.candidate));
    const challenge = d.h.created(d.h.run({ action: "record_challenge", payload: { invocation_id: d.invocation_id, target: ref(pass), statement: "Observation did not execute the asserted check", contradicting_refs: [evidence], impact: "Both completion criteria unsupported" } }), "challenge");
    const supersede: C.WorkCommand = { action: "resolve_challenge", payload: { invocation_id: d.invocation_id, challenge_id: challenge.id, resolution: "superseded", reason: "Use derived check", evidence_refs: [], replacement_ref: ref(derived) } };
    const outcome = d.h.try(supersede);
    if (!outcome.ok) return;
    d.h.run(supersede);
    rejected(d.h.try(d.completion([ref(derived)])), "invalid_transition");
  });
});

function lesson(h: Journey, invocation_id: string) {
  return h.created(h.run({ action: "propose_lesson", payload: { invocation_id, title: "Inspect evidence", trigger: "Before completion", action: "Read the exact observation", supporting_refs: [evidence], counterexamples: "Reported output may be wrong", applicability: { task_types: ["review"], interface_versions: ["v1"], required_capabilities: ["read"] }, invalidation_condition: "Evidence unavailable" } }), "lesson");
}
function application(invocation_id: string, target: C.ObjectRef, attempt_id: string): C.LearnCommand {
  return { action: "assess_lesson", payload: { invocation_id, lesson_ref: target, assessment: { kind: "application", invocation_id, attempt_id, context: "Previously unseen case", action_taken: "Applied exact evidence rule", result: "supports", case_kind: "unseen", check_refs: [], limits: "One case" } } };
}
describe("independent current authorization acceptance", () => {
  test("revoking an ancestor removes delegated member rights and old-history reads", () => {
    const h = new Journey(), invocation_id = h.open(), a = h.attempt(invocation_id);
    expect(hasRight(h.snapshot, member, "member-submit", { kind: "attempt", attempt_id: a.id }, 100)).toBe(true);
    const old = h.get("invocation", invocation_id);
    h.run({ action: "set_next", payload: { invocation_id, action: "Inspect result", intended_result: "Evidence", blockers: [] } });
    expect(h.get("invocation", invocation_id).object_revision).toBe(old.object_revision + 1);
    h.revoke("lead");
    expect(hasRight(h.snapshot, member, "member-submit", { kind: "attempt", attempt_id: a.id }, 100)).toBe(false);
    h.grant(reader, ["read"], { kind: "proposal", proposal_ref: ref(old) }, "reader");
    expect(querySnapshot(h.snapshot, { kind: "object", object_id: old.id, object_revision: old.object_revision }, { actor: reader, now: 100 }).ok).toBe(true);
    h.revoke("reader");
    rejected(querySnapshot(h.snapshot, { kind: "object", object_id: old.id, object_revision: old.object_revision }, { actor: reader, now: 100 }), "not_authorized");
  });
  test("another live attempt must not revive a revoked attempt's lesson application authority", () => {
    const h = new Journey(), invocation_id = h.open(), a = h.attempt(invocation_id), advice = lesson(h, invocation_id);
    h.attempt(invocation_id); // The same member retains valid rights on a distinct attempt.
    const scoped = h.snapshot.policy.grants.find(g => g.scope.kind === "attempt" && g.scope.attempt_id === a.id)!;
    h.revoke(scoped.id);
    expect(hasRight(h.snapshot, member, "member-submit", { kind: "attempt", attempt_id: a.id }, 100)).toBe(false);
    rejected(h.try(application(invocation_id, ref(advice), a.id), member), "not_authorized");
  });
});

function publicationDraft(h: Journey, invocation_id: string, domain_id: string, reflection_id?: string, fact_refs: C.Ref[] = []): C.LearnCommand {
  return { action: "propose_reflection", payload: { invocation_id, domain_id, title: "Exact evidence matters", problem: "Claims outlive observations", actions_and_evidence: "Check the original record", judgment_change: "Separate versions", limits: "Local evidence only", next_test: "New independent case", fact_refs, retrospective: false, ...(reflection_id ? { reflection_id } : {}) } };
}
function publicationSetup() {
  const h = new Journey(), invocation_id = h.open(); h.attempt(invocation_id);
  const domain = h.created(h.run({ action: "organize_domain", payload: { invocation_id, change: { kind: "create", title: "Evidence", questions: "What actually happened?", audience: "Maintainers", overview: "Inspect exact sources" } } }), "domain");
  const draft = h.created(h.run(publicationDraft(h, invocation_id, domain.id), member), "reflection");
  const review = (target: C.ObjectRef, verdict: C.ReviewPayload["verdict"], findings: C.ReviewFinding[] = []): C.LearnCommand => ({ action: "review_reflection", payload: { invocation_id, proposal_ref: target, verdict, findings, evidence_refs: [evidence] } });
  const publish = (target: C.ObjectRef, reviews: C.ObjectRef[]): C.LearnCommand => ({ action: "publish_reflection", payload: { invocation_id, proposal_ref: target, review_refs: reviews } });
  const assign = (actor: C.Actor, target: C.ObjectRef) => h.grant(actor, ["read", "review"], { kind: "proposal", proposal_ref: target });
  return { h, invocation_id, domain, draft, review, publish, assign };
}
describe("independent publication acceptance", () => {
  test("review needs exact assignment, current draft and current grant at publication", () => {
    const d = publicationSetup();
    d.h.grant(reviewer, ["review"], { kind: "project" });
    rejected(d.h.try(d.review(ref(d.draft), "approve"), reviewer), "not_authorized");
    d.assign(member, ref(d.draft));
    rejected(d.h.try(d.review(ref(d.draft), "approve"), member), "not_authorized");
    const grant = d.assign(reviewer, ref(d.draft));
    const oldReview = d.h.created(d.h.run(d.review(ref(d.draft), "approve"), reviewer), "review");
    d.h.revoke(grant);
    rejected(d.h.try(d.publish(ref(d.draft), [ref(oldReview)])));
    const revised = d.h.created(d.h.run(publicationDraft(d.h, d.invocation_id, d.domain.id, d.draft.id), member), "reflection");
    rejected(d.h.try(d.review(ref(revised), "approve"), reviewer), "not_authorized");
    d.assign(reviewer, ref(revised));
    rejected(d.h.try(d.publish(ref(revised), [ref(oldReview)])));
    const newReview = d.h.created(d.h.run(d.review(ref(revised), "approve"), reviewer), "review");
    const published = d.h.created(d.h.run(d.publish(ref(revised), [ref(newReview)])), "publication");
    expect(published.body.proposal_ref).toEqual(ref(revised));
    rejected(d.h.try(publicationDraft(d.h, d.invocation_id, d.domain.id, d.draft.id), member), "invalid_transition");
  });
  test("revocation and a different approve cannot drop a blocker across a draft revision", () => {
    const d = publicationSetup();
    const assigned = d.assign(reviewer, ref(d.draft)); d.assign(second, ref(d.draft));
    const blocked = d.h.created(d.h.run(d.review(ref(d.draft), "reject", [{ statement: "Missing counterexample", blocking: true, evidence_refs: [evidence] }]), reviewer), "review");
    d.h.revoke(assigned);
    const revised = d.h.created(d.h.run(publicationDraft(d.h, d.invocation_id, d.domain.id, d.draft.id), member), "reflection");
    d.assign(second, ref(revised));
    const approved = d.h.created(d.h.run(d.review(ref(revised), "approve"), second), "review");
    rejected(d.h.try(d.publish(ref(revised), [ref(approved)])), "invalid_transition");
    const finding = blocked.body.findings[0]!;
    const answer: C.ReviewFinding = { id: finding.id!, statement: "Counterexample examined", blocking: false, evidence_refs: [evidence] };
    rejected(d.h.try(d.review(ref(revised), "approve", [answer]), second), "not_authorized");
    d.h.snapshot = { ...d.h.snapshot, policy: { ...d.h.snapshot.policy, epoch: d.h.snapshot.policy.epoch + 1, reviewer_reassignments: [{ proposalId: revised.id, findingId: finding.id!, reviewer: C.actorIdentity(second) }] } };
    const replacement = d.h.created(d.h.run(d.review(ref(revised), "approve", [answer]), second), "review");
    d.h.run(d.publish(ref(revised), [ref(replacement)]));
  });
  test("reviewed correction cannot silently become withdrawal or alter the original text", () => {
    const d = publicationSetup(); d.assign(reviewer, ref(d.draft));
    const approved = d.h.created(d.h.run(d.review(ref(d.draft), "approve"), reviewer), "review");
    const original = d.h.created(d.h.run(d.publish(ref(d.draft), [ref(approved)])), "publication");
    const draftCommand = publicationDraft(d.h, d.invocation_id, d.domain.id);
    if (draftCommand.action !== "propose_reflection") throw Error("wrong command");
    const amendment = d.h.created(d.h.run({ ...draftCommand, payload: { ...draftCommand.payload, amendment: { target: ref(original), mode: "correct", reason: "Narrow the claim" } } }, member), "reflection");
    d.assign(reviewer, ref(amendment));
    const reviewed = d.h.created(d.h.run(d.review(ref(amendment), "approve"), reviewer), "review");
    const command: C.LearnCommand = { action: "amend_publication", payload: { invocation_id: d.invocation_id, target: ref(original), proposal_ref: ref(amendment), review_refs: [ref(reviewed)], reason: "Narrow the claim", mode: "withdraw" } };
    rejected(d.h.try(command), "invalid_input");
    d.h.run({ ...command, payload: { ...command.payload, mode: "correct" } });
    expect(d.h.get("reflection", d.draft.id)).toEqual(d.draft);
    expect(d.h.get("publication", original.id)).toEqual(original);
  });
});

describe("independent private evidence and bounded reads", () => {
  test("private counterexample revokes recommendation without disclosing its content or identity", () => {
    const h = new Journey(), publicWork = h.open(), advice = lesson(h, publicWork);
    const privateWork = h.open(), attempt = h.attempt(privateWork);
    h.grant(reviewer, ["review"], { kind: "proposal", proposal_ref: ref(advice) });
    const reviewed = h.check(privateWork, ref(advice), "passed", reviewer);
    const report = application(privateWork, ref(advice), attempt.id);
    if (report.action !== "assess_lesson" || report.payload.assessment.kind !== "application") throw Error();
    const supporting = h.created(h.run({ ...report, payload: { ...report.payload, assessment: { ...report.payload.assessment, check_refs: [ref(reviewed)] } } }, member), "application");
    h.run({ action: "assess_lesson", payload: { invocation_id: privateWork, lesson_ref: ref(advice), assessment: { kind: "decision", status: "supported", reason: "Independent unseen application", application_refs: [ref(supporting)], review_ref: ref(reviewed) } } });
    h.grant(reader, ["read"], { kind: "invocation", invocation_id: publicWork });
    const query: C.Query = { kind: "lessons", task_context: advice.body.applicability };
    const facts: C.QueryFacts = { actor: reader, now: 100 };
    expect(value(querySnapshot(h.snapshot, query, facts)).items).toHaveLength(1);
    const contrary = h.created(h.run({ ...report, payload: { ...report.payload, assessment: { ...report.payload.assessment, context: "PRIVATE-CONTEXT-DO-NOT-LEAK", result: "contradicts", limits: "PRIVATE-LIMIT-DO-NOT-LEAK" } } }, member), "application");
    expect(value(querySnapshot(h.snapshot, query, facts)).items).toHaveLength(0);
    const contested = value(querySnapshot(h.snapshot, { ...query, status: "contested" }, facts));
    expect(contested.items).toHaveLength(1);
    const item = contested.items[0]!;
    expect("status" in item && item.status).toBe("contested");
    expect(JSON.stringify(contested)).not.toContain("PRIVATE-");
    expect(JSON.stringify(contested)).not.toContain(contrary.id);
    rejected(querySnapshot(h.snapshot, { kind: "object", object_id: contrary.id }, facts), "not_found");
    const dependency: C.LearnCommand = { action: "propose_lesson", payload: { ...advice.body, supporting_refs: [ref(contrary)] } };
    const actorGrant = h.grant(reader, ["lead"], { kind: "invocation", invocation_id: publicWork });
    // A real lead with restricted reads must also fail when referencing private evidence.
    const restricted = { ...h.snapshot, policy: { ...h.snapshot.policy, grants: h.snapshot.policy.grants.filter(g => g.id !== "lead" && g.id !== actorGrant).concat([{ id: "restricted-lead", subject: C.actorIdentity(lead), scope: { kind: "invocation", invocation_id: publicWork }, rights: ["lead", "read"], revoked: false }]) } };
    rejected(applyLearning(restricted, dependency, h.facts(lead)), "not_authorized");
  });
  test("multi-page UTF-8 text reassembles exact generated prose and revoked continuation fails", () => {
    const h = new Journey(), invocation_id = h.open();
    const advice = lesson(h, invocation_id);
    const long = h.created(h.run({ action: "propose_lesson", payload: { ...advice.body, lesson_id: advice.id, counterexamples: "限制中文😀é".repeat(200) } }), "lesson");
    h.grant(reader, ["read"], { kind: "proposal", proposal_ref: ref(long) }, "paged-read");
    const query: C.Query = { kind: "object", object_id: long.id, object_revision: long.object_revision, content_mode: "text" };
    const full = value(querySnapshot(h.snapshot, query, { actor: reader, now: 100, responseBytes: 32768, nextCursor: next => `pinned:${next}` }));
    const firstItem = full.items[0]!;
    if (!("kind" in firstItem) || firstItem.kind !== "object_content") throw Error("generated page required");
    let offset = 0, joined = "", rounds = 0;
    do {
      const result = value(querySnapshot(h.snapshot, { ...query, ...(offset ? { cursor: "archive-validated" } : {}) }, { actor: reader, now: 100, offset, responseBytes: 1100, nextCursor: next => `pinned:${next}` }));
      expect(new TextEncoder().encode(JSON.stringify({ ok: true, value: result })).byteLength).toBeLessThanOrEqual(1100);
      const item = result.items[0]!;
      if (!("kind" in item) || item.kind !== "object_content") throw Error("generated page required");
      expect(item.offset).toBe(offset); expect(item.text).not.toContain("�");
      joined += item.text; rounds++;
      if (item.next_offset === undefined) { expect(result.completeness).toBe("complete"); break; }
      expect(result.completeness).toBe("partial"); expect(item.next_offset).toBeGreaterThan(offset);
      offset = item.next_offset;
    } while (rounds < 100);
    expect(rounds).toBeGreaterThan(1); expect(rounds).toBeLessThan(100); expect(joined).toBe(firstItem.text!);
    h.revoke("paged-read");
    rejected(querySnapshot(h.snapshot, { ...query, cursor: "archive-validated" }, { actor: reader, now: 100, offset, nextCursor: n => `${n}` }), "not_authorized");
  });
});

test("closed codec rejects actor forgery, extra nested controls, null and malformed Unicode", () => {
  rejected(decodeWorkCommand({ action: "open", payload: { ...frame, author: "owner" } }), "invalid_input");
  rejected(decodeWorkCommand({ action: "open", payload: { ...frame, coverage: [{ ...frame.coverage[0], isVerified: true }] } }), "invalid_input");
  rejected(decodeWorkCommand({ action: "open", payload: null }), "invalid_input");
  rejected(decodeWorkCommand({ action: "open", payload: { ...frame, goal: String.fromCharCode(0xd800) } }), "invalid_input");
});

describe("independent check resolution ordering", () => {
  test("still_failing attached to a passing observation is still a critical blocker", () => {
    const d = ready(), pass = d.h.check(d.invocation_id, ref(d.candidate));
    resolution(d.h, d.invocation_id, ref(d.candidate), ref(pass), "still_failing");
    rejected(d.h.try(d.completion([ref(pass)])), "invalid_transition");
  });
  test("invalidating an observation also invalidates applicability recorded before the resolution", () => {
    const d = ready(), pass = d.h.check(d.invocation_id, ref(d.candidate));
    const reused = applicability(d.h, d.invocation_id, ref(pass), ref(d.candidate));
    resolution(d.h, d.invocation_id, ref(d.candidate), ref(pass), "invalid_observation");
    rejected(d.h.try(d.completion([ref(reused)])), "invalid_transition");
  });
  test("critical coverage cannot be removed merely by dropping it from completion", () => {
    const h = new Journey();
    const invocation = h.created(h.run({ action: "open", payload: { ...frame, coverage: [...frame.coverage, { key: "second", title: "Second requirement", requirement: "Keep independent second coverage", required: true, authority_refs: [] }], criteria: [...frame.criteria, { key: "second-check", coverage_targets: [{ kind: "request_key", key: "second" }], statement: "Second coverage verified", method: "Run", critical: true }] } }), "invocation");
    const target = h.candidate(invocation.id), pass = h.check(invocation.id, ref(target));
    const finding = h.created(h.run({ action: "record_finding", payload: { invocation_id: invocation.id, kind: "opportunity", statement: "All behavior inspected", impact: "Coverage satisfied", evidence_refs: [evidence], coverage_ids: invocation.body.coverage_ids } }), "finding");
    const decision = h.created(h.run({ action: "decide", payload: { invocation_id: invocation.id, target: ref(finding), disposition: "accepted", reason: "Evidence checked", evidence_refs: [evidence], consequence: "Use" } }), "decision");
    rejected(h.try({ action: "set_lifecycle", payload: { invocation_id: invocation.id, transition: "complete", reason: "Only report first coverage", evidence_refs: [evidence], completion: { candidate_ref: ref(target), coverage: [{ coverage_id: invocation.body.coverage_ids[0]!, decision_refs: [ref(decision)], check_refs: [ref(pass)] }] } } }), "invalid_input");
  });
});

test("a nested delegation cannot manufacture a read right outside its ancestor allowance", () => {
  const h = new Journey();
  const policy: C.PolicySnapshot = { epoch: 5, paused: false, grants: [
    { id: "owner-allowance", subject: C.actorIdentity(lead), scope: { kind: "project" }, rights: ["read"], delegable_rights: ["member-submit"], revoked: false },
    { id: "intermediate", subject: C.actorIdentity(member), scope: { kind: "project" }, rights: ["member-submit"], delegable_rights: ["read"], delegated_from: "owner-allowance", revoked: false },
    { id: "leaf", subject: C.actorIdentity(reader), scope: { kind: "project" }, rights: ["read"], delegated_from: "intermediate", revoked: false },
  ] };
  const snapshot = value(decodeSnapshot({ ...h.snapshot, policy }));
  expect(hasRight(snapshot, reader, "read", { kind: "project" }, 100)).toBe(false);
  rejected(querySnapshot(snapshot, { kind: "context" }, { actor: reader, now: 100 }), "not_authorized");
});

test("fresh execution can supersede a challenged check without losing the challenge history", () => {
  const d = ready(), old = d.h.check(d.invocation_id, ref(d.candidate));
  const challenge = d.h.created(d.h.run({ action: "record_challenge", payload: { invocation_id: d.invocation_id, target: ref(old), statement: "Check may have omitted a case", contradicting_refs: [evidence], impact: "Critical criteria require reassessment" } }), "challenge");
  const fresh = d.h.check(d.invocation_id, ref(d.candidate));
  d.h.run({ action: "resolve_challenge", payload: { invocation_id: d.invocation_id, challenge_id: challenge.id, resolution: "superseded", reason: "Fresh full execution covers omitted case", evidence_refs: [evidence], replacement_ref: ref(fresh) } });
  d.h.run(d.completion([ref(fresh)]));
  expect(d.h.get("challenge", challenge.id).body.resolution?.replacement_ref).toEqual(ref(fresh));
  expect(d.h.snapshot.objectHistory?.some(o => o.id === challenge.id && o.object_revision === 1)).toBe(true);
});

test("new frame invalidates old completion evidence and weakening a criterion needs owner approval", () => {
  const d = ready(), pass = d.h.check(d.invocation_id, ref(d.candidate));
  const coverage = d.h.get("coverage"), criteria = d.h.snapshot.objects.filter((r): r is C.RecordOf<"criterion"> => r.kind === "criterion");
  const requirements: C.Requirements = {
    coverage: [{ ...frame.coverage[0]!, id: coverage.id }],
    criteria: criteria.map(c => ({ id: c.id, key: c.body.key, statement: c.body.statement, method: c.body.method, critical: c.body.critical, coverage_targets: [{ kind: "existing_id", id: coverage.id }] })),
  };
  rejected(d.h.try({ action: "amend_frame", payload: { invocation_id: d.invocation_id, group: "requirements", rationale: "Skip safety", value: { ...requirements, criteria: requirements.criteria.map(c => ({ ...c, critical: false })) } } }), "not_authorized");
  d.h.run({ action: "amend_frame", payload: { invocation_id: d.invocation_id, group: "requirements", rationale: "Add separately visible optional work", value: { ...requirements, coverage: [...requirements.coverage, { key: "optional", title: "Optional", requirement: "Nice to have", required: false, authority_refs: [] }] } } });
  d.redecide();
  rejected(d.h.try(d.completion([ref(pass)])), "object_changed");
});

test("original-case repair cannot prove transfer and late old-version evidence cannot contaminate a new lesson", () => {
  const h = new Journey(), invocation_id = h.open(), advice = lesson(h, invocation_id), attempt = h.attempt(invocation_id);
  h.grant(reviewer, ["review"], { kind: "proposal", proposal_ref: ref(advice) });
  const checked = h.check(invocation_id, ref(advice), "passed", reviewer);
  const base = application(invocation_id, ref(advice), attempt.id);
  if (base.action !== "assess_lesson" || base.payload.assessment.kind !== "application") throw Error();
  const original = h.created(h.run({ ...base, payload: { ...base.payload, assessment: { ...base.payload.assessment, case_kind: "original", check_refs: [ref(checked)] } } }, member), "application");
  rejected(h.try({ action: "assess_lesson", payload: { invocation_id, lesson_ref: ref(advice), assessment: { kind: "decision", status: "supported", reason: "Original case repaired", application_refs: [ref(original)], review_ref: ref(checked) } } }), "invalid_transition");
  const revised = h.created(h.run({ action: "propose_lesson", payload: { ...advice.body, lesson_id: advice.id, counterexamples: "New narrower scope" } }), "lesson");
  h.run({ ...base, payload: { ...base.payload, assessment: { ...base.payload.assessment, result: "contradicts" } } }, member);
  const search = value(querySnapshot(h.snapshot, { kind: "lessons", status: "proposed", task_context: revised.body.applicability }, { actor: lead, now: 100 }));
  expect(search.items).toHaveLength(1);
  const item = search.items[0]!;
  expect("lesson" in item && item.lesson.object_revision).toBe(revised.object_revision);
  expect(value(querySnapshot(h.snapshot, { kind: "lessons", status: "contested", task_context: revised.body.applicability }, { actor: lead, now: 100 })).items).toHaveLength(0);
});

test("later invalidation of a superseding check cannot make the challenged original pass usable again", () => {
  const d = ready(), original = d.h.check(d.invocation_id, ref(d.candidate));
  const challenge = d.h.created(d.h.run({ action: "record_challenge", payload: { invocation_id: d.invocation_id, target: ref(original), statement: "Original pass lacks a required case", contradicting_refs: [evidence], impact: "Critical completion disputed" } }), "challenge");
  const replacement = d.h.check(d.invocation_id, ref(d.candidate));
  d.h.run({ action: "resolve_challenge", payload: { invocation_id: d.invocation_id, challenge_id: challenge.id, resolution: "superseded", reason: "Use fresh execution", evidence_refs: [evidence], replacement_ref: ref(replacement) } });
  resolution(d.h, d.invocation_id, ref(d.candidate), ref(replacement), "invalid_observation");
  rejected(d.h.try(d.completion([ref(original)])), "invalid_transition");
});
