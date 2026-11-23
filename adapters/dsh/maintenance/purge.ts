/** Conservative sensitive-content rebuild: retain only byte-clean originals, no old history or derived prose. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { success, failure, type Actor, type Result, type Snapshot } from "../../../modules/ensemble/contracts.ts";
import { ArchiveRegistry, type OwnerLease } from "../store/index.ts";
import { ArchiveKernel, StoreFault } from "../store/kernel.ts";
import { digestBytes } from "../uploads/index.ts";
import { buildImportPlan, type Inventory } from "./transfer.ts";
import type { MaintenancePlan } from "./plans.ts";
import type { SourceScan } from "./handles.ts";
export const PURGE_POLICY = "Discard all prior history, operations, receipts, coordination and learning prose; retain only originals without selected bytes, and discard embedded Git bundles. Retained originals receive new identities and neutral titles. External backups and replicas require separate disposal.";
export async function inspectPurge(lease: OwnerLease, digests: readonly string[]): Promise<{
    retained: string[];
    removed: string[];
    derivedObjects: number;
}> {
    const targets: Buffer[] = [];
    for (const digest of digests) {
        let bytes = await lease.kernel.read(lease.root, lease.snapshot.revision, `content/${digest}`, lease.signal);
        if (!bytes)
            for (const revision of await lease.kernel.history(lease.root, lease.snapshot.revision, lease.signal)) {
                bytes = await lease.kernel.read(lease.root, revision, `content/${digest}`, lease.signal);
                if (bytes)
                    break;
            }
        if (!bytes)
            throw new StoreFault("not_found", "purge target content is absent");
        targets.push(Buffer.from(bytes));
    }
    const retained: string[] = [], removed: string[] = [];
    for (const object of lease.snapshot.objects) {
        if (object.kind !== "artifact")
            continue;
        const bytes = await lease.kernel.read(lease.root, lease.snapshot.revision, `content/${object.body.content.digest}`, lease.signal);
        if (!bytes)
            throw new StoreFault("archive_corrupt", "artifact content is missing");
        const raw = Buffer.from(bytes);
        const bundle = raw.subarray(0, 32).toString("ascii").startsWith("# v2 git bundle") || raw.subarray(0, 32).toString("ascii").startsWith("# v3 git bundle");
        if (bundle || digests.includes(object.body.content.digest) || targets.some(target => raw.includes(target)))
            removed.push(object.id);
        else
            retained.push(object.id);
    }
    return { retained: retained.sort(), removed: removed.sort(), derivedObjects: lease.snapshot.objects.filter(o => o.kind !== "artifact").length };
}
export function createPurgeExecutor(deps: {
    registry: ArchiveRegistry;
    kernel: ArchiveKernel;
    quarantineRoot: string;
    discardCandidates(archiveId: string): number;
}) {
    return async function purge(actor: Actor, archiveId: string, plan: MaintenancePlan, signal: AbortSignal, operationId: string, businessDigest?: string): Promise<Result<unknown>> {
        const prepared = await deps.registry.withOwner(actor, archiveId, signal, async (lease) => {
            if (!lease.snapshot.policy.paused || lease.snapshot.revision !== plan.revision)
                return failure("revision_conflict", "purge preview no longer matches paused authority");
            if (lease.snapshot.policy.grants.some(g => g.subject.kind === "session" && !g.revoked && (g.expires_at === undefined || g.expires_at > Date.now())))
                return failure("not_authorized", "revoke Session reads and shares before purging sensitive content");
            const impact = await inspectPurge(lease, plan.contentDigests);
            if (JSON.stringify(impact.retained) !== JSON.stringify(plan.retainedArtifacts))
                return failure("revision_conflict", "purge retained set changed");
            const contents = new Map<string, Uint8Array>();
            for (const id of impact.retained) {
                const record = lease.snapshot.objects.find(o => o.id === id);
                if (!record || record.kind !== "artifact")
                    throw new Error("purge artifact disappeared");
                contents.set(`retained/${id}`, (await lease.kernel.read(lease.root, lease.snapshot.revision, `content/${record.body.content.digest}`, lease.signal))!);
            }
            const entries = [...contents].map(([path, bytes]) => ({ path, kind: "file" as const, bytes: bytes.length, digest: digestBytes(bytes) }));
            const scan: SourceScan = { entries, contents, completeness: "complete" };
            const inventory: Inventory = { id: plan.id, digest: plan.digest, entries: entries.map(e => ({ ...e, export_path: e.path })), completeness: "complete", exceptions: [], total_bytes: entries.reduce((n, e) => n + e.bytes, 0), mapping_proposals: [PURGE_POLICY] };
            const imported = buildImportPlan(lease.snapshot, actor, inventory, scan);
            const sanitized: Snapshot = { ...lease.snapshot, sequence: lease.snapshot.sequence + 1, objects: imported.upserts, policy: { epoch: lease.snapshot.policy.epoch + 1, grants: [], paused: true }, bindings: [] };
            const root = join(deps.quarantineRoot, `purge_${randomUUID()}`);
            mkdirSync(root, { mode: 0o700 });
            await deps.kernel.initialize(root, signal);
            const { revision: _revision, objectHistory: _history, ...stored } = sanitized;
            const treeEntries = [{ path: "snapshot.json", oid: await deps.kernel.hash(root, Buffer.from(JSON.stringify(stored)), signal) }];
            for (const content of imported.content) {
                if (content.kind !== "inline")
                    throw new Error("purge only accepts verified bytes");
                treeEntries.push({ path: `content/${content.digest}`, oid: await deps.kernel.hash(root, content.bytes, signal) });
            }
            const tree = await deps.kernel.tree(root, treeEntries, signal);
            const head = await deps.kernel.commit(root, tree, null, 1, signal);
            await deps.kernel.publish(root, head, null, signal);
            await deps.kernel.fsck(root, signal);
            return success({ root, originalHead: lease.snapshot.revision });
        });
        if (!prepared.ok)
            return prepared;
        const activated = await deps.registry.activateRestored(actor, { candidateRoot: prepared.value.root, mode: "new-id", operationId, ...(businessDigest ? { businessDigest } : {}), expectedOriginalRevision: prepared.value.originalHead, discardHistory: true }, signal);
        if (!activated.ok)
            return activated;
        const disposed = await deps.registry.disposeRetired(actor, { oldArchiveId: archiveId, replacementArchiveId: activated.value.archiveId, expectedOldHead: prepared.value.originalHead }, signal);
        if (!disposed.ok)
            return success({ ...activated.value, status: "active_archive_purged", completeness: "partial", retainedOriginal: "retired, physical disposal pending", disposalFailure: disposed.error.code, externalCopies: plan.knownReplicas.map(id => ({ replica_id: id, status: "unconfirmed" })) });
        const copyDispositions:{copyId:string;state:string}[]=[];
        for(const copy of plan.knownLocalCopies){if(copy.state!=="retained"){copyDispositions.push({copyId:copy.copyId,state:copy.state});continue;}const result=await deps.registry.disposeKnownCopy(actor,{copyId:copy.copyId,replacementArchiveId:activated.value.archiveId,expectedHead:copy.revision},signal);copyDispositions.push({copyId:copy.copyId,state:result.ok?"disposed":"unconfirmed"});}
        const removedCandidates = deps.discardCandidates(archiveId);
        return success({ ...activated.value, status: "local_archive_purged", completeness: "partial", retiredPrimary: "disposed", quarantineCopiesDisposed: removedCandidates, localCopies:copyDispositions, externalCopies: plan.knownReplicas.map(id => ({ replica_id: id, status: "unconfirmed" })), backupDisposition: "owner backup remains; separate disposal required", previousLocations: "retained relocation copies and filesystem snapshots require separate disposal", policy: PURGE_POLICY });
    };
}
