/** Preview/approval orchestration. Destructive publication remains in Registry. */
import { randomUUID } from "node:crypto";
import { actorKey, failure, success, type Actor, type Receipt, type Ref, type Result } from "../../../modules/ensemble/contracts.ts";
import { digestBytes } from "../uploads/index.ts";
import type { ArchiveRegistry } from "../store/index.ts";
import { inspectPurge, PURGE_POLICY } from "./purge.ts";
import type { HistoryMaintenance } from "./history.ts";
export interface MaintenancePlan {
    id: string;
    kind: "gc" | "purge";
    archiveId: string;
    revision: string;
    backupDigest: string;
    candidateId: string;
    contentDigests: readonly string[];
    reason: string;
    affectedCommits: readonly string[];
    affectedArtifacts: readonly string[];
    retainedArtifacts: readonly string[];
    rebuildPolicy: string;
    knownReplicas: readonly string[];
    knownLocalCopies:readonly {copyId:string;revision:string;state:string}[];
    unconfirmedExternalCopies: true;
    digest: string;
    plan_ref: Ref;
}
export interface PlanDependencies {
    registry: ArchiveRegistry;
    history: HistoryMaintenance;
    approval(actor: Actor, archiveId: string, approvalId: string, action: string, targetDigest: string, signal: AbortSignal): Promise<boolean>;
    purge(actor: Actor, archiveId: string, plan: MaintenancePlan, signal: AbortSignal, operationId: string, businessDigest?: string): Promise<Result<unknown>>;
}
export function createMaintenancePlans(deps: PlanDependencies) {
    const plans = new Map<string, {
        actor: string;
        plan: MaintenancePlan;
        expires: number;
    }>();
    async function preview(actor: Actor, archiveId: string, input: {
        kind: "gc" | "purge";
        backupHandle: string;
        reason: string;
        contentDigests?: readonly string[];
    }, signal: AbortSignal): Promise<Result<MaintenancePlan>> {
        const backup = await deps.history.restore(actor, archiveId, input.backupHandle, signal);
        if (!backup.ok)
            return backup;
        const copies=await deps.registry.knownCopies(actor,archiveId,signal);if(!copies.ok)return copies;
        return deps.registry.withOwner(actor, archiveId, signal, async (lease) => {
            if (!lease.snapshot.policy.paused)
                return failure("invalid_transition", "pause writes before planning maintenance");
            if (backup.value.identity.archiveId !== archiveId || backup.value.identity.head !== lease.snapshot.revision)
                return failure("revision_conflict", "maintenance needs a verified backup of the current paused head");
            const digests = [...new Set(input.contentDigests ?? [])].sort();
            if (input.kind === "purge" && (!digests.length || digests.some(d => !/^[0-9a-f]{64}$/.test(d))))
                return failure("invalid_input", "purge requires exact SHA-256 content digests");
            const commits: string[] = [];
            const artifacts = new Set<string>();
            const seen = new Set<string>();
            if (input.kind === "purge")
                for (const revision of await lease.kernel.history(lease.root, lease.snapshot.revision, lease.signal)) {
                    const entries = await lease.kernel.entries(lease.root, revision, lease.signal);
                    if (entries.some(e => digests.some(d => e.path === `content/${d}`)))
                        commits.push(revision);
                    for (const d of digests)
                        if (entries.some(e => e.path === `content/${d}`))
                            seen.add(d);
                }
            for (const record of lease.snapshot.objects)
                if (record.kind === "artifact" && digests.includes(record.body.content.digest))
                    artifacts.add(record.id);
            if (digests.some(d => !seen.has(d)))
                return failure("not_found", "one or more purge digests are absent from published history");
            if (input.kind === "purge" && lease.snapshot.policy.grants.some(g => g.subject.kind === "session" && !g.revoked && (g.expires_at === undefined || g.expires_at > Date.now())))
                return failure("not_authorized", "revoke Session reads before sensitive-content maintenance");
            const impact = input.kind === "purge" ? await inspectPurge(lease, digests) : { retained: [], removed: [], derivedObjects: 0 };
            const replicas = lease.configuration("replicas");
            const knownReplicas = replicas && typeof replicas === "object" ? Object.keys(replicas) : [];
            const id = `maintenance_${randomUUID()}`;
            const body = { id, kind: input.kind, archiveId, revision: lease.snapshot.revision, backupDigest: backup.value.backupDigest, candidateId: backup.value.id, contentDigests: digests, reason: input.reason, affectedCommits: commits, affectedArtifacts: input.kind === "purge" ? impact.removed : [...artifacts], retainedArtifacts: impact.retained, rebuildPolicy: input.kind === "purge" ? PURGE_POLICY : "Retain all reachable history and receipts", knownReplicas, knownLocalCopies:copies.value.map(c=>({copyId:c.copyId,revision:c.revision,state:c.state})), unconfirmedExternalCopies: true as const };
            const plan: MaintenancePlan = { ...body, digest: digestBytes(Buffer.from(JSON.stringify(body))), plan_ref: { kind: "reported", statement: id, source_label: "maintenance-preview", supporting_refs: [] } };
            plans.set(id, { actor: actorKey(actor), plan, expires: Date.now() + 15 * 60 * 1000 });
            return success(plan);
        });
    }
    async function maintain(actor: Actor, archiveId: string, input: {
        planRef: Ref;
        approvalId: string;
        expectedRevision: string;
        operationId: string;
        businessDigest?: string;
    }, signal: AbortSignal): Promise<Result<unknown>> {
        const id = input.planRef.kind === "reported" && input.planRef.source_label === "maintenance-preview" ? input.planRef.statement : input.planRef.kind === "object" ? input.planRef.object_id : "";
        const saved = plans.get(id);
        if (!saved || saved.actor !== actorKey(actor) || saved.plan.archiveId !== archiveId || saved.expires <= Date.now())
            return failure("not_found", "maintenance plan expired or unavailable; preview again");
        const plan = saved.plan;
        // The approval is issued for the plan's own action ("gc" or "purge"), which is
        // what the owner console can name, and which is stricter than a generic
        // "maintain": an approval to collect garbage never authorises a purge.
        if (!await deps.approval(actor, archiveId, input.approvalId, plan.kind, plan.digest, signal))
            return failure("not_authorized", "exact maintenance plan requires current owner approval");
        if (plan.kind === "purge")
            return deps.purge(actor, archiveId, plan, signal, input.operationId, input.businessDigest);
        return deps.registry.withOwner(actor, archiveId, signal, async (lease) => {
            if (!lease.snapshot.policy.paused || lease.snapshot.revision !== plan.revision || input.expectedRevision !== plan.revision)
                return failure("revision_conflict", "archive state changed after maintenance preview");
            await lease.kernel.gc(lease.root, lease.signal);
            return lease.commit({ upserts: [], content: [], views: [], result: { status: "gc_completed", message: "Reachable history and receipts retained; external copies unchanged" } }, { expectedRevision: plan.revision, operationId: input.operationId, action: "maintain", digest: plan.digest });
        });
    }
    return { preview, maintain };
}
