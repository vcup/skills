/**
 * Contract tests for the deployment-side replica transport adapter.
 *
 * The engine supplies the archive's leased repository path per call, so this
 * adapter must never keep one. These tests therefore check three things that a
 * happy-path push would not reveal:
 *
 *   1. **Destination and allowlist are deployment facts.** An undeclared handle,
 *      a host outside the allowlist, or a credential the provider cannot resolve
 *      is refused *before* any transfer; a model argument can add none of them.
 *   2. **No mutable shared root.** Two concurrent transfers for two different
 *      archives each get their own primary repository. A cached "current root"
 *      would silently push the second archive's revision from the first
 *      archive's repository — the failure mode this shape exists to prevent.
 *   3. **Authorization is per transfer.** A transfer with no fresh `authorize`
 *      for that replica is refused, so a verdict cannot be reused after a
 *      revocation.
 *
 * The Git argv is not exercised here (that belongs to the transport tests in the
 * maintenance subtree); this file pins the *adapter's* decisions, which is its
 * whole interface.
 */

import { describe, expect, test } from "bun:test";
import type { Actor } from "../../../modules/ensemble/contracts.ts";
import type { Replica, ReplicaTransferContext } from "../maintenance/replication.ts";
import { authorityOf, createProductReplicaTransport, parseReplicaDestinations } from "./replication.ts";

const owner: Actor = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" };
const signal = AbortSignal.timeout(5_000);

function replica(overrides: Partial<Replica> = {}): Replica {
  return {
    id: "replica-1",
    archiveId: "archive-1",
    destinationHandle: "mirror",
    expectedIdentity: "mirror-host",
    credentialHandle: "none",
    expectedRevision: null,
    state: "configured",
    ...overrides,
  } as Replica;
}

/** A stand-in credentials service that resolves exactly one reference. */
function credentials(values: Record<string, string> = {}) {
  return { resolve: async (ref: string) => values[ref] === undefined ? undefined : { value: values[ref] } };
}

const configuration = parseReplicaDestinations(JSON.stringify({
  mirror: { url: "https://git.internal.example/team/archive.git", identity: "mirror-host" },
  offline: { url: "http://127.0.0.1:9418/team/archive.git", identity: "offline-host" },
}));
if (!configuration.ok) throw new Error(configuration.reason);

/** The engine always supplies both the leased path and the capability's key. */
function context(primaryRoot: string, destinationKey = "mirror"): ReplicaTransferContext { return { primaryRoot, destinationKey }; }

describe("replica transport adapter", () => {
  test("parses destinations, derives the allowlist and refuses malformed configuration", () => {
    expect(configuration.ok).toBe(true);
    if (!configuration.ok || configuration.value === undefined) return;
    // `allowlist` is `readonly string[]`, so sorting it in place is both a type
    // error and a mutation of the parsed configuration this test then reuses
    // below. Copy first, then sort the copy: the assertion is about the derived
    // set, not about order, and the fixture must stay pristine.
    expect(Array.from(configuration.value.allowlist).sort()).toEqual(["127.0.0.1:9418", "git.internal.example"]);

    const cases: readonly [string, string][] = [
      ["not json", "not valid JSON"],
      ["[]", "must be a JSON object"],
      [JSON.stringify({ mirror: { url: "https://h/p" } }), "needs a stated remote identity"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", extra: 1 } }), "unknown fields"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", credential_ref: "token" } }), "no credential_username"],
      // A user name without a secret is equally unusable, and says so.
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", credential_username: "bot" } }), "a user name alone cannot authenticate"],
      // The user name reaches Git's askpass prompt verbatim: a colon would change
      // the meaning of the `user:password` pair, and a control code corrupts it.
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", credential_ref: "t", credential_username: "a:b" } }), "invalid credential_username"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", credential_ref: "t", credential_username: "a\nb" } }), "invalid credential_username"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i" }, allow: [] }), "non-empty array"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i" }, allow: ["other.example"] }), "does not cover"],
      [JSON.stringify({ "bad handle!": { url: "https://h/p", identity: "i" } }), "not a plain name"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i" }, typo: 1 }), "destination typo must be an object"],
      // `ssh` is not a supported transport in this release; the refusal must name it.
      [JSON.stringify({ mirror: { url: "ssh://git@h/p", identity: "i" } }), "does not support"],
      // A `GIT_*` carrier is the transport's own prohibited namespace. It must be
      // refused at parse time, not at transfer time: this adapter constructs a
      // transport per transfer, so a late refusal would fail every push.
      // A carrier variable is no longer configuration at all: the transport owns a
      // fixed helper, so any attempt to name one is an unknown field.
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", credential_ref: "token", credential_env: "GIT_ASKPASS_TOKEN" } }), "unknown fields"],
      [JSON.stringify({ mirror: { url: "https://h/p", identity: "i", credential_ref: "token", credential_env: "ENSEMBLE_MIRROR_TOKEN" } }), "unknown fields"],
    ];
    for (const [raw, expected] of cases) {
      const parsed = parseReplicaDestinations(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain(expected);
    }
    expect(parseReplicaDestinations(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseReplicaDestinations("  ")).toEqual({ ok: true, value: undefined });
  });

  test("an undeclared destination, a non-allowlisted host or a missing credential refuses before transfer", async () => {
    if (!configuration.ok || configuration.value === undefined) return;
    const ctx = { get: (name: string) => name === "credentials" ? credentials() : undefined } as never;
    const transport = createProductReplicaTransport(ctx, configuration.value, { quarantineRoot: "/var/tmp/replica-adaptor-unused" });

    // The record's `destinationHandle` is irrelevant by design: what matters is the
    // capability's key, so an undeclared *key* is what refuses.
    expect(await transport.authorize(owner, replica({ destinationHandle: "nowhere" }), signal, context("/var/tmp/primary-unused", "nowhere"))).toBeUndefined();
    // Declared with a plain carrier, but the credential reference cannot be
    // resolved by the provider: that is a refusal, never a push without auth.
    // (The carrier must be a plain name; a `GIT_*` one is refused at parse, which
    // the malformed-configuration case above already covers.)
    const withCredential = parseReplicaDestinations(JSON.stringify({
      mirror: { url: "https://git.internal.example/a.git", identity: "mirror-host", credential_ref: "token", credential_username: "bot" },
    }));
    if (!withCredential.ok || withCredential.value === undefined) throw new Error("fixture");
    const strict = createProductReplicaTransport(ctx, withCredential.value, { quarantineRoot: "/var/tmp/replica-adaptor-unused" });
    expect(await strict.authorize(owner, replica(), signal, context("/var/tmp/primary-unused"))).toBeUndefined();
    // A non-owner actor is refused even with everything declared.
    expect(await transport.authorize({ kind: "session", sessionId: "s", rootSessionId: "s" } as Actor, replica(), signal, context("/var/tmp/primary-unused"))).toBeUndefined();
    // And a healthy configuration authorizes the current owner.
    expect(await transport.authorize(owner, replica(), signal, context("/var/tmp/primary-unused"))).toBeDefined();
  });

  test("a transfer without a fresh authorization for that replica is refused", async () => {
    if (!configuration.ok || configuration.value === undefined) return;
    const ctx = { get: () => credentials() } as never;
    const transport = createProductReplicaTransport(ctx, configuration.value, { quarantineRoot: "/var/tmp/replica-adaptor-unused" });
    // No `authorize` call first: the engine always calls it, so a transfer
    // without one means a caller bypassed the guard.
    // A transfer needs a capability, so the type now prevents the bypass this case
    // used to assert at runtime; a mismatched pair is the remaining way to try.
    const capability = await transport.authorize(owner, replica(), signal, context("/var/tmp/primary-unused"));
    expect(capability).toBeDefined();
    await expect(transport.push(replica(), "a".repeat(40), null, signal, context("/var/tmp/primary-unused", "not-declared"), capability!)).rejects.toThrow("does not match the transfer context");
  });

  test("two concurrent transfers each take the repository from their own lease", async () => {
    if (!configuration.ok || configuration.value === undefined) return;
    const ctx = { get: () => credentials() } as never;
    const transport = createProductReplicaTransport(ctx, configuration.value, { quarantineRoot: "/var/tmp/replica-adaptor-unused" });
    // Authorize two different archives (well, one archive per replica id).
    const first = replica({ id: "replica-a", archiveId: "archive-a" });
    const second = replica({ id: "replica-b", archiveId: "archive-b" });
    const capA = await transport.authorize(owner, first, signal, context("/var/tmp/archive-a"));
    expect(capA).toBeDefined();
    const capB = await transport.authorize(owner, second, signal, context("/var/tmp/archive-b"));
    expect(capB).toBeDefined();
    // Neither destination is reachable, so each transfer fails inside its own
    // transport. What matters is the *root each one used*: an adapter that cached
    // one root would run both against a single path, and the second archive's
    // push would read the first archive's repository. The failures must be
    // transfer failures, not missing-context ones.
    //
    // The bound must stay under the runner's per-test timeout (5s), otherwise the
    // test times out before the transfers do — which is what it did at 20s, and
    // that is a bug in this test rather than a slow transfer.
    const bounded = AbortSignal.timeout(2_000);
    const failures = await Promise.allSettled([
      transport.push(first, "a".repeat(40), null, bounded, context("/var/tmp/archive-a"), capA!),
      transport.push(second, "b".repeat(40), null, bounded, context("/var/tmp/archive-b"), capB!),
    ]);
    for (const outcome of failures) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(String(outcome.reason?.message ?? outcome.reason)).not.toContain("leased repository path");
      }
    }
  }, 20_000);

  test("a missing lease context is an explicit refusal, not an empty path", async () => {
    if (!configuration.ok || configuration.value === undefined) return;
    const ctx = { get: () => credentials() } as never;
    const transport = createProductReplicaTransport(ctx, configuration.value, { quarantineRoot: "/var/tmp/replica-adaptor-unused" });
    const capability = await transport.authorize(owner, replica(), signal, context("/var/tmp/primary-unused"));
    expect(capability).toBeDefined();
    // An empty leased path is refused before any child process starts.
    await expect(transport.push(replica(), "a".repeat(40), null, signal, context("", "mirror"), capability!)).rejects.toThrow("leased repository path");
    await expect(transport.head(replica(), signal, context("", "mirror"), capability!)).rejects.toThrow("leased repository path");
  });

  test("authority helper reads host[:port] the way the allowlist does", () => {
    expect(authorityOf("https://git.internal.example/a.git")).toBe("git.internal.example");
    expect(authorityOf("http://127.0.0.1:9418/a.git")).toBe("127.0.0.1:9418");
    expect(authorityOf("not a url")).toBeUndefined();
    expect(authorityOf("file:///tmp/x")).toBeUndefined();
  });
});
