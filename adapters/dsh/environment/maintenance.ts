/** Environment-specific backup/recovery over the shared owner location and byte publication seams. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { actorKey, failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import type { EnvironmentRequest } from "../../../modules/ensemble/environment.ts";
import { decode, integer, literal, object, str } from "../../../modules/ensemble/validation.ts";
import { validateArchiveRoot } from "../archive.ts";
import { publishDirectory, readRegular } from "../maintenance/files.ts";
import type { LocationHandles } from "../maintenance/handles.ts";
import type { EnvironmentService } from "./service.ts";

interface Manifest {
  format: "ensemble-environment-backup/v1"; environment_id: string; revision: string;
  operation_id: string; actor_key: string; bundle: { digest: string; bytes: number };
}
const manifestSchema = object({ format: literal("ensemble-environment-backup/v1"), environment_id: str(1, 128), revision: str(40, 40, "^[0-9a-f]{40}$"),
  operation_id: str(1, 128), actor_key: str(1, 1024), bundle: object({ digest: str(64, 64, "^[0-9a-f]{64}$"), bytes: integer(1, 512 * 1024 * 1024) }) });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function readBackup(root: string): Result<{ manifest: Manifest; bytes: Uint8Array }> {
  try {
    const manifest = decode<Manifest>(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRegular(join(root, "manifest.json"), 65536))), manifestSchema);
    if (!manifest.ok) return failure("archive_corrupt", "Environment backup manifest is invalid.");
    const bytes = readRegular(join(root, "environment.bundle"));
    if (bytes.length !== manifest.value.bundle.bytes || digest(bytes) !== manifest.value.bundle.digest) return failure("archive_corrupt", "Environment backup bytes do not match their manifest.");
    return success({ manifest: manifest.value, bytes });
  } catch { return failure("archive_corrupt", "Environment backup cannot be safely read as complete regular files."); }
}
export interface EnvironmentLocations { readonly handles: LocationHandles; readonly hostWorld: string; readonly protectedRoots: readonly string[] }
export async function maintainEnvironment(service: EnvironmentService, root: string, locations: EnvironmentLocations, actor: Actor,
  request: Extract<EnvironmentRequest, { action: "environment_backup" | "environment_recover" }>, signal: AbortSignal): Promise<Result<unknown>> {
  try {
    const handle = await locations.handles.use(actor, request.action === "environment_backup" ? request.destination_handle : request.backup_handle, request.action === "environment_backup" ? "destination" : "backup", signal);
    if (!handle.ok) return handle;
    if (handle.value.world !== locations.hostWorld) return failure("invalid_input", "Environment maintenance requires a verified Host-world location.");
    // Environment backup/restore are filesystem-only: they publish and read a directory of
    // regular files. A network replica capability carries no path at all, so an absent path
    // is refused here as "not a filesystem location" rather than collapsed into the process
    // working directory by a non-null assertion or a `join(undefined, ...)`.
    if (typeof handle.value.path !== "string") return failure("invalid_input", "Environment backup and restore require a filesystem location path; a network destination is not supported.");
    const path = handle.value.path;
    if (!validateArchiveRoot(path, [root, ...locations.protectedRoots]).ok) return failure("invalid_input", "Environment backup overlaps a protected archive or source.");
    if (request.action === "environment_recover") {
      const backup = readBackup(path); if (!backup.ok) return backup;
      if (!await handle.value.check(signal)) return failure("not_authorized", "Backup read authorization was revoked.");
      return service.restoreBackup(actor, backup.value.bytes, backup.value.manifest.revision, request.operation_id, signal);
    }
    // A lost publication response is reconciled by the exact output manifest, never by overwriting it.
    if (existsSync(path)) {
      const prior = readBackup(path); if (!prior.ok) return failure("destination_exists", "Destination already exists and is not a complete environment backup.");
      if (prior.value.manifest.operation_id !== request.operation_id || prior.value.manifest.actor_key !== actorKey(actor) || prior.value.manifest.revision !== request.expected_revision) return failure("operation_key_conflict", "Existing backup belongs to a different operation or revision.");
      return success({ status: "backed_up", ...prior.value.manifest, replayed: true });
    }
    const backup = await service.backup(actor, signal, request.expected_revision); if (!backup.ok) return backup;
    const manifest: Manifest = { format: "ensemble-environment-backup/v1", environment_id: backup.value.environment_id, revision: backup.value.revision,
      operation_id: request.operation_id, actor_key: actorKey(actor), bundle: { digest: backup.value.digest, bytes: backup.value.bytes.length } };
    if (!await handle.value.check(signal)) return failure("not_authorized", "Backup destination authorization was revoked.");
    publishDirectory(path, [{ path: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) }, { path: "environment.bundle", bytes: backup.value.bytes }]);
    return success({ status: "backed_up", ...manifest, replayed: false });
  } catch { return failure("storage_unavailable", "Environment maintenance failed; inspect the exact destination and operation before retrying."); }
}
