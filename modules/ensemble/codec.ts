/** All wire and persisted schemas live here; unknown control fields fail closed. */
import * as C from "./contracts.ts";
import { array, bool, decode, enumeration as en, extend, integer, literal as lit, object as obj, publicSchema, reference, str, union, type Schema } from "./validation.ts";
const text = str(), raw = str(0), id = str(1, 128, "^[^\\u0000\\r\\n]+$"), positive = integer(1), nonnegative = integer();
const digest = str(64, 64, "^[a-f0-9]{64}$"), revision = str(40, 64, "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"), ids = array(id), strings = array(text);
const objectRef = obj({
    kind: lit("object"), object_id: id, object_revision: positive
});
const ref = reference("ref"), refs = array(ref), objectRefs = array(objectRef), authority = obj({
    approval_id: id
});
const nativeTask = obj({
    kind: lit("native_task"), root_session_id: id, task_id: id, task_revision: positive
});
const REF = union(objectRef, obj({
    kind: lit("source"), binding_id: id, source_handle: id, baseline: text
}, {
    selector: text
}), obj({
    kind: lit("native_event"), session_id: id, event_seq: nonnegative
}), nativeTask, obj({
    kind: lit("external"), url: str(1, 8192, "^https?://[^\\s]+$")
}, {
    snapshot_ref: objectRef
}), obj({
    kind: lit("reported"), statement: text, source_label: text, supporting_refs: refs
}));
const DEFS = {
    ref: REF
};
const actorIdentity = union(obj({
    kind: lit("owner"), ownerId: id, hostAuthorityId: id
}), obj({
    kind: lit("session"), sessionId: id, rootSessionId: id
}));
const right = en("read", "open", "lead", "member-submit", "review", "organize");
const grantScope = union(obj({
    kind: lit("project")
}), obj({
    kind: lit("invocation"), invocation_id: id
}), obj({
    kind: lit("attempt"), attempt_id: id
}), obj({
    kind: lit("proposal"), proposal_ref: objectRef
}));
const grantRequest = obj({
    subject: actorIdentity, rights: array(right, 1), scope: grantScope
}, {
    expires_at: nonnegative, delegable_rights: array(right)
});
const grant = extend(grantRequest, {
    id, revoked: bool
}, {
    delegated_from: id
});
const reassignment = obj({
    proposalId: id, findingId: id, reviewer: actorIdentity
});
const policy = obj({
    epoch: nonnegative, grants: array(grant), paused: bool
}, {
    reviewer_reassignments: array(reassignment)
});
const sourceDescriptor = obj({
    worldIdentity: id, canonicalAddress: text, nativeWorkspaceRef: id
}, {
    nativeSessionRef: id, baseline: text
});
const binding = extend(sourceDescriptor, {
    bindingId: id, active: bool
});
const coverageInput = obj({
    key: id, title: text, requirement: text, required: bool, authority_refs: array(authority)
}, {
    id
});
const coverageTarget = union(obj({
    kind: lit("request_key"), key: id
}), obj({
    kind: lit("existing_id"), id
}));
const criterionInput = obj({
    key: id, coverage_targets: array(coverageTarget, 1), statement: text, critical: bool, method: text
}, {
    id
});
const requirements = obj({
    coverage: array(coverageInput, 1), criteria: array(criterionInput, 1)
});
const contextPlan = obj({
    mode: en("fresh", "fork", "continue"), relevance: text, exposure: text
});
const selection = obj({
    provider: text, model: text
}, {
    reasoning_effort: text, preset: text
});
const planAttempt = obj({
    invocation_id: id, question: text, baseline_refs: refs, coverage_ids: ids, difference_or_redundancy: text, context_plan: contextPlan, expected_output: text, early_slice: text, write_scope_claims: strings, purpose: en("produce", "review")
}, {
    member_id: id, task_ref: nativeTask, requested_selection: selection
});
const artifactContent = union(obj({
    kind: lit("text"), media_type: text, text: raw
}), obj({
    kind: lit("upload"), upload_id: id, digest
}));
const artifactKind = en("research", "design", "note", "evidence", "attachment", "imported-original");
const artifactChange = union(obj({
    action: lit("create"), kind: artifactKind, title: text, content: artifactContent, refs
}, {
    domains: ids
}), obj({
    action: lit("revise"), target: objectRef, title: text, content: artifactContent, refs, reason: text
}), obj({
    action: lit("retire"), target: objectRef, reason: text
}), obj({
    action: lit("correct"), target: objectRef, content: artifactContent, reason: text, evidence_refs: refs
}));
const attemptChange = union(obj({
    kind: lit("progress"), state: en("planned", "running", "returned", "missing"), reason: text
}), obj({
    kind: lit("bind"), member_id: id, creation_ref: ref, context_exposure: text
}, {
    task_ref: nativeTask
}), obj({
    kind: lit("replace"), member_id: id, creation_ref: ref, reason: text, context_exposure: text
}, {
    task_ref: nativeTask
}), obj({
    kind: lit("supersede"), replacement_attempt_id: id, reason: text
}));
const contribution = obj({
    invocation_id: id, attempt_id: id, summary: text, artifact_refs: objectRefs, evidence_refs: refs, limitations: text, source: union(obj({
        kind: lit("self")
    }), obj({
        kind: lit("external"), label: text, refs
    }))
}, {
    contribution_id: id
});
const finding = obj({
    invocation_id: id, kind: en("issue", "opportunity", "gap", "risk", "question"), statement: text, impact: text, evidence_refs: refs, coverage_ids: ids
}, {
    options: strings, responsible_member_id: id
});
const decision = obj({
    invocation_id: id, target: objectRef, disposition: en("accepted", "rejected", "revise", "deferred", "unresolved"), reason: text, evidence_refs: refs, consequence: text
});
const checkInput = union(obj({
    kind: lit("execution"), target: objectRef, criterion_ids: ids, method: text, action: text, result: en("passed", "failed", "partial", "not_run", "unavailable"), evidence_refs: refs, limits: text
}), obj({
    kind: lit("applicability"), prior_check: objectRef, current_target: objectRef, criterion_ids: ids, scope: text, rationale: text, impact_refs: refs
}), obj({
    kind: lit("resolution"), target: objectRef, criterion_ids: ids, conflicting_check_refs: array(objectRef, 1), conclusion: en("invalid_observation", "replaced", "still_failing"), replacement_check_refs: objectRefs, rationale: text, evidence_refs: refs
}));
const challenge = obj({
    invocation_id: id, target: objectRef, statement: text, contradicting_refs: array(ref, 1), impact: text
});
const resolution = obj({
    resolution: en("upheld", "dismissed", "superseded"), reason: text, evidence_refs: refs
}, {
    replacement_ref: objectRef
});
const blocker = obj({
    statement: text, coverage_ids: ids, clearing_evidence_refs: refs
});
const next = obj({
    invocation_id: id, action: text, intended_result: text, blockers: array(blocker)
}, {
    owner_id: id
});
const completion = obj({
    candidate_ref: objectRef, coverage: array(obj({
        coverage_id: id, decision_refs: objectRefs, check_refs: objectRefs
    }), 1)
});
const lifecycleCommon = {
    invocation_id: id, reason: text, evidence_refs: refs
};
export const WORK_PAYLOAD_SCHEMAS: Readonly<Record<keyof C.WorkPayloads, Schema>> = {
    open: extend(requirements, {
        title: text, goal: text, deliverable: text, subject: text, constraints: text, exclusions: text
    }),
    amend_frame: union(obj({
        invocation_id: id, group: en("goal", "deliverable", "subject", "constraints", "exclusions"), value: text, rationale: text
    }, {
        authority_ref: authority
    }), obj({
        invocation_id: id, group: lit("requirements"), value: requirements, rationale: text
    }, {
        authority_ref: authority
    })),
    plan_attempt: planAttempt, update_attempt: obj({
        invocation_id: id, attempt_id: id, change: attemptChange
    }), put_artifact: obj({
        invocation_id: id, change: artifactChange
    }),
    submit_contribution: contribution, record_finding: finding, decide: decision,
    set_candidate: obj({
        invocation_id: id, source_ref: ref, description: text, dirty: bool
    }), record_check: obj({
        invocation_id: id, check: checkInput
    }), record_challenge: challenge,
    resolve_challenge: extend(resolution, {
        invocation_id: id, challenge_id: id
    }), set_next: next,
    set_lifecycle: union(obj({
        ...lifecycleCommon, transition: en("block", "resume", "abandon", "reopen")
    }), obj({
        ...lifecycleCommon, transition: lit("complete"), completion
    })),
};
const applicability = obj({
    task_types: strings, interface_versions: strings, required_capabilities: strings
});
const coaching = obj({
    invocation_id: id, attempt_id: id, observed_problem: text, diagnosis: text, instruction: text, exposure_refs: refs, intended_transfer: text
});
const reflection = obj({
    invocation_id: id, domain_id: id, title: text, problem: text, actions_and_evidence: text, judgment_change: text, limits: text, next_test: text, fact_refs: refs, retrospective: bool
}, {
    reflection_id: id, amendment: obj({
        target: objectRef, mode: en("correct", "withdraw"), reason: text
    })
});
const review = obj({
    invocation_id: id, proposal_ref: objectRef, verdict: en("approve", "revise", "reject"), findings: array(obj({
        statement: text, blocking: bool, evidence_refs: refs
    }, {
        id
    })), evidence_refs: refs
});
const publish = obj({
    invocation_id: id, proposal_ref: objectRef, review_refs: array(objectRef, 1)
});
const lesson = obj({
    invocation_id: id, title: text, trigger: text, action: text, supporting_refs: refs, counterexamples: text, applicability, invalidation_condition: text
}, {
    lesson_id: id
});
const application = obj({
    kind: lit("application"), invocation_id: id, attempt_id: id, context: text, action_taken: text, result: en("supports", "contradicts", "inconclusive"), check_refs: objectRefs, limits: text
}, {
    case_kind: en("original", "unseen", "counterexample", "unknown")
});
const assessment = obj({
    kind: lit("decision"), status: en("supported", "contested", "retired"), reason: text, application_refs: objectRefs, review_ref: objectRef
});
const domainDefinition = obj({
    title: text, questions: text, audience: text, overview: text
});
const domainChange = union(extend(domainDefinition, {
    kind: lit("create")
}), extend(domainDefinition, {
    kind: lit("revise"), domain_ref: objectRef
}), obj({
    kind: lit("move"), publication_ref: objectRef, from_domain: id, to_domain: id, reason: text
}), obj({
    kind: lit("split"), domain_ref: objectRef, new_domains: array(extend(domainDefinition, {
        key: id
    }), 1), entry_assignments: array(obj({
        publication_ref: objectRef, domain_key: id
    })), reason: text
}), obj({
    kind: lit("retire"), domain_ref: objectRef, successor_id: id, reason: text
}));
export const LEARN_PAYLOAD_SCHEMAS: Readonly<Record<keyof C.LearnPayloads, Schema>> = {
    record_coaching: coaching, propose_reflection: reflection, review_reflection: review, publish_reflection: publish, amend_publication: extend(publish, {
        target: objectRef, reason: text, mode: en("correct", "withdraw")
    }), propose_lesson: lesson, assess_lesson: obj({
        invocation_id: id, lesson_ref: objectRef, assessment: union(application, assessment)
    }), organize_domain: obj({
        invocation_id: id, change: domainChange
    })
};
function commands(payloads: Readonly<Record<string, Schema>>, envelope = false): Schema {
    return union(...Object.entries(payloads).map(([action, payload]) => obj({
        action: lit(action), payload, ...(envelope ? {
            expected_revision: revision, operation_id: id
        } : {})
    })));
}
const workCommand = commands(WORK_PAYLOAD_SCHEMAS), learnCommand = commands(LEARN_PAYLOAD_SCHEMAS);
const workEnvelope = commands(WORK_PAYLOAD_SCHEMAS, true), learnEnvelope = commands(LEARN_PAYLOAD_SCHEMAS, true);
const queryCommon = {
    project_id: id
}, page = {
    revision, cursor: text, page_size: integer(1, 100)
};
const query = union(obj({
    kind: en("context", "projects")
}, queryCommon), obj({
    kind: en("invocation", "checkpoint"), invocation_id: id
}, {
    ...queryCommon, revision
}), obj({
    kind: en("object", "artifact"), object_id: id
}, {
    ...queryCommon, object_revision: positive, revision, content_mode: en("summary", "text", "bytes"), cursor: text
}), obj({
    kind: lit("list"), object_kind: en(...C.OBJECT_KINDS)
}, {
    ...queryCommon, ...page, invocation_id: id, domain_id: id, status: text
}), obj({
    kind: lit("history"), object_id: id
}, {
    ...queryCommon, ...page
}), obj({
    kind: lit("history"), invocation_id: id
}, {
    ...queryCommon, ...page
}), obj({
    kind: lit("reading"), domain_id: id
}, {
    ...queryCommon, ...page, include_drafts: bool
}), obj({
    kind: lit("lessons"), task_context: applicability
}, {
    ...queryCommon, ...page, domain_id: id, status: en("proposed", "supported", "contested", "retired"), text
}), obj({
    kind: lit("receipt"), operation_id: id
}, queryCommon), obj({
    kind: lit("environment_preferences"), role: text, task_context: applicability
}, queryCommon));
const upload = union(obj({
    action: lit("begin"), payload: obj({
        media_type: text, total_bytes: nonnegative, digest, invocation_id: id
    })
}), obj({
    action: lit("chunk"), payload: obj({
        upload_id: id, offset: nonnegative, bytes: str(0, 1400000, "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"), digest
    })
}), obj({
    action: en("status", "commit", "seal", "cancel"), payload: obj({
        upload_id: id
    })
}));
const limits = obj({
    inline_input_bytes: positive, response_bytes: positive, artifact_bytes: positive, upload_chunk_bytes: positive, upload_total_bytes: positive, concurrent_uploads: positive, page_items: integer(1, 100)
});
const bindPayload = obj({
    source_descriptor: sourceDescriptor, mapping_evidence: refs, reason: text
});
export const ADMIN_PAYLOAD_SCHEMAS: Readonly<Record<keyof C.AdminPayloads, Schema>> = {
    initialize: obj({
        root_handle: id, source_descriptor: sourceDescriptor, initial_grants: array(grantRequest, 1), limits
    }), bind: bindPayload, rebind: bindPayload,
    grant: extend(grantRequest, {
        reason: text
    }), revoke: obj({
        grant_id: id, reason: text
    }), takeover: obj({
        invocation_id: id, new_lead_session_id: id, reason: text
    }), assign_reviewer: obj({
        proposal_ref: objectRef, reviewer_session_id: id, delegated_rights: array(right, 1)
    }), pause: obj({
        reason: text
    }), resume: obj({
        reason: text, diagnostic_ref: ref
    }),
    inventory_import: obj({
        source_handle: id, selection: strings, budget: positive
    }), commit_import: obj({
        inventory_id: id, accepted_exceptions: strings, approval_ref: authority
    }), export: obj({
        revision, selection: ids, destination_handle: id
    }, {
        overwrite_approval: authority
    }), backup: obj({
        revision, destination_handle: id
    }), restore: obj({
        backup_handle: id, mapping_evidence: refs
    }), activate_restore: union(obj({
        candidate_id: id, mode: lit("lossless"), source_descriptor: sourceDescriptor, initial_grants: array(grantRequest, 1), approval_ref: authority, source_stop_evidence: array(ref, 1), final_head_ref: authority
    }), obj({
        candidate_id: id, mode: lit("lossy"), source_descriptor: sourceDescriptor, initial_grants: array(grantRequest, 1), approval_ref: authority, source_stop_evidence: refs, loss_statement: text
    }, {
        final_head_ref: authority
    })), relocate: obj({
        destination_handle: id, source_stop_evidence: array(ref, 1), mapping_evidence: refs, source_descriptor: sourceDescriptor, initial_grants: array(grantRequest, 1), approval_ref: authority
    }), plan_maintenance: union(obj({
        kind: en("gc", "purge"), backup_handle: id, reason: text
    }, {
        content_digests: array(digest)
    }), obj({
        kind: lit("legacy_upgrade"), source_handle: id, target_format: text, reason: text
    })), upgrade: obj({
        target_format: text, migration_plan_ref: ref, approval_ref: authority, source_stop_ref: authority, source_stop_evidence: array(ref, 1)
    }), diagnose: obj({
        scope: text
    }), maintain: obj({
        plan_ref: ref, approval_ref: authority
    }), configure_replica: obj({
        destination_handle: id, credential_handle: id, expected_remote_identity: text
    }), push_replica: obj({
        replica_id: id, local_revision: revision
    }), fetch_replica: obj({
        replica_id: id, expected_remote_revision: revision
    }),
};
const adminCommand = commands(ADMIN_PAYLOAD_SCHEMAS);
const adminEnvelope = union(...Object.entries(ADMIN_PAYLOAD_SCHEMAS).map(([action, payload]) => action === "initialize" ? obj({
    action: lit(action), payload, expected_revision: lit("absent"), operation_id: id
}) : obj({
    action: lit(action), payload, project_id: id, expected_revision: revision, operation_id: id
})));
const descriptor = obj({
    digest, bytes: nonnegative, media_type: text
});
const context = {
    frame_revision: positive
}, optionalContext = {
    candidate_ref: objectRef
};
const lifecycleEvent = obj({
    transition: en("open", "block", "resume", "complete", "abandon", "reopen"), reason: text, evidence_refs: refs
}, {
    completion
});
const BODY_SCHEMAS: Readonly<Record<C.ObjectKind, Schema>> = {
    invocation: obj({
        title: text, goal: text, deliverable: text, subject: text, constraints: text, exclusions: text, frame_revision: positive, lead: actorIdentity, lifecycle: en("active", "blocked", "completed", "abandoned"), coverage_ids: ids, criterion_ids: ids, lifecycle_history: array(lifecycleEvent)
    }, {
        candidate_ref: objectRef, next, frame_history: array(obj({
            frame_revision: positive, group: text, rationale: text
        }, {
            authority_ref: authority
        }))
    }),
    coverage: obj({
        invocation_id: id, key: id, title: text, requirement: text, required: bool, authority_refs: array(authority), retired: bool
    }),
    criterion: obj({
        invocation_id: id, key: id, coverage_ids: array(id, 1), statement: text, critical: bool, method: text, retired: bool
    }),
    attempt: extend(planAttempt, {
        progress: en("planned", "running", "returned", "missing", "superseded"), binding_history: array(obj({
            member_id: id, creation_ref: ref, exposure: text, reason: text
        }))
    }, {
        replacement_attempt_id: id, progress_history: array(obj({
            state: en("planned", "running", "returned", "missing", "superseded"), reason: text
        }))
    }),
    artifact: obj({
        invocation_id: id, kind: artifactKind, title: text, content: descriptor, refs, domains: ids, status: en("current", "retired"), editors: array(actorIdentity)
    }, {
        correction_of: objectRef, reason: text
    }),
    contribution, finding, decision: extend(decision, context, optionalContext), candidate: extend(WORK_PAYLOAD_SCHEMAS.set_candidate, context),
    check: extend(WORK_PAYLOAD_SCHEMAS.record_check, {
        ...context, provenance: en("reported", "observed")
    }, optionalContext), challenge: extend(challenge, {}, {
        resolution
    }),
    coaching, reflection: extend(reflection, {
        status: en("draft", "published")
    }), review,
    publication: extend(publish, {
        domain_id: id, sequence: positive, status: en("current", "withdrawn")
    }, {
        supersedes: objectRef, reason: text
    }),
    lesson, application: obj({
        invocation_id: id, lesson_ref: objectRef, assessment: application
    }), assessment: obj({
        invocation_id: id, lesson_ref: objectRef, assessment
    }),
    domain: extend(domainDefinition, {
        invocation_id: id, retired: bool
    }, {
        successor_id: id, primary_publication_ids: ids, overview_author: actorIdentity, change_kind: en("create", "revise", "move", "split", "retire"), change_reason: text
    }),
};
const domainRecord = union(...Object.entries(BODY_SCHEMAS).map(([kind, body]) => obj({
    format: lit(C.ARCHIVE_FORMAT), kind: lit(kind), id, object_revision: positive, created_sequence: positive, updated_sequence: positive, author: actorIdentity, body
})));
const snapshot = obj({
    archiveId: id, projectId: id, title: text, revision, sequence: nonnegative, formatVersion: lit(C.FORMAT_VERSION), rendererVersion: text, policy, bindings: array(binding), objects: array(domainRecord)
}, {
    objectHistory: array(domainRecord)
});
function checkedEnvelope<T>(value: unknown, schema: Schema): C.Result<T> {
    const result = decode<T>(value, schema, DEFS);
    if (!result.ok)
        return result;
    const op = (value as {
        operation_id: string;
    }).operation_id;
    return new TextEncoder().encode(op).byteLength > 128 ? C.failure("invalid_input", "operation_id exceeds 128 bytes.", "$.operation_id") : result;
}
export const decodeWorkCommand = (v: unknown): C.Result<C.WorkCommand> => decode(v, workCommand, DEFS);
export const decodeLearnCommand = (v: unknown): C.Result<C.LearnCommand> => decode(v, learnCommand, DEFS);
export const decodeWorkEnvelope = (v: unknown): C.Result<C.CommandEnvelope<C.WorkCommand>> => checkedEnvelope(v, workEnvelope);
export const decodeLearnEnvelope = (v: unknown): C.Result<C.CommandEnvelope<C.LearnCommand>> => checkedEnvelope(v, learnEnvelope);
export const decodeQuery = (v: unknown): C.Result<C.Query> => decode(v, query, DEFS);
export const decodeUpload = (v: unknown): C.Result<C.UploadCommand> => decode(v, upload, DEFS, 2 * 1024 * 1024);
export const decodeAdminCommand = (v: unknown): C.Result<C.AdminCommand> => decode(v, adminCommand, DEFS);
export const decodeAdminEnvelope = (v: unknown): C.Result<C.AdminEnvelope> => checkedEnvelope(v, adminEnvelope);
export const decodeGrant = (v: unknown): C.Result<C.Grant> => decode(v, grant, DEFS);
export const decodePolicySnapshot = (v: unknown): C.Result<C.PolicySnapshot> => decode(v, policy, DEFS);
export const decodeProjectBinding = (v: unknown): C.Result<C.ProjectBinding> => decode(v, binding, DEFS);
export const decodeRef = (v: unknown): C.Result<C.Ref> => decode(v, ref, DEFS);
export function decodeDomainRecord(value: unknown): C.Result<C.DomainRecord> {
    const result = decode<C.DomainRecord>(value, domainRecord, DEFS, 1024 * 1024);
    if (!result.ok)
        return result;
    return result.value.created_sequence > result.value.updated_sequence ? C.failure("invalid_input", "Record sequence ordering is invalid.") : result;
}
export function decodeSnapshot(value: unknown): C.Result<C.Snapshot> {
    const result = decode<C.Snapshot>(value, snapshot, DEFS, 64 * 1024 * 1024);
    if (!result.ok)
        return result;
    const s = result.value, seen = new Set<string>();
    for (const record of s.objects) {
        if (seen.has(record.id) || record.created_sequence > record.updated_sequence || record.updated_sequence > s.sequence)
            return C.failure("invalid_input", "Duplicate object or invalid snapshot sequence.");
        seen.add(record.id);
    }
    if (new Set(s.policy.grants.map(g => g.id)).size !== s.policy.grants.length)
        return C.failure("invalid_input", "Duplicate grant id.");
    if (new Set(s.bindings.map(b => b.bindingId)).size !== s.bindings.length)
        return C.failure("invalid_input", "Duplicate binding id.");
    const versions = new Set(s.objects.map(o => `${o.id}:${o.object_revision}`));
    for (const record of s.objectHistory ?? []) {
        const key = `${record.id}:${record.object_revision}`;
        if (versions.has(key) || record.created_sequence > record.updated_sequence || record.updated_sequence > s.sequence)
            return C.failure("invalid_input", "Duplicate or invalid historical object.");
        versions.add(key);
    }
    return result;
}
export const WORK_TOOL_SCHEMA = publicSchema(workEnvelope, DEFS);
export const LEARN_TOOL_SCHEMA = publicSchema(learnEnvelope, DEFS);
export const READ_TOOL_SCHEMA = publicSchema(query, DEFS);
export const UPLOAD_TOOL_SCHEMA = publicSchema(upload, DEFS);
export const ADMIN_COMMAND_SCHEMA = publicSchema(adminCommand, DEFS);
export const ADMIN_ENVELOPE_SCHEMA = publicSchema(adminEnvelope, DEFS);
export const DOMAIN_RECORD_SCHEMA = publicSchema(domainRecord, DEFS);
export const SNAPSHOT_SCHEMA = publicSchema(snapshot, DEFS);
