/** Source bytes stay in their native filesystem world; archive grants never grant source access. */
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import { safeLogicalPath, type LocationSelection, type NativeLocationPermission, type SourceReader, type SourceEntry } from "../maintenance/handles.ts";
import { digestBytes } from "../uploads/index.ts";

export interface LocationWorld {
  readonly identity: string;
  readonly fs: FileSystem;
  /** Only this world may provide paths to Host-local maintenance implementations. */
  readonly hostLocal: boolean;
  readonly source?: boolean;
  readonly current: () => boolean;
  readonly readLink?: (path: string, signal: AbortSignal) => Promise<string>;
}

/** Scan through public native filesystem methods only, including binary content and containment. */
export function nativeSourceReader(world: LocationWorld, root: FsTarget): SourceReader {
  return { async scan(selection, budget, signal) {
    if (!Number.isSafeInteger(budget) || budget < 1 || selection.some(path => !safeLogicalPath(path))) return failure("invalid_input", "source selection or byte budget is invalid");
    if (!world.current()) return failure("not_authorized", "source execution world is no longer active");
    const entries: SourceEntry[] = [];
    const contents = new Map<string, Uint8Array>();
    const seen = new Set<string>();
    let used = 0;
    const base = world.fs.processPath(root);
    async function walk(logical: string): Promise<void> {
      signal.throwIfAborted();
      if (!world.current()) throw new Error("source execution world changed");
      if (seen.has(logical)) return;
      seen.add(logical);
      if (seen.size > 10000) throw new Error("source inventory item budget exceeded");
      const path = logical ? `${base}/${logical}` : base;
      const parentPath = logical.includes("/") ? `${base}/${logical.slice(0, logical.lastIndexOf("/"))}` : base;
      const parent = await world.fs.resolve(parentPath, { signal });
      if (!world.fs.contains(root, parent)) throw new Error("source ancestor escapes the selected native root");
      const direct = await world.fs.lstat(path, {}, signal);
      if (direct?.type === "symlink") {
        if (!world.readLink) { entries.push({ path: logical, kind: "symlink", bytes: direct.size ?? 0, error: "unreadable" }); return; }
        const link = await world.readLink(path, signal);
        const bytes = new TextEncoder().encode(link);
        const after = await world.fs.lstat(path, {}, signal);
        if (after?.version !== direct.version) throw new Error("source symlink changed during inventory");
        if (bytes.byteLength > budget - used) { entries.push({ path: logical, kind: "symlink", bytes: bytes.byteLength, link, error: "budget_exceeded" }); return; }
        used += bytes.byteLength;
        entries.push({ path: logical, kind: "symlink", bytes: bytes.byteLength, link, digest: digestBytes(bytes) });
        contents.set(logical, bytes);
        return;
      }
      const target = await world.fs.resolve(path, { signal });
      if (!world.fs.contains(root, target)) throw new Error("source escapes the selected native root");
      const before = await world.fs.stat(target, signal);
      if (!before) throw new Error("source disappeared during inventory");
      if (before.type === "directory") {
        if (logical) entries.push({ path: logical, kind: "directory", bytes: 0 });
        const children = await world.fs.listDir(target, signal);
        for (const child of [...children].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
          if (!safeLogicalPath(child.name) || child.name.includes("/")) throw new Error("native directory entry is not a basename");
          const childPath = logical ? `${logical}/${child.name}` : child.name;
          try { await walk(childPath); }
          catch (error) {
            const code = error instanceof Error && "code" in error ? error.code : undefined;
            if (code === "EACCES" || code === "FS_PERMISSION_DENIED") entries.push({ path: childPath, kind: "other", bytes: 0, error: "unreadable" });
            else throw error;
          }
        }
        const after = await world.fs.stat(target, signal);
        if (after?.version !== before.version) throw new Error("source directory changed during inventory");
      } else if (before.type === "file") {
        if (typeof before.size !== "number" || before.size > budget - used) { entries.push({ path: logical, kind: "file", bytes: before.size ?? 0, error: "budget_exceeded" }); return; }
        const bytes = await world.fs.readBytes(target, signal, budget - used);
        const after = await world.fs.stat(target, signal);
        if (after?.version !== before.version || bytes.byteLength !== before.size) throw new Error("source file changed during inventory");
        used += bytes.byteLength;
        entries.push({ path: logical, kind: "file", bytes: bytes.byteLength, digest: digestBytes(bytes) });
        contents.set(logical, bytes);
      } else entries.push({ path: logical, kind: "other", bytes: 0, error: "unsupported_file" });
    }
    try {
      for (const path of selection.length ? selection : [""]) await walk(path);
      return success({ entries, contents, completeness: entries.some(entry => entry.error) ? "partial" : "complete" });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      return failure(code === "FS_PERMISSION_DENIED" || code === "FS_SANDBOX_DENIED" ? "not_authorized" : "source_changed", "source could not be completely read in its native execution world; reselect or retry the inventory");
    }
  } };
}

/**
 * Issue a capability only for an explicit owner selection in a registered world.
 *
 * Two shapes are admitted, and they are not interchangeable:
 *
 * - a **filesystem** selection (every kind) names an absolute path in a world this
 *   deployment maps to real services, and the capability carries a re-checkable
 *   filesystem target;
 * - a **network replica** selection names a deployment destination key instead.
 *   There is no filesystem target to resolve and nothing on this Host to re-check,
 *   so the capability carries only the key, and every use of it is re-authorized by
 *   the caller. A key is supplied here only when the deployment actually declares
 *   it; the request cannot invent one, and a replica selection may not carry a path.
 */
export function locationAuthorizer(worlds: readonly LocationWorld[], destinations?: (key: string) => { identity: string; url: string } | undefined) {
  return async (actor: Actor, request: LocationSelection, signal: AbortSignal): Promise<Result<NativeLocationPermission>> => {
    if (actor.kind !== "owner" || actor.channel !== "authenticated-remote") return failure("not_authorized", "location selection requires the authenticated owner");
    // A network replica has no Host-local path: it is identified by the
    // deployment's own destination name, and only a declared name is accepted.
    if (request.kind === "replica" && request.path === undefined) {
      if (typeof request.destinationKey !== "string" || request.destinationKey === "") {
        return failure("invalid_input", "a network replica selection must name a declared destination");
      }
      const declared = destinations?.(request.destinationKey);
      if (declared === undefined) return failure("not_authorized", "this deployment does not declare that replica destination");
      // No filesystem re-check is possible or meaningful for a remote; the caller
      // re-authorizes on every use instead, so `check` reports only that the
      // destination is still declared.
      const key = request.destinationKey;
      return success({
        world: request.world,
        path: "",
        deploymentKey: key,
        check: async (control: AbortSignal) => !control.aborted && destinations?.(key) !== undefined,
      });
    }
    if (request.path === undefined) return failure("invalid_input", "this location kind requires an absolute path");
    const path = request.path;
    const candidates = worlds.filter(world => world.identity === request.world && (request.kind === "source" ? world.source !== false : world.hostLocal));
    if (candidates.length !== 1) return failure("not_authorized", "execution world is not uniquely registered");
    const world = candidates[0]!;
    if (!world.current() || (request.kind !== "source" && !world.hostLocal)) return failure("not_authorized", "this location kind requires the registered Host-local execution world");
    try {
      signal.throwIfAborted();
      const target = await world.fs.resolve(path, { signal });
      const canonical = world.fs.processPath(target);
      const info = await world.fs.stat(target, signal);
      if (request.kind === "source" && info?.type !== "directory") return failure("invalid_input", "source selection must be an accessible native directory");
      const check = async (control: AbortSignal) => {
        if (control.aborted || !world.current()) return false;
        try {
          const current = await world.fs.resolve(path, { signal: control });
          if (current.targetKey !== target.targetKey) return false;
          if (request.kind === "source") return (await world.fs.stat(current, control))?.type === "directory";
          return true;
        } catch { return false; }
      };
      return success({ world: world.identity, path: canonical, check, ...(request.kind === "source" ? { reader: nativeSourceReader(world, target) } : {}) });
    } catch { return failure("not_authorized", "the native filesystem refused the selected location"); }
  };
}
