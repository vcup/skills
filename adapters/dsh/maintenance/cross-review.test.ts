import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocationHandles } from "./handles.ts";
import { createLoopbackReplicaTransport } from "./network.ts";
import { ReplicaTransportError, createReplicaMaintenance, type NativeReplicaTransport, type Replica, type ReplicaLease } from "./replication.ts";
import { success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";

const actor: Actor = { kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote" };
const signal = new AbortController().signal;

function value<T>(r: Result<T>): T {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
}

function baseOptions(root: string) {
    return {
        resolve: (_handle: string) => "git://127.0.0.1:1/repo.git",
        identity: "remote",
        quarantineRoot: join(root, "q"),
        primaryRoot: root,
        authorize: () => true,
    };
}

describe("cross-review findings", () => {
    test("a deployment environment that could redirect Git is refused at construction, never dropped silently", () => {
        const root = mkdtempSync(join(tmpdir(), "env-guard-"));
        // Both transports must agree: a GIT_* name is a configuration error, not
        // something a transport silently discards (which would send an unauthenticated
        // request while looking like it honoured the deployment).
        const hostile: Readonly<Record<string, string>>[] = [{ GIT_DIR: "/elsewhere" }, { GIT_ASKPASS: "/tmp/helper" }, { "bad name": "x" }];
        for (const env of hostile) {
            expect(() => createLoopbackReplicaTransport({ ...baseOptions(root), environment: env })).toThrow();
        }
        // A legitimate non-GIT_ variable is still accepted.
        expect(() => createLoopbackReplicaTransport({ ...baseOptions(root), environment: { REPLICA_TOKEN: "t" } })).not.toThrow();
    });

    test("an unanswerable ancestry check is a conflict, not an indeterminate transfer", async () => {
        let pushes = 0;
        let saves = 0;
        const configs = new Map<string, Replica>();
        const handles = createLocationHandles({ // A replica selection carries the deployment key the native authorizer vouched for;
        // without it a network transfer is refused before reaching these tests' subject.
        authorizeSelection: async (_a, r) => success({ world: r.world, path: r.path, check: async () => true, ...(r.kind === "replica" ? { deploymentKey: "mirror" } : {}) }) });
        const location = value(await handles.choose(actor, { kind: "replica", world: "loopback", path: join(mkdtempSync(join(tmpdir(), "anc-")), "endpoint") }, signal));
        const lease: ReplicaLease = {
            destinationAllowed: () => true,
            head: async () => "a".repeat(40),
            remoteHead: async () => "b".repeat(40),
            push: async () => { pushes++; },
            fetch: async (_d, expected) => ({ candidateId: "c", head: expected, readOnly: true }),
            // The remote revision is absent from the local object database, which is
            // exactly the case Git reports as an error rather than exit 1.
            isAncestor: async () => { throw new Error("fatal: bad object bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"); },
            repository: "/tmp/repository-fixture",
            get: async id => configs.get(id),
            save: async replica => { saves++; configs.set(replica.id, replica); },
        };
        const transport: NativeReplicaTransport = {
            async authorize() { return { identity: "deployment-remote", destinationKey: "mirror" }; },
            async head() { return "b".repeat(40); },
            async push() { pushes++; },
            async fetch(_r, expected) { return { candidateId: "c", head: expected, readOnly: true }; },
        };
        const manager = createReplicaMaintenance({ handles, hostWorld: "host", network: transport, access: { withOwner: async (_a, _id, _s, run) => run(lease) } });
        const replica = value(await manager.configure(actor, "archive", { destinationHandle: location.handle, credentialHandle: "native:token", expectedIdentity: "deployment-remote" }, signal));
        // Make the saved expected revision match the observed remote so push reaches
        // the ancestry gate rather than failing CAS first.
        configs.set(replica.id, { ...replica, expectedRevision: "b".repeat(40) });
        saves = 0;
        const pushed = await manager.push(actor, "archive", replica.id, "a".repeat(40), signal);
        expect(pushed.ok).toBe(false);
        if (!pushed.ok) {
            // A conflict the operator can act on by re-reading the remote.
            expect(pushed.error.code).toBe("remote_conflict");
            expect(pushed.error.message).toContain("cannot be proven an ancestor");
            // And the message still carries no raw Git text.
            expect(pushed.error.message).not.toContain("bad object");
            expect(pushed.error.message).not.toContain("bbbb");
        }
        // Crucially: nothing was sent, and no "intent to push" was persisted for a
        // transfer that never started.
        expect(pushes).toBe(0);
        expect(saves).toBe(0);
    });

    test("the fixed vocabulary is the only thing a transport may raise", () => {
        const reasons = ["not_authorized", "credential_unavailable", "invalid_destination", "remote_unreachable", "remote_conflict", "quarantine_failed", "unclassified_transport_failure"] as const;
        for (const reason of reasons) {
            const error = new ReplicaTransportError(reason, "provider text with a secret");
            expect(error.reason).toBe(reason);
        }
    });
});
