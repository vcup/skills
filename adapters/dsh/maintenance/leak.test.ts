import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocationHandles } from "./handles.ts";
import { ReplicaTransportError, createReplicaMaintenance, describeReplicaFailure, type NativeReplicaTransport, type Replica, type ReplicaLease } from "./replication.ts";
import { success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";

const actor: Actor = { kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote" };
const signal = new AbortController().signal;
const SECRET = "sup3r-s3cret-token-value";
/** configure() probes the remote head first; later reads are the transfer attempts. */
let heads = 0;
const URL_WITH_SECRET = `https://user:${SECRET}@git.internal.example/team/archive.git`;

function value<T>(r: Result<T>): T {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
}

async function fixture(transport: NativeReplicaTransport) {
    const configs = new Map<string, Replica>();
    const handles = createLocationHandles({ // A replica selection carries the deployment key the native authorizer vouched for;
        // without it a network transfer is refused before reaching these tests' subject.
        authorizeSelection: async (_a, r) => success({ world: r.world, path: r.path, check: async () => true, ...(r.kind === "replica" ? { deploymentKey: "mirror" } : {}) }) });
    const location = value(await handles.choose(actor, { kind: "replica", world: "loopback", path: join(mkdtempSync(join(tmpdir(), "leak-")), "endpoint") }, signal));
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
    const manager = createReplicaMaintenance({ handles, hostWorld: "host", network: transport, access: { withOwner: async (_a, _id, _s, run) => run(lease) } });
    const replica = value(await manager.configure(actor, "archive", { destinationHandle: location.handle, credentialHandle: "native:token", expectedIdentity: "deployment-remote" }, signal));
    return { manager, replica, configs };
}

/** Every string a caller could ever see for a failure, flattened. */
function visibleText(result: unknown): string {
    return JSON.stringify(result);
}

test("a transport that throws a provider message with a secret cannot leak it", async () => {
    // A realistic worst case: the native credential provider or Git itself reports
    // the URL and the token in the thrown message.
    const transport: NativeReplicaTransport = {
        async authorize() { return { identity: "deployment-remote", destinationKey: "mirror" }; },
        // configure() probes the remote head first, so that call must succeed and the
        // leak attempt lands on the actual transfer.
        async head() { return heads++ === 0 ? null : (() => { throw new Error(`fatal: unable to access '${URL_WITH_SECRET}': token ${SECRET} rejected`); })(); },
        async push() { throw new Error(`fatal: Authentication failed for '${URL_WITH_SECRET}' using ${SECRET}`); },
        async fetch() { throw new Error(`fatal: could not read ${SECRET} from ${URL_WITH_SECRET}`); },
    };
    heads = 0;
    const f = await fixture(transport);
    const pushed = await f.manager.push(actor, "archive", f.replica.id, "a".repeat(40), signal);
    expect(pushed.ok).toBe(false);
    if (!pushed.ok) {
        const text = visibleText(pushed);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain("git.internal.example");
        expect(pushed.error.code).toBe("outcome_unknown");
        // Actionable without being revealing: a fixed sentence and a reason token.
        expect(pushed.error.message).toContain("re-read remote before retrying");
    }
    const fetched = await f.manager.fetch(actor, "archive", f.replica.id, "b".repeat(40), signal);
    expect(fetched.ok).toBe(false);
    if (!fetched.ok) {
        expect(visibleText(fetched)).not.toContain(SECRET);
        expect(visibleText(fetched)).not.toContain("git.internal.example");
    }
});

test("a classified transport failure keeps its reason token and still leaks nothing", async () => {
    const transport: NativeReplicaTransport = {
        async authorize() { return { identity: "deployment-remote", destinationKey: "mirror" }; },
        async head() { return heads++ === 0 ? null : (() => { throw new ReplicaTransportError("credential_unavailable", `askpass helper ${SECRET} missing for ${URL_WITH_SECRET}`); })(); },
        async push() { throw new ReplicaTransportError("credential_unavailable", `token ${SECRET} rejected at ${URL_WITH_SECRET}`); },
        async fetch() { throw new ReplicaTransportError("quarantine_failed", `bad object containing ${SECRET}`); },
    };
    heads = 0;
    const f = await fixture(transport);
    const pushed = await f.manager.push(actor, "archive", f.replica.id, "a".repeat(40), signal);
    expect(pushed.ok).toBe(false);
    if (!pushed.ok) {
        expect(visibleText(pushed)).not.toContain(SECRET);
        expect(visibleText(pushed)).not.toContain("git.internal.example");
        // The reason the operator needs survives; the transport's own message does not.
        expect(pushed.error.message).toContain("reason: credential_unavailable");
        expect(pushed.error.message).toContain("the native credential for this remote is unavailable or unusable");
    }
});

test("an unclassified error collapses to a fixed sentence", () => {
    expect(describeReplicaFailure(new Error(`boom ${SECRET}`))).toBe("the native transport failed without a classified reason (reason: unclassified_transport_failure)");
    expect(describeReplicaFailure("plain string " + SECRET)).not.toContain(SECRET);
    expect(describeReplicaFailure(new ReplicaTransportError("remote_conflict", SECRET))).not.toContain(SECRET);
    expect(describeReplicaFailure(new ReplicaTransportError("remote_conflict", SECRET))).toContain("reason: remote_conflict");
});
