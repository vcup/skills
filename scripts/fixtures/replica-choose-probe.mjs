/**
 * The public `choose` → `configure_replica` path for a NETWORK destination, end to end.
 *
 * This is the RED that started it: `choose` returned an opaque runtime handle
 * (`location_<uuid>`), `configure_replica` stored that handle in the replica
 * record, and the transport looked the handle up in the deployment map where it
 * cannot exist — so every real network configure failed `not_authorized` even
 * though the owner picked a destination the deployment really declared.
 *
 * The probe drives the shipped chain, not a stand-in:
 *
 *   owner names a destination  →  `locationAuthorizer` (deployment map) supplies
 *   the key  →  the capability carries `deploymentKey`  →  the engine puts it in
 *   the transfer context  →  the transport resolves from that key, returns a
 *   per-call capability, and `configure` completes against a real Git remote that
 *   requires authentication.
 *
 * The remote is a real `git http-backend` that refuses anonymous access, so a
 * passing `configure` also proves the credential path end to end. `remote_unreachable`
 * or `not_authorized` would both fail this probe.
 *
 * Negative cases: an undeclared destination, a non-replica kind naming one, a
 * model-supplied URL, and a capability issued for a different destination all
 * refuse — with no fallback to the record's handle in any of them.
 *
 * Usage: bun scripts/fixtures/replica-choose-probe.mjs
 * Exit 0 only when every expectation holds.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "replica-choose-probe-"));
const owner = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" };
const signal = AbortSignal.timeout(20_000);
const hostWorld = "host-world";
// Deliberately unlike the destination name: the opacity check below must be able
// to tell "the key leaked" from "the world name happens to contain it".
const remoteWorld = "remote-world";

const { createLocationHandles } = await import("../../adapters/dsh/maintenance/handles.ts");
const { createReplicaMaintenance } = await import("../../adapters/dsh/maintenance/replication.ts");
const { parseReplicaDestinations, createProductReplicaTransport } = await import("../../adapters/dsh/native/replication.ts");
const { locationAuthorizer } = await import("../../adapters/dsh/native/locations.ts");

// A real remote that requires Basic auth, plus a bare repository behind it.
const repoRoot = join(scratch, "remote");
await import("node:fs/promises").then(fs => fs.mkdir(repoRoot, { recursive: true }));
const init = spawn("git", ["init", "--bare", "--quiet", join(repoRoot, "repo.git")], { stdio: "ignore" });
await new Promise((done, fail) => init.once("exit", code => (code === 0 ? done() : fail(new Error(`git init ${code}`)))));

const server = spawn(process.execPath, [new URL("./git-auth-server.mjs", import.meta.url).pathname, repoRoot], { stdio: ["ignore", "pipe", "pipe"] });
const banner = await new Promise((done, fail) => {
  let out = "";
  server.stdout.on("data", chunk => { out += chunk.toString(); if (out.includes("\n")) done(JSON.parse(out.trim())); });
  server.once("exit", code => fail(new Error(`auth server exited ${code}`)));
});

/** What the deployment declares: one authenticated destination. */
const parsed = parseReplicaDestinations(JSON.stringify({
  mirror: {
    url: `${banner.origin}/repo.git`,
    identity: "mirror-host",
    credential_ref: "mirror_token",
    credential_username: banner.username,
  },
}));
if (!parsed.ok || parsed.value === undefined) throw new Error(`fixture: ${parsed.reason}`);
const configuration = parsed.value;

/** The Host credential provider, exactly as the product resolves it per transfer. */
const credentials = { resolve: async (ref) => ref === "mirror_token" ? { value: banner.token } : undefined };
const ctx = { get: (name) => name === "credentials" ? credentials : undefined };

/** The deployment's declared destination lookup the authorizer consults. */
const worlds = [{ identity: remoteWorld, fs: undefined, hostLocal: false, current: () => true }];
const handles = createLocationHandles({ authorizeSelection: locationAuthorizer(worlds, key => configuration.destinations[key]) });
const transport = createProductReplicaTransport(ctx, configuration, { quarantineRoot: join(scratch, "quarantine") });

const saved = [];
const replicas = createReplicaMaintenance({
  handles,
  hostWorld,
  network: transport,
  access: {
    withOwner: async (_actor, _archiveId, _signal, run) => run({
      destinationAllowed: () => true,
      head: async () => "0".repeat(40),
      remoteHead: async () => null,
      push: async () => {},
      fetch: async (_d, expected) => ({ candidateId: "c", head: expected, readOnly: true }),
      isAncestor: async () => true,
      repository: join(scratch, "primary.git"),
      get: async () => undefined,
      save: async (replica) => { saved.push(replica); },
    }),
  },
});

const observed = {};
let ok = true;
const expectThat = (label, condition, detail) => {
  if (!condition) ok = false;
  observed[label] = { pass: Boolean(condition), ...(detail === undefined ? {} : { detail }) };
};

try {
  // --- positive: a declared destination, authenticated, really configures -----
  const chosen = await handles.choose(owner, { kind: "replica", world: remoteWorld, destinationKey: "mirror" }, signal);
  expectThat("choose declared destination", chosen.ok, chosen.ok ? undefined : chosen.error);
  // The public response must not leak the deployment name.
  // The public response is `{handle, kind, world, expires_at, digest}`: a caller
    // must not be able to read the deployment name back out of it.
    const serialized = chosen.ok ? JSON.stringify(chosen.value) : "";
    expectThat("handle is opaque", chosen.ok && /^location_[0-9a-f-]{36}$/.test(chosen.value.handle) && !serialized.includes("mirror"), chosen.ok ? serialized : undefined);

  if (chosen.ok) {
    const configured = await replicas.configure(owner, "archive-1", {
      destinationHandle: chosen.value.handle,
      credentialHandle: "mirror_token",
      expectedIdentity: "mirror-host",
    }, signal);
    expectThat("configure succeeds over an authenticated remote", configured.ok, configured.ok ? { state: configured.value.state } : configured.error);
    // The record keeps the runtime handle; the deployment name travelled only
    // through the trusted capability.
    expectThat("record keeps runtime handle", saved[0]?.destinationHandle === chosen.value.handle);
  }

  // --- negative: a destination the deployment never declared ------------------
  const undeclared = await handles.choose(owner, { kind: "replica", world: remoteWorld, destinationKey: "not-declared" }, signal);
  expectThat("undeclared destination refused", !undeclared.ok, undeclared.ok ? "accepted" : undeclared.error.code);

  // --- negative: only a replica selection may name a destination --------------
  const wrongKind = await handles.choose(owner, { kind: "backup", world: hostWorld, destinationKey: "mirror" }, signal);
  expectThat("non-replica kind refused", !wrongKind.ok, wrongKind.ok ? "accepted" : wrongKind.error.code);

  // --- negative: a model-supplied URL is not a destination name ---------------
  const asUrl = await handles.choose(owner, { kind: "replica", world: remoteWorld, destinationKey: "http://evil.example/x.git" }, signal);
  expectThat("URL as destination refused", !asUrl.ok, asUrl.ok ? "accepted" : asUrl.error.code);

  // --- a capability is per call and cannot be reused across destinations ------
  const record = { id: "replica-x", archiveId: "archive-1", destinationHandle: "location_x", expectedIdentity: "mirror-host", credentialHandle: "mirror_token", expectedRevision: null, state: "configured" };
  const capability = await transport.authorize(owner, record, signal, { primaryRoot: join(scratch, "p.git"), destinationKey: "mirror" });
  expectThat("authorize yields capability", capability !== undefined, capability);
  let mismatched = false;
  try {
    await transport.head(record, signal, { primaryRoot: join(scratch, "p.git"), destinationKey: "not-declared" }, capability);
  } catch { mismatched = true; }
  expectThat("mismatched capability refused", mismatched);

  // --- no remembered state: two archives do not observe each other ------------
  const [capA, capB] = await Promise.all([
    transport.authorize(owner, { ...record, id: "replica-a" }, signal, { primaryRoot: "/p", destinationKey: "mirror" }),
    transport.authorize(owner, { ...record, id: "replica-b" }, signal, { primaryRoot: "/p", destinationKey: "not-declared" }),
  ]);
  expectThat("concurrent keys stay separate", capA?.destinationKey === "mirror" && capB === undefined, { a: capA?.destinationKey, b: capB });

  console.log(JSON.stringify({ ok, observed }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, observed, error: String(error?.message ?? error).slice(0, 300) }, null, 2));
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}
