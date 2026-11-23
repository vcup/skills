/** Shared IO-free contracts. Actor/facts come from trusted adapters, JSON from codec. */
export const FORMAT_VERSION = 2 as const;
export const ARCHIVE_FORMAT = "ensemble-archive/v2" as const;
export type ProjectId = string;
export type ArchiveId = string;
export type ObjectId = string;
export type SessionId = string;
export type CommitId = string;
export type Digest = string;
export type Actor = {
    readonly kind: "owner";
    readonly ownerId: string;
    readonly hostAuthorityId: string;
    readonly channel: "authenticated-remote";
} | {
    readonly kind: "session";
    readonly sessionId: SessionId;
    readonly rootSessionId: SessionId;
    readonly workspaceRef: string;
    readonly callId: string;
};
export type ActorIdentity = {
    readonly kind: "owner";
    readonly ownerId: string;
    readonly hostAuthorityId: string;
} | {
    readonly kind: "session";
    readonly sessionId: SessionId;
    readonly rootSessionId: SessionId;
};
export function actorIdentity(a: Actor): ActorIdentity {
    return a.kind === "owner" ? {
        kind: "owner", ownerId: a.ownerId, hostAuthorityId: a.hostAuthorityId
    } : {
        kind: "session", sessionId: a.sessionId, rootSessionId: a.rootSessionId
    };
}
export function actorKey(a: Actor | ActorIdentity): string { return a.kind === "owner" ? JSON.stringify(["owner", a.hostAuthorityId, a.ownerId]) : JSON.stringify(["session", a.rootSessionId, a.sessionId]); }
export type ObjectRef = {
    readonly kind: "object";
    readonly object_id: ObjectId;
    readonly object_revision: number;
};
export type Ref = ObjectRef | {
    readonly kind: "source";
    readonly binding_id: string;
    readonly source_handle: string;
    readonly baseline: string;
    readonly selector?: string;
} | {
    readonly kind: "native_event";
    readonly session_id: SessionId;
    readonly event_seq: number;
} | {
    readonly kind: "native_task";
    readonly root_session_id: SessionId;
    readonly task_id: string;
    readonly task_revision: number;
} | {
    readonly kind: "external";
    readonly url: string;
    readonly snapshot_ref?: ObjectRef;
} | {
    readonly kind: "reported";
    readonly statement: string;
    readonly source_label: string;
    readonly supporting_refs: readonly Ref[];
};
export type AuthorityRef = {
    readonly approval_id: string;
};
export type Right = "read" | "open" | "lead" | "member-submit" | "review" | "organize";
export type GrantScope = {
    readonly kind: "project";
} | {
    readonly kind: "invocation";
    readonly invocation_id: ObjectId;
} | {
    readonly kind: "attempt";
    readonly attempt_id: ObjectId;
} | {
    readonly kind: "proposal";
    readonly proposal_ref: ObjectRef;
};
export interface Grant {
    readonly id: string;
    readonly subject: ActorIdentity;
    readonly rights: readonly Right[];
    readonly scope: GrantScope;
    readonly revoked: boolean;
    readonly expires_at?: number;
    readonly delegated_from?: string;
    readonly delegable_rights?: readonly Right[];
}
export interface PolicySnapshot {
    readonly epoch: number;
    readonly grants: readonly Grant[];
    readonly paused: boolean;
    readonly reviewer_reassignments?: readonly ReviewerReassignment[];
}
export interface ReviewerReassignment {
    readonly proposalId: ObjectId;
    readonly findingId: string;
    readonly reviewer: ActorIdentity;
}
export interface GrantRequest {
    readonly subject: ActorIdentity;
    readonly rights: readonly Right[];
    readonly scope: GrantScope;
    readonly expires_at?: number;
    readonly delegable_rights?: readonly Right[];
}
export interface ProjectBinding {
    readonly bindingId: string;
    readonly worldIdentity: string;
    readonly canonicalAddress: string;
    readonly nativeWorkspaceRef: string;
    readonly nativeSessionRef?: string;
    readonly baseline?: string;
    readonly active: boolean;
}
export interface BoundTarget {
    readonly archiveId: ArchiveId;
    readonly projectId: ProjectId;
    readonly bindingId: string;
}
export interface ArchiveHandle {
    readonly archiveId: ArchiveId;
    readonly projectId: ProjectId;
    readonly locator: string;
}
export interface CoverageInput {
    readonly key: string;
    readonly title: string;
    readonly requirement: string;
    readonly required: boolean;
    readonly authority_refs: readonly AuthorityRef[];
    readonly id?: ObjectId;
}
export type CoverageTarget = {
    readonly kind: "request_key";
    readonly key: string;
} | {
    readonly kind: "existing_id";
    readonly id: ObjectId;
};
export interface CriterionInput {
    readonly key: string;
    readonly coverage_targets: readonly CoverageTarget[];
    readonly statement: string;
    readonly critical: boolean;
    readonly method: string;
    readonly id?: ObjectId;
}
export interface Requirements {
    readonly coverage: readonly CoverageInput[];
    readonly criteria: readonly CriterionInput[];
}
export interface OpenPayload extends Requirements {
    readonly title: string;
    readonly goal: string;
    readonly deliverable: string;
    readonly subject: string;
    readonly constraints: string;
    readonly exclusions: string;
}
export type AmendFramePayload = {
    readonly invocation_id: ObjectId;
    readonly rationale: string;
    readonly authority_ref?: AuthorityRef;
} & ({
    readonly group: "goal" | "deliverable" | "subject" | "constraints" | "exclusions";
    readonly value: string;
} | {
    readonly group: "requirements";
    readonly value: Requirements;
});
export interface ContextPlan {
    readonly mode: "fresh" | "fork" | "continue";
    readonly relevance: string;
    readonly exposure: string;
}
export interface RequestedSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoning_effort?: string;
    readonly preset?: string;
}
export interface PlanAttemptPayload {
    readonly invocation_id: ObjectId;
    readonly question: string;
    readonly baseline_refs: readonly Ref[];
    readonly coverage_ids: readonly ObjectId[];
    readonly difference_or_redundancy: string;
    readonly context_plan: ContextPlan;
    readonly expected_output: string;
    readonly early_slice: string;
    readonly write_scope_claims: readonly string[];
    readonly purpose: "produce" | "review";
    readonly member_id?: SessionId;
    readonly task_ref?: Extract<Ref, {
        kind: "native_task";
    }>;
    readonly requested_selection?: RequestedSelection;
}
export type AttemptProgress = "planned" | "running" | "returned" | "missing" | "superseded";
export type AttemptChange = {
    readonly kind: "progress";
    readonly state: Exclude<AttemptProgress, "superseded">;
    readonly reason: string;
} | {
    readonly kind: "bind";
    readonly member_id: SessionId;
    readonly creation_ref: Ref;
    readonly context_exposure: string;
    readonly task_ref?: Extract<Ref, {
        kind: "native_task";
    }>;
} | {
    readonly kind: "replace";
    readonly member_id: SessionId;
    readonly creation_ref: Ref;
    readonly reason: string;
    readonly context_exposure: string;
    readonly task_ref?: Extract<Ref, {
        kind: "native_task";
    }>;
} | {
    readonly kind: "supersede";
    readonly replacement_attempt_id: ObjectId;
    readonly reason: string;
};
export type ArtifactKind = "research" | "design" | "note" | "evidence" | "attachment" | "imported-original";
export type ArtifactContent = {
    readonly kind: "text";
    readonly media_type: string;
    readonly text: string;
} | {
    readonly kind: "upload";
    readonly upload_id: string;
    readonly digest: Digest;
};
/** action discriminates the operation; kind on create is the artifact's content kind. */
export type ArtifactChange = {
    readonly action: "create";
    readonly kind: ArtifactKind;
    readonly title: string;
    readonly content: ArtifactContent;
    readonly refs: readonly Ref[];
    readonly domains?: readonly ObjectId[];
} | {
    readonly action: "revise";
    readonly target: ObjectRef;
    readonly title: string;
    readonly content: ArtifactContent;
    readonly refs: readonly Ref[];
    readonly reason: string;
} | {
    readonly action: "retire";
    readonly target: ObjectRef;
    readonly reason: string;
} | {
    readonly action: "correct";
    readonly target: ObjectRef;
    readonly content: ArtifactContent;
    readonly reason: string;
    readonly evidence_refs: readonly Ref[];
};
export interface ContributionPayload {
    readonly invocation_id: ObjectId;
    readonly attempt_id: ObjectId;
    readonly summary: string;
    readonly artifact_refs: readonly ObjectRef[];
    readonly evidence_refs: readonly Ref[];
    readonly limitations: string;
    readonly source: {
        readonly kind: "self";
    } | {
        readonly kind: "external";
        readonly label: string;
        readonly refs: readonly Ref[];
    };
    readonly contribution_id?: ObjectId;
}
export interface FindingPayload {
    readonly invocation_id: ObjectId;
    readonly kind: "issue" | "opportunity" | "gap" | "risk" | "question";
    readonly statement: string;
    readonly impact: string;
    readonly evidence_refs: readonly Ref[];
    readonly coverage_ids: readonly ObjectId[];
    readonly options?: readonly string[];
    readonly responsible_member_id?: SessionId;
}
export type Disposition = "accepted" | "rejected" | "revise" | "deferred" | "unresolved";
export interface DecisionPayload {
    readonly invocation_id: ObjectId;
    readonly target: ObjectRef;
    readonly disposition: Disposition;
    readonly reason: string;
    readonly evidence_refs: readonly Ref[];
    readonly consequence: string;
}
export type CheckResult = "passed" | "failed" | "partial" | "not_run" | "unavailable";
export type CheckInput = {
    readonly kind: "execution";
    readonly target: ObjectRef;
    readonly criterion_ids: readonly ObjectId[];
    readonly method: string;
    readonly action: string;
    readonly result: CheckResult;
    readonly evidence_refs: readonly Ref[];
    readonly limits: string;
} | {
    readonly kind: "applicability";
    readonly prior_check: ObjectRef;
    readonly current_target: ObjectRef;
    readonly criterion_ids: readonly ObjectId[];
    readonly scope: string;
    readonly rationale: string;
    readonly impact_refs: readonly Ref[];
} | {
    readonly kind: "resolution";
    readonly target: ObjectRef;
    readonly criterion_ids: readonly ObjectId[];
    readonly conflicting_check_refs: readonly ObjectRef[];
    readonly conclusion: "invalid_observation" | "replaced" | "still_failing";
    readonly replacement_check_refs: readonly ObjectRef[];
    readonly rationale: string;
    readonly evidence_refs: readonly Ref[];
};
export interface ChallengePayload {
    readonly invocation_id: ObjectId;
    readonly target: ObjectRef;
    readonly statement: string;
    readonly contradicting_refs: readonly Ref[];
    readonly impact: string;
}
export interface ResolveChallengePayload {
    readonly invocation_id: ObjectId;
    readonly challenge_id: ObjectId;
    readonly resolution: "upheld" | "dismissed" | "superseded";
    readonly reason: string;
    readonly evidence_refs: readonly Ref[];
    readonly replacement_ref?: ObjectRef;
}
export interface Blocker {
    readonly statement: string;
    readonly coverage_ids: readonly ObjectId[];
    readonly clearing_evidence_refs: readonly Ref[];
}
export interface NextPayload {
    readonly invocation_id: ObjectId;
    readonly action: string;
    readonly intended_result: string;
    readonly owner_id?: SessionId;
    readonly blockers: readonly Blocker[];
}
export interface Completion {
    readonly candidate_ref: ObjectRef;
    readonly coverage: readonly {
        readonly coverage_id: ObjectId;
        readonly decision_refs: readonly ObjectRef[];
        readonly check_refs: readonly ObjectRef[];
    }[];
}
export type LifecyclePayload = {
    readonly invocation_id: ObjectId;
    readonly reason: string;
    readonly evidence_refs: readonly Ref[];
} & ({
    readonly transition: "block" | "resume" | "abandon" | "reopen";
} | {
    readonly transition: "complete";
    readonly completion: Completion;
});
export interface WorkPayloads {
    open: OpenPayload;
    amend_frame: AmendFramePayload;
    plan_attempt: PlanAttemptPayload;
    update_attempt: {
        readonly invocation_id: ObjectId;
        readonly attempt_id: ObjectId;
        readonly change: AttemptChange;
    };
    put_artifact: {
        readonly invocation_id: ObjectId;
        readonly change: ArtifactChange;
    };
    submit_contribution: ContributionPayload;
    record_finding: FindingPayload;
    decide: DecisionPayload;
    set_candidate: {
        readonly invocation_id: ObjectId;
        readonly source_ref: Ref;
        readonly description: string;
        readonly dirty: boolean;
    };
    record_check: {
        readonly invocation_id: ObjectId;
        readonly check: CheckInput;
    };
    record_challenge: ChallengePayload;
    resolve_challenge: ResolveChallengePayload;
    set_next: NextPayload;
    set_lifecycle: LifecyclePayload;
}
export type CommandOf<M> = {
    [K in keyof M & string]: {
        readonly action: K;
        readonly payload: M[K];
    };
}[keyof M & string];
export type WorkCommand = CommandOf<WorkPayloads>;
export const WORK_ACTIONS = ["open", "amend_frame", "plan_attempt", "update_attempt", "put_artifact", "submit_contribution", "record_finding", "decide", "set_candidate", "record_check", "record_challenge", "resolve_challenge", "set_next", "set_lifecycle"] as const;
export interface CoachingPayload {
    readonly invocation_id: ObjectId;
    readonly attempt_id: ObjectId;
    readonly observed_problem: string;
    readonly diagnosis: string;
    readonly instruction: string;
    readonly exposure_refs: readonly Ref[];
    readonly intended_transfer: string;
}
export interface ReflectionPayload {
    readonly invocation_id: ObjectId;
    readonly domain_id: ObjectId;
    readonly title: string;
    readonly problem: string;
    readonly actions_and_evidence: string;
    readonly judgment_change: string;
    readonly limits: string;
    readonly next_test: string;
    readonly fact_refs: readonly Ref[];
    readonly retrospective: boolean;
    readonly reflection_id?: ObjectId;
    readonly amendment?: {
        readonly target: ObjectRef;
        readonly mode: "correct" | "withdraw";
        readonly reason: string;
    };
}
export interface ReviewFinding {
    readonly id?: string;
    readonly statement: string;
    readonly blocking: boolean;
    readonly evidence_refs: readonly Ref[];
}
export interface ReviewPayload {
    readonly invocation_id: ObjectId;
    readonly proposal_ref: ObjectRef;
    readonly verdict: "approve" | "revise" | "reject";
    readonly findings: readonly ReviewFinding[];
    readonly evidence_refs: readonly Ref[];
}
export interface PublishPayload {
    readonly invocation_id: ObjectId;
    readonly proposal_ref: ObjectRef;
    readonly review_refs: readonly ObjectRef[];
}
export interface Applicability {
    readonly task_types: readonly string[];
    readonly interface_versions: readonly string[];
    readonly required_capabilities: readonly string[];
}
export interface LessonPayload {
    readonly invocation_id: ObjectId;
    readonly title: string;
    readonly trigger: string;
    readonly action: string;
    readonly supporting_refs: readonly Ref[];
    readonly counterexamples: string;
    readonly applicability: Applicability;
    readonly invalidation_condition: string;
    readonly lesson_id?: ObjectId;
}
export type LessonStatus = "proposed" | "supported" | "contested" | "retired";
export type Assessment = {
    readonly kind: "application";
    readonly invocation_id: ObjectId;
    readonly attempt_id: ObjectId;
    readonly context: string;
    readonly action_taken: string;
    readonly result: "supports" | "contradicts" | "inconclusive";
    readonly case_kind?: "original" | "unseen" | "counterexample" | "unknown";
    readonly check_refs: readonly ObjectRef[];
    readonly limits: string;
} | {
    readonly kind: "decision";
    readonly status: Exclude<LessonStatus, "proposed">;
    readonly reason: string;
    readonly application_refs: readonly ObjectRef[];
    readonly review_ref: ObjectRef;
};
export interface DomainDefinition {
    readonly title: string;
    readonly questions: string;
    readonly audience: string;
    readonly overview: string;
}
export type DomainChange = ({
    readonly kind: "create";
} & DomainDefinition) | ({
    readonly kind: "revise";
    readonly domain_ref: ObjectRef;
} & DomainDefinition) | {
    readonly kind: "move";
    readonly publication_ref: ObjectRef;
    readonly from_domain: ObjectId;
    readonly to_domain: ObjectId;
    readonly reason: string;
} | {
    readonly kind: "split";
    readonly domain_ref: ObjectRef;
    readonly new_domains: readonly (DomainDefinition & {
        readonly key: string;
    })[];
    readonly entry_assignments: readonly {
        readonly publication_ref: ObjectRef;
        readonly domain_key: string;
    }[];
    readonly reason: string;
} | {
    readonly kind: "retire";
    readonly domain_ref: ObjectRef;
    readonly successor_id: ObjectId;
    readonly reason: string;
};
export interface LearnPayloads {
    record_coaching: CoachingPayload;
    propose_reflection: ReflectionPayload;
    review_reflection: ReviewPayload;
    publish_reflection: PublishPayload;
    amend_publication: PublishPayload & {
        readonly target: ObjectRef;
        readonly reason: string;
        readonly mode: "correct" | "withdraw";
    };
    propose_lesson: LessonPayload;
    assess_lesson: {
        readonly invocation_id: ObjectId;
        readonly lesson_ref: ObjectRef;
        readonly assessment: Assessment;
    };
    organize_domain: {
        readonly invocation_id: ObjectId;
        readonly change: DomainChange;
    };
}
export type LearnCommand = CommandOf<LearnPayloads>;
export const LEARN_ACTIONS = ["record_coaching", "propose_reflection", "review_reflection", "publish_reflection", "amend_publication", "propose_lesson", "assess_lesson", "organize_domain"] as const;
export type DomainCommand = WorkCommand | LearnCommand;
export type CommandEnvelope<C = DomainCommand> = C & {
    readonly expected_revision: CommitId;
    readonly operation_id: string;
};
export type WriteEnvelope<C = DomainCommand> = CommandEnvelope<C>;
export interface TransactionRequest<C = DomainCommand> {
    readonly archiveId: ArchiveId;
    readonly expectedRevision: CommitId;
    readonly operationId: string;
    readonly command: C;
}
export interface ContentDescriptor {
    readonly digest: Digest;
    readonly bytes: number;
    readonly media_type: string;
}
export type ContentWrite = {
    readonly kind: "inline";
    readonly digest: Digest;
    readonly bytes: Uint8Array;
    readonly media_type: string;
} | {
    readonly kind: "sealed";
    readonly handle: string;
    readonly digest: Digest;
    readonly bytes: number;
    readonly media_type: string;
};
export interface CoverageBody {
    readonly invocation_id: ObjectId;
    readonly key: string;
    readonly title: string;
    readonly requirement: string;
    readonly required: boolean;
    readonly authority_refs: readonly AuthorityRef[];
    readonly retired: boolean;
}
export interface CriterionBody {
    readonly invocation_id: ObjectId;
    readonly key: string;
    readonly coverage_ids: readonly ObjectId[];
    readonly statement: string;
    readonly critical: boolean;
    readonly method: string;
    readonly retired: boolean;
}
export type Lifecycle = "active" | "blocked" | "completed" | "abandoned";
export interface InvocationBody {
    readonly title: string;
    readonly goal: string;
    readonly deliverable: string;
    readonly subject: string;
    readonly constraints: string;
    readonly exclusions: string;
    readonly frame_revision: number;
    readonly frame_history?: readonly {
        readonly frame_revision: number;
        readonly group: string;
        readonly rationale: string;
        readonly authority_ref?: AuthorityRef;
    }[];
    readonly lead: ActorIdentity;
    readonly lifecycle: Lifecycle;
    readonly coverage_ids: readonly ObjectId[];
    readonly criterion_ids: readonly ObjectId[];
    readonly candidate_ref?: ObjectRef;
    readonly next?: NextPayload;
    readonly lifecycle_history: readonly {
        readonly transition: string;
        readonly reason: string;
        readonly evidence_refs: readonly Ref[];
        readonly completion?: Completion;
    }[];
}
export interface AttemptBody extends PlanAttemptPayload {
    readonly progress: AttemptProgress;
    readonly progress_history?: readonly {
        readonly state: AttemptProgress;
        readonly reason: string;
    }[];
    readonly binding_history: readonly {
        readonly member_id: SessionId;
        readonly creation_ref: Ref;
        readonly exposure: string;
        readonly reason: string;
    }[];
    readonly replacement_attempt_id?: ObjectId;
}
export interface ArtifactBody {
    readonly invocation_id: ObjectId;
    readonly kind: ArtifactKind;
    readonly title: string;
    readonly content: ContentDescriptor;
    readonly refs: readonly Ref[];
    readonly domains: readonly ObjectId[];
    readonly status: "current" | "retired";
    readonly editors: readonly ActorIdentity[];
    readonly correction_of?: ObjectRef;
    readonly reason?: string;
}
export interface DecisionContext {
    readonly frame_revision: number;
    readonly candidate_ref?: ObjectRef;
}
export interface RecordBodies {
    invocation: InvocationBody;
    coverage: CoverageBody;
    criterion: CriterionBody;
    attempt: AttemptBody;
    artifact: ArtifactBody;
    contribution: ContributionPayload;
    finding: FindingPayload;
    decision: DecisionPayload & DecisionContext;
    candidate: WorkPayloads["set_candidate"] & {
        readonly frame_revision: number;
    };
    check: WorkPayloads["record_check"] & DecisionContext & {
        readonly provenance: "reported" | "observed";
    };
    challenge: ChallengePayload & {
        readonly resolution?: Omit<ResolveChallengePayload, "invocation_id" | "challenge_id">;
    };
    coaching: CoachingPayload;
    reflection: ReflectionPayload & {
        readonly status: "draft" | "published";
    };
    review: ReviewPayload;
    publication: PublishPayload & {
        readonly domain_id: ObjectId;
        readonly sequence: number;
        readonly status: "current" | "withdrawn";
        readonly supersedes?: ObjectRef;
        readonly reason?: string;
    };
    lesson: LessonPayload;
    application: {
        readonly invocation_id: ObjectId;
        readonly lesson_ref: ObjectRef;
        readonly assessment: Extract<Assessment, {
            kind: "application";
        }>;
    };
    assessment: {
        readonly invocation_id: ObjectId;
        readonly lesson_ref: ObjectRef;
        readonly assessment: Extract<Assessment, {
            kind: "decision";
        }>;
    };
    domain: DomainDefinition & {
        readonly invocation_id: ObjectId;
        readonly retired: boolean;
        readonly successor_id?: ObjectId;
        readonly primary_publication_ids?: readonly ObjectId[];
        readonly overview_author?: ActorIdentity;
        readonly change_kind?: "create" | "revise" | "move" | "split" | "retire";
        readonly change_reason?: string;
    };
}
export type ObjectKind = keyof RecordBodies;
export type RecordOf<K extends ObjectKind> = {
    readonly format: typeof ARCHIVE_FORMAT;
    readonly kind: K;
    readonly id: ObjectId;
    readonly object_revision: number;
    readonly created_sequence: number;
    readonly updated_sequence: number;
    readonly author: ActorIdentity;
    readonly body: RecordBodies[K];
};
export type DomainRecord = {
    [K in ObjectKind]: RecordOf<K>;
}[ObjectKind];
export const OBJECT_KINDS = ["invocation", "coverage", "criterion", "attempt", "artifact", "contribution", "finding", "decision", "candidate", "check", "challenge", "coaching", "reflection", "review", "publication", "lesson", "application", "assessment", "domain"] as const;
export interface Snapshot {
    readonly archiveId: ArchiveId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly revision: CommitId;
    readonly sequence: number;
    readonly formatVersion: typeof FORMAT_VERSION;
    readonly rendererVersion: string;
    readonly policy: PolicySnapshot;
    readonly bindings: readonly ProjectBinding[];
    readonly objects: readonly DomainRecord[];
    readonly objectHistory?: readonly DomainRecord[];
}
export type SemanticResult = {
    readonly id?: ObjectId;
    readonly object_revision?: number;
    readonly invocation_id?: ObjectId;
    readonly ids?: Readonly<Record<string, ObjectId>>;
    readonly status?: string;
    readonly message?: string;
};
export type ViewSelection = {
    readonly kind: "checkpoint";
    readonly invocation_id: ObjectId;
} | {
    readonly kind: "reading";
    readonly domain_id: ObjectId;
} | {
    readonly kind: "overview";
} | {
    readonly kind: "object";
    readonly object_id: ObjectId;
};
export interface MutationPlan {
    readonly upserts: readonly DomainRecord[];
    readonly content: readonly ContentWrite[];
    readonly views: readonly ViewSelection[];
    readonly result: SemanticResult;
    readonly policy?: PolicySnapshot;
}
export interface NativeMember {
    readonly sessionId: SessionId;
    readonly rootSessionId: SessionId;
    readonly name: string;
    readonly contextMode: "fresh" | "fork" | "continue";
    readonly creationRef: Ref;
}
export interface Approval {
    readonly id: string;
    readonly archiveId: ArchiveId;
    readonly invocationId?: ObjectId;
    readonly action: string;
    readonly active: boolean;
    readonly expires_at?: number;
}
export interface TrustedFacts {
    readonly actor: Actor;
    readonly now: number;
    readonly newId: (kind: ObjectKind) => ObjectId;
    readonly nativeMembers?: readonly NativeMember[];
    readonly approvals?: readonly Approval[];
    readonly contents?: readonly (ContentDescriptor & {
        readonly input: ArtifactContent;
        readonly write: ContentWrite;
    })[];
    readonly observedEventRefs?: readonly Ref[];
    readonly nativeTaskRefs?: readonly Extract<Ref, {
        kind: "native_task";
    }>[];
    readonly reviewerReassignments?: readonly ReviewerReassignment[];
}
export type FailureCode = "invalid_input" | "invalid_transition" | "not_authorized" | "not_found" | "binding_required" | "binding_ambiguous" | "revision_conflict" | "object_changed" | "operation_key_conflict" | "budget_exceeded" | "cursor_expired" | "storage_unavailable" | "lock_busy" | "outcome_unknown" | "unsupported_version" | "archive_corrupt" | "stale_inventory" | "destination_exists" | "restore_read_only" | "source_changed" | "remote_conflict" | "source_stop_required";
export interface Failure {
    readonly status: "refused";
    readonly code: FailureCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly field?: string;
    readonly current_revision?: CommitId;
}
export type Result<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: Failure;
};
export function success<T>(value: T): Result<T> {
    return {
        ok: true, value
    };
}
export function failure(code: FailureCode, message: string, field?: string): Result<never> {
    return {
        ok: false, error: {
            status: "refused", code, message, retryable: code === "storage_unavailable" || code === "lock_busy", ...(field === undefined ? {} : {
                field
            })
        }
    };
}
export type Reducer<C = DomainCommand> = (snapshot: Snapshot, command: C, facts: TrustedFacts) => Result<MutationPlan>;
export interface Receipt {
    readonly status: "committed";
    readonly operation_id: string;
    readonly committed_revision: CommitId;
    readonly head_revision: CommitId;
    readonly sequence: number;
    readonly changed: readonly {
        readonly id: ObjectId;
        readonly object_revision: number;
    }[];
    readonly documents: readonly ViewSelection[];
    readonly result: SemanticResult;
}
export type Query = {
    readonly project_id?: ProjectId;
} & ({
    readonly kind: "context" | "projects";
} | {
    readonly kind: "invocation" | "checkpoint";
    readonly invocation_id: ObjectId;
    readonly revision?: CommitId;
} | {
    readonly kind: "object" | "artifact";
    readonly object_id: ObjectId;
    readonly object_revision?: number;
    readonly revision?: CommitId;
    readonly content_mode?: "summary" | "text" | "bytes";
    readonly cursor?: string;
} | {
    readonly kind: "list";
    readonly object_kind: ObjectKind;
    readonly invocation_id?: ObjectId;
    readonly domain_id?: ObjectId;
    readonly status?: string;
    readonly revision?: CommitId;
    readonly cursor?: string;
    readonly page_size?: number;
} | ({
    readonly kind: "history";
    readonly revision?: CommitId;
    readonly cursor?: string;
    readonly page_size?: number;
} & ({
    readonly object_id: ObjectId;
} | {
    readonly invocation_id: ObjectId;
})) | {
    readonly kind: "reading";
    readonly domain_id: ObjectId;
    readonly revision?: CommitId;
    readonly include_drafts?: boolean;
    readonly cursor?: string;
    readonly page_size?: number;
} | {
    readonly kind: "lessons";
    readonly task_context: Applicability;
    readonly domain_id?: ObjectId;
    readonly status?: LessonStatus;
    readonly revision?: CommitId;
    readonly text?: string;
    readonly cursor?: string;
    readonly page_size?: number;
} | {
    readonly kind: "receipt";
    readonly operation_id: string;
} | {
    readonly kind: "environment_preferences";
    readonly role: string;
    readonly task_context: Applicability;
});
export interface ProjectSummary {
    readonly project_id: ProjectId;
    readonly title: string;
    readonly read_revision: CommitId;
    readonly authorization_epoch: number;
    readonly capabilities: readonly string[];
    readonly binding_id?: string;
}
export interface ReadPage<T = QueryItem> {
    readonly project_id: ProjectId;
    readonly read_revision: CommitId;
    readonly authorization_epoch: number;
    readonly items: readonly T[];
    readonly completeness: "complete" | "partial";
    readonly partial_reason?: string;
    readonly next_cursor?: string;
}
export type UploadCommand = {
    readonly action: "begin";
    readonly payload: {
        readonly media_type: string;
        readonly total_bytes: number;
        readonly digest: Digest;
        readonly invocation_id: ObjectId;
    };
} | {
    readonly action: "chunk";
    readonly payload: {
        readonly upload_id: string;
        readonly offset: number;
        readonly bytes: string;
        readonly digest: Digest;
    };
} | {
    readonly action: "status" | "commit" | "seal" | "cancel";
    readonly payload: {
        readonly upload_id: string;
    };
};
export interface ArchiveLimits {
    readonly inline_input_bytes: number;
    readonly response_bytes: number;
    readonly artifact_bytes: number;
    readonly upload_chunk_bytes: number;
    readonly upload_total_bytes: number;
    readonly concurrent_uploads: number;
    readonly page_items: number;
}
export interface AdminPayloads {
    initialize: {
        readonly root_handle: string;
        readonly source_descriptor: SourceDescriptor;
        readonly initial_grants: readonly GrantRequest[];
        readonly limits: ArchiveLimits;
    };
    bind: {
        readonly source_descriptor: SourceDescriptor;
        readonly mapping_evidence: readonly Ref[];
        readonly reason: string;
    };
    rebind: AdminPayloads["bind"];
    grant: GrantRequest & {
        readonly reason: string;
    };
    revoke: {
        readonly grant_id: string;
        readonly reason: string;
    };
    takeover: {
        readonly invocation_id: ObjectId;
        readonly new_lead_session_id: SessionId;
        readonly reason: string;
    };
    assign_reviewer: {
        readonly proposal_ref: ObjectRef;
        readonly reviewer_session_id: SessionId;
        readonly delegated_rights: readonly Right[];
    };
    pause: {
        readonly reason: string;
    };
    resume: {
        readonly reason: string;
        readonly diagnostic_ref: Ref;
    };
    inventory_import: {
        readonly source_handle: string;
        readonly selection: readonly string[];
        readonly budget: number;
    };
    commit_import: {
        readonly inventory_id: string;
        readonly accepted_exceptions: readonly string[];
        readonly approval_ref: AuthorityRef;
    };
    export: {
        readonly revision: CommitId;
        readonly selection: readonly ObjectId[];
        readonly destination_handle: string;
        readonly overwrite_approval?: AuthorityRef;
    };
    backup: {
        readonly revision: CommitId;
        readonly destination_handle: string;
    };
    restore: {
        readonly backup_handle: string;
        readonly mapping_evidence: readonly Ref[];
    };
    activate_restore: {
        readonly candidate_id: string;
        readonly mode: "lossless" | "lossy";
        readonly source_descriptor: SourceDescriptor;
        readonly initial_grants: readonly GrantRequest[];
        readonly approval_ref: AuthorityRef;
        readonly source_stop_evidence: readonly Ref[];
        readonly final_head_ref?: AuthorityRef;
        readonly loss_statement?: string;
    };
    relocate: {
        readonly destination_handle: string;
        readonly source_stop_evidence: readonly Ref[];
        readonly mapping_evidence: readonly Ref[];
        readonly source_descriptor: SourceDescriptor;
        readonly initial_grants: readonly GrantRequest[];
        readonly approval_ref: AuthorityRef;
    };
    plan_maintenance: {
        readonly kind: "gc" | "purge";
        readonly backup_handle: string;
        readonly content_digests?: readonly Digest[];
        readonly reason: string;
    } | {
        readonly kind: "legacy_upgrade";
        readonly source_handle: string;
        readonly target_format: string;
        readonly reason: string;
    };
    upgrade: {
        readonly target_format: string;
        readonly migration_plan_ref: Ref;
        readonly approval_ref: AuthorityRef;
        readonly source_stop_ref: AuthorityRef;
        readonly source_stop_evidence: readonly Ref[];
    };
    diagnose: {
        readonly scope: string;
    };
    maintain: {
        readonly plan_ref: Ref;
        readonly approval_ref: AuthorityRef;
    };
    configure_replica: {
        readonly destination_handle: string;
        readonly credential_handle: string;
        readonly expected_remote_identity: string;
    };
    push_replica: {
        readonly replica_id: string;
        readonly local_revision: CommitId;
    };
    fetch_replica: {
        readonly replica_id: string;
        readonly expected_remote_revision: CommitId;
    };
}
export type AdminCommand = CommandOf<AdminPayloads>;
export type SourceDescriptor = Omit<ProjectBinding, "bindingId" | "active">;
export type AdminEnvelope = (Extract<AdminCommand, {
    action: "initialize";
}> & {
    readonly expected_revision: "absent";
    readonly operation_id: string;
}) | (Exclude<AdminCommand, {
    action: "initialize";
}> & {
    readonly project_id: ProjectId;
    readonly expected_revision: CommitId;
    readonly operation_id: string;
});
export interface OwnerContext {
    readonly capabilities: readonly string[];
    readonly root_handles: readonly string[];
    readonly source_handles: readonly string[];
    readonly destination_handles: readonly string[];
    readonly projects: readonly ProjectSummary[];
    /**
     * The authenticated owner this response was produced for.
     *
     * `initialize` requires at least one initial grant, and a grant's `subject` is
     * an `ActorIdentity`. Before this field existed a Client could only obtain a
     * legal subject by being told the ids out of band — which meant either asking a
     * user to type internal identifiers or having a probe read them from a fixture.
     * Both are guesses dressed as authority, so the owner is stated here instead.
     *
     * The value is derived from the **verified invocation** (the same principal the
     * owner guard already admitted), narrowed to its owner variant and projected by
     * {@link actorIdentity}; it is never read from a request body, so a caller cannot
     * assert a subject and have it echoed.
     *
     * The type is the **owner variant only** rather than the whole `ActorIdentity`
     * union: this context is reachable only through an owner-guarded endpoint, so a
     * `session` subject here would mean the guard failed. Declaring the narrow type
     * makes that unrepresentable instead of leaving a reader to infer it.
     *
     * It carries two opaque host-scoped ids and no credential, cookie or signature.
     */
    readonly current_owner: Extract<ActorIdentity, { kind: "owner" }>;
}
export interface ArchiveInterface {
    execute(actor: Actor, request: TransactionRequest, signal: AbortSignal): Promise<Result<Receipt>>;
    query(actor: Actor, target: BoundTarget, query: Query, signal: AbortSignal): Promise<Result<ReadPage>>;
}
export interface RenderedView {
    readonly selection: ViewSelection;
    readonly media_type: "text/markdown";
    readonly text: string;
    readonly renderer_version: string;
}
export interface Projection {
    render(snapshot: Snapshot, selections: readonly ViewSelection[]): readonly RenderedView[];
}
/** Already-authorized IO facts supplied to the pure query module. */
export interface HistoryEntry {
    readonly committed_revision: CommitId;
    readonly operation_id: string;
    readonly sequence: number;
    readonly action: string;
    readonly actor: ActorIdentity;
    readonly changed: readonly ObjectRef[];
}
export interface ArtifactPage extends ContentDescriptor {
    readonly object_ref: ObjectRef;
    readonly offset: number;
    readonly next_offset?: number;
    readonly text?: string;
    readonly base64?: string;
}
export interface EnvironmentPreferences {
    readonly role: string;
    readonly desired_revision: string;
    readonly applied_status: "pending" | "applied" | "failed" | "unknown";
    readonly candidates: readonly {
        readonly selection: RequestedSelection;
        readonly reason: string;
        readonly availability: "available" | "unavailable" | "unknown";
    }[];
}
export interface LessonMatch {
    readonly lesson: RecordOf<"lesson">;
    readonly status: LessonStatus;
    readonly applicability: "matched" | "unknown" | "mismatch";
    readonly reasons: readonly string[];
    readonly snippet?: string;
}
export type QueryItem = DomainRecord | ProjectSummary | Receipt | HistoryEntry | ArtifactPage | EnvironmentPreferences | RenderedView | LessonMatch | StructuredContentPage;
export interface QueryFacts {
    readonly actor: Actor;
    readonly now: number;
    readonly responseBytes?: number;
    readonly pageItems?: number;
    readonly searchScanObjects?: number;
    readonly offset?: number;
    readonly nextCursor?: (nextOffset: number) => string;
    readonly receipt?: Receipt;
    readonly history?: readonly HistoryEntry[];
    readonly content?: ArtifactPage;
    readonly environment?: EnvironmentPreferences;
    readonly projects?: readonly ProjectSummary[];
    readonly resolveObject?: (ref: ObjectRef) => DomainRecord | undefined;
}
/** Complete generated representation, distinct from an artifact's original bytes. */
export interface StructuredContentPage {
    readonly kind: "object_content";
    readonly generated: true;
    readonly object_ref: ObjectRef;
    readonly media_type: "application/json" | "text/markdown";
    readonly total_bytes: number;
    readonly offset: number;
    readonly next_offset?: number;
    readonly text?: string;
    readonly base64?: string;
}
