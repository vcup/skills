/** Current authorization, independent of IO and historical read revisions. */
import { actorKey, failure, success, type Actor, type ActorIdentity, type DomainCommand, type DomainRecord, type Grant, type GrantScope, type ObjectRef, type Right, type Snapshot, type TrustedFacts, type Result } from "./contracts.ts";
export function sameActor(left: Actor | ActorIdentity, right: Actor | ActorIdentity): boolean {
    return actorKey(left) === actorKey(right);
}
export function sameRef(left: ObjectRef, right: ObjectRef): boolean {
    return left.object_id === right.object_id && left.object_revision === right.object_revision;
}
export function objectAt(snapshot: Snapshot, ref: ObjectRef): DomainRecord | undefined {
    return snapshot.objects.find((o) => o.id === ref.object_id && o.object_revision === ref.object_revision)
        ?? snapshot.objectHistory?.find((o) => o.id === ref.object_id && o.object_revision === ref.object_revision);
}
function invocationOf(snapshot: Snapshot, scope: GrantScope): string | undefined {
    if (scope.kind === "invocation")
        return scope.invocation_id;
    const id = scope.kind === "attempt" ? scope.attempt_id : scope.kind === "proposal" ? scope.proposal_ref.object_id : undefined;
    const object = snapshot.objects.find((o) => o.id === id);
    return object && "invocation_id" in object.body ? object.body.invocation_id : undefined;
}
function includesScope(snapshot: Snapshot, grant: GrantScope, requested: GrantScope): boolean {
    if (grant.kind === "project")
        return true;
    if (grant.kind === "invocation")
        return invocationOf(snapshot, requested) === grant.invocation_id;
    if (grant.kind === "attempt")
        return requested.kind === "attempt" && grant.attempt_id === requested.attempt_id;
    return requested.kind === "proposal" && sameRef(grant.proposal_ref, requested.proposal_ref);
}
function activeGrant(snapshot: Snapshot, grant: Grant, now: number, seen = new Set<string>()): boolean {
    if (grant.revoked || (grant.expires_at !== undefined && grant.expires_at <= now) || seen.has(grant.id))
        return false;
    if (!grant.delegated_from)
        return true;
    const parent = snapshot.policy.grants.find((g) => g.id === grant.delegated_from);
    if (!parent || !grant.rights.every((right) => parent.delegable_rights?.includes(right)) || !(grant.delegable_rights ?? []).every((right) => parent.delegable_rights?.includes(right)) || !includesScope(snapshot, parent.scope, grant.scope))
        return false;
    const next = new Set(seen);
    next.add(grant.id);
    return activeGrant(snapshot, parent, now, next);
}
/** Owner access is valid only after the trusted Remote/registry admits this archive. */
export function hasRight(snapshot: Snapshot, actor: Actor | ActorIdentity, right: Right, scope: GrantScope, now: number): boolean {
    if (actor.kind === "owner")
        return true;
    if (!Number.isFinite(now))
        return false;
    return snapshot.policy.grants.some((grant) => {
        if (!sameActor(grant.subject, actor) || !grant.rights.includes(right) || !activeGrant(snapshot, grant, now))
            return false;
        // A general ability to review is not an assignment to this exact proposal.
        if (right === "review" && scope.kind === "proposal" && grant.scope.kind !== "proposal")
            return false;
        return includesScope(snapshot, grant.scope, scope);
    });
}
export function isAssignedReviewer(snapshot: Snapshot, actor: Actor | ActorIdentity, proposal: ObjectRef, now: number): boolean {
    if (actor.kind !== "session")
        return false;
    const object = objectAt(snapshot, proposal);
    return object !== undefined && !sameActor(object.author, actor)
        && hasRight(snapshot, actor, "review", {
            kind: "proposal", proposal_ref: proposal
        }, now);
}
export function isLead(snapshot: Snapshot, actor: Actor | ActorIdentity, invocationId: string, now: number): boolean {
    if (actor.kind !== "session")
        return false;
    const invocation = snapshot.objects.find((o) => o.kind === "invocation" && o.id === invocationId);
    if (!invocation || invocation.kind !== "invocation" || !sameActor(invocation.body.lead, actor))
        return false;
    // open grants own-invocation leadership; revoking it removes this derived authority.
    return hasRight(snapshot, actor, "lead", {
        kind: "invocation", invocation_id: invocationId
    }, now)
        || hasRight(snapshot, actor, "open", {
            kind: "project"
        }, now);
}
export function isCurrentMember(snapshot: Snapshot, actor: Actor | ActorIdentity, invocationId: string, now: number, attemptId?: string): boolean {
    if (actor.kind !== "session")
        return false;
    return snapshot.objects.some((object) => object.kind === "attempt"
        && object.body.invocation_id === invocationId
        && (attemptId === undefined || object.id === attemptId)
        && object.body.member_id === actor.sessionId
        && object.body.progress !== "superseded"
        && hasRight(snapshot, actor, "member-submit", {
            kind: "attempt", attempt_id: object.id
        }, now));
}
function reviewerInInvocation(snapshot: Snapshot, actor: Actor, invocationId: string, now: number): boolean {
    return snapshot.policy.grants.some((g) => g.scope.kind === "proposal"
        && invocationOf(snapshot, g.scope) === invocationId
        && isAssignedReviewer(snapshot, actor, g.scope.proposal_ref, now));
}
export function mayReadObject(snapshot: Snapshot, actor: Actor | ActorIdentity, object: DomainRecord, now: number): boolean {
    if (actor.kind === "owner")
        return true;
    if (hasRight(snapshot, actor, "read", {
        kind: "project"
    }, now))
        return true;
    const invocationId = object.kind === "invocation" ? object.id : "invocation_id" in object.body ? object.body.invocation_id : undefined;
    if (invocationId && hasRight(snapshot, actor, "read", {
        kind: "invocation", invocation_id: invocationId
    }, now))
        return true;
    const ref: ObjectRef = {
        kind: "object", object_id: object.id, object_revision: object.object_revision
    };
    return hasRight(snapshot, actor, "read", {
        kind: "proposal", proposal_ref: ref
    }, now);
}
/** Authorization only. Reducers additionally enforce transitions and exact references. */
export function authorizeCommand(snapshot: Snapshot, command: DomainCommand, facts: TrustedFacts): Result<true> {
    const { actor, now } = facts;
    if (actor.kind !== "session")
        return failure("not_authorized", "Model domain commands require a trusted Session actor; owner actions use management.");
    if (snapshot.policy.paused)
        return failure("not_authorized", "Archive is paused for new domain writes.");
    if (command.action === "open") {
        return hasRight(snapshot, actor, "open", {
            kind: "project"
        }, now)
            ? success(true) : failure("not_authorized", "Current project open grant is required.");
    }
    const invocationId = command.payload.invocation_id;
    const invocation = snapshot.objects.find((o) => o.kind === "invocation" && o.id === invocationId);
    if (!invocation)
        return failure("not_found", "Invocation is not available.");
    const lead = isLead(snapshot, actor, invocationId, now);
    const member = isCurrentMember(snapshot, actor, invocationId, now);
    const reviewer = reviewerInInvocation(snapshot, actor, invocationId, now);
    let allowed = false;
    switch (command.action) {
        case "amend_frame":
        case "plan_attempt":
        case "decide":
        case "set_candidate":
        case "resolve_challenge":
        case "set_next":
        case "set_lifecycle":
        case "record_coaching":
        case "publish_reflection":
        case "amend_publication":
            allowed = lead;
            break;
        case "update_attempt":
            allowed = lead || (command.payload.change.kind === "progress" && isCurrentMember(snapshot, actor, invocationId, now, command.payload.attempt_id));
            break;
        case "submit_contribution":
            allowed = command.payload.source.kind === "external" ? lead : isCurrentMember(snapshot, actor, invocationId, now, command.payload.attempt_id);
            break;
        case "put_artifact":
        case "propose_reflection":
        case "propose_lesson":
            allowed = lead || member;
            break;
        case "record_finding":
        case "record_challenge":
            allowed = lead || member || reviewer;
            break;
        case "record_check": {
            const check = command.payload.check;
            // An exact lesson assignment is reusable in a later readable invocation;
            // it does not grant access to that invocation by itself.
            const assignedLessonReviewer = check.kind === "execution"
                && objectAt(snapshot, check.target)?.kind === "lesson"
                && isAssignedReviewer(snapshot, actor, check.target, now)
                && mayReadObject(snapshot, actor, invocation, now);
            allowed = check.kind === "execution" ? lead || member || reviewer || assignedLessonReviewer : lead;
            break;
        }
        case "review_reflection":
            allowed = isAssignedReviewer(snapshot, actor, command.payload.proposal_ref, now);
            break;
        case "assess_lesson":
            allowed = command.payload.assessment.kind === "decision" ? lead : lead || member || reviewer;
            break;
        case "organize_domain":
            allowed = lead && hasRight(snapshot, actor, "organize", {
                kind: "project"
            }, now);
            break;
    }
    return allowed ? success(true) : failure("not_authorized", "Current actor lacks the required role and scoped grant.");
}
/** Returns the exact currently active delegation, not a different matching grant. */
export function findDelegatingGrant(snapshot: Snapshot, actor: Actor | ActorIdentity, right: Right, scope: GrantScope, now: number): Grant | undefined {
    return snapshot.policy.grants.find(grant => sameActor(grant.subject, actor)
        && grant.delegable_rights?.includes(right) && activeGrant(snapshot, grant, now)
        && includesScope(snapshot, grant.scope, scope));
}
