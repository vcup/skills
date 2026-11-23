import { describe, expect, test } from "bun:test";
import { decodeAdminEnvelope, decodeDomainRecord, decodeGrant, decodeLearnEnvelope, decodeQuery, decodeRef, decodeSnapshot, decodeUpload, decodeWorkEnvelope } from "./codec.ts";
import { ARCHIVE_FORMAT, type Snapshot } from "./contracts.ts";
const revision = "a".repeat(40);
const open = {
    action: "open", expected_revision: revision, operation_id: "one", payload: {
        title: "Delivery", goal: "Ship", deliverable: "Patch", subject: "Project", constraints: "Keep compatibility", exclusions: "No unrelated work", coverage: [{
                key: "c", title: "Works", requirement: "The result works", required: true, authority_refs: []
            }], criteria: [{
                key: "k", coverage_targets: [{
                        kind: "request_key", key: "c"
                    }], statement: "Run independent check", critical: true, method: "test"
            }]
    }
};
const identity = {
    kind: "session" as const, sessionId: "s", rootSessionId: "r"
};
const snapshot: Snapshot = {
    archiveId: "a", projectId: "p", title: "P", revision, sequence: 1, formatVersion: 2, rendererVersion: "v1", policy: {
        epoch: 0, paused: false, grants: []
    }, bindings: [], objects: []
};
describe("closed control envelopes", () => {
    test("accepts a full work request without claimed identity", () => expect(decodeWorkEnvelope(open).ok).toBe(true));
    test("rejects identity, project, flags and unknown fields at every level", () => {
        for (const key of ["actor", "author", "isVerified", "owner", "project_id", "extra"]) {
            expect(decodeWorkEnvelope({
                ...open, [key]: "x"
            }).ok).toBe(false);
            expect(decodeWorkEnvelope({
                ...open, payload: {
                    ...open.payload, [key]: "x"
                }
            }).ok).toBe(false);
        }
        expect(decodeWorkEnvelope({
            ...open, payload: {
                ...open.payload, criteria: [{
                        ...open.payload.criteria[0], verified: true
                    }]
            }
        }).ok).toBe(false);
    });
    test("requires exact revision, operation and complete required body", () => {
        for (const value of [null, {}, [], "open", {
                ...open, expected_revision: "latest"
            }, {
                ...open, expected_revision: "absent"
            }, {
                ...open, operation_id: "😀".repeat(40)
            }, {
                ...open, payload: {
                    ...open.payload, goal: ""
                }
            }])
            expect(decodeWorkEnvelope(value).ok).toBe(false);
    });
    test("has no undefined, accessor, cyclic or nonJSON loophole", () => {
        expect(decodeWorkEnvelope({
            ...open, missing: undefined
        }).ok).toBe(false);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(decodeWorkEnvelope(cyclic).ok).toBe(false);
        let accessed = false;
        const getter = Object.defineProperty({}, "action", {
            enumerable: true, get() { accessed = true; return "open"; }
        });
        expect(decodeWorkEnvelope(getter).ok).toBe(false);
        expect(accessed).toBe(false);
        expect(decodeWorkEnvelope(new Date()).ok).toBe(false);
    });
    test("budgets whole input and prevents surrogate byte loss", () => {
        const large = decodeWorkEnvelope({
            ...open, payload: {
                ...open.payload, goal: "x".repeat(300000)
            }
        });
        expect(large.ok).toBe(false);
        if (!large.ok)
            expect(large.error.code).toBe("budget_exceeded");
        expect(decodeWorkEnvelope({
            ...open, payload: {
                ...open.payload, title: "\ud800"
            }
        }).ok).toBe(false);
    });
    test("complete and artifact variants cannot mix fields", () => {
        expect(decodeWorkEnvelope({
            ...open, action: "set_lifecycle", payload: {
                invocation_id: "i", transition: "complete", reason: "Done", evidence_refs: []
            }
        }).ok).toBe(false);
        expect(decodeWorkEnvelope({
            ...open, action: "put_artifact", payload: {
                invocation_id: "i", change: {
                    action: "create", kind: "note", title: "empty bytes", content: {
                        kind: "text", media_type: "text/plain", text: ""
                    }, refs: []
                }
            }
        }).ok).toBe(true);
        expect(decodeWorkEnvelope({
            ...open, action: "put_artifact", payload: {
                invocation_id: "i", change: {
                    action: "retire", target: {
                        kind: "object", object_id: "a", object_revision: 1
                    }, reason: "Old", content: {
                        kind: "text", media_type: "text/plain", text: "replacement"
                    }
                }
            }
        }).ok).toBe(false);
    });
    test("fresh effort without route is refused by structural schema", () => expect(decodeWorkEnvelope({
        ...open, action: "plan_attempt", payload: {
            invocation_id: "i", question: "Q", baseline_refs: [], coverage_ids: [], difference_or_redundancy: "Independent", context_plan: {
                mode: "fresh", relevance: "New", exposure: "None"
            }, expected_output: "Report", early_slice: "Finding", write_scope_claims: [], purpose: "produce", requested_selection: {
                reasoning_effort: "high"
            }
        }
    }).ok).toBe(false));
});
describe("read, learning and management", () => {
    test("unopened project has a revision acquisition query", () => expect(decodeQuery({
        kind: "context"
    }).ok).toBe(true));
    test("history requires exactly one selector and pagination is bounded", () => {
        expect(decodeQuery({
            kind: "history", object_id: "x", invocation_id: "y"
        }).ok).toBe(false);
        expect(decodeQuery({
            kind: "history"
        }).ok).toBe(false);
        expect(decodeQuery({
            kind: "history", object_id: "x", page_size: 101
        }).ok).toBe(false);
    });
    test("lesson applicability cannot be a vague untyped blob", () => {
        expect(decodeQuery({
            kind: "lessons", task_context: {
                task_types: [], interface_versions: [], required_capabilities: []
            }
        }).ok).toBe(true);
        expect(decodeQuery({
            kind: "lessons", task_context: "anything"
        }).ok).toBe(false);
    });
    test("reflection amendments bind target mode and reason in reviewed body", () => {
        const payload = {
            invocation_id: "i", domain_id: "d", title: "A", problem: "P", actions_and_evidence: "E", judgment_change: "J", limits: "L", next_test: "N", fact_refs: [], retrospective: false, amendment: {
                target: {
                    kind: "object", object_id: "pub", object_revision: 1
                }, mode: "withdraw", reason: "Incorrect"
            }
        };
        expect(decodeLearnEnvelope({
            ...open, action: "propose_reflection", payload
        }).ok).toBe(true);
        expect(decodeLearnEnvelope({
            ...open, action: "propose_reflection", payload: {
                ...payload, amendment: {
                    target: payload.amendment.target, mode: "withdraw"
                }
            }
        }).ok).toBe(false);
    });
    test("owner grants cannot specify generated record identity", () => {
        const request = {
            action: "grant", project_id: "p", expected_revision: revision, operation_id: "g", payload: {
                subject: identity, rights: ["read"], scope: {
                    kind: "project"
                }, reason: "Share"
            }
        };
        expect(decodeAdminEnvelope(request).ok).toBe(true);
        expect(decodeAdminEnvelope({
            ...request, payload: {
                ...request.payload, id: "invented"
            }
        }).ok).toBe(false);
    });
    test("upload seal is explicit and bytes are canonical base64", () => {
        expect(decodeUpload({
            action: "seal", payload: {
                upload_id: "u"
            }
        }).ok).toBe(true);
        expect(decodeUpload({
            action: "chunk", payload: {
                upload_id: "u", offset: 0, bytes: "aGVsbG8=", digest: "b".repeat(64)
            }
        }).ok).toBe(true);
        expect(decodeUpload({
            action: "chunk", payload: {
                upload_id: "u", offset: -1, bytes: "plain text", digest: "b".repeat(64)
            }
        }).ok).toBe(false);
    });
});
describe("stored data is not trusted because it has a format label", () => {
    test("refuses all three independently reproduced v1 weakness classes", () => {
        expect(decodeDomainRecord({
            format: ARCHIVE_FORMAT, kind: "artifact"
        }).ok).toBe(false);
        expect(decodeSnapshot({
            ...snapshot, bindings: null
        }).ok).toBe(false);
        expect(decodeGrant({
            id: "g", subject: identity, rights: "read", scope: {
                kind: "project"
            }, revoked: false
        }).ok).toBe(false);
    });
    test("unknown future formats, duplicate bindings and grants fail", () => {
        expect(decodeSnapshot(snapshot).ok).toBe(true);
        expect(decodeSnapshot({
            ...snapshot, formatVersion: 3
        }).ok).toBe(false);
        const g = {
            id: "g", subject: identity, rights: ["read"], scope: {
                kind: "project"
            }, revoked: false
        };
        expect(decodeSnapshot({
            ...snapshot, policy: {
                ...snapshot.policy, grants: [g, g]
            }
        }).ok).toBe(false);
    });
    test("references require positive exact object revisions", () => {
        for (const r of [0, -1, 1.2, NaN, Infinity])
            expect(decodeRef({
                kind: "object", object_id: "a", object_revision: r
            }).ok).toBe(false);
        expect(decodeRef({
            kind: "external", url: "file:///secrets"
        }).ok).toBe(false);
        expect(decodeRef({
            kind: "reported", statement: "Owner said yes", source_label: "model", supporting_refs: [], approval_id: "x"
        }).ok).toBe(false);
    });
});
test("upgrade requires real approval and stopped-writer attestation references", () => {
    const command = {
        action: "upgrade", project_id: "p", expected_revision: revision, operation_id: "upgrade", payload: {
            target_format: ARCHIVE_FORMAT, migration_plan_ref: {
                kind: "reported", statement: "Preview plan", source_label: "owner control", supporting_refs: []
            }
        }
    };
    expect(decodeAdminEnvelope(command).ok).toBe(false);
    expect(decodeAdminEnvelope({
        ...command, payload: {
            ...command.payload, approval_ref: {
                approval_id: "owner-approved-plan"
            }, source_stop_ref: {
                approval_id: "owner-final-head"
            }, source_stop_evidence: [{
                    kind: "reported", statement: "Stopped old writer", source_label: "owner", supporting_refs: []
                }]
        }
    }).ok).toBe(true);
});
