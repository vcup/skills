/**
 * A replica destination key must come from the owner's location capability.
 *
 * The bug this locks down: `choose {kind:"replica"}` returns a runtime capability id
 * (`location_<uuid>`), and `configure_replica` stores it in the replica record. The
 * native adapter used to look that value up in the deployment map, which is keyed by
 * the deployment's own name, so every real network replica was refused. The fix is a
 * trusted mapping: the native authorizer that issues the capability names the
 * deployment key, the engine copies it into the transfer context, and the transport
 * resolves only that key.
 *
 * These cases assert the trust properties, not just the happy path:
 * - no key on the capability -> refused, with no fallback to the runtime handle;
 * - a key on a non-replica capability -> refused (a native bug must not become a path
 *   to a remote);
 * - the transport resolves the deployment key and never the replica record's handle;
 * - the key dies with the capability, so a revoked selection cannot transfer.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocationHandles } from "./handles.ts";
import { ReplicaTransportError, createReplicaMaintenance, type NativeReplicaTransport, type Replica, type ReplicaLease } from "./replication.ts";
import { success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";

const actor: Actor = { kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote" };
const signal = new AbortController().signal;

function value<T>(r: Result<T>): T {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
}

/** Transport that records the context it was handed, so trust can be inspected. */
function recorder() {
    const seen: { readonly destinationKey: string; readonly primaryRoot: string }[] = [];
    const transport: NativeReplicaTransport = {
        async authorize() { return { identity: "deployment-remote", destinationKey: "mirror" }; },
        async head(_r, _s, context) { if (context) seen.push(context); return null; },
        async push(_r, _rev, _exp, _s, context) { if (context) seen.push(context); },
        async fetch(_r, expected, _s, context) { if (context) seen.push(context); return { candidateId: "candidate", head: expected, readOnly: true }; },
    };
    return { transport, seen };
}

async function fixture(authorizeSelection: Parameters<typeof createLocationHandles>[0]["authorizeSelection"]) {
    const configs = new Map<string, Replica>();
    const handles = createLocationHandles({ authorizeSelection });
    const lease: ReplicaLease = {
        destinationAllowed: () => true,
        head: async () => "a".repeat(40),
        remoteHead: async () => null,
        push: async () => {},
        fetch: async (_d, expected) => ({ candidateId: "candidate", head: expected, readOnly: true }),
        isAncestor: async () => true,
        repository: "/tmp/repository-fixture",
        get: async id => configs.get(id),
        save: async replica => { configs.set(replica.id, replica); },
    };
    const recording = recorder();
    const manager = createReplicaMaintenance({ handles, hostWorld: "host", network: recording.transport, access: { withOwner: async (_a, _id, _s, run) => run(lease) } });
    return { manager, handles, seen: recording.seen, configs };
}

const locationPath = () => join(mkdtempSync(join(tmpdir(), "destkey-")), "destination");

describe("replica destination key trust", () => {
    test("a capability carrying the deployment key is forwarded, and the runtime handle is never resolved", async () => {
        const f = await fixture(async (_a, r) => success({ world: r.world, path: r.path, check: async () => true, deploymentKey: "mirror" }));
        const chosen = value(await f.handles.choose(actor, { kind: "replica", world: "network", path: locationPath() }, signal));
        // The public handle stays opaque and does not leak the deployment name.
        expect(chosen.handle).toMatch(/^location_[0-9a-f-]{36}$/);
        expect(JSON.stringify(chosen)).not.toContain("mirror");
        const replica = value(await f.manager.configure(actor, "archive", { destinationHandle: chosen.handle, credentialHandle: "native:replica", expectedIdentity: "deployment-remote" }, signal));
        // The stored record keeps the runtime handle; the deployment name travelled only
        // through the trusted capability and the transfer context.
        expect(replica.destinationHandle).toBe(chosen.handle);
        expect(f.seen[0]?.destinationKey).toBe("mirror");
    });

    test("a replica capability with no deployment key is refused, not resolved from the handle", async () => {
        const f = await fixture(async (_a, r) => success({ world: r.world, path: r.path, check: async () => true }));
        const chosen = value(await f.handles.choose(actor, { kind: "replica", world: "network", path: locationPath() }, signal));
        const refused = await f.manager.configure(actor, "archive", { destinationHandle: chosen.handle, credentialHandle: "native:replica", expectedIdentity: "deployment-remote" }, signal);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.code).toBe("not_authorized");
        expect(f.seen).toEqual([]);
    });

    test("a deployment key on a non-replica capability is refused as a native bug", async () => {
        const f = await fixture(async (_a, r) => success({ world: r.world, path: r.path, check: async () => true, deploymentKey: "mirror" }));
        const refused = await f.handles.choose(actor, { kind: "destination", world: "host", path: locationPath() }, signal);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
    });

    test("an invalid deployment key name is refused when the capability is issued", async () => {
        const f = await fixture(async (_a, r) => success({ world: r.world, path: r.path, check: async () => true, deploymentKey: "bad key/../x" }));
        const refused = await f.handles.choose(actor, { kind: "replica", world: "network", path: locationPath() }, signal);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.code).toBe("not_authorized");
    });

    test("the key dies with the capability: a revoked selection cannot transfer", async () => {
        let allowed = true;
        const f = await fixture(async (_a, r) => success({ world: r.world, path: r.path, check: async () => allowed, deploymentKey: "mirror" }));
        const chosen = value(await f.handles.choose(actor, { kind: "replica", world: "network", path: locationPath() }, signal));
        const replica = value(await f.manager.configure(actor, "archive", { destinationHandle: chosen.handle, credentialHandle: "native:replica", expectedIdentity: "deployment-remote" }, signal));
        allowed = false;
        const pushed = await f.manager.push(actor, "archive", replica.id, "a".repeat(40), signal);
        expect(pushed.ok).toBe(false);
        if (!pushed.ok) expect(pushed.error.code).toBe("not_authorized");
        // A revoked capability never produced a transfer.
        expect(f.seen.length).toBeLessThanOrEqual(1);
    });

    test("the transport itself refuses a transfer that carries no deployment key", async () => {
        // Directly, with no engine in between: an empty key is a refusal, never a
        // fallback to the replica's runtime handle.
        const { createAllowlistedReplicaTransport } = await import("./network-deployment.ts");
        const transport = createAllowlistedReplicaTransport({
            allowlist: ["git.example"],
            resolve: (key: string) => { if (key !== "mirror") throw new Error("undeclared"); return "https://git.example/team/archive.git"; },
            identity: "git.example",
            quarantineRoot: mkdtempSync(join(tmpdir(), "destkey-q-")),
            primaryRoot: "/tmp",
            timeoutMs: 5000,
            authorize: () => true,
        });
        const replica: Replica = { id: "r", archiveId: "a", destinationHandle: "location_00000000-0000-0000-0000-000000000000", expectedIdentity: "git.example", credentialHandle: "native:replica", expectedRevision: null, state: "configured" };
        await expect(transport.head(replica, signal, { primaryRoot: "/tmp", destinationKey: "" }, { identity: "git.example", destinationKey: "" })).rejects.toBeInstanceOf(ReplicaTransportError);
        await expect(transport.head(replica, signal, { primaryRoot: "/tmp", destinationKey: "not-declared" }, { identity: "git.example", destinationKey: "not-declared" })).rejects.toThrow();
    });
});
