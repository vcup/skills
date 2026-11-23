/** Explicit v1 → new v2 identity migration. Legacy control JSON stays opaque original data. */
import { randomUUID } from "node:crypto";
import { ArchiveKernel, asFailure } from "../store/kernel.ts";
import { actorKey, failure, success, type Actor, type Receipt, type Ref, type Result } from "../../../modules/ensemble/contracts.ts";
import { digestBytes } from "../uploads/index.ts";
import { buildImportPlan, type Inventory, type TransferAccess } from "./transfer.ts";
import type { LocationHandles, SourceScan } from "./handles.ts";
export interface LegacyPreview {
    id: string;
    sourceArchiveId: string;
    sourceHead: string;
    digest: string;
    files: number;
    bytes: number;
    oldGrants: "historical-only";
    newIdentityRequired: true;
    plan_ref: Ref;
    source_stop_digest: string;
}
export function createLegacyMigration(deps: {
    kernel: ArchiveKernel;
    handles: LocationHandles;
    access: TransferAccess;
    hostWorld: string;
    proveStopped(actor: Actor, sourceArchiveId: string, head: string, evidence: string, signal: AbortSignal): Promise<boolean>;
    now?: () => number;
}) {
    const entries = new Map<string, {
        actor: string;
        sourceHandle: string;
        preview: LegacyPreview;
        expires: number;
    }>();
    const now = deps.now ?? Date.now;
    async function collect(root: string, signal: AbortSignal): Promise<{
        scan: SourceScan;
        preview: Omit<LegacyPreview, "id" | "plan_ref">;
    }> {
        const head = await deps.kernel.head(root, signal);
        if (!head)
            throw new Error("legacy archive has no authoritative head");
        await deps.kernel.fsck(root, signal);
        const metaBytes = await deps.kernel.read(root, head, "meta.json", signal, 1024 * 1024);
        if (!metaBytes)
            throw new Error("legacy metadata missing");
        const meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metaBytes)) as Record<string, unknown>;
        if (meta.format !== "ensemble-archive/v1" || typeof meta.archiveId !== "string" || !meta.archiveId)
            throw new Error("explicit legacy migration requires known v1 identity");
        const paths = await deps.kernel.entries(root, head, signal);
        if (paths.length > 10000)
            throw new Error("legacy inventory exceeds object budget");
        const contents = new Map<string, Uint8Array>();
        let total = 0;
        for (const item of paths) {
            const bytes = await deps.kernel.blob(root, item.oid, signal);
            total += bytes.length;
            if (total > 256 * 1024 * 1024)
                throw new Error("legacy import exceeds total byte budget");
            contents.set(`legacy-tree/${item.path}`, bytes);
        }
        const bundle = await deps.kernel.backup(root, head, signal);
        total += bundle.length;
        if (total > 256 * 1024 * 1024)
            throw new Error("legacy bundle exceeds total byte budget");
        contents.set("legacy-history/archive.bundle", bundle);
        const files = [...contents].map(([path, bytes]) => ({ path, kind: "file" as const, bytes: bytes.length, digest: digestBytes(bytes) }));
        const digest = digestBytes(Buffer.from(JSON.stringify(files)));
        if (await deps.kernel.head(root, signal) !== head)
            throw new Error("legacy head changed during inventory");
        return { scan: { entries: files, contents, completeness: "complete" }, preview: { sourceArchiveId: meta.archiveId, sourceHead: head, digest, files: files.length, bytes: total, oldGrants: "historical-only", newIdentityRequired: true, source_stop_digest: digestBytes(Buffer.from(JSON.stringify({ archiveId: meta.archiveId, head }))) } };
    }
    async function preview(actor: Actor, targetArchiveId: string, sourceHandle: string, signal: AbortSignal): Promise<Result<LegacyPreview>> {
        return deps.access.withOwner(actor, targetArchiveId, signal, async () => {
            let cap = await deps.handles.use(actor, sourceHandle, "backup", signal);
            if (!cap.ok)
                cap = await deps.handles.use(actor, sourceHandle, "source", signal);
            if (!cap.ok)
                return cap;
            // A legacy archive is a local v1 repository read from disk, so a selection with no
            // path cannot be one.
            if (cap.value.path === undefined)
                return failure("invalid_input", "legacy migration source requires a filesystem path");
            if (cap.value.world !== deps.hostWorld)
                return failure("invalid_input", "legacy Git location must be in the verified Host world");
            try {
                const data = await collect(cap.value.path, signal);
                const id = `legacy_${randomUUID()}`;
                const result: LegacyPreview = { id, ...data.preview, plan_ref: { kind: "reported", statement: id, source_label: "legacy-upgrade-preview", supporting_refs: [] } };
                entries.set(result.id, { actor: actorKey(actor), sourceHandle, preview: result, expires: now() + 15 * 60 * 1000 });
                return success(result);
            }
            catch (error) {
                return asFailure(error);
            }
        });
    }
    async function commit(actor: Actor, targetArchiveId: string, request: {
        previewId: string;
        approvalId: string;
        stopEvidence: string;
        expectedRevision: string;
        operationId: string;
    }, signal: AbortSignal): Promise<Result<Receipt>> {
        return deps.access.withOwner(actor, targetArchiveId, signal, async (lease) => {
            const saved = entries.get(request.previewId);
            if (!saved || saved.actor !== actorKey(actor) || saved.expires <= now())
                return failure("not_found", "legacy preview unavailable; preview again");
            if (saved.preview.sourceArchiveId === targetArchiveId)
                return failure("invalid_input", "legacy migration must create a new archive identity");
            if (!await deps.access.approval(actor, targetArchiveId, request.approvalId, "upgrade", saved.preview.digest, signal))
                return failure("not_authorized", "current owner migration approval required");
            if (!await deps.proveStopped(actor, saved.preview.sourceArchiveId, saved.preview.sourceHead, request.stopEvidence, signal))
                return failure("source_stop_required", "legacy writer must be stopped and its final head verified");
            let cap = await deps.handles.use(actor, saved.sourceHandle, "backup", signal);
            if (!cap.ok)
                cap = await deps.handles.use(actor, saved.sourceHandle, "source", signal);
            if (!cap.ok)
                return cap;
            if (cap.value.path === undefined)
                return failure("invalid_input", "legacy migration source requires a filesystem path");
            try {
                const data = await collect(cap.value.path, signal);
                if (data.preview.digest !== saved.preview.digest || data.preview.sourceHead !== saved.preview.sourceHead)
                    return failure("stale_inventory", "legacy source changed after preview");
                const snapshot = await lease.snapshot();
                if (snapshot.archiveId === data.preview.sourceArchiveId)
                    return failure("invalid_input", "new archive identity required");
                const inventory: Inventory = { id: saved.preview.id, digest: data.preview.digest, entries: data.scan.entries.map(e => ({ ...e, export_path: `originals/${e.path}` })), completeness: "complete", exceptions: [], total_bytes: data.preview.bytes, mapping_proposals: ["Legacy v1 records, receipts, grants and complete Git history are historical originals; no old grant or operation key is activated."] };
                if (!(await cap.value.check(signal)))
                    return failure("not_authorized", "legacy source permission changed");
                return lease.commit(buildImportPlan(snapshot, actor, inventory, data.scan), { expectedRevision: request.expectedRevision, operationId: request.operationId, action: "upgrade", digest: data.preview.digest });
            }
            catch (error) {
                return asFailure(error);
            }
        });
    }
    return { preview, commit };
}
