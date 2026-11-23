import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { success, type Actor } from "../../../modules/ensemble/contracts.ts";
import { createLocationHandles, type LocationHandles } from "../maintenance/handles.ts";
import { maintainEnvironment, type EnvironmentLocations } from "./maintenance.ts";
import type { EnvironmentService } from "./service.ts";

const owner: Actor = { kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote" };
const hostWorld = "host-world";
const scratchRoots: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "environment-maintenance-")); scratchRoots.push(path); return path; };
afterEach(() => { for (const path of scratchRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** A service that fails the test if maintenance reaches any archive effect. */
function unreachableService(): EnvironmentService {
  const forbidden = (name: string) => () => { throw new Error(`${name} must not run for a refused location`); };
  return { backup: forbidden("backup"), restoreBackup: forbidden("restoreBackup") } as unknown as EnvironmentService;
}
/** Handles whose `use` returns exactly the supplied capability, ignoring the request. */
function fixedHandles(capability: { readonly world: string; readonly path?: string }): LocationHandles {
  return {
    async use() { return success({ ...capability, check: async () => true, kind: "backup", handle: "fixed" } as never); },
    async choose() { throw new Error("choose is not part of this seam test"); },
    async list() { return []; },
    revoke() { return false; },
    dispose() { },
  } as unknown as LocationHandles;
}
const backupRequest = (handle: string) => ({ action: "environment_backup" as const, expected_revision: "a".repeat(40), operation_id: "backup", destination_handle: handle });
const recoverRequest = (handle: string) => ({ action: "environment_recover" as const, expected_revision: "absent" as const, operation_id: "recover", backup_handle: handle });

describe("environment maintenance requires a real filesystem location", () => {
  test("a network destination capability is refused as invalid_input and writes nothing", async () => {
    const parent = scratch();
    const destination = join(parent, "backup-destination");
    const locations: EnvironmentLocations = { handles: fixedHandles({ world: hostWorld }), hostWorld, protectedRoots: [] };
    const result = await maintainEnvironment(unreachableService(), join(parent, "environment.git"), locations, owner, backupRequest("network"), AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.code).toBe("invalid_input"); expect(result.error.message).toContain("filesystem"); }
    // Nothing was published, staged, or committed anywhere under the destination parent.
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });

  test("a network restore source is refused as invalid_input and never reads or restores", async () => {
    const parent = scratch();
    const locations: EnvironmentLocations = { handles: fixedHandles({ world: hostWorld }), hostWorld, protectedRoots: [] };
    const result = await maintainEnvironment(unreachableService(), join(parent, "environment.git"), locations, owner, recoverRequest("network"), AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.code).toBe("invalid_input"); expect(result.error.message).toContain("filesystem"); }
    expect(readdirSync(parent)).toEqual([]);
  });

  test("an empty path is refused, never resolved as the process working directory", async () => {
    const parent = scratch();
    const locations: EnvironmentLocations = { handles: fixedHandles({ world: hostWorld, path: "" }), hostWorld, protectedRoots: [] };
    const result = await maintainEnvironment(unreachableService(), join(parent, "environment.git"), locations, owner, backupRequest("empty"), AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
    expect(readdirSync(parent)).toEqual([]);
  });

  test("a relative path is refused instead of resolving against an unowned cwd", async () => {
    const parent = scratch();
    const locations: EnvironmentLocations = { handles: fixedHandles({ world: hostWorld, path: "relative/backup" }), hostWorld, protectedRoots: [] };
    const result = await maintainEnvironment(unreachableService(), join(parent, "environment.git"), locations, owner, backupRequest("relative"), AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
    expect(readdirSync(parent)).toEqual([]);
  });

  test("the real handle seam cannot issue a pathless destination or backup capability", async () => {
    const handles = createLocationHandles({ async authorizeSelection(_actor, request) { return success({ world: request.world, check: async () => true }); } });
    const signal = AbortSignal.timeout(5000);
    for (const kind of ["destination", "backup"] as const) {
      // The network form is only selectable as `replica`; as destination/backup it carries no path.
      const network = await handles.choose(owner, { kind, world: "network" }, signal);
      expect(network.ok).toBe(false);
      if (!network.ok) expect(network.error.code).toBe("invalid_input");
      // An authorizer that grants no path for a filesystem kind is refused by the seam.
      const pathless = await handles.choose(owner, { kind, world: "network", path: join(tmpdir(), "selection") }, signal);
      expect(pathless.ok).toBe(false);
      if (!pathless.ok) expect(pathless.error.code).toBe("not_authorized");
    }
    handles.dispose();
  });
});
