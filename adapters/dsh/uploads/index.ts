/** Private byte staging. Archive owns authorization, grants and transaction locking. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { actorKey, failure, success, type Actor, type Result, type Snapshot, type UploadCommand } from "../../../modules/ensemble/contracts.ts";
export interface UploadLimits {
    artifactBytes: number;
    chunkBytes: number;
    totalBytes: number;
    concurrent: number;
    idleTtlMs: number;
}
export const DEFAULT_UPLOAD_LIMITS: Readonly<UploadLimits> = { artifactBytes: 64 * 1024 * 1024, chunkBytes: 1024 * 1024, totalBytes: 256 * 1024 * 1024, concurrent: 4, idleTtlMs: 24 * 60 * 60 * 1000 };
export interface UploadAccess {
    kind: "upload";
    invocationId: string;
    action: UploadCommand["action"];
}
export interface UploadDependencies {
    /** Deployment-owned Host staging directory outside all sources. Never a tool argument. */
    root: string;
    withAccess<T>(actor: Actor, archiveId: string, access: UploadAccess, signal: AbortSignal, run: (snapshot: Snapshot) => Promise<Result<T>>): Promise<Result<T>>;
    limits?: Partial<UploadLimits>;
    now?: () => number;
}
interface Entry {
    version: 1;
    id: string;
    archiveId: string;
    actor: string;
    invocationId: string;
    mediaType: string;
    total: number;
    digest: string;
    ranges: [
        number,
        number
    ][];
    state: "receiving" | "sealed";
    touched: number;
}
export interface UploadStatus {
    upload_id: string;
    state: "receiving" | "sealed" | "cancelled";
    total_bytes: number;
    digest: string;
    ranges: readonly (readonly [
        number,
        number
    ])[];
    media_type: string;
    expires_at: number;
    chunk_bytes: number;
}
export interface SealedBytes {
    upload_id: string;
    digest: string;
    media_type: string;
    bytes: Uint8Array;
}
const ID = /^upload_[0-9a-f-]{36}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export function digestBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function decodeBase64(value: string): Result<Uint8Array> {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        return failure("invalid_input", "bytes must be canonical base64", "bytes");
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value ? success(bytes) : failure("invalid_input", "bytes must be canonical base64", "bytes");
}
/** Refuse every symlink component, including a replaced parent on later calls. */
export function privateDirectory(path: string, create = false): void {
    if (!isAbsolute(path) || resolve(path) !== path)
        throw new Error("directory must be canonical and absolute");
    const parent = dirname(path);
    if (parent !== path)
        privateDirectory(parent, false);
    if (!existsSync(path)) {
        if (!create)
            throw new Error("directory missing");
        mkdirSync(path, { mode: 0o700 });
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("directory is not a real directory");
}
function readPrivate(path: string): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || (st.mode & 0o077) !== 0)
            throw new Error("not a private regular staging file");
        return readFileSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function merge(ranges: [
    number,
    number
][]): [
    number,
    number
][] {
    const result: [
        number,
        number
    ][] = [];
    for (const r of ranges.sort((a, b) => a[0] - b[0])) {
        const last = result.at(-1);
        if (last && r[0] <= last[1])
            last[1] = Math.max(last[1], r[1]);
        else
            result.push([...r]);
    }
    return result;
}
export function createUploadManager(deps: UploadDependencies) {
    const limits = { ...DEFAULT_UPLOAD_LIMITS, ...deps.limits };
    const now = deps.now ?? Date.now;
    if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n <= 0) || limits.chunkBytes > limits.artifactBytes || limits.artifactBytes > limits.totalBytes || limits.artifactBytes > 1024 * 1024 * 1024 || limits.concurrent > 100 || limits.idleTtlMs > 30 * 86400000)
        throw new Error("invalid upload limits");
    privateDirectory(deps.root, true);
    if ((lstatSync(deps.root).mode & 0o077) !== 0)
        throw new Error("staging root must be private (0700)");
    function paths(id: string) { if (!ID.test(id))
        throw new Error("invalid upload id"); return { meta: join(deps.root, `${id}.json`), data: join(deps.root, `${id}.bytes`) }; }
    function save(e: Entry) { const p = paths(e.id); const temp = join(deps.root, `${e.id}.${randomUUID()}.tmp`); const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try {
        writeFileSync(fd, JSON.stringify(e));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    } renameSync(temp, p.meta); const dir = openSync(deps.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try {
        fsyncSync(dir);
    }
    finally {
        closeSync(dir);
    } }
    function read(id: string): Entry | undefined {
        const p = paths(id);
        if (!existsSync(p.meta))
            return;
        const e = JSON.parse(readPrivate(p.meta).toString("utf8")) as Entry;
        if (e.version !== 1 || e.id !== id || typeof e.actor !== "string" || typeof e.archiveId !== "string" || typeof e.invocationId !== "string" || typeof e.mediaType !== "string" || !Number.isSafeInteger(e.total) || e.total < 0 || e.total > limits.artifactBytes || !DIGEST.test(e.digest) || !Number.isSafeInteger(e.touched) || !["receiving", "sealed"].includes(e.state) || !Array.isArray(e.ranges) || e.ranges.some(r => !Array.isArray(r) || r.length !== 2 || !Number.isSafeInteger(r[0]) || !Number.isSafeInteger(r[1]) || r[0] < 0 || r[0] >= r[1] || r[1] > e.total))
            throw new Error("corrupt upload metadata");
        return e;
    }
    function drop(e: Entry) { const p = paths(e.id); for (const path of [p.meta, p.data]) {
        if (existsSync(path)) {
            if (!lstatSync(path).isFile())
                throw new Error("unsafe staging file");
            unlinkSync(path);
        }
    } }
    function status(e: Entry): UploadStatus { return { upload_id: e.id, state: e.state, total_bytes: e.total, digest: e.digest, ranges: e.ranges, media_type: e.mediaType, expires_at: e.touched + limits.idleTtlMs, chunk_bytes: limits.chunkBytes }; }
    // Archive's cross-process lock serializes metadata; this queue also bounds one manager's in-flight memory.
    let queue: Promise<unknown> = Promise.resolve();
    async function execute(actor: Actor, archiveId: string, command: UploadCommand, signal: AbortSignal): Promise<Result<UploadStatus>> {
        const operation = queue.then(async () => {
            try {
                privateDirectory(deps.root);
                if (signal.aborted)
                    return failure("storage_unavailable", "upload cancelled before staging");
                const old = command.action === "begin" ? undefined : read(command.payload.upload_id);
                const invocationId = command.action === "begin" ? command.payload.invocation_id : old?.invocationId ?? "";
                return await deps.withAccess<UploadStatus>(actor, archiveId, { kind: "upload", invocationId, action: command.action }, signal, async () => {
                    if (signal.aborted)
                        return failure("storage_unavailable", "upload cancelled before staging");
                    if (command.action === "begin") {
                        const p = command.payload;
                        if (!Number.isSafeInteger(p.total_bytes) || p.total_bytes < 0 || !DIGEST.test(p.digest) || typeof p.media_type !== "string" || p.media_type.length === 0 || p.media_type.length > 256 || typeof p.invocation_id !== "string" || !p.invocation_id)
                            return failure("invalid_input", "invalid upload declaration");
                        if (p.total_bytes > limits.artifactBytes)
                            return failure("budget_exceeded", "artifact exceeds byte limit");
                        const entries = readdirSync(deps.root).filter(n => n.endsWith(".json") && ID.test(n.slice(0, -5))).map(n => read(n.slice(0, -5))!);
                        let total = 0, count = 0;
                        for (const entry of entries) {
                            if (entry.archiveId !== archiveId)
                                continue;
                            if (entry.touched + limits.idleTtlMs <= now()) {
                                drop(entry);
                                continue;
                            }
                            total += entry.total;
                            count++;
                        }
                        if (count >= limits.concurrent || total + p.total_bytes > limits.totalBytes)
                            return failure("budget_exceeded", "archive staging budget exhausted; cancel or wait for expiry");
                        const e: Entry = { version: 1, id: `upload_${randomUUID()}`, archiveId, actor: actorKey(actor), invocationId: p.invocation_id, mediaType: p.media_type, total: p.total_bytes, digest: p.digest, ranges: [], state: "receiving", touched: now() };
                        const fd = openSync(paths(e.id).data, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
                        fsyncSync(fd);
                        closeSync(fd);
                        save(e);
                        return success(status(e));
                    }
                    // Re-read only after obtaining the archive lock, not the pre-lock routing hint.
                    const e = read(command.payload.upload_id);
                    if (!e || e.archiveId !== archiveId || e.actor !== actorKey(actor))
                        return failure("not_found", "upload not found in this actor scope");
                    if (e.touched + limits.idleTtlMs <= now()) {
                        drop(e);
                        return failure("not_found", "upload expired; begin again");
                    }
                    if (command.action === "cancel") {
                        drop(e);
                        return success({ ...status(e), state: "cancelled" });
                    }
                    if (command.action === "chunk") {
                        const p = command.payload;
                        if (typeof p.bytes !== "string" || p.bytes.length > Math.ceil(limits.chunkBytes / 3) * 4)
                            return failure("budget_exceeded", "chunk exceeds byte limit");
                        const decoded = decodeBase64(p.bytes);
                        if (!decoded.ok)
                            return decoded;
                        const bytes = decoded.value;
                        if (bytes.length > limits.chunkBytes)
                            return failure("budget_exceeded", "chunk exceeds byte limit");
                        if (!Number.isSafeInteger(p.offset) || p.offset < 0 || bytes.length === 0 || p.offset + bytes.length > e.total || !DIGEST.test(p.digest) || digestBytes(bytes) !== p.digest)
                            return failure("invalid_input", "chunk range or digest mismatch");
                        const combined = merge([...e.ranges, [p.offset, p.offset + bytes.length]]);
                        if (combined.length > 512)
                            return failure("budget_exceeded", "too many fragmented ranges; fill existing gaps first");
                        const fd = openSync(paths(e.id).data, constants.O_RDWR | constants.O_NOFOLLOW);
                        try {
                            const st = fstatSync(fd);
                            if (!st.isFile() || (st.mode & 0o077) !== 0)
                                throw new Error("unsafe upload byte file");
                            for (const [start, end] of e.ranges) {
                                const a = Math.max(start, p.offset), b = Math.min(end, p.offset + bytes.length);
                                if (a < b) {
                                    const prior = Buffer.alloc(b - a);
                                    if (readSync(fd, prior, 0, prior.length, a) !== prior.length || !prior.equals(bytes.subarray(a - p.offset, b - p.offset)))
                                        return failure("invalid_input", "overlapping chunk contains different bytes");
                                }
                            }
                            if (e.state === "sealed")
                                return success(status(e));
                            let written = 0;
                            while (written < bytes.length)
                                written += writeSync(fd, bytes, written, bytes.length - written, p.offset + written);
                            fsyncSync(fd);
                        }
                        finally {
                            closeSync(fd);
                        }
                        e.ranges = combined;
                    }
                    else if (command.action === "commit" || command.action === "seal") {
                        if (e.total !== 0 && (e.ranges.length !== 1 || e.ranges[0]![0] !== 0 || e.ranges[0]![1] !== e.total))
                            return failure("invalid_input", "upload has missing ranges");
                        const bytes = readPrivate(paths(e.id).data);
                        if (bytes.length !== e.total || digestBytes(bytes) !== e.digest)
                            return failure("invalid_input", "upload total digest mismatch");
                        e.state = "sealed";
                    }
                    e.touched = now();
                    save(e);
                    return success(status(e));
                });
            }
            catch {
                return failure("storage_unavailable", "upload staging is unavailable or corrupt");
            }
        });
        queue = operation.then(() => undefined, () => undefined);
        return operation;
    }
    /** Store-only: use while Archive already holds its current authorization lock. Never expose as a Remote. */
    function resolveSealed(actor: Actor, archiveId: string, invocationId: string, uploadId: string, digest: string): Result<SealedBytes> {
        try {
            privateDirectory(deps.root);
            const e = read(uploadId);
            if (!e || e.archiveId !== archiveId || e.actor !== actorKey(actor) || e.invocationId !== invocationId || e.touched + limits.idleTtlMs <= now())
                return failure("not_found", "upload not found in this actor/invocation scope");
            if (e.state !== "sealed" || e.digest !== digest)
                return failure("invalid_input", "upload must be sealed with matching digest");
            const bytes = readPrivate(paths(e.id).data);
            if (bytes.length !== e.total || digestBytes(bytes) !== digest)
                return failure("archive_corrupt", "sealed upload bytes changed");
            return success({ upload_id: e.id, digest, media_type: e.mediaType, bytes });
        }
        catch {
            return failure("storage_unavailable", "sealed staging is unavailable");
        }
    }
    return { execute, resolveSealed, limits: Object.freeze({ ...limits }) };
}
export type UploadManager = ReturnType<typeof createUploadManager>;
