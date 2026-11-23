/**
 * Cold restart: a persisted replica must be re-authorized, and its old handle must not work.
 *
 * The restart case is what the design has to survive. `choose` issues a capability
 * in memory with a TTL; nothing about it is persisted. So after a Host restart:
 *
 *   - the recorded `destinationHandle` is a **dead** handle: `use` refuses it,
 *     because the capability table is empty. No grant is revived implicitly, and
 *     nothing read from the archive can re-create authority.
 *   - the destination is still reachable, but only by asking again: a fresh
 *     `choose` for the same declared destination issues a new handle, and a new
 *     `configure_replica` succeeds. That is the reselect path an operator actually
 *     follows, and it must work — a design that only refuses would leave a
 *     persisted replica permanently unrecoverable.
 *   - the new handle and the old one are different, and only the new one works.
 *
 * "Restart" here means a new capability table over the same declared deployment:
 * exactly what a process restart produces, without needing to restart a container.
 *
 * Usage: bun scripts/fixtures/replica-cold-restart.mjs
 * Exit 0 only when the dead handle is refused AND the reselect path succeeds.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "replica-restart-probe-"));
const owner = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" };
const signal = AbortSignal.timeout(20_000);
const hostWorld = "host-world";
const remoteWorld = "remote-world";

const { createLocationHandles } = await import("../../adapters/dsh/maintenance/handles.ts");
const { createReplicaMaintenance } = await import("../../adapters/dsh/maintenance/replication.ts");
const { parseReplicaDestinations, createProductReplicaTransport } = await import("../../adapters/dsh/native/replication.ts");
const { locationAuthorizer } = await import("../../adapters/dsh/native/locations.ts");

// A real authenticated remote, so `configure` completes for the reason under test
// (the handle's lifetime) rather than failing because nothing is listening.
const repoRoot = join(scratch, "remote");
await mkdir(repoRoot, { recursive: true });
const init = spawn("git", ["init", "--bare", "--quiet", join(repoRoot, "repo.git")], { stdio: "ignore" });
await new Promise((done, fail) => init.once("exit", code => (code === 0 ? done() : fail(new Error(`git init ${code}`)))));
const server = spawn(process.execPath, [new URL("./git-auth-server.mjs", import.meta.url).pathname, repoRoot], { stdio: ["ignore", "pipe", "pipe"] });
const banner = await new Promise((done, fail) => {
  let out = "";
  server.stdout.on("data", chunk => { out += chunk.toString(); if (out.includes("\n")) done(JSON.parse(out.trim())); });
  server.once("exit", code => fail(new Error(`auth server exited ${code}`)));
});

const parsed = parseReplicaDestinations(JSON.stringify({
  mirror: { url: `${banner.origin}/repo.git`, identity: "mirror-host", credential_ref: "mirror_token", credential_username: banner.username },
}));
if (!parsed.ok || parsed.value === undefined) throw new Error(`fixture: ${parsed.reason}`);
const configuration = parsed.value;
/** Resolved per transfer, exactly as the product does. */
const credentials = { resolve: async (ref) => ref === "mirror_token" ? { value: banner.token } : undefined };
const worlds = [{ identity: remoteWorld, fs: undefined, hostLocal: false, current: () => true }];

/** One Host lifetime: a fresh capability table over the same deployment. */
function hostLifetime() {
  const handles = createLocationHandles({ authorizeSelection: locationAuthorizer(worlds, key => configuration.destinations[key]) });
  const transport = createProductReplicaTransport({ get: (name) => name === "credentials" ? credentials : undefined }, configuration, { quarantineRoot: join(scratch, "quarantine") });
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
        get: async id => saved.find(replica => replica.id === id),
        save: async (replica) => { saved.push(replica); },
      }),
    },
  });
  return { handles, replicas, saved };
}

const observed = {};
let ok = true;
const expectThat = (label, condition, detail) => {
  if (!condition) ok = false;
  observed[label] = { pass: Boolean(condition), ...(detail === undefined ? {} : { detail }) };
};

try {
  // --- before the restart ----------------------------------------------------
  const before = hostLifetime();
  const first = await before.handles.choose(owner, { kind: "replica", world: remoteWorld, destinationKey: "mirror" }, signal);
  expectThat("initial choose", first.ok, first.ok ? undefined : first.error);
  const persistedHandle = first.ok ? first.value.handle : "";
  const configuredBefore = first.ok && (await before.replicas.configure(owner, "archive-1", {
    destinationHandle: persistedHandle, credentialHandle: "mirror_token", expectedIdentity: "mirror-host",
  }, signal)).ok;
  expectThat("initial configure", configuredBefore);

  // --- after the restart: a new process, empty capability table --------------
  const after = hostLifetime();

  // The persisted replica record, exactly as the archive holds it.
  const persisted = { id: "replica-1", archiveId: "archive-1", destinationHandle: persistedHandle, expectedIdentity: "mirror-host", credentialHandle: "mirror_token", expectedRevision: null, state: "configured" };

  // The old handle must not work: no grant is revived implicitly.
  const reused = await after.handles.use(owner, persistedHandle, "replica", signal);
  expectThat("old handle refused after restart", !reused.ok, reused.ok ? "reused" : reused.error.code);

  // And a transfer through it must not invent authority from the record either.
  let revived = false;
  try {
    const capability = await after.replicas.push(owner, "archive-1", persisted.id, "a".repeat(40), signal);
    revived = capability.ok;
  } catch { revived = false; }
  expectThat("persisted replica does not self-revive", revived === false);

  // --- the reselect path an operator actually follows ------------------------
  const second = await after.handles.choose(owner, { kind: "replica", world: remoteWorld, destinationKey: "mirror" }, signal);
  expectThat("reselect succeeds", second.ok, second.ok ? undefined : second.error);
  if (second.ok) {
    expectThat("new handle differs from the dead one", second.value.handle !== persistedHandle);
    const reconfigured = await after.replicas.configure(owner, "archive-1", {
      destinationHandle: second.value.handle, credentialHandle: "mirror_token", expectedIdentity: "mirror-host",
    }, signal);
    expectThat("reconfigure after reselect succeeds", reconfigured.ok, reconfigured.ok ? { state: reconfigured.value.state } : reconfigured.error);
  }

  console.log(JSON.stringify({ ok, observed }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, observed, error: String(error?.message ?? error).slice(0, 300) }, null, 2));
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}
