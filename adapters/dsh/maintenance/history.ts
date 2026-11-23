/** Complete Git-history backup and isolated restore. Activation stays with Registry. */
import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateArchiveRoot } from "../archive.ts";
import { ArchiveKernel, asFailure, type KernelOptions } from "../store/kernel.ts";
import { failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import { digestBytes, privateDirectory } from "../uploads/index.ts";
import { publishDirectory, readRegular } from "./files.ts";
import type { LocationHandles } from "./handles.ts";
export interface HistoryIdentity {
    archiveId: string;
    head: string;
    format: string;
    renderer: string;
}
export interface BackupManifest {
    format: "ensemble-backup/v1";
    identity: HistoryIdentity;
    bundle: {
        digest: string;
        bytes: number;
    };
    refs: Readonly<Record<string, string>>;
    externalDependencies: readonly string[];
    completeness: "complete";
}
export interface HistoryAccess {
    authorizeOwner(actor: Actor, signal: AbortSignal): Promise<Result<unknown>>;
    /** Archive checks current owner and holds its writer lock while run executes. */
    withOwner<T>(actor: Actor, archiveId: string, signal: AbortSignal, run: (root: string, protectedRoots: readonly string[]) => Promise<Result<T>>): Promise<Result<T>>;
}
export interface QuarantineCandidate {
    id: string;
    identity: HistoryIdentity;
    refs: Readonly<Record<string, string>>;
    readOnly: true;
    backupDigest: string;
}
export function createHistoryMaintenance(deps: {
    kernel: ArchiveKernel;
    access: HistoryAccess;
    handles: LocationHandles;
    quarantineRoot: string;
    hostWorld: string;
}) {
    privateDirectory(deps.quarantineRoot, true);
    const candidates = new Map<string, {
        root: string;
        candidate: QuarantineCandidate;
        dev: number;
        ino: number;
    }>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    async function identity(root: string, head: string, signal: AbortSignal): Promise<HistoryIdentity> {
        const bytes = await deps.kernel.read(root, head, "snapshot.json", signal) ?? await deps.kernel.read(root, head, "meta.json", signal);
        if (!bytes)
            throw new Error("archive identity metadata missing");
        const meta = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
        const archiveId = meta.archiveId ?? meta.archive_id ?? meta.projectId;
        const format = meta.format ?? meta.formatVersion;
        const renderer = meta.rendererVersion ?? meta.renderer_version ?? meta.renderer;
        if (typeof archiveId !== "string" || !archiveId || !(typeof format === "string" || typeof format === "number"))
            throw new Error("archive identity missing");
        return { archiveId, head, format: String(format), renderer: typeof renderer === "string" ? renderer : "legacy-unknown" };
    }
    async function candidate(bytes: Uint8Array, manifest: BackupManifest, signal: AbortSignal): Promise<QuarantineCandidate> {
        if (digestBytes(bytes) !== manifest.bundle.digest || bytes.length !== manifest.bundle.bytes)
            throw new Error("backup digest mismatch");
        const id = `candidate_${randomUUID()}`;
        const root = join(deps.quarantineRoot, id);
        mkdirSync(root, { mode: 0o700 });
        const refs = await deps.kernel.restoreBundle(bytes, root, signal);
        await deps.kernel.fsck(root, signal);
        const head = await deps.kernel.head(root, signal);
        if (head !== manifest.identity.head)
            throw new Error("backup head mismatch");
        const found = await identity(root, head, signal);
        if (found.archiveId !== manifest.identity.archiveId || found.format !== manifest.identity.format || JSON.stringify(refs) !== JSON.stringify(manifest.refs))
            throw new Error("backup identity or refs mismatch");
        const value: QuarantineCandidate = { id, identity: found, refs, readOnly: true, backupDigest: digestBytes(bytes) };
        candidates.set(id, { root, candidate: value, dev: lstatSync(root).dev, ino: lstatSync(root).ino });
        return value;
    }
    async function backup(actor: Actor, archiveId: string, revision: string, destinationHandle: string, signal: AbortSignal): Promise<Result<BackupManifest>> {
        return deps.access.withOwner(actor, archiveId, signal, async (root, protectedRoots) => {
            try {
                const destination = await deps.handles.use(actor, destinationHandle, "destination", signal);
                if (!destination.ok)
                    return destination;
                if (destination.value.world !== deps.hostWorld)
                    return failure("invalid_input", "backup destination requires a verified Host world");
                // A backup needs a real local directory. A network destination has no path, so
                // refuse instead of letting an absent path collapse into the process cwd.
                if (destination.value.path === undefined)
                    return failure("invalid_input", "backup destination requires a filesystem path");
                if (!validateArchiveRoot(destination.value.path, [root, ...protectedRoots]).ok)
                    return failure("invalid_input", "backup destination overlaps an archive or bound source");
                const head = await deps.kernel.head(root, signal);
                if (head !== revision)
                    return failure("revision_conflict", "backup requires the exact current archive revision");
                await deps.kernel.fsck(root, signal);
                const info = await identity(root, revision, signal);
                if (info.archiveId !== archiveId)
                    return failure("archive_corrupt", "registered archive identity changed");
                const bytes = await deps.kernel.backup(root, revision, signal);
                const manifest: BackupManifest = { format: "ensemble-backup/v1", identity: info, bundle: { digest: digestBytes(bytes), bytes: bytes.length }, refs: await deps.kernel.refs(root, signal), externalDependencies: ["source workspace", "native session logs", "native credentials"], completeness: "complete" };
                // Verification is an independent repository, not verification against source objects/alternates.
                await candidate(bytes, manifest, signal);
                if (!(await destination.value.check(signal)))
                    return failure("not_authorized", "destination permission changed");
                publishDirectory(destination.value.path, [{ path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }, { path: "archive.bundle", bytes }]);
                return success(manifest);
            }
            catch (error) {
                if (error instanceof Error && error.message === "destination_exists")
                    return failure("destination_exists", "backup destination already exists");
                return asFailure(error);
            }
        });
    }
    async function restore(actor: Actor, archiveId: string, backupHandle: string, signal: AbortSignal): Promise<Result<QuarantineCandidate>> {
        const owner = await deps.access.authorizeOwner(actor, signal);
        if (!owner.ok)
            return owner;
        try {
            const handle = await deps.handles.use(actor, backupHandle, "backup", signal);
            if (!handle.ok)
                return handle;
            if (handle.value.world !== deps.hostWorld)
                return failure("invalid_input", "backup reader requires verified Host world");
            if (handle.value.path === undefined)
                return failure("invalid_input", "restore source requires a filesystem path");
            const manifest = JSON.parse(decoder.decode(readRegular(join(handle.value.path, "manifest.json"), 1024 * 1024))) as BackupManifest;
            if (manifest.format !== "ensemble-backup/v1" || manifest.completeness !== "complete" || !manifest.identity || typeof manifest.identity.archiveId !== "string" || !manifest.bundle || !Number.isSafeInteger(manifest.bundle.bytes) || manifest.bundle.bytes < 0 || !/^[0-9a-f]{64}$/.test(manifest.bundle.digest) || !manifest.refs)
                return failure("archive_corrupt", "backup manifest is invalid");
            const bytes = readRegular(join(handle.value.path, "archive.bundle"));
            const value = await candidate(bytes, manifest, signal);
            if (!(await handle.value.check(signal)))
                return failure("not_authorized", "backup permission changed");
            // All candidates remain read-only: only Registry can prove stopped-head and reactivate with new grants.
            return success(value);
        }
        catch (error) {
            return asFailure(error);
        }
    }
    /** Store-only, opaque id lookup. Registry must recheck owner, final-head evidence, identity and grants. */
    function candidateRoot(id: string): string | undefined { return candidates.get(id)?.root; }
    function candidateInfo(id: string) { const entry = candidates.get(id); return entry ? { root: entry.root, candidate: entry.candidate } : undefined; }
    async function adoptCandidate(root: string, expected: string, signal: AbortSignal): Promise<QuarantineCandidate> {
        await deps.kernel.fsck(root, signal);
        const head = await deps.kernel.head(root, signal);
        if (head !== expected)
            throw new Error("quarantine head changed");
        const found = await identity(root, head, signal);
        const refs = await deps.kernel.refs(root, signal);
        const bytes = await deps.kernel.backup(root, head, signal);
        const id = `candidate_${randomUUID()}`;
        const value: QuarantineCandidate = { id, identity: found, refs, readOnly: true, backupDigest: digestBytes(bytes) };
        candidates.set(id, { root, candidate: value, dev: lstatSync(root).dev, ino: lstatSync(root).ino });
        return value;
    }
    function discardArchiveCandidates(archiveId: string): number {
        privateDirectory(deps.quarantineRoot);
        let removed = 0;
        for (const [id, entry] of candidates) {
            if (entry.candidate.identity.archiveId !== archiveId)
                continue;
            const st = lstatSync(entry.root);
            if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== entry.dev || st.ino !== entry.ino || realpathSync(entry.root) !== entry.root || !entry.root.startsWith(`${deps.quarantineRoot}/`))
                throw new Error("quarantine candidate identity changed; refusing cleanup");
            rmSync(entry.root, { recursive: true, force: false });
            candidates.delete(id);
            removed++;
        }
        return removed;
    }
    return { backup, restore, candidateRoot, candidateInfo, adoptCandidate, discardArchiveCandidates };
}
export type HistoryMaintenance = ReturnType<typeof createHistoryMaintenance>;
