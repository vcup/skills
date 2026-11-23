import { describe, expect, test } from "bun:test";
import { actorIdentity, ARCHIVE_FORMAT, type Actor, type Grant, type Snapshot, type RecordOf, type TrustedFacts } from "./contracts.ts";
import { authorizeCommand, hasRight, isAssignedReviewer, isCurrentMember, isLead, mayReadObject } from "./policy.ts";
const lead: Actor = {
    kind: "session", sessionId: "lead-session", rootSessionId: "root", workspaceRef: "workspace", callId: "call"
};
const member: Actor = {
    ...lead, sessionId: "member"
};
const replacement: Actor = {
    ...lead, sessionId: "replacement"
};
const reviewer: Actor = {
    ...lead, sessionId: "reviewer"
};
const owner: Actor = {
    kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote"
};
const invocation: RecordOf<"invocation"> = {
    format: ARCHIVE_FORMAT, kind: "invocation", id: "i", object_revision: 1, created_sequence: 1, updated_sequence: 1, author: actorIdentity(lead), body: {
        title: "T", goal: "G", deliverable: "D", subject: "S", constraints: "C", exclusions: "E", frame_revision: 1, lead: actorIdentity(lead), lifecycle: "active", coverage_ids: [], criterion_ids: [], lifecycle_history: []
    }
};
const attempt: RecordOf<"attempt"> = {
    format: ARCHIVE_FORMAT, kind: "attempt", id: "attempt", object_revision: 1, created_sequence: 1, updated_sequence: 1, author: actorIdentity(lead), body: {
        invocation_id: "i", question: "Q", baseline_refs: [], coverage_ids: [], difference_or_redundancy: "fresh", context_plan: {
            mode: "fresh", relevance: "R", exposure: "None"
        }, expected_output: "O", early_slice: "E", write_scope_claims: [], purpose: "produce", member_id: "member", progress: "planned", binding_history: []
    }
};
const reflection: RecordOf<"reflection"> = {
    format: ARCHIVE_FORMAT, kind: "reflection", id: "reflection", object_revision: 1, created_sequence: 1, updated_sequence: 1, author: actorIdentity(member), body: {
        invocation_id: "i", domain_id: "d", title: "T", problem: "P", actions_and_evidence: "E", judgment_change: "J", limits: "L", next_test: "N", fact_refs: [], retrospective: false, status: "draft"
    }
};
const ref = {
    kind: "object" as const, object_id: "reflection", object_revision: 1
};
const grants: Grant[] = [{
        id: "lead", subject: actorIdentity(lead), rights: ["read", "open"], scope: {
            kind: "project"
        }, revoked: false
    }, {
        id: "member", subject: actorIdentity(member), rights: ["member-submit"], scope: {
            kind: "attempt", attempt_id: "attempt"
        }, revoked: false
    }, {
        id: "reviewer", subject: actorIdentity(reviewer), rights: ["read", "review"], scope: {
            kind: "proposal", proposal_ref: ref
        }, revoked: false
    }];
function state(extra: Partial<Snapshot> = {}): Snapshot {
    return {
        archiveId: "a", projectId: "p", title: "P", revision: "a".repeat(40), sequence: 1, formatVersion: 2, rendererVersion: "v1", policy: {
            epoch: 1, paused: false, grants
        }, bindings: [], objects: [invocation, attempt, reflection], ...extra
    };
}
const facts = (actor: Actor): TrustedFacts => ({
    actor, now: 100, newId: k => `new-${k}`
});
describe("current actor and scope authorization", () => {
    test("lead role is not authority without a current grant", () => {
        expect(isLead(state(), lead, "i", 100)).toBe(true);
        expect(isLead(state({
            policy: {
                epoch: 2, paused: false, grants: []
            }
        }), lead, "i", 100)).toBe(false);
        expect(isLead(state(), member, "i", 100)).toBe(false);
    });
    test("open grants leadership only to own invocation, not all invocations", () => expect(isLead(state(), {
        ...lead, sessionId: "different"
    }, "i", 100)).toBe(false));
    test("model commands never inherit owner control authority", () => {
        const command = {
            action: "set_next" as const, payload: {
                invocation_id: "i", action: "Continue", intended_result: "Delivery", blockers: []
            }
        };
        expect(authorizeCommand(state(), command, facts(lead)).ok).toBe(true);
        expect(authorizeCommand(state(), command, facts(owner)).ok).toBe(false);
    });
    test("session callId changes do not change identity, root changes do", () => {
        expect(isLead(state(), {
            ...lead, callId: "retry"
        }, "i", 100)).toBe(true);
        expect(isLead(state(), {
            ...lead, rootSessionId: "another-root"
        }, "i", 100)).toBe(false);
    });
    test("expired or revoked parent invalidates all delegated grants", () => {
        const parent: Grant = {
            id: "parent", subject: actorIdentity(lead), rights: ["member-submit"], delegable_rights: ["member-submit"], scope: {
                kind: "project"
            }, revoked: false
        };
        const child: Grant = {
            ...grants[1]!, delegated_from: "parent"
        };
        const check = (p: Grant) => hasRight(state({
            policy: {
                epoch: 2, paused: false, grants: [p, child]
            }
        }), member, "member-submit", {
            kind: "attempt", attempt_id: "attempt"
        }, 100);
        expect(check(parent)).toBe(true);
        expect(check({
            ...parent, revoked: true
        })).toBe(false);
        expect(check({
            ...parent, expires_at: 100
        })).toBe(false);
        expect(check({
            ...parent, delegable_rights: []
        })).toBe(false);
    });
    test("delegation cycles fail rather than hang", () => {
        const a: Grant = {
            ...grants[1]!, id: "a", delegated_from: "b", delegable_rights: ["member-submit"]
        };
        const b: Grant = {
            ...a, id: "b", delegated_from: "a"
        };
        expect(hasRight(state({
            policy: {
                epoch: 1, paused: false, grants: [a, b]
            }
        }), member, "member-submit", {
            kind: "attempt", attempt_id: "attempt"
        }, 100)).toBe(false);
    });
    test("replace revokes old contribution/progress privilege even with old grant", () => {
        expect(isCurrentMember(state(), member, "i", 100, "attempt")).toBe(true);
        const changed = {
            ...attempt, body: {
                ...attempt.body, member_id: replacement.kind === "session" ? replacement.sessionId : ""
            }
        };
        const current = state({
            objects: [invocation, changed, reflection]
        });
        expect(isCurrentMember(current, member, "i", 100, "attempt")).toBe(false);
        expect(authorizeCommand(current, {
            action: "update_attempt", payload: {
                invocation_id: "i", attempt_id: "attempt", change: {
                    kind: "progress", state: "returned", reason: "Late"
                }
            }
        }, facts(member)).ok).toBe(false);
    });
    test("member may not promote a self report into external author or decide", () => {
        expect(authorizeCommand(state(), {
            action: "submit_contribution", payload: {
                invocation_id: "i", attempt_id: "attempt", summary: "S", artifact_refs: [], evidence_refs: [], limitations: "L", source: {
                    kind: "external", label: "Other", refs: []
                }
            }
        }, facts(member)).ok).toBe(false);
        expect(authorizeCommand(state(), {
            action: "decide", payload: {
                invocation_id: "i", target: ref, disposition: "accepted", reason: "R", evidence_refs: [], consequence: "C"
            }
        }, facts(member)).ok).toBe(false);
    });
    test("pause blocks new domain writes without withdrawing reads", () => {
        const paused = state({
            policy: {
                ...state().policy, paused: true
            }
        });
        expect(mayReadObject(paused, lead, invocation, 100)).toBe(true);
        expect(authorizeCommand(paused, {
            action: "set_next", payload: {
                invocation_id: "i", action: "X", intended_result: "Y", blockers: []
            }
        }, facts(lead)).ok).toBe(false);
    });
});
describe("review identity and version are exact", () => {
    test("explicit assignment supports nonauthor, never author", () => {
        expect(isAssignedReviewer(state(), reviewer, ref, 100)).toBe(true);
        const selfGrant = {
            ...grants[2]!, subject: actorIdentity(member)
        };
        expect(isAssignedReviewer(state({
            policy: {
                epoch: 2, paused: false, grants: [selfGrant]
            }
        }), member, ref, 100)).toBe(false);
    });
    test("project review ability is not a proposal assignment", () => {
        const broad: Grant = {
            ...grants[2]!, scope: {
                kind: "project"
            }
        };
        expect(isAssignedReviewer(state({
            policy: {
                epoch: 2, paused: false, grants: [broad]
            }
        }), reviewer, ref, 100)).toBe(false);
    });
    test("old review grant does not cover revised proposal", () => {
        const revised = {
            ...reflection, object_revision: 2
        };
        expect(isAssignedReviewer(state({
            objects: [invocation, attempt, revised], objectHistory: [reflection]
        }), reviewer, {
            ...ref, object_revision: 2
        }, 100)).toBe(false);
    });
    test("other invocations cannot borrow an assignment", () => expect(authorizeCommand(state(), {
        action: "record_finding", payload: {
            invocation_id: "other", kind: "risk", statement: "S", impact: "I", evidence_refs: [], coverage_ids: []
        }
    }, facts(reviewer)).ok).toBe(false));
});
test("exact lesson review assignment needs separate read access to the next invocation", () => {
    const lesson: RecordOf<"lesson"> = {
        ...reflection, kind: "lesson", id: "lesson", body: {
            invocation_id: "i", title: "L", trigger: "T", action: "A", supporting_refs: [], counterexamples: "C", applicability: {
                task_types: [], interface_versions: [], required_capabilities: []
            }, invalidation_condition: "I"
        }
    };
    const target = {
        kind: "object" as const, object_id: lesson.id, object_revision: 1
    };
    const next = {
        ...invocation, id: "next"
    };
    const assignment: Grant = {
        ...grants[2]!, scope: {
            kind: "proposal", proposal_ref: target
        }
    };
    const command = {
        action: "record_check" as const, payload: {
            invocation_id: "next", check: {
                kind: "execution" as const, target, criterion_ids: [], method: "Unseen case", action: "Actually test", result: "passed" as const, evidence_refs: [], limits: "Controlled case"
            }
        }
    };
    const initial = state({
        objects: [invocation, next, lesson], policy: {
            epoch: 1, paused: false, grants: [assignment]
        }
    });
    expect(authorizeCommand(initial, command, facts(reviewer)).ok).toBe(false);
    const read: Grant = {
        id: "next-read", subject: actorIdentity(reviewer), scope: {
            kind: "invocation", invocation_id: "next"
        }, rights: ["read"], revoked: false
    };
    expect(authorizeCommand({
        ...initial, policy: {
            ...initial.policy, grants: [assignment, read]
        }
    }, command, facts(reviewer)).ok).toBe(true);
});
