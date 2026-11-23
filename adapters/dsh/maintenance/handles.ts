/** Short-lived location capabilities issued only after native, current owner authorization. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { actorKey, failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import { digestBytes } from "../uploads/index.ts";
export type LocationKind = "source" | "destination" | "backup" | "replica" | "root";
/**
 * What the owner selected.
 *
 * A filesystem location names an absolute `path`. A **network replica** names no path at
 * all: its endpoint belongs to the deployment, so the owner names the deployment's own
 * destination key instead, and the native authorizer decides whether that key is
 * declared. The two forms are mutually exclusive, so a caller can never pass a path that
 * is silently ignored, or a key for a kind that needs a real path.
 */
export interface LocationSelection {
    kind: LocationKind;
    world: string;
    /** Absolute path of a filesystem location. Absent for a network replica. */
    path?: string;
    /** Deployment-declared destination name. Only meaningful for `kind: "replica"`. */
    destinationKey?: string;
}
export interface NativeLocationPermission {
    /** Canonical identity from the native permission adapter, never from the request alone. */
    world: string;
    /**
     * Canonical path of a filesystem location.
     *
     * Absent for a network replica, whose endpoint belongs to the deployment and has no
     * local path at all. Consumers that need a path (backup, restore, relocation, Host-local
     * replicas) must treat its absence as "not a filesystem location" rather than defaulting
     * to `""` and touching the current directory.
     */
    path?: string;
    /** Current native authorization is checked on every subsequent use. */
    check(signal: AbortSignal): Promise<boolean>;
    reader?: SourceReader;
    /**
     * Deployment-declared key of the replica destination this selection names.
     *
     * The native authorizer sets it when the owner selects a destination it has actually
     * declared; the value never comes from a request, a model field or a replica record.
     * It lives only inside this capability, so it shares the capability's lifetime:
     * expiring, revoking or restarting the Host drops it, and the next transfer must
     * re-establish authorization instead of reusing a remembered mapping.
     */
    deploymentKey?: string;
}
export interface LocationCapability extends NativeLocationPermission {
    kind: LocationKind;
    handle: string;
}
export interface SourceEntry {
    path: string;
    kind: "file" | "directory" | "symlink" | "other";
    bytes: number;
    digest?: string;
    link?: string;
    error?: "unreadable" | "budget_exceeded" | "unsupported_file";
}
export interface SourceScan {
    entries: readonly SourceEntry[];
    contents: ReadonlyMap<string, Uint8Array>;
    completeness: "complete" | "partial";
}
export interface SourceReader {
    scan(selection: readonly string[], budget: number, signal: AbortSignal): Promise<Result<SourceScan>>;
}
/** Grammar of a deployment-declared destination name. */
const DEPLOYMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function safeLogicalPath(path: string): boolean { return typeof path === "string" && path.length > 0 && Buffer.byteLength(path) <= 4096 && !isAbsolute(path) && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path) && path.split("/").every(p => p !== "" && p !== "." && p !== ".." && !/^[A-Za-z]:/.test(p)); }
export function createLocationHandles(deps: {
    authorizeSelection(actor: Actor, request: LocationSelection, signal: AbortSignal): Promise<Result<NativeLocationPermission>>;
    now?: () => number;
    ttlMs?: number;
}) {
    const entries = new Map<string, {
        actor: string;
        value: LocationCapability;
        expires: number;
    }>();
    const now = deps.now ?? Date.now;
    const ttl = deps.ttlMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400000)
        throw new Error("invalid location handle TTL");
    async function choose(actor: Actor, request: LocationSelection, signal: AbortSignal): Promise<Result<{
        handle: string;
        kind: LocationKind;
        world: string;
        expires_at: number;
        digest: string;
    }>> {
        if (actor.kind !== "owner" || actor.channel !== "authenticated-remote")
            return failure("not_authorized", "location selection requires a current authenticated owner");
        if (!["source", "destination", "backup", "replica", "root"].includes(request.kind) || !request.world || typeof request.world !== "string")
            return failure("invalid_input", "select a location in a verified execution world");
        // A replica names a deployment destination, not a filesystem path. Every other kind
        // names an absolute path and must not carry a destination key, so neither form can
        // be smuggled through the other.
        const networkSelection = request.kind === "replica" && request.path === undefined;
        if (networkSelection) {
            if (typeof request.destinationKey !== "string" || !DEPLOYMENT_KEY.test(request.destinationKey))
                return failure("invalid_input", "a network replica selection requires a declared destination key");
        }
        else {
            if (typeof request.path !== "string" || !isAbsolute(request.path) || request.path.includes("\0"))
                return failure("invalid_input", "select an absolute location in a verified execution world");
            if (request.destinationKey !== undefined)
                return failure("invalid_input", "only a network replica selection may name a deployment destination");
        }
        if (signal.aborted)
            return failure("storage_unavailable", "location selection cancelled");
        for (const [id, entry] of entries)
            if (entry.expires <= now())
                entries.delete(id);
        if (entries.size >= 256)
            return failure("budget_exceeded", "too many active location handles; revoke unused handles first");
        const granted = await deps.authorizeSelection(actor, request, signal);
        if (!granted.ok)
            return granted;
        // The authorizer answers with canonical values. A network replica has no path; every
        // other kind requires an absolute one.
        if (!granted.value.world || typeof granted.value.world !== "string" || !(await granted.value.check(signal)))
            return failure("not_authorized", "native location authorization unavailable");
        // A filesystem location must be absolute; a network replica must carry no path at
        // all, so it can never be mistaken for a local directory.
        if (networkSelection) {
            if (granted.value.path !== undefined && granted.value.path !== "")
                return failure("not_authorized", "native location authorization returned a path for a network destination");
        }
        else if (typeof granted.value.path !== "string" || !isAbsolute(granted.value.path))
            return failure("not_authorized", "native location authorization unavailable");
        // A deployment key is a plain name the deployment declared. It is validated once
        // here rather than trusted later, and it is meaningful only for a replica
        // selection; any other kind carrying one is a native bug.
        if (granted.value.deploymentKey !== undefined) {
            if (request.kind !== "replica")
                return failure("invalid_input", "only a replica selection may name a deployment destination");
            if (!DEPLOYMENT_KEY.test(granted.value.deploymentKey))
                return failure("not_authorized", "native authorization named an invalid deployment destination");
            // The request may ask for a destination; only the authorizer may grant one, and
            // only the granted destination is stored.
            if (request.destinationKey !== undefined && request.destinationKey !== granted.value.deploymentKey)
                return failure("not_authorized", "native authorization does not cover the requested destination");
        }
        // A network replica with no granted key has no endpoint at all; refuse here rather
        // than issue a capability the transport would have to reject later.
        if (networkSelection && granted.value.deploymentKey === undefined)
            return failure("not_authorized", "this deployment declares no such replica destination");
        const handle = `location_${randomUUID()}`;
        const expires = now() + ttl;
        entries.set(handle, { actor: actorKey(actor), value: { ...granted.value, kind: request.kind, handle }, expires });
        return success({ handle, kind: request.kind, world: granted.value.world, expires_at: expires, digest: digestBytes(Buffer.from(handle)) });
    }
    async function use(actor: Actor, handle: string, kind: LocationKind, signal: AbortSignal): Promise<Result<LocationCapability>> {
        if (actor.kind !== "owner" || actor.channel !== "authenticated-remote")
            return failure("not_authorized", "location use requires owner");
        const entry = entries.get(handle);
        if (!entry || entry.actor !== actorKey(actor) || entry.value.kind !== kind || entry.expires <= now())
            return failure("not_found", "location handle is unavailable or expired");
        if (signal.aborted || !(await entry.value.check(signal)))
            return failure("not_authorized", "native location permission was revoked");
        return success(entry.value);
    }
    async function list(actor: Actor, signal: AbortSignal): Promise<readonly {
        handle: string;
        kind: LocationKind;
        world: string;
        expires_at: number;
    }[]> {
        if (actor.kind !== "owner" || actor.channel !== "authenticated-remote")
            return [];
        const result: {
            handle: string;
            kind: LocationKind;
            world: string;
            expires_at: number;
        }[] = [];
        for (const [handle, entry] of entries) {
            if (entry.actor !== actorKey(actor) || entry.expires <= now() || signal.aborted)
                continue;
            if (await entry.value.check(signal))
                result.push({ handle, kind: entry.value.kind, world: entry.value.world, expires_at: entry.expires });
        }
        return result;
    }
    return { choose, use, list, revoke: (handle: string) => entries.delete(handle), dispose: () => entries.clear() };
}
export type LocationHandles = ReturnType<typeof createLocationHandles>;
/** Host-world adapter only. Native adapter must select this only for a verified Host-local source. */
export function localSourceReader(root: string): SourceReader {
    const canonical = realpathSync(root);
    if (resolve(root) !== canonical || !lstatSync(root).isDirectory())
        throw new Error("source root must be canonical");
    const identity = lstatSync(root);
    return { async scan(selection, budget, signal) {
            if (!Number.isSafeInteger(budget) || budget < 0 || budget > 1024 * 1024 * 1024 || selection.some(p => !safeLogicalPath(p)))
                return failure("invalid_input", "invalid source selection or byte budget");
            try {
                const current = lstatSync(root);
                if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(root) !== canonical)
                    return failure("source_changed", "source root identity changed");
                let used = 0;
                const entries: SourceEntry[] = [];
                const contents = new Map<string, Uint8Array>();
                const seen = new Set<string>();
                const wanted = selection.length ? selection : [""];
                const openDir = (path: string) => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                const rootFd = openDir(root);
                const rootStat = fstatSync(rootFd);
                if (rootStat.dev !== identity.dev || rootStat.ino !== identity.ino) {
                    closeSync(rootFd);
                    throw new Error("source root changed");
                }
                function walk(parentFd: number, name: string, logical: string): void {
                    if (signal.aborted)
                        throw new Error("cancelled");
                    if (seen.has(logical))
                        return;
                    seen.add(logical);
                    if (entries.length >= 10000)
                        throw new Error("inventory entry budget exceeded");
                    const full = `/proc/self/fd/${parentFd}/${name}`;
                    try {
                        const st = lstatSync(full);
                        if (st.isSymbolicLink()) {
                            const link = readlinkSync(full);
                            const bytes = Buffer.from(link);
                            if (bytes.length > budget - used) {
                                entries.push({ path: logical, kind: "symlink", bytes: bytes.length, link, error: "budget_exceeded" });
                                return;
                            }
                            used += bytes.length;
                            entries.push({ path: logical, kind: "symlink", bytes: bytes.length, digest: digestBytes(bytes), link });
                            contents.set(logical, bytes);
                            return;
                        }
                        if (st.isDirectory()) {
                            const fd = openDir(full);
                            if (logical)
                                entries.push({ path: logical, kind: "directory", bytes: 0 });
                            try {
                                for (const childName of readdirSync(`/proc/self/fd/${fd}`).sort()) {
                                    const child = logical ? `${logical}/${childName}` : childName;
                                    if (!safeLogicalPath(child))
                                        throw new Error("unsafe source filename");
                                    walk(fd, childName, child);
                                }
                            }
                            finally {
                                closeSync(fd);
                            }
                            return;
                        }
                        if (!st.isFile()) {
                            entries.push({ path: logical, kind: "other", bytes: st.size, error: "unsupported_file" });
                            return;
                        }
                        if (st.size > budget - used) {
                            entries.push({ path: logical, kind: "file", bytes: st.size, error: "budget_exceeded" });
                            return;
                        }
                        const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
                        let bytes: Buffer;
                        try {
                            const before = fstatSync(fd);
                            if (!before.isFile() || before.size > budget - used)
                                throw new Error("source changed");
                            bytes = readFileSync(fd);
                            const after = fstatSync(fd);
                            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size)
                                throw new Error("source changed");
                        }
                        finally {
                            closeSync(fd);
                        }
                        used += bytes.length;
                        entries.push({ path: logical, kind: "file", bytes: bytes.length, digest: digestBytes(bytes) });
                        contents.set(logical, bytes);
                    }
                    catch {
                        entries.push({ path: logical || "(root)", kind: "other", bytes: 0, error: "unreadable" });
                    }
                }
                try {
                    for (const path of wanted) {
                        if (!path) {
                            for (const name of readdirSync(`/proc/self/fd/${rootFd}`).sort()) {
                                if (!safeLogicalPath(name))
                                    throw new Error("unsafe source filename");
                                walk(rootFd, name, name);
                            }
                            continue;
                        }
                        const parts = path.split("/");
                        let fd = rootFd;
                        const ancestors: number[] = [];
                        try {
                            for (const part of parts.slice(0, -1)) {
                                fd = openDir(`/proc/self/fd/${fd}/${part}`);
                                ancestors.push(fd);
                            }
                            walk(fd, parts.at(-1)!, path);
                        }
                        catch {
                            entries.push({ path, kind: "other", bytes: 0, error: "unreadable" });
                        }
                        finally {
                            for (const ancestor of ancestors.reverse())
                                closeSync(ancestor);
                        }
                    }
                }
                finally {
                    closeSync(rootFd);
                }
                entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
                return success({ entries, contents, completeness: entries.some(e => e.error) ? "partial" : "complete" });
            }
            catch {
                return failure("source_changed", "source cannot be safely inventoried; reselect or reduce the selection");
            }
        } };
}
