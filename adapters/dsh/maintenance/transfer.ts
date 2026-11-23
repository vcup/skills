import { posix } from "node:path";
/** Inventory and transfer preserve source bytes. Structured interpretation remains an explicit later domain action. */
import { StoreFault } from "../store/kernel.ts";
import { randomUUID } from "node:crypto";
import { ARCHIVE_FORMAT, actorIdentity, actorKey, failure, success, type Actor, type DomainRecord, type MutationPlan, type Receipt, type Result, type Snapshot } from "../../../modules/ensemble/contracts.ts";
import { digestBytes } from "../uploads/index.ts";
import { publishDirectory } from "./files.ts";
import { safeLogicalPath, type LocationHandles, type SourceEntry, type SourceScan } from "./handles.ts";
export interface Inventory {
    id: string;
    digest: string;
    entries: readonly (SourceEntry & {
        export_path: string;
    })[];
    completeness: "complete" | "partial";
    exceptions: readonly string[];
    total_bytes: number;
    original_links?: readonly {
        source: string;
        target: string;
        status: "external" | "present" | "missing" | "unsafe";
    }[];
    mapping_proposals: readonly string[];
}
export interface TransferLease {
    destinationAllowed(path: string): boolean;
    artifactBytes: number;
    snapshot(): Promise<Snapshot>;
    commit(plan: MutationPlan, request: {
        expectedRevision: string;
        operationId: string;
        action: string;
        digest: string;
    }): Promise<Result<Receipt>>;
    files(revision: string, selection: readonly string[]): Promise<readonly {
        path: string;
        kind: "original" | "generated";
        bytes: Uint8Array;
    }[]>;
}
export interface TransferAccess {
    withOwner<T>(actor: Actor, archiveId: string, signal: AbortSignal, run: (lease: TransferLease) => Promise<Result<T>>): Promise<Result<T>>;
    approval(actor: Actor, archiveId: string, approvalId: string, action: string, targetDigest: string, signal: AbortSignal): Promise<boolean>;
}
function manifest(scan: SourceScan, maxArtifactBytes: number): Omit<Inventory, "id"> {
    const occupied = new Set<string>();
    const entries = scan.entries.map((original, index) => {
        const e = original.bytes > maxArtifactBytes && !original.error ? { ...original, error: "budget_exceeded" as const } : original;
        if (!safeLogicalPath(e.path))
            throw new Error("source returned an unsafe logical path");
        let exportPath = `originals/${e.path}`;
        const normalized = e.path.normalize("NFC").toLocaleLowerCase("en-US");
        if (occupied.has(normalized))
            exportPath = `_collisions/${String(index).padStart(6, "0")}/${e.path}`;
        occupied.add(normalized);
        // Links are always exported as target text, never materialized as filesystem symlinks.
        if (e.kind === "symlink")
            exportPath = `_links/${String(index).padStart(6, "0")}.txt`;
        return { ...e, export_path: exportPath };
    });
    const originalLinks: {
        source: string;
        target: string;
        status: "external" | "present" | "missing" | "unsafe";
    }[] = [];
    const paths = new Set(entries.map(e => e.path));
    for (const [source, bytes] of scan.contents) {
        if (!/\.(?:md|markdown|txt)$/i.test(source))
            continue;
        let text: string;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            continue;
        }
        for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
            if (originalLinks.length >= 10000)
                throw new Error("link inventory budget exceeded");
            const target = match[1]!;
            let status: "external" | "present" | "missing" | "unsafe";
            if (/^https?:\/\//i.test(target))
                status = "external";
            else {
                let local: string;
                try {
                    local = decodeURIComponent(target.split("#")[0]!.split("?")[0]!);
                }
                catch {
                    local = "../";
                }
                if (!local)
                    status = "present";
                else {
                    const resolved = posix.normalize(posix.join(posix.dirname(source), local));
                    status = !safeLogicalPath(resolved) || local.startsWith("/") || /^[a-z]+:/i.test(local) ? "unsafe" : paths.has(resolved) ? "present" : "missing";
                }
            }
            originalLinks.push({ source, target, status });
        }
    }
    const serial = JSON.stringify(entries);
    const exceptions = entries.filter(e => e.error).map(e => e.path);
    return { digest: digestBytes(Buffer.from(serial)), entries, completeness: exceptions.length ? "partial" : "complete", exceptions, total_bytes: entries.filter(e => !e.error).reduce((n, e) => n + e.bytes, 0), original_links: originalLinks, mapping_proposals: ["Source headings and status words are preserved as originals; no completion, checks, current grants or publications are inferred."] };
}
export function buildImportPlan(snapshot: Snapshot, actor: Actor, inventory: Inventory, scan: SourceScan): MutationPlan {
    const sequence = snapshot.sequence + 1;
    const invocationId = `invocation_${randomUUID()}`;
    const author = actorIdentity(actor);
    const base = { format: ARCHIVE_FORMAT, object_revision: 1, created_sequence: sequence, updated_sequence: sequence, author } as const;
    const objects: DomainRecord[] = [{ ...base, id: invocationId, kind: "invocation", body: { title: "Imported historical materials", goal: "Preserve original bytes and provenance", deliverable: "Historical originals and inventory", subject: "Owner-approved import", constraints: "Historical statements are not current execution evidence or authorization", exclusions: "No inferred completion or native action replay", frame_revision: 1, lead: author, lifecycle: "active", coverage_ids: [], criterion_ids: [], lifecycle_history: [] } }];
    const content: MutationPlan["content"][number][] = [];
    const add = (title: string, bytes: Uint8Array, mediaType: string) => { const digest = digestBytes(bytes); const id = `artifact_${randomUUID()}`; objects.push({ ...base, id, kind: "artifact", body: { invocation_id: invocationId, kind: "imported-original", title, content: { digest, bytes: bytes.length, media_type: mediaType }, refs: [], domains: [], status: "current", editors: [author] } }); content.push({ kind: "inline", digest, bytes, media_type: mediaType }); return id; };
    const mappings: Record<string, string> = {};
    for (const entry of inventory.entries) {
        if (entry.error || entry.kind === "directory")
            continue;
        const bytes = scan.contents.get(entry.path);
        if (!bytes || bytes.length !== entry.bytes || digestBytes(bytes) !== entry.digest)
            throw new Error("staged original does not match inventory");
        mappings[entry.path] = add(entry.path, bytes, "application/octet-stream");
    }
    const manifestId = add("Import inventory and source mapping", Buffer.from(JSON.stringify({ format: "ensemble-import/v1", ...inventory, artifact_ids: mappings }, null, 2) + "\n"), "application/json");
    return { upserts: objects, content, views: [{ kind: "checkpoint", invocation_id: invocationId }, { kind: "overview" }], result: { id: manifestId, invocation_id: invocationId, status: inventory.completeness, ids: mappings } };
}
export function createTransferMaintenance(deps: {
    access: TransferAccess;
    handles: LocationHandles;
    hostWorld: string;
    now?: () => number;
    inventoryTtlMs?: number;
}) {
    const now = deps.now ?? Date.now;
    const ttl = deps.inventoryTtlMs ?? 15 * 60 * 1000;
    const inventories = new Map<string, {
        actor: string;
        archiveId: string;
        sourceHandle: string;
        selection: readonly string[];
        budget: number;
        expires: number;
        inventory: Inventory;
    }>();
    async function inventoryImport(actor: Actor, archiveId: string, sourceHandle: string, selection: readonly string[], budget: number, signal: AbortSignal): Promise<Result<Inventory>> {
        return deps.access.withOwner(actor, archiveId, signal, async (lease) => {
            const cap = await deps.handles.use(actor, sourceHandle, "source", signal);
            if (!cap.ok)
                return cap;
            if (!cap.value.reader)
                return failure("not_authorized", "source execution world has no approved reader");
            if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 256 * 1024 * 1024)
                return failure("budget_exceeded", "import budget must be between 1 and 256 MiB");
            const scan = await cap.value.reader.scan(selection, budget, signal);
            if (!scan.ok)
                return scan;
            if (!(await cap.value.check(signal)))
                return failure("not_authorized", "source read permission changed");
            try {
                const inventory: Inventory = { id: `inventory_${randomUUID()}`, ...manifest(scan.value, lease.artifactBytes) };
                inventories.set(inventory.id, { actor: actorKey(actor), archiveId, sourceHandle, selection: [...selection], budget, expires: now() + ttl, inventory });
                return success(inventory);
            }
            catch {
                return failure("invalid_input", "source returned unsafe inventory paths");
            }
        });
    }
    async function commitImport(actor: Actor, archiveId: string, request: {
        inventoryId: string;
        acceptedExceptions: readonly string[];
        approvalId: string;
        expectedRevision: string;
        operationId: string;
    }, signal: AbortSignal): Promise<Result<Receipt>> {
        return deps.access.withOwner(actor, archiveId, signal, async (lease) => {
            const saved = inventories.get(request.inventoryId);
            if (!saved || saved.actor !== actorKey(actor) || saved.archiveId !== archiveId || saved.expires <= now())
                return failure("not_found", "inventory unavailable or expired; preview again");
            if (!await deps.access.approval(actor, archiveId, request.approvalId, "commit_import", saved.inventory.digest, signal))
                return failure("not_authorized", "current owner approval for this inventory is required");
            if (JSON.stringify([...new Set(request.acceptedExceptions)].sort()) !== JSON.stringify([...saved.inventory.exceptions].sort()))
                return failure("invalid_input", "accept exactly the reported exceptions before importing a partial inventory");
            const cap = await deps.handles.use(actor, saved.sourceHandle, "source", signal);
            if (!cap.ok)
                return cap;
            if (!cap.value.reader)
                return failure("not_authorized", "source reader unavailable");
            const scan = await cap.value.reader.scan(saved.selection, saved.budget, signal);
            if (!scan.ok)
                return scan;
            let fresh: Omit<Inventory, "id">;
            try {
                fresh = manifest(scan.value, lease.artifactBytes);
            }
            catch {
                return failure("stale_inventory", "source inventory is no longer safe");
            }
            if (fresh.digest !== saved.inventory.digest)
                return failure("stale_inventory", "source members or bytes changed; preview again");
            if (!(await cap.value.check(signal)))
                return failure("not_authorized", "source read permission changed");
            const snapshot = await lease.snapshot();
            const plan = buildImportPlan(snapshot, actor, saved.inventory, scan.value);
            // Content-derived receipt key makes a second identical inventory return the original import.
            return lease.commit(plan, { expectedRevision: request.expectedRevision, operationId: `import:${saved.inventory.digest}`, action: "commit_import", digest: saved.inventory.digest });
        });
    }
    async function exportRevision(actor: Actor, archiveId: string, revision: string, selection: readonly string[], destinationHandle: string, signal: AbortSignal): Promise<Result<{
        revision: string;
        files: number;
        digest: string;
        completeness: "complete";
    }>> {
        return deps.access.withOwner(actor, archiveId, signal, async (lease) => {
            const cap = await deps.handles.use(actor, destinationHandle, "destination", signal);
            if (!cap.ok)
                return cap;
            if (cap.value.world !== deps.hostWorld)
                return failure("invalid_input", "destination requires a verified Host world");
            // An export writes real files; a network destination has no path.
            if (cap.value.path === undefined)
                return failure("invalid_input", "export destination requires a filesystem path");
            if (!lease.destinationAllowed(cap.value.path))
                return failure("invalid_input", "export destination overlaps an archive or bound source");
            try {
                const files = await lease.files(revision, selection);
                const listing = files.map(f => ({ path: f.path, kind: f.kind, bytes: f.bytes.length, digest: digestBytes(f.bytes) }));
                const bytes = Buffer.from(JSON.stringify({ format: "ensemble-export/v1", archiveId, revision, files: listing, completeness: "complete" }, null, 2) + "\n");
                if (files.some(f => f.path === "manifest.json"))
                    return failure("invalid_input", "export selection collides with manifest path");
                if (!(await cap.value.check(signal)))
                    return failure("not_authorized", "destination permission changed");
                publishDirectory(cap.value.path, [...files, { path: "manifest.json", bytes }]);
                return success({ revision, files: files.length, digest: digestBytes(bytes), completeness: "complete" });
            }
            catch (error) {
                return error instanceof StoreFault?failure(error.code,error.message):failure(error instanceof Error && error.message === "destination_exists" ? "destination_exists" : "storage_unavailable", "export was not published; inspect destination and retry");
            }
        });
    }
    return { inventoryImport, commitImport, exportRevision };
}
export type TransferMaintenance = ReturnType<typeof createTransferMaintenance>;
