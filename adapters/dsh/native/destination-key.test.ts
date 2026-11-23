/**
 * The transport resolves destinations only from the capability it is handed.
 *
 * The defect this locks down: `choose` returns an opaque runtime handle
 * (`location_<uuid>`), `configure_replica` stores it in the replica record as
 * `destinationHandle`, and this adapter used to look *that* up in the deployment's
 * destination map. It cannot be there, so every real network configure failed
 * `not_authorized` even though the owner had picked a destination the deployment
 * declared.
 *
 * The fix is not a fallback between two shapes — it is a rule: the deployment key
 * travels only through the location capability and the engine's transfer context,
 * and `authorize` returns a capability for exactly one transfer instead of a
 * boolean plus a separate lookup. A runtime handle must never be able to
 * masquerade as a deployment name, and no state may be remembered between calls:
 * two archives transferring concurrently must not be able to observe each other's
 * destination or identity.
 */

import { describe, expect, test } from "bun:test";
import type { Actor } from "../../../modules/ensemble/contracts.ts";
import type { Replica, ReplicaTransferContext } from "../maintenance/replication.ts";
import { createProductReplicaTransport, parseReplicaDestinations } from "./replication.ts";

const owner: Actor = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" };
const signal = AbortSignal.timeout(5_000);

const parsed = parseReplicaDestinations(JSON.stringify({
  mirror: { url: "http://127.0.0.1:9/repo.git", identity: "mirror-host" },
  second: { url: "http://127.0.0.1:9/second.git", identity: "second-host" },
}));
if (!parsed.ok || parsed.value === undefined) throw new Error("fixture");

/** A replica whose record holds the runtime handle, exactly as the engine stores it. */
function replica(id = "replica-1"): Replica {
  return {
    id,
    archiveId: "archive-1",
    destinationHandle: "location_11111111-2222-3333-4444-555555555555",
    expectedIdentity: "mirror-host",
    credentialHandle: "none",
    expectedRevision: null,
    state: "configured",
  } as Replica;
}

function context(destinationKey: string, primaryRoot = "/var/tmp/replica-path-fixture"): ReplicaTransferContext {
  return { primaryRoot, destinationKey };
}

const ctx = { get: () => undefined } as never;
const transport = createProductReplicaTransport(ctx, parsed.value, { quarantineRoot: "/var/tmp/replica-quarantine-fixture" });

describe("replica destination key", () => {
  test("the declared key authorizes and yields a capability; the runtime handle is irrelevant", async () => {
    const capability = await transport.authorize(owner, replica(), signal, context("mirror"));
    expect(capability).toEqual({ identity: "mirror-host", destinationKey: "mirror" });
  });

  test("no key refuses, and never falls back to the stored runtime handle", async () => {
    // An empty key is exactly what a replica configured before the fix carries.
    expect(await transport.authorize(owner, replica(), signal, context(""))).toBeUndefined();
    // A key the deployment does not declare is refused too.
    expect(await transport.authorize(owner, replica(), signal, context("not-declared"))).toBeUndefined();
    // And no context at all refuses rather than guessing.
    expect(await transport.authorize(owner, replica(), signal, undefined)).toBeUndefined();
  });

  test("a capability issued for one destination cannot drive a transfer to another", async () => {
    const forMirror = await transport.authorize(owner, replica(), signal, context("mirror"));
    expect(forMirror).toBeDefined();
    // The engine threads both, so a mismatched pair is a bug: refuse it loudly
    // rather than quietly transferring to whichever one wins.
    await expect(
      transport.head(replica(), signal, context("second"), forMirror!),
    ).rejects.toThrow("does not match the transfer context");
  });

  test("two archives authorize concurrently without observing each other's destination", async () => {
    // Interleaved order that a remembered "latest" would get wrong:
    // authorize(A), authorize(B), then ask A's capability what it is for.
    const [a, b] = await Promise.all([
      transport.authorize(owner, replica("replica-a"), signal, context("mirror")),
      transport.authorize(owner, replica("replica-b"), signal, context("second")),
    ]);
    expect(a).toEqual({ identity: "mirror-host", destinationKey: "mirror" });
    expect(b).toEqual({ identity: "second-host", destinationKey: "second" });
  });

  test("a missing lease path is refused before any child process", async () => {
    const capability = await transport.authorize(owner, replica(), signal, context("mirror"));
    await expect(
      transport.push(replica(), "a".repeat(40), null, signal, context("mirror", ""), capability!),
    ).rejects.toThrow("leased repository path");
  });

  test("a non-owner is refused regardless of the key", async () => {
    expect(await transport.authorize({ kind: "session", sessionId: "s", rootSessionId: "s" } as Actor, replica(), signal, context("mirror"))).toBeUndefined();
  });
});
