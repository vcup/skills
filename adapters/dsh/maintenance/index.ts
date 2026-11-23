import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
/** Composition of maintenance with the sole durable ArchiveRegistry and its fixed Git kernel. */
import { decodeSnapshot } from "../../../modules/ensemble/codec.ts";
import { failure, type Actor, type AdminEnvelope, type Result, type Snapshot } from "../../../modules/ensemble/contracts.ts";
import { canonicalJson } from "../records.ts";
import { validateArchiveRoot } from "../archive.ts";
import { ArchiveRegistry, type OwnerLease } from "../store/index.ts";
import { ArchiveKernel, StoreFault } from "../store/kernel.ts";
import { digestBytes } from "../uploads/index.ts";
import { createHistoryMaintenance } from "./history.ts";
import { createTransferMaintenance, type TransferLease } from "./transfer.ts";
import { createPurgeExecutor } from "./purge.ts";
import { createRecoveryMaintenance } from "./recovery.ts";
import { createMaintenancePlans, type MaintenancePlan } from "./plans.ts";
import { createReplicaMaintenance, type Replica, type NativeReplicaTransport } from "./replication.ts";
import { createLegacyMigration } from "./legacy.ts";
import { safeLogicalPath, type LocationHandles } from "./handles.ts";
export interface MaintenanceOptions {
    registry: ArchiveRegistry;
    kernel: ArchiveKernel;
    handles: LocationHandles;
    hostWorld: string;
    quarantineRoot: string;
    network?: NativeReplicaTransport;
    verifyApproval(actor: Actor, archiveId: string, approvalId: string, action: string, targetDigest: string, signal: AbortSignal): Promise<boolean>;
    purge?(actor: Actor, archiveId: string, plan: MaintenancePlan, signal: AbortSignal, operationId: string, businessDigest?: string): Promise<Result<unknown>>;
    proveStopped(actor: Actor, archiveId: string, head: string, evidenceId: string, signal: AbortSignal): Promise<boolean>;
}
async function snapshotAt(lease: OwnerLease, revision: string): Promise<Snapshot> {
    if (!await lease.kernel.isAncestor(lease.root, revision, lease.snapshot.revision, lease.signal))
        throw new StoreFault("not_found", "export revision is not in authoritative history");
    if (revision === lease.snapshot.revision)
        return lease.snapshot;
    const bytes = await lease.kernel.read(lease.root, revision, "snapshot.json", lease.signal);
    if (!bytes)
        throw new StoreFault("unsupported_version", "historical format has no v2 snapshot; use complete history backup");
    const decoded = decodeSnapshot({ ...JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), revision });
    if (!decoded.ok)
        throw new StoreFault("archive_corrupt", decoded.error.message);
    return decoded.value;
}
async function exportFiles(lease: OwnerLease, revision: string, selection: readonly string[]): Promise<readonly {
    path: string;
    kind: "original" | "generated";
    bytes: Uint8Array;
}[]> {
    const snapshot = await snapshotAt(lease, revision);
    const wanted = new Set(selection);
    const artifacts = snapshot.objects.filter(o => o.kind === "artifact" && (wanted.size === 0 || wanted.has(o.id)));
    if (wanted.size && [...wanted].some(id => !artifacts.some(a => a.id === id)))
        throw new StoreFault("not_found", "export selection contains unknown or non-artifact objects");
    const mappings = new Map<string, string>();
    for (const record of snapshot.objects) {
        if (record.kind !== "artifact" || record.body.kind !== "imported-original" || record.body.content.media_type !== "application/json")
            continue;
        const bytes = await lease.kernel.read(lease.root, revision, `content/${record.body.content.digest}`, lease.signal);
        if (!bytes)
            throw new StoreFault("archive_corrupt", "import manifest content is missing");
        let manifest;
        try {
            manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        }
        catch {
            continue;
        }
        if (manifest?.format !== "ensemble-import/v1" || !Array.isArray(manifest.entries) || typeof manifest.artifact_ids !== "object" || manifest.artifact_ids === null)
            continue;
        for (const entry of manifest.entries) {
            const id = manifest.artifact_ids[entry.path];
            if (typeof id !== "string")
                continue;
            if (!safeLogicalPath(entry.export_path))
                throw new StoreFault("archive_corrupt", "import export mapping is unsafe");
            mappings.set(id, `imports/${record.id}/${entry.export_path}`);
        }
    }
    const files: {
        path: string;
        kind: "original" | "generated";
        bytes: Uint8Array;
    }[] = [];
    for (const artifact of artifacts) {
        if (artifact.kind !== "artifact")
            continue;
        const bytes = await lease.kernel.read(lease.root, revision, `content/${artifact.body.content.digest}`, lease.signal);
        if (!bytes || bytes.length !== artifact.body.content.bytes || digestBytes(bytes) !== artifact.body.content.digest)
            throw new StoreFault("archive_corrupt", "original content digest is invalid");
        files.push({ path: mappings.get(artifact.id) ?? `originals/${artifact.id}`, kind: "original", bytes });
    }
    if (selection.length === 0)
        for (const entry of await lease.kernel.entries(lease.root, revision, lease.signal)) {
            if (entry.path.startsWith("views/"))
                files.push({ path: entry.path, kind: "generated", bytes: await lease.kernel.blob(lease.root, entry.oid, lease.signal) });
        }
    return files;
}
export function createArchiveMaintenance(options: MaintenanceOptions) {
    const access = {
        withOwner<T>(actor: Actor, archiveId: string, signal: AbortSignal, run: (lease: TransferLease) => Promise<Result<T>>) { return options.registry.withOwner(actor, archiveId, signal, lease => run({ artifactBytes: lease.limits.artifact_bytes, destinationAllowed: path => validateArchiveRoot(path, [lease.root, ...lease.snapshot.bindings.filter(b => b.worldIdentity === options.hostWorld).map(b => b.canonicalAddress)]).ok, snapshot: async () => lease.snapshot, commit: (plan, request) => lease.commit(plan, request), files: (revision, selection) => exportFiles(lease, revision, selection) })); },
        approval: options.verifyApproval,
    };
    const transfer = createTransferMaintenance({ access, handles: options.handles, hostWorld: options.hostWorld });
    const history = createHistoryMaintenance({ kernel: options.kernel, handles: options.handles, hostWorld: options.hostWorld, quarantineRoot: options.quarantineRoot, access: { authorizeOwner: (actor, signal) => options.registry.context(actor, signal), withOwner: (actor, id, signal, run) => options.registry.withOwner(actor, id, signal, lease => run(lease.root, lease.snapshot.bindings.filter(b => b.worldIdentity === options.hostWorld).map(b => b.canonicalAddress))) } });
    const legacy = createLegacyMigration({ kernel: options.kernel, handles: options.handles, access, hostWorld: options.hostWorld, proveStopped: options.proveStopped });
    const replicas = createReplicaMaintenance({ handles: options.handles, hostWorld: options.hostWorld, ...(options.network ? { network: options.network } : {}), access: { withOwner: (actor, archiveId, signal, run) => options.registry.withOwner(actor, archiveId, signal, lease => run({
                destinationAllowed: path => validateArchiveRoot(path, [lease.root, ...lease.snapshot.bindings.filter(b => b.worldIdentity === options.hostWorld).map(b => b.canonicalAddress)]).ok,
                head: async () => { const head = await lease.kernel.head(lease.root, lease.signal); if (!head)
                    throw new StoreFault("archive_corrupt", "primary ref disappeared"); return head; },
                remoteHead: destination => lease.kernel.remoteHead(lease.root, destination, lease.signal),
                push: (destination, revision, expected) => lease.kernel.pushLease(lease.root, destination, revision, expected, lease.signal),
                fetch: async (destination, expected) => { const candidateId = `replica_${randomUUID()}`; const root = join(options.quarantineRoot, candidateId); mkdirSync(root, { mode: 0o700 }); const head = await lease.kernel.fetchQuarantine(destination, root, expected, lease.signal); const verified = await history.adoptCandidate(root, head, lease.signal); return { candidateId: verified.id, head, readOnly: true }; },
                isAncestor: (older, newer) => lease.kernel.isAncestor(lease.root, older, newer, lease.signal),
                // The engine owns the transfer context: the repository path comes from
                // the held lease (honours relocation), so no transport re-derives
                // storage layout and none re-enters this lock.
                repository: lease.repository.path,
                get: async (id) => { const all = lease.configuration("replicas") as Record<string, Replica> | undefined; return all?.[id]; },
                save: async (replica) => { const all = lease.configuration("replicas") as Record<string, Replica> | undefined; lease.saveConfiguration("replicas", { ...all, [replica.id]: replica }); },
            })) } });
    const recovery = createRecoveryMaintenance({ candidate: history.candidateInfo, access: {
            approval: options.verifyApproval,
            finalHead: async (actor, expected, evidenceId, signal) => await options.proveStopped(actor, expected.archiveId, expected.head, evidenceId, signal) ? { ok: true, value: { ...expected, stopped: true } } : failure("source_stop_required", "previous writer final-head evidence is unavailable or revoked"),
            activate: async (actor, _archiveId, candidate, root, request, signal) => {
                const result = await options.registry.activateRestored(actor, { candidateRoot: root, mode: request.mode === "lossless" ? "same-id" : "new-id", operationId: request.operationId, ...(request.businessDigest ? { businessDigest: request.businessDigest } : {}), expectedOriginalRevision: request.expectedRevision, source: request.source, grants: request.grants, ...(request.mode === "lossless" ? { finalProof: { archiveId: candidate.identity.archiveId, head: candidate.identity.head, previousWriterStopped: true as const, receiptContinuity: true as const } } : {}) }, signal);
                if (!result.ok)
                    return result;
                if (result.value.readOnly || !result.value.registered)
                    return failure("restore_read_only", "candidate remains read-only because final-head continuity is unproven");
                return { ok: true, value: { ...result.value, rebound: true, reauthorized: true } };
            }
        } });
    const plans = createMaintenancePlans({ registry: options.registry, history, approval: options.verifyApproval, purge: options.purge ?? createPurgeExecutor({ registry: options.registry, kernel: options.kernel, quarantineRoot: options.quarantineRoot, discardCandidates: history.discardArchiveCandidates }) });
    async function execute(actor: Actor, request: AdminEnvelope, signal: AbortSignal): Promise<Result<unknown>> {
        if (request.action === "initialize")
            return options.registry.admin(actor, request, signal);
        const businessDigest = digestBytes(Buffer.from(canonicalJson({ action: request.action, project_id: request.project_id, payload: request.payload })));
        if (request.action === "activate_restore" || request.action === "maintain") {
            const previous = await options.registry.activationResult(actor, request.operation_id, signal, {projectId:request.project_id});
            if (previous.ok) {
                if (previous.value.businessDigest !== businessDigest)
                    return failure("operation_key_conflict", "maintenance operation key names different approved business input");
                if (request.action === "maintain" && previous.value.expectedOldHead && !previous.value.disposed) {
                    const disposed = await options.registry.disposeRetired(actor, { oldArchiveId: previous.value.sourceArchiveId, replacementArchiveId: previous.value.archiveId, expectedOldHead: previous.value.expectedOldHead }, signal);
                    if (!disposed.ok)
                        return disposed;
                    history.discardArchiveCandidates(previous.value.sourceArchiveId);
                }
                return { ok: true, value: { ...previous.value, reconciled: true } };
            }
            if (previous.error.code !== "not_found")
                return previous;
        }
        // Independent restore authenticates this Host owner, not a project that may have been lost.
        if (request.action === "restore")
            return history.restore(actor, request.project_id, request.payload.backup_handle, signal);
        if (request.action === "activate_restore")
            return recovery.activate(actor, request.project_id, { operationId: request.operation_id, businessDigest, expectedRevision: request.expected_revision, candidateId: request.payload.candidate_id, mode: request.payload.mode, source: request.payload.source_descriptor, grants: request.payload.initial_grants, approvalId: request.payload.approval_ref.approval_id, sourceStopEvidence: request.payload.source_stop_evidence, ...(request.payload.final_head_ref ? { finalHeadEvidence: request.payload.final_head_ref.approval_id } : {}), ...(request.payload.loss_statement ? { lossStatement: request.payload.loss_statement } : {}) }, signal);
        const selected = await options.registry.resolveProject(actor, request.project_id, signal);
        if (!selected.ok)
            return selected;
        const archiveId = selected.value.archiveId;
        switch (request.action) {
            case "inventory_import": return transfer.inventoryImport(actor, archiveId, request.payload.source_handle, request.payload.selection, request.payload.budget, signal);
            case "commit_import": return transfer.commitImport(actor, archiveId, { inventoryId: request.payload.inventory_id, acceptedExceptions: request.payload.accepted_exceptions, approvalId: request.payload.approval_ref.approval_id, expectedRevision: request.expected_revision, operationId: request.operation_id }, signal);
            case "export": return transfer.exportRevision(actor, archiveId, request.payload.revision, request.payload.selection, request.payload.destination_handle, signal);
            case "backup": return history.backup(actor, archiveId, request.payload.revision, request.payload.destination_handle, signal);
            case "configure_replica": return replicas.configure(actor, archiveId, { destinationHandle: request.payload.destination_handle, credentialHandle: request.payload.credential_handle, expectedIdentity: request.payload.expected_remote_identity }, signal);
            case "push_replica": return replicas.push(actor, archiveId, request.payload.replica_id, request.payload.local_revision, signal);
            case "fetch_replica": return replicas.fetch(actor, archiveId, request.payload.replica_id, request.payload.expected_remote_revision, signal);
            case "plan_maintenance": {
                if (request.payload.kind === "legacy_upgrade")
                    return legacy.preview(actor, archiveId, request.payload.source_handle, signal);
                return plans.preview(actor, archiveId, { kind: request.payload.kind, backupHandle: request.payload.backup_handle, reason: request.payload.reason, ...("content_digests" in request.payload ? { contentDigests: request.payload.content_digests } : {}) }, signal);
            }
            case "relocate": {
                const destination = await options.handles.use(actor, request.payload.destination_handle, "destination", signal);
                if (!destination.ok)
                    return destination;
                if (destination.value.world !== options.hostWorld)
                    return failure("invalid_input", "relocation needs a verified Host-local destination");
                if (!request.payload.source_stop_evidence.length)
                    return failure("source_stop_required", "relocation requires explicit stopped-writer evidence");
                // Relocation moves a repository to a real directory; a network destination has
                // no path and cannot be a relocation target.
                if (destination.value.path === undefined)
                    return failure("invalid_input", "relocation destination requires a filesystem path");
                if (!await options.verifyApproval(actor, archiveId, request.payload.approval_ref.approval_id, "relocate", digestBytes(Buffer.from(request.payload.destination_handle)), signal))
                    return failure("not_authorized", "relocation destination requires current owner approval");
                return options.registry.relocate(actor, archiveId, { destination: destination.value.path, expectedRevision: request.expected_revision, operationId: request.operation_id, source: request.payload.source_descriptor, grants: request.payload.initial_grants }, signal);
            }
            case "upgrade": {
                if (!["ensemble-archive/v2", "2"].includes(request.payload.target_format))
                    return failure("invalid_input", "upgrade target must be the implemented v2 format");
                const ref = request.payload.migration_plan_ref;
                const previewId = ref.kind === "reported" && ref.source_label === "legacy-upgrade-preview" ? ref.statement : ref.kind === "object" ? ref.object_id : "";
                return legacy.commit(actor, archiveId, { previewId, approvalId: request.payload.approval_ref.approval_id, stopEvidence: request.payload.source_stop_ref.approval_id, expectedRevision: request.expected_revision, operationId: request.operation_id }, signal);
            }
            case "maintain": return plans.maintain(actor, archiveId, { planRef: request.payload.plan_ref, approvalId: request.payload.approval_ref.approval_id, expectedRevision: request.expected_revision, operationId: request.operation_id, businessDigest }, signal);
            case "diagnose": return options.registry.withOwner(actor, archiveId, signal, async (lease) => { await lease.kernel.fsck(lease.root, lease.signal); return { ok: true, value: { archive_id: archiveId, revision: lease.snapshot.revision, format: lease.snapshot.formatVersion, renderer: lease.snapshot.rendererVersion, paused: lease.snapshot.policy.paused, authorization_epoch: lease.snapshot.policy.epoch, bindings: lease.snapshot.bindings.length, grants: lease.snapshot.policy.grants.length,
                        // The owner must be able to name the exact grant it revokes:
                        // grant ids are opaque, so a count alone left `revoke` (and the
                        // Session-read preconditions of purge) unreachable from the owner
                        // entry. Ids, rights and scopes are owner-visible management facts;
                        // no credential or secret is ever included.
                        grant_ids: lease.snapshot.policy.grants.map(grant => ({ grant_id: grant.id, rights: grant.rights, scope: grant.scope.kind, revoked: grant.revoked, ...(grant.expires_at === undefined ? {} : { expires_at: grant.expires_at }) })),
                        objects: lease.snapshot.objects.length, capacity: await lease.kernel.objectStats(lease.root, lease.signal), refs: await lease.kernel.refs(lease.root, lease.signal) } }; });
            default: return options.registry.admin(actor, request, signal);
        }
    }
    return { execute, transfer, history, legacy, replicas, plans, recovery };
}
export type ArchiveMaintenance = ReturnType<typeof createArchiveMaintenance>;
export { createLocationHandles, localSourceReader } from "./handles.ts";
