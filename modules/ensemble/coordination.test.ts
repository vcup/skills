import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as C from "./contracts.ts";
import { applyCoordination } from "./coordination.ts";
import { decodeSnapshot } from "./codec.ts";
const lead: C.Actor = {
    kind: "session", sessionId: "lead", rootSessionId: "root", workspaceRef: "ws", callId: "call"
};
const worker: C.Actor = {
    ...lead, sessionId: "worker"
};
const other: C.Actor = {
    ...lead, sessionId: "other"
};
const observation: C.Ref = {
    kind: "reported", statement: "Observed test and inspected result", source_label: "fixture", supporting_refs: []
};
const creation: C.Ref = {
    kind: "native_event", session_id: "root", event_seq: 10
};
const member: C.NativeMember = {
    sessionId: "worker", rootSessionId: "root", name: "worker", contextMode: "fresh", creationRef: creation
};
const otherMember: C.NativeMember = {
    ...member, sessionId: "other", name: "other", creationRef: {
        kind: "native_event", session_id: "root", event_seq: 11
    }
};
const ref = (o: C.DomainRecord): C.ObjectRef => ({
    kind: "object", object_id: o.id, object_revision: o.object_revision
});
const frame: C.OpenPayload = {
    title: "Delivery", goal: "Complete requested work", deliverable: "Tested change", subject: "Feature", constraints: "Maintain compatibility", exclusions: "No unrelated changes", coverage: [{
            key: "feature", title: "Feature", requirement: "Implement requested behavior", required: true, authority_refs: []
        }], criteria: [{
            key: "test", coverage_targets: [{
                    kind: "request_key", key: "feature"
                }], statement: "Actual tests pass", critical: true, method: "run tests"
        }]
};
class Harness {
    sequence = 0;
    id = 0;
    snapshot: C.Snapshot = {
        archiveId: "a", projectId: "p", title: "P", revision: "a".repeat(40), sequence: 0, formatVersion: 2, rendererVersion: "v1", policy: {
            epoch: 1, paused: false, grants: [{
                    id: "lead-grant", subject: C.actorIdentity(lead), rights: ["read", "open"], scope: {
                        kind: "project"
                    }, revoked: false, delegable_rights: ["member-submit", "review"]
                }, {
                    id: "worker-read", subject: C.actorIdentity(worker), rights: ["read"], scope: {
                        kind: "project"
                    }, revoked: false
                }, {
                    id: "other-read", subject: C.actorIdentity(other), rights: ["read"], scope: {
                        kind: "project"
                    }, revoked: false
                }]
        }, bindings: [{
                bindingId: "b", worldIdentity: "local", canonicalAddress: "/source", nativeWorkspaceRef: "ws", active: true
            }], objects: []
    };
    try(command: C.WorkCommand, actor: C.Actor = lead, extra: Partial<C.TrustedFacts> = {}): C.Result<C.MutationPlan> {
        const contents: C.TrustedFacts["contents"] = command.action === "put_artifact" && "content" in command.payload.change && command.payload.change.content.kind === "text" ? [(() => {
                const input = command.payload.change.content;
                if (input.kind !== "text")
                    throw Error("text");
                const bytes = new TextEncoder().encode(input.text);
                const digest = createHash("sha256").update(bytes).digest("hex");
                return {
                    input, digest, bytes: bytes.byteLength, media_type: input.media_type, write: {
                        kind: "inline" as const, digest, bytes, media_type: input.media_type
                    }
                };
            })()] : [];
        return applyCoordination(this.snapshot, command, {
            actor, now: 100, newId: k => `${k}-${++this.id}`, nativeMembers: [member, otherMember], observedEventRefs: [creation, otherMember.creationRef], contents, ...extra
        });
    }
    run(command: C.WorkCommand, actor: C.Actor = lead, extra: Partial<C.TrustedFacts> = {}): C.MutationPlan {
        const outcome = this.try(command, actor, extra);
        if (!outcome.ok)
            throw Error(`${command.action}: ${outcome.error.code} ${outcome.error.message}`);
        const plan = outcome.value, changed = new Set(plan.upserts.map(o => o.id));
        this.snapshot = {
            ...this.snapshot, sequence: ++this.sequence, revision: this.sequence.toString(16).padStart(40, "0"), objects: [...this.snapshot.objects.filter(o => !changed.has(o.id)), ...plan.upserts], objectHistory: [...(this.snapshot.objectHistory ?? []), ...this.snapshot.objects.filter(o => changed.has(o.id))], policy: plan.policy ?? this.snapshot.policy
        };
        expect(decodeSnapshot(this.snapshot).ok).toBe(true);
        return plan;
    }
    get<K extends C.ObjectKind>(kind: K, id?: string): C.RecordOf<K> {
        const result = this.snapshot.objects.find(o => o.kind === kind && (id === undefined || o.id === id));
        if (!result)
            throw Error(`No ${kind}`);
        return result as C.RecordOf<K>;
    }
    open() {
        return this.run({
            action: "open", payload: frame
        });
    }
}
function delivery() {
    const h = new Harness();
    h.open();
    const invocationId = h.get("invocation").id, coverage = h.get("coverage").id, criterion = h.get("criterion").id;
    h.run({
        action: "plan_attempt", payload: {
            invocation_id: invocationId, question: "Implement", baseline_refs: [observation], coverage_ids: [coverage], difference_or_redundancy: "Independent implementation", context_plan: {
                mode: "fresh", relevance: "Self contained", exposure: "Requirements only"
            }, expected_output: "Code and evidence", early_slice: "Interface", write_scope_claims: ["source"], purpose: "produce", member_id: "worker"
        }
    });
    const attempt = h.get("attempt").id;
    h.run({
        action: "put_artifact", payload: {
            invocation_id: invocationId, change: {
                action: "create", kind: "design", title: "Candidate design", content: {
                    kind: "text", media_type: "text/plain", text: "Complete original text"
                }, refs: [observation]
            }
        }
    }, worker);
    const artifact = ref(h.get("artifact"));
    h.run({
        action: "submit_contribution", payload: {
            invocation_id: invocationId, attempt_id: attempt, summary: "Implemented", artifact_refs: [artifact], evidence_refs: [observation], limitations: "Fixture only", source: {
                kind: "self"
            }
        }
    }, worker);
    const contribution = ref(h.get("contribution"));
    h.run({
        action: "set_candidate", payload: {
            invocation_id: invocationId, source_ref: artifact, description: "Selected version", dirty: false
        }
    });
    h.run({
        action: "decide", payload: {
            invocation_id: invocationId, target: contribution, disposition: "accepted", reason: "Meets requested coverage", evidence_refs: [observation], consequence: "Integrate"
        }
    });
    const decision = ref(h.get("decision"));
    const candidate = h.get("invocation").body.candidate_ref!;
    const check = (result: C.CheckResult) => h.run({
        action: "record_check", payload: {
            invocation_id: invocationId, check: {
                kind: "execution", target: candidate, criterion_ids: [criterion], method: "test", action: "Run scenario", result, evidence_refs: [observation], limits: "Fixture environment"
            }
        }
    });
    const complete = (checks: C.ObjectRef[]) => ({
        action: "set_lifecycle" as const, payload: {
            invocation_id: invocationId, transition: "complete" as const, reason: "All requirements satisfied", evidence_refs: [observation], completion: {
                candidate_ref: candidate, coverage: [{
                        coverage_id: coverage, decision_refs: [decision], check_refs: checks
                    }]
            }
        }
    });
    return {
        h, invocationId, coverage, criterion, attempt, artifact, contribution, decision, candidate, check, complete
    };
}
function failed(result: C.Result<unknown>, code?: C.FailureCode) {
    expect(result.ok).toBe(false);
    if (!result.ok && code)
        expect(result.error.code).toBe(code);
}
describe("whole work journey", () => {
    test("open, verified member, complete bytes, contribution, decision, check and close", () => {
        const d = delivery();
        const output = d.check("passed");
        const check = output.upserts.find(o => o.kind === "check")!;
        d.h.run(d.complete([ref(check)]));
        expect(d.h.get("invocation").body.lifecycle).toBe("completed");
        expect(d.h.get("check").body.provenance).toBe("reported");
        expect(d.h.get("attempt").body.progress).toBe("returned");
        const artifact = d.h.get("artifact");
        expect(artifact.body.content.bytes).toBe(new TextEncoder().encode("Complete original text").byteLength);
        expect(d.h.snapshot.objectHistory?.some(o => o.kind === "attempt" && o.body.progress === "planned")).toBe(true);
    });
    test("all plan results are immutable and cannot mutate source snapshot", () => {
        const h = new Harness(), before = JSON.stringify(h.snapshot);
        const result = h.try({
            action: "open", payload: frame
        });
        expect(result.ok).toBe(true);
        expect(JSON.stringify(h.snapshot)).toBe(before);
    });
    test("member cannot decide, complete or impersonate author", () => {
        const d = delivery();
        failed(d.h.try(d.complete([]), worker), "not_authorized");
        failed(d.h.try({
            action: "decide", payload: {
                invocation_id: d.invocationId, target: d.contribution, disposition: "accepted", reason: "self", evidence_refs: [observation], consequence: "skip review"
            }
        }, worker), "not_authorized");
        failed(d.h.try({
            ...d.complete([]), payload: {
                ...d.complete([]).payload, author: "lead"
            }
        } as unknown as C.WorkCommand), "invalid_input");
    });
    test("unknown native member and unverified task never become a binding", () => {
        const h = new Harness();
        h.open();
        const i = h.get("invocation").id;
        const payload: C.PlanAttemptPayload = {
            invocation_id: i, question: "Q", baseline_refs: [], coverage_ids: [], difference_or_redundancy: "D", context_plan: {
                mode: "fresh", relevance: "R", exposure: "E"
            }, expected_output: "O", early_slice: "S", write_scope_claims: [], purpose: "produce", member_id: "invented"
        };
        failed(h.try({
            action: "plan_attempt", payload
        }), "not_authorized");
        failed(h.try({
            action: "plan_attempt", payload: {
                ...payload, member_id: "worker", task_ref: {
                    kind: "native_task", root_session_id: "root", task_id: "t", task_revision: 1
                }
            }
        }), "not_found");
    });
    test("replacement rejects late self submission but permits attributed external evidence", () => {
        const d = delivery();
        d.h.run({
            action: "update_attempt", payload: {
                invocation_id: d.invocationId, attempt_id: d.attempt, change: {
                    kind: "replace", member_id: "other", creation_ref: otherMember.creationRef, reason: "Continue with new member", context_exposure: "Initial result known"
                }
            }
        });
        const payload: C.ContributionPayload = {
            invocation_id: d.invocationId, attempt_id: d.attempt, summary: "Late", artifact_refs: [d.artifact], evidence_refs: [], limitations: "Late result", source: {
                kind: "self"
            }
        };
        failed(d.h.try({
            action: "submit_contribution", payload
        }, worker), "not_authorized");
        d.h.run({
            action: "submit_contribution", payload: {
                ...payload, source: {
                    kind: "external", label: "Former worker late submission", refs: [observation]
                }
            }
        });
        expect(d.h.get("attempt").body.binding_history).toHaveLength(2);
    });
});
describe("completion is about all current evidence", () => {
    test("a later pass cannot hide an unresolved failure", () => {
        const d = delivery();
        d.check("failed");
        const passing = d.check("passed").upserts.find(o => o.kind === "check")!;
        failed(d.h.try(d.complete([ref(passing)])), "invalid_transition");
    });
    test("explicit replacement clears failure but does not fabricate a pass", () => {
        const d = delivery();
        const bad = d.check("failed").upserts.find(o => o.kind === "check")!, good = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "record_check", payload: {
                invocation_id: d.invocationId, check: {
                    kind: "resolution", target: d.candidate, criterion_ids: [d.criterion], conflicting_check_refs: [ref(bad)], conclusion: "replaced", replacement_check_refs: [ref(good)], rationale: "Fixed and actually reran", evidence_refs: [observation]
                }
            }
        });
        d.h.run(d.complete([ref(good)]));
        expect(d.h.get("invocation").body.lifecycle).toBe("completed");
    });
    test("partial, unavailable, not_run and deferred each block completion", () => {
        for (const result of ["partial", "unavailable", "not_run"] as const) {
            const d = delivery();
            const c = d.check(result).upserts.find(o => o.kind === "check")!;
            failed(d.h.try(d.complete([ref(c)])), "invalid_transition");
        }
        const d = delivery(), good = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "decide", payload: {
                invocation_id: d.invocationId, target: d.contribution, disposition: "deferred", reason: "Not ready", evidence_refs: [observation], consequence: "Still missing"
            }
        });
        failed(d.h.try(d.complete([ref(good)])), "object_changed");
    });
    test("new candidate requires new decisions and explicit check applicability", () => {
        const d = delivery(), old = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "set_candidate", payload: {
                invocation_id: d.invocationId, source_ref: d.artifact, description: "New integration revision", dirty: true
            }
        });
        failed(d.h.try(d.complete([ref(old)])), "object_changed");
        const current = d.h.get("invocation").body.candidate_ref!;
        d.h.run({
            action: "decide", payload: {
                invocation_id: d.invocationId, target: d.contribution, disposition: "accepted", reason: "Reassessed unchanged contribution", evidence_refs: [observation], consequence: "Applicable"
            }
        });
        const decision = d.h.snapshot.objects.filter((o): o is C.RecordOf<"decision"> => o.kind === "decision").at(-1)!;
        const applied = d.h.run({
            action: "record_check", payload: {
                invocation_id: d.invocationId, check: {
                    kind: "applicability", prior_check: ref(old), current_target: current, criterion_ids: [d.criterion], scope: "Untouched exact behavior", rationale: "Verified impact", impact_refs: [observation]
                }
            }
        }).upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "complete", reason: "All current evidence", evidence_refs: [observation], completion: {
                    candidate_ref: current, coverage: [{
                            coverage_id: d.coverage, decision_refs: [ref(decision)], check_refs: [ref(applied)]
                        }]
                }
            }
        });
    });
    test("applicability chains and failed-to-passed laundering are refused", () => {
        const d = delivery(), bad = d.check("failed").upserts.find(o => o.kind === "check")!;
        const app = d.h.run({
            action: "record_check", payload: {
                invocation_id: d.invocationId, check: {
                    kind: "applicability", prior_check: ref(bad), current_target: d.candidate, criterion_ids: [d.criterion], scope: "Same", rationale: "Same observation", impact_refs: [observation]
                }
            }
        }).upserts.find(o => o.kind === "check")!;
        failed(d.h.try(d.complete([ref(app)])), "invalid_transition");
        failed(d.h.try({
            action: "record_check", payload: {
                invocation_id: d.invocationId, check: {
                    kind: "applicability", prior_check: ref(app), current_target: d.candidate, criterion_ids: [d.criterion], scope: "Chain", rationale: "Try reuse", impact_refs: [observation]
                }
            }
        }), "invalid_input");
    });
    test("a critical challenge blocks independently of passing checks", () => {
        const d = delivery(), good = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "record_challenge", payload: {
                invocation_id: d.invocationId, target: ref(good), statement: "Wrong environment", contradicting_refs: [observation], impact: "Critical result may not hold"
            }
        });
        failed(d.h.try(d.complete([ref(good)])), "invalid_transition");
        d.h.run({
            action: "resolve_challenge", payload: {
                invocation_id: d.invocationId, challenge_id: d.h.get("challenge").id, resolution: "dismissed", reason: "Verified environment separately", evidence_refs: [observation]
            }
        });
        d.h.run(d.complete([ref(good)]));
    });
});
describe("requirements, content, interruption and closed work", () => {
    test("loosening text or retiring a requirement needs actual owner approval", () => {
        const d = delivery();
        const command: C.WorkCommand = {
            action: "amend_frame", payload: {
                invocation_id: d.invocationId, group: "goal", value: "Do less", rationale: "Cannot finish"
            }
        };
        failed(d.h.try(command), "not_authorized");
        const approved: C.WorkCommand = {
            ...command, payload: {
                ...command.payload, authority_ref: {
                    approval_id: "approved"
                }
            }
        };
        failed(d.h.try(approved), "not_authorized");
        d.h.run(approved, lead, {
            approvals: [{
                    id: "approved", archiveId: "a", invocationId: d.invocationId, action: "amend_frame", active: true
                }]
        });
        expect(d.h.get("invocation").body.frame_revision).toBe(2);
    });
    test("coverage and criteria update atomically with all required targets covered", () => {
        const d = delivery();
        const command: C.WorkCommand = {
            action: "amend_frame", payload: {
                invocation_id: d.invocationId, group: "requirements", value: {
                    coverage: [{
                            ...frame.coverage[0]!, id: d.coverage
                        }], criteria: [{
                            ...frame.criteria[0]!, id: d.criterion, coverage_targets: [{
                                    kind: "existing_id", id: "unrelated"
                                }]
                        }]
                }, rationale: "Bad map"
            }
        };
        const old = JSON.stringify(d.h.snapshot);
        failed(d.h.try(command), "invalid_input");
        expect(JSON.stringify(d.h.snapshot)).toBe(old);
    });
    test("old accepted contribution becomes inapplicable after author revises", () => {
        const d = delivery(), good = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "submit_contribution", payload: {
                ...d.h.get("contribution").body, contribution_id: d.contribution.object_id, summary: "Changed result"
            }
        }, worker);
        failed(d.h.try(d.complete([ref(good)])), "object_changed");
    });
    test("lead cannot overwrite member's artifact, correction preserves original version", () => {
        const d = delivery();
        failed(d.h.try({
            action: "put_artifact", payload: {
                invocation_id: d.invocationId, change: {
                    action: "revise", target: d.artifact, title: "Changed", content: {
                        kind: "text", media_type: "text/plain", text: "rewrite"
                    }, refs: [], reason: "Convenient"
                }
            }
        }), "not_authorized");
        d.h.run({
            action: "put_artifact", payload: {
                invocation_id: d.invocationId, change: {
                    action: "correct", target: d.artifact, content: {
                        kind: "text", media_type: "text/plain", text: "Correction with evidence"
                    }, reason: "Original misunderstood", evidence_refs: [observation]
                }
            }
        });
        expect(d.h.get("artifact", d.artifact.object_id).object_revision).toBe(1);
        expect(d.h.snapshot.objects.some(o => o.kind === "artifact" && o.body.correction_of?.object_id === d.artifact.object_id)).toBe(true);
    });
    test("sealed content is not accepted without actor-scoped preparation", () => {
        const d = delivery();
        failed(d.h.try({
            action: "put_artifact", payload: {
                invocation_id: d.invocationId, change: {
                    action: "create", kind: "attachment", title: "Binary", content: {
                        kind: "upload", upload_id: "somebody-elses", digest: "d".repeat(64)
                    }, refs: []
                }
            }
        }), "storage_unavailable");
    });
    test("blockers need clearing evidence and blocked work cannot complete", () => {
        const d = delivery();
        d.h.run({
            action: "set_next", payload: {
                invocation_id: d.invocationId, action: "Repair", intended_result: "Pass", blockers: [{
                        statement: "Broken dependency", coverage_ids: [d.coverage], clearing_evidence_refs: []
                    }]
            }
        });
        d.h.run({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "block", reason: "Dependency", evidence_refs: [observation]
            }
        });
        failed(d.h.try(d.complete([])), "invalid_transition");
        failed(d.h.try({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "resume", reason: "Pretend fixed", evidence_refs: [observation]
            }
        }), "invalid_transition");
        failed(d.h.try({
            action: "set_next", payload: {
                invocation_id: d.invocationId, action: "Go", intended_result: "Delivery", blockers: []
            }
        }), "invalid_input");
        d.h.run({
            action: "set_next", payload: {
                invocation_id: d.invocationId, action: "Continue", intended_result: "Delivery", blockers: [{
                        statement: "Broken dependency", coverage_ids: [d.coverage], clearing_evidence_refs: [observation]
                    }]
            }
        });
        d.h.run({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "resume", reason: "Now verified", evidence_refs: [observation]
            }
        });
        expect(d.h.get("invocation").body.lifecycle).toBe("active");
    });
    test("closed delivery accepts artifacts and challenges but plan changes need explicit reopen", () => {
        const d = delivery(), good = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run(d.complete([ref(good)]));
        const closed = ref(d.h.get("invocation"));
        failed(d.h.try({
            action: "set_candidate", payload: {
                invocation_id: d.invocationId, source_ref: d.artifact, description: "Sneak change", dirty: false
            }
        }), "invalid_transition");
        d.h.run({
            action: "put_artifact", payload: {
                invocation_id: d.invocationId, change: {
                    action: "create", kind: "research", title: "Later observation", content: {
                        kind: "text", media_type: "text/plain", text: "Additional facts"
                    }, refs: [observation]
                }
            }
        });
        failed(d.h.try({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "reopen", reason: "New evidence", evidence_refs: [observation]
            }
        }), "invalid_input");
        d.h.run({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "reopen", reason: "New evidence affects delivery", evidence_refs: [closed, observation]
            }
        });
        expect(d.h.get("invocation").body.lifecycle_history.some(e => e.transition === "complete")).toBe(true);
    });
});
describe("final public counterexamples", () => {
    test("a revoked delegation chain cannot borrow a different active read grant", () => {
        const h = new Harness();
        h.open();
        h.snapshot = {
            ...h.snapshot, policy: {
                ...h.snapshot.policy, grants: [
                    {
                        ...h.snapshot.policy.grants[0]!, delegable_rights: []
                    },
                    {
                        id: "parent", subject: C.actorIdentity(lead), rights: ["read"], delegable_rights: ["read", "member-submit"], scope: {
                            kind: "project"
                        }, revoked: true
                    },
                    {
                        id: "invalid-quota", subject: C.actorIdentity(lead), rights: ["read"], delegable_rights: ["member-submit"], scope: {
                            kind: "project"
                        }, revoked: false, delegated_from: "parent"
                    }
                ]
            }
        };
        failed(h.try({
            action: "plan_attempt", payload: {
                invocation_id: h.get("invocation").id, question: "Q", baseline_refs: [], coverage_ids: [], difference_or_redundancy: "D", context_plan: {
                    mode: "fresh", relevance: "R", exposure: "E"
                }, expected_output: "O", early_slice: "S", write_scope_claims: [], purpose: "produce", member_id: "worker"
            }
        }), "not_authorized");
    });
    test("an old pass cannot count as a later replacement execution", () => {
        const d = delivery(), oldPass = d.check("passed").upserts.find(o => o.kind === "check")!, newFail = d.check("failed").upserts.find(o => o.kind === "check")!;
        failed(d.h.try({
            action: "record_check", payload: {
                invocation_id: d.invocationId, check: {
                    kind: "resolution", target: d.candidate, criterion_ids: [d.criterion], conflicting_check_refs: [ref(newFail)], conclusion: "replaced", replacement_check_refs: [ref(oldPass)], rationale: "Select the old result", evidence_refs: []
                }
            }
        }), "invalid_input");
    });
    test("candidate changes cannot launder a challenged observation through applicability", () => {
        const d = delivery(), old = d.check("passed").upserts.find(o => o.kind === "check")!;
        d.h.run({
            action: "record_challenge", payload: {
                invocation_id: d.invocationId, target: ref(old), statement: "Evidence flawed", contradicting_refs: [observation], impact: "Critical observation unreliable"
            }
        });
        d.h.run({
            action: "set_candidate", payload: {
                invocation_id: d.invocationId, source_ref: d.artifact, description: "New candidate", dirty: false
            }
        });
        const candidate = d.h.get("invocation").body.candidate_ref!;
        const decision = d.h.run({
            action: "decide", payload: {
                invocation_id: d.invocationId, target: d.contribution, disposition: "accepted", reason: "Accepted again", evidence_refs: [observation], consequence: "Use"
            }
        }).upserts.find(o => o.kind === "decision")!;
        const app = d.h.run({
            action: "record_check", payload: {
                invocation_id: d.invocationId, check: {
                    kind: "applicability", prior_check: ref(old), current_target: candidate, criterion_ids: [d.criterion], scope: "Same observed code", rationale: "Reuse", impact_refs: [observation]
                }
            }
        }).upserts.find(o => o.kind === "check")!;
        failed(d.h.try({
            action: "set_lifecycle", payload: {
                invocation_id: d.invocationId, transition: "complete", reason: "Attempt to ignore challenge", evidence_refs: [observation], completion: {
                    candidate_ref: candidate, coverage: [{
                            coverage_id: d.coverage, decision_refs: [ref(decision)], check_refs: [ref(app)]
                        }]
                }
            }
        }), "invalid_transition");
    });
    test("progress, supersession and finding dispositions retain their full reasons", () => {
        const d = delivery();
        const planned = d.h.run({
            action: "plan_attempt", payload: {
                invocation_id: d.invocationId, question: "Extra check", baseline_refs: [], coverage_ids: [d.coverage], difference_or_redundancy: "Second lens", context_plan: {
                    mode: "fresh", relevance: "Review", exposure: "Original code only"
                }, expected_output: "Finding", early_slice: "Method", write_scope_claims: [], purpose: "produce"
            }
        }).upserts.find(o => o.kind === "attempt")!;
        d.h.run({
            action: "update_attempt", payload: {
                invocation_id: d.invocationId, attempt_id: planned.id, change: {
                    kind: "progress", state: "missing", reason: "Native creation failed"
                }
            }
        });
        expect(d.h.get("attempt", planned.id).body.progress_history?.at(-1)?.reason).toBe("Native creation failed");
        d.h.run({
            action: "update_attempt", payload: {
                invocation_id: d.invocationId, attempt_id: planned.id, change: {
                    kind: "supersede", replacement_attempt_id: d.attempt, reason: "Existing verified member covers it"
                }
            }
        });
        expect(d.h.get("attempt", planned.id).body.progress_history?.at(-1)?.reason).toBe("Existing verified member covers it");
        const finding = d.h.run({
            action: "record_finding", payload: {
                invocation_id: d.invocationId, kind: "question", statement: "Choice remains", impact: "Tradeoff", evidence_refs: [observation], coverage_ids: [d.coverage], options: ["A", "B"]
            }
        }).upserts.find(o => o.kind === "finding")!;
        const decision = d.h.run({
            action: "decide", payload: {
                invocation_id: d.invocationId, target: ref(finding), disposition: "unresolved", reason: "Requires evidence", evidence_refs: [observation], consequence: "Continue investigation"
            }
        }).upserts.find(o => o.kind === "decision")!;
        expect(decision.kind === "decision" && decision.body.disposition).toBe("unresolved");
    });
});
test("review-purpose binding cannot consume only a submission allowance", () => {
    const h = new Harness();
    h.open();
    const command: C.WorkCommand = {
        action: "plan_attempt", payload: {
            invocation_id: h.get("invocation").id, question: "Review", baseline_refs: [], coverage_ids: [], difference_or_redundancy: "Independent", context_plan: {
                mode: "fresh", relevance: "Review", exposure: "None"
            }, expected_output: "Review", early_slice: "First finding", write_scope_claims: [], purpose: "review", member_id: "worker"
        }
    };
    expect(h.try(command).ok).toBe(true);
    h.snapshot = {
        ...h.snapshot, policy: {
            ...h.snapshot.policy, grants: h.snapshot.policy.grants.map(g => g.id === "lead-grant" ? {
                ...g, delegable_rights: ["member-submit"]
            } : g)
        }
    };
    failed(h.try(command), "not_authorized");
});
