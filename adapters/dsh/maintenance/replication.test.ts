import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocationHandles } from "./handles.ts";
import { createReplicaMaintenance, type Replica, type ReplicaLease } from "./replication.ts";
import { success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
const actor: Actor = { kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote" };
const signal = new AbortController().signal;
function val<T>(r: Result<T>): T { if (!r.ok)
    throw new Error(JSON.stringify(r.error)); return r.value; }
async function setup() {
    let remote: string | null = null;
    let pushes = 0;
    let lose = false;
    let authorized = true;
    const configs = new Map<string, Replica>();
    const handles = createLocationHandles({ authorizeSelection: async (_a, r) => success({ world: r.world, path: r.path, check: async () => authorized }) });
    const location = val(await handles.choose(actor, { kind: "replica", world: "host", path: mkdtempSync(join(tmpdir(), "replica-unit-")) }, signal));
    const lease: ReplicaLease = { destinationAllowed: () => true, head: async () => "a".repeat(40), remoteHead: async () => remote, push: async (_d, revision, expected) => { if (remote !== expected)
            throw new Error("CAS failed"); pushes++; remote = revision; if (lose)
            throw new Error("connection lost after publish"); }, fetch: async (_d, expected) => ({ candidateId: "quarantine", head: expected, readOnly: true }), isAncestor: async () => true, repository: "/tmp/repository-fixture", get: async (id) => configs.get(id), save: async (r) => { configs.set(r.id, r); } };
    const manager = createReplicaMaintenance({ handles, hostWorld: "host", access: { withOwner: async (_a, _id, _s, run) => run(lease) } });
    const replica = val(await manager.configure(actor, "archive", { destinationHandle: location.handle, credentialHandle: "none", expectedIdentity: "host" }, signal));
    return { manager, replica, lose: () => { lose = true; }, deny: () => { authorized = false; }, foreign: () => { remote = "b".repeat(40); }, pushes: () => pushes, configs };
}
test("lost push acknowledgement persists unknown and reconciles before any retry", async () => { const f = await setup(); f.lose(); const first = await f.manager.push(actor, "archive", f.replica.id, "a".repeat(40), signal); expect(!first.ok && first.error.code).toBe("outcome_unknown"); expect(f.configs.get(f.replica.id)?.state).toBe("unknown"); expect(val(await f.manager.push(actor, "archive", f.replica.id, "a".repeat(40), signal)).state).toBe("pushed"); expect(f.pushes()).toBe(1); });
test("remote changes and expired native location reject without sending", async () => { const f = await setup(); f.foreign(); const conflict = await f.manager.push(actor, "archive", f.replica.id, "a".repeat(40), signal); expect(!conflict.ok && conflict.error.code).toBe("remote_conflict"); f.deny(); expect((await f.manager.fetch(actor, "archive", f.replica.id, "b".repeat(40), signal)).ok).toBe(false); expect(f.pushes()).toBe(0); });
