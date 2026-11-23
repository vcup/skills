/** Recovery policy is explicit; Registry alone publishes identity, grants and location changes. */
import { createHash, randomUUID } from "node:crypto";
import { actorKey, failure, success, type Actor, type GrantRequest, type Ref, type Result, type SourceDescriptor } from "../../../modules/ensemble/contracts.ts";
import type { QuarantineCandidate } from "./history.ts";
export interface ActivationRequest {
    operationId: string;
    expectedRevision: string;
    businessDigest?: string;
    candidateId: string;
    mode: "lossless" | "lossy";
    source: SourceDescriptor;
    grants: readonly GrantRequest[];
    approvalId: string;
    finalHeadEvidence?: string;
    sourceStopEvidence: readonly Ref[];
    lossStatement?: string;
}
export interface RecoveryAccess {
    /** Registry performs owner validation, source mapping validation, lock order and single-writer switching. */
    activate(actor: Actor, archiveId: string, candidate: QuarantineCandidate, root: string, request: ActivationRequest, signal: AbortSignal): Promise<Result<{
        archiveId: string;
        projectId: string;
        revision: string;
        rebound: true;
        reauthorized: true;
    }>>;
    approval(actor: Actor, archiveId: string, approvalId: string, action: string, targetDigest: string, signal: AbortSignal): Promise<boolean>;
    finalHead(actor: Actor, expected: {
        archiveId: string;
        head: string;
    }, evidenceId: string, signal: AbortSignal): Promise<Result<{
        archiveId: string;
        head: string;
        stopped: true;
    }>>;
}
export function createRecoveryMaintenance(deps: {
    access: RecoveryAccess;
    candidate(id: string): {
        candidate: QuarantineCandidate;
        root: string;
    } | undefined;
}) {
    async function activate(actor: Actor, archiveId: string, request: ActivationRequest, signal: AbortSignal) {
        if (actor.kind !== "owner" || actor.channel !== "authenticated-remote")
            return failure("not_authorized", "recovery activation requires current owner authentication");
        const saved = deps.candidate(request.candidateId);
        if (!saved)
            return failure("not_found", "quarantine candidate not found; restore again");
        if (!request.grants.length || !request.source || request.sourceStopEvidence === undefined)
            return failure("invalid_input", "recovery requires an explicit new mapping and fresh grants");
        if (request.mode === "lossless") {
            if (!request.finalHeadEvidence || request.sourceStopEvidence.length === 0)
                return failure("source_stop_required", "lossless recovery needs stopped-primary final-head evidence");
            const proof = await deps.access.finalHead(actor, { archiveId: saved.candidate.identity.archiveId, head: saved.candidate.identity.head }, request.finalHeadEvidence, signal);
            if (!proof.ok)
                return proof;
            if (proof.value.archiveId !== saved.candidate.identity.archiveId || proof.value.head !== saved.candidate.identity.head || !proof.value.stopped)
                return failure("restore_read_only", "candidate is not proven to contain the stopped primary's final receipts; retain read-only");
        }
        else if (request.mode === "lossy") {
            if (!request.lossStatement?.trim())
                return failure("invalid_input", "lossy recovery must declare lost or unknown history intervals");
        }
        else
            return failure("invalid_input", "unknown recovery mode");
        const digest = saved.candidate.backupDigest;
        // The approval is issued by the owner for the *candidate's archive
        // identity* — that is the only identity the restore preview can name,
        // because a lossy recovery has no project yet. Verifying it against a
        // project id made every real activation fail as not_authorized.
        if (!await deps.access.approval(actor, saved.candidate.identity.archiveId, request.approvalId, "activate_restore", digest, signal))
            return failure("not_authorized", "exact recovery plan needs current owner approval");
        // No grant from candidate history is ever passed to Registry. It mints fresh grant ids and retry namespace.
        const result = await deps.access.activate(actor, archiveId, saved.candidate, saved.root, request, signal);
        if (result.ok && request.mode === "lossy" && result.value.archiveId === saved.candidate.identity.archiveId)
            return failure("archive_corrupt", "Registry failed to allocate a new identity for lossy recovery");
        return result;
    }
    return { activate };
}
