/** Independent replica/network acceptance at public seams. Never an authenticated Remote claim.
 * Run: bun scripts/verify-dsh-replica-acceptance.ts --runtime <isolated rc4/rc5 install>
 * Real loopback git daemon only; no real network, no live profile, no implementation edits.
 * A live fixture secret proves credential containment empirically, not by string guessing.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createArchiveMaintenance, createLocationHandles } from "../adapters/dsh/maintenance/index.ts";
import { createLoopbackReplicaTransport, loopbackEndpoint } from "../adapters/dsh/maintenance/network.ts";
import { allowlistedEndpoint, createAllowlistedReplicaTransport } from "../adapters/dsh/maintenance/network-deployment.ts";
import { ReplicaTransportError, type NativeReplicaTransport, type Replica } from "../adapters/dsh/maintenance/replication.ts";
import { ArchiveKernel } from "../adapters/dsh/store/kernel.ts";
import { DEFAULT_LIMITS } from "../adapters/dsh/store/index.ts";
import { openRegistry, OWNER, ALICE, OPEN_COMMAND, nativeOptions } from "./verify-dsh-store-acceptance.ts";
import * as C from "../modules/ensemble/contracts.ts";

const signal = () => new AbortController().signal;
function value2<T>(result: C.Result<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value; }
function denied<T>(result: C.Result<T>, code?: string): void { assert.equal(result.ok, false, `request must fail, got ${JSON.stringify(result)}`); if (!result.ok && code) assert.equal(result.error.code, code); }
function denied2(result: { ok: boolean; reason?: string }): void { assert.equal(result.ok, false, `endpoint must be refused: ${JSON.stringify(result)}`); }
/** The live fixture credential; nothing in a message, receipt, persisted record or archive may carry it. */
const SECRET = `REPLICA-FIXTURE-SECRET-${randomUUID()}`;

function git(args: readonly string[], options: { cwd?: string } = {}): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: options.cwd ?? "/", encoding: "utf8", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}
function bare(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const out = git(["init", "--bare", "--quiet", root]);
  assert.equal(out.code, 0, out.stderr);
  return root;
}
function freePort(): Promise<number> {
  return new Promise(done => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)); });
  });
}

interface Daemon { readonly url: (repo: string) => string; readonly port: number; readonly repos: string; close(): void }
async function startGitDaemon(base: string): Promise<Daemon> {
  const repos = join(base, "daemon-repos"); mkdirSync(repos, { recursive: true, mode: 0o700 });
  bare(join(repos, "probe.git"));
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = await freePort();
    const child = spawn("git", ["daemon", "--listen=127.0.0.1", `--port=${port}`, `--base-path=${repos}`, "--export-all", "--enable=receive-pack", "--reuseaddr"], { stdio: ["ignore", "ignore", "ignore"] });
    const url = (repo: string) => `git://127.0.0.1:${port}/${repo}.git`;
    for (let probe = 0; probe < 25; probe++) {
      if (git(["ls-remote", url("probe"), "refs/ensemble/main"]).code === 0) return { url, port, repos, close: () => child.kill("SIGTERM") };
      await new Promise(done => setTimeout(done, 120));
    }
    child.kill("SIGTERM");
  }
  throw new Error("could not start a loopback git daemon fixture");
}
function daemonRepo(daemon: Daemon, name: string): string { return bare(join(daemon.repos, `${name}.git`)); }
export interface Fixture {
  base: string; registryRoot: string; archiveRoot: string; archiveId: string; registry: Awaited<ReturnType<typeof openRegistry>>; kernel: ArchiveKernel;
  head: string; openRevision(): Promise<string>; currentHead(): Promise<string>;
  close(): void;
}
export async function fixture(runtime: string): Promise<Fixture> {
  const base = resolve(join(".scratch", "production-cycle", `replica-review-${randomUUID().slice(0, 8)}`));
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const source = join(base, "source"); mkdirSync(source, { mode: 0o700 });
  const registry = await openRegistry(runtime, join(base, "registry"));
  const initial = value2(await registry.admin(OWNER, { action: "initialize", expected_revision: "absent", operation_id: "init", payload: { root_handle: "default", source_descriptor: { worldIdentity: "host", canonicalAddress: source, nativeWorkspaceRef: ALICE.workspaceRef }, initial_grants: [{ subject: C.actorIdentity(ALICE), rights: ["read", "open"], scope: { kind: "project" } }], limits: DEFAULT_LIMITS } }, signal()));
  const target = value2(await registry.resolve(ALICE, { worldIdentity: "host", nativeWorkspaceRef: ALICE.workspaceRef, canonicalAddress: source }, signal()));
  const kernel = new ArchiveKernel(await nativeOptions(runtime));
  const archivesDir = realpathSync(join(base, "registry", "archives"));
  const archiveRoot = realpathSync(join(archivesDir, readdirSync(archivesDir)[0]!));
  const currentHead = async (): Promise<string> => value2(await registry.withOwner(OWNER, target.archiveId, signal(), async lease => C.success(lease.snapshot))).revision;
  let sequence = 0;
  const openRevision = async (): Promise<string> => {
    sequence++;
    const committed = value2(await registry.execute(ALICE, { archiveId: target.archiveId, expectedRevision: await currentHead(), operationId: `open-${sequence}`, command: OPEN_COMMAND }, signal()));
    return committed.committed_revision;
  };
  return { base, registryRoot: realpathSync(join(base, "registry")), archiveRoot, archiveId: target.archiveId, registry, kernel, head: initial.committed_revision, openRevision, currentHead, close() { registry.dispose(); kernel.dispose(); } };
}

export interface MaintenanceFixture extends Fixture {
  bare: string; handles: ReturnType<typeof createLocationHandles>; maintenance: ReturnType<typeof createArchiveMaintenance>;
  /**
   * Select a **Host-local** replica destination by its absolute filesystem path.
   *
   * A local replica really does have a path, so the authorizer answers with it and the
   * fixture mints a deployment key for the selection.
   */
  localReplicaHandle(path: string): Promise<string>;
  /**
   * Select a **network** replica destination by its deployment key.
   *
   * A network destination has no filesystem path at all; passing one would be exactly the
   * confusion the interface now prevents, so this takes the key the deployment declares. No
   * `!`, no empty string and no process working directory stands in for a destination.
   */
  networkReplicaHandle(key: string, world: string): Promise<string>;
  /** Every destination key this fixture's authorizer has declared, in declaration order. */
  declaredKeys(): string[];
}
export async function maintenanceFixture(runtime: string, network?: NativeReplicaTransport): Promise<MaintenanceFixture> {
  const f = await fixture(runtime);
  const bareRepo = bare(join(f.base, "file-replica.git"));
  // Local selections get a deterministic key derived from the canonical path; network
  // selections carry the key the deployment declared. Both are decided here, by the
  // authorizer - the only party allowed to name a destination.
  const localKeys = new Map<string, string>(); const declared = new Set<string>(); let nextKey = 0;
  const handles = createLocationHandles({ authorizeSelection: async (actor, request) => {
    if (actor.kind !== "owner") return C.failure("not_authorized", "fixture authorizer is owner-only");
    if (request.kind === "replica" && request.path === undefined) {
      // A network replica: the request names a deployment key and the authorizer confirms it
      // is declared. No path exists and none is invented.
      const key = request.destinationKey;
      if (key === undefined) return C.failure("invalid_input", "a network replica selection requires a destination key");
      declared.add(key);
      return C.success({ world: request.world, check: async () => true, deploymentKey: key });
    }
    // A filesystem location: canonicalise the real path it named.
    if (request.path === undefined || request.destinationKey !== undefined)
      return C.failure("invalid_input", "a filesystem location requires an absolute path and no destination key");
    const canonical = resolve(request.path);
    const existing = localKeys.get(canonical);
    const key = existing === undefined ? `local-${++nextKey}` : existing;
    if (existing === undefined) localKeys.set(canonical, key);
    declared.add(key);
    return C.success({ world: request.world, path: canonical, deploymentKey: key, check: async () => true });
  } });
  const maintenance = createArchiveMaintenance({ registry: f.registry, kernel: f.kernel, handles, hostWorld: "host", quarantineRoot: join(f.base, "quarantine"), ...(network ? { network } : {}), verifyApproval: async () => false, proveStopped: async () => false });
  const localReplicaHandle = async (path: string) => value2(await handles.choose(OWNER, { kind: "replica", path, world: "host" }, signal())).handle;
  const networkReplicaHandle = async (key: string, world: string) => value2(await handles.choose(OWNER, { kind: "replica", destinationKey: key, world }, signal())).handle;
  return { ...f, bare: bareRepo, handles, maintenance, localReplicaHandle, networkReplicaHandle, declaredKeys: () => [...declared], close() { handles.dispose(); f.close(); } };
}

/** Seed a scratch primary repository with an archive revision so real daemon pushes can run. */
function seedPrimary(archiveRoot: string, revision: string, target: string): void {
  bare(target);
  const fetched = git(["fetch", archiveRoot, revision], { cwd: target });
  assert.equal(fetched.code, 0, fetched.stderr);
  const written = git(["update-ref", "refs/ensemble/main", revision], { cwd: target });
  assert.equal(written.code, 0, written.stderr);
}
function syncPrimary(archiveRoot: string, revision: string, target: string): void {
  const fetched = git(["fetch", archiveRoot, revision], { cwd: target });
  assert.equal(fetched.code, 0, fetched.stderr);
  const written = git(["update-ref", "refs/ensemble/main", revision], { cwd: target });
  assert.equal(written.code, 0, written.stderr);
}
function daemonHead(url: string): string | null {
  const out = git(["ls-remote", url, "refs/ensemble/main"]);
  return /^([0-9a-f]{40})\trefs\/ensemble\/main$/m.exec(out.stdout)?.[1] ?? null;
}

async function fileReplicaRoundtrip(runtime: string) {
  const f = await maintenanceFixture(runtime);
  try {
    const handle = await f.localReplicaHandle(f.bare);
    const configured = value2(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "none", expectedIdentity: "host" }, signal()));
    assert.equal(configured.state, "configured"); assert.equal(configured.credentialHandle, "none");
    const head = await f.openRevision();
    const pushed = value2(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, head, signal()));
    assert.equal(pushed.revision, head, "file replica holds the pushed revision");
    assert.equal(git(["for-each-ref", "--format=%(objectname)", "refs/ensemble/main"], { cwd: f.bare }).stdout.trim(), head);
    denied(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, "0".repeat(40), signal()), "revision_conflict");
    const fetched = value2(await f.maintenance.replicas.fetch(OWNER, f.archiveId, configured.id, head, signal()));
    assert.ok(fetched.readOnly && fetched.head === head && fetched.candidateId.length > 0);
    denied(await f.maintenance.replicas.fetch(OWNER, f.archiveId, configured.id, "0".repeat(40), signal()), "remote_conflict");
    const overlapping = await f.localReplicaHandle(f.registryRoot);
    denied(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: overlapping, credentialHandle: "none", expectedIdentity: "host" }, signal()), "invalid_input");
    denied(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: SECRET, expectedIdentity: "host" }, signal()), "invalid_input");
    return { fixture: f.base, pushed: pushed.revision, candidate: fetched.candidateId };
  } finally { f.close(); }
}

async function networkReplicaRoundtrip(runtime: string) {
  const f0 = await fixture(runtime);
  const daemon = await startGitDaemon(f0.base);
  try {
    daemonRepo(daemon, "roundtrip");
    const primary = bare(join(f0.base, "network-primary.git"));
    const urls = new Map<string, string>();
    const transport: NativeReplicaTransport = createLoopbackReplicaTransport({
      resolve: key => { const url = urls.get(key); if (!url) throw new Error("fixture does not declare that destination key"); return url; },
      identity: "fixture-git-daemon", quarantineRoot: join(f0.base, "quarantine"), primaryRoot: primary,
      authorize: (actor, replica) => actor.kind === "owner" && actor.channel === "authenticated-remote" && replica.credentialHandle === "fixture-cred-handle",
    });
    const f = await maintenanceFixture(runtime, transport);
    try {
      seedPrimary(f0.archiveRoot, f0.head, primary);
      // A network destination is named by the deployment key, never by a path: the
      // transport resolves only declared keys and the capability carries the granted one.
      urls.set("roundtrip", daemon.url("roundtrip"));
      const handle = await f.networkReplicaHandle("roundtrip", "remote");
      const configured = value2(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "fixture-cred-handle", expectedIdentity: "fixture-git-daemon" }, signal()));
      assert.equal(configured.expectedRevision, null, "an empty daemon repository has no head yet");
      const first = await f.openRevision(); syncPrimary(f.archiveRoot, first, primary);
      const pushed = value2(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, first, signal()));
      assert.equal(pushed.revision, first);
      assert.equal(daemonHead(daemon.url("roundtrip")), first, "the loopback daemon holds the pushed revision");
      const fetched = value2(await f.maintenance.replicas.fetch(OWNER, f.archiveId, configured.id, first, signal()));
      assert.ok(fetched.readOnly && fetched.head === first);
      const second = await f.openRevision(); syncPrimary(f.archiveRoot, second, primary);
      assert.equal(value2(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, second, signal())).revision, second, "fast-forward replica push succeeds");
      denied(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "fixture-cred-handle", expectedIdentity: "wrong-identity" }, signal()), "remote_conflict");
      const replica: Replica = { id: "replica_x", archiveId: f.archiveId, destinationHandle: handle, expectedIdentity: "fixture-git-daemon", credentialHandle: "fixture-cred-handle", expectedRevision: null, state: "configured" };
      assert.equal(await transport.authorize({ ...ALICE }, replica, signal()), undefined, "a session actor cannot authorize a network transfer");
      denied(await f.maintenance.replicas.configure({ ...ALICE }, f.archiveId, { destinationHandle: handle, credentialHandle: "fixture-cred-handle", expectedIdentity: "fixture-git-daemon" }, signal()), "not_authorized");
      return { fixture: f.base, daemon: daemon.url("roundtrip"), pushed: [first, second], candidate: fetched.candidateId };
    } finally { f.close(); }
  } finally { daemon.close(); f0.close(); }
}

async function networkCasAndAncestor(runtime: string) {
  const f0 = await fixture(runtime);
  const daemon = await startGitDaemon(f0.base);
  try {
    daemonRepo(daemon, "cas");
    const primary = bare(join(f0.base, "cas-primary.git"));
    const urls = new Map<string, string>();
    const transport: NativeReplicaTransport = createLoopbackReplicaTransport({ resolve: key => { const url = urls.get(key); if (!url) throw new Error("fixture does not declare that destination key"); return url; }, identity: "fixture-git-daemon", quarantineRoot: join(f0.base, "quarantine"), primaryRoot: primary, authorize: () => true });
    const f = await maintenanceFixture(runtime, transport);
    try {
      seedPrimary(f0.archiveRoot, f0.head, primary);
      urls.set("cas", daemon.url("cas"));
      const handle = await f.networkReplicaHandle("cas", "remote");
      const configured = value2(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "none", expectedIdentity: "fixture-git-daemon" }, signal()));
      const head = await f.openRevision(); syncPrimary(f.archiveRoot, head, primary);
      value2(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, head, signal()));
      // A remote that moved to unrelated history must never be forced or merged.
      const scratch = join(f.base, "scratch"); mkdirSync(scratch, { mode: 0o700 });
      assert.equal(git(["init", "--quiet", scratch]).code, 0);
      const orphan = git(["-C", scratch, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--allow-empty", "-m", "unrelated root"]);
      assert.equal(orphan.code, 0, orphan.stderr);
      const forced = git(["-C", scratch, "push", "--porcelain", "--force", daemon.url("cas"), "HEAD:refs/ensemble/main"]);
      assert.equal(forced.code, 0, forced.stderr);
      const orphanRevision = git(["-C", scratch, "rev-parse", "HEAD"]).stdout.trim();
      denied(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, head, signal()), "remote_conflict");
      // With the expected revision matching the unrelated remote, the ancestor gate fires.
      const record = value2(await f.registry.withOwner(OWNER, f.archiveId, signal(), async lease => C.success(((lease.configuration("replicas") as Record<string, Replica>) ?? {})[configured.id]!)));
      await f.registry.withOwner(OWNER, f.archiveId, signal(), async lease => { const all = (lease.configuration("replicas") as Record<string, Replica>) ?? {}; lease.saveConfiguration("replicas", { ...all, [configured.id]: { ...record, expectedRevision: orphanRevision } }); return C.success(true); });
      const ancestorGate = await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, head, signal());
      assert.ok(ancestorGate.ok === false && ["remote_conflict", "storage_unavailable", "outcome_unknown"].includes(ancestorGate.error.code), `unrelated remote history must be refused, got ${JSON.stringify(ancestorGate)}`);
      assert.equal(daemonHead(daemon.url("cas")), orphanRevision, "the remote was never moved by the engine");
      // Restore the fixture daemon to the last pushed archive revision (the ancestor test
      // deliberately left unrelated history there), then exercise unknown reconciliation.
      const restored = git(["-C", primary, "push", "--porcelain", "--force", daemon.url("cas"), `${head}:refs/ensemble/main`]);
      assert.equal(restored.code, 0, restored.stderr);
      const localHead = await f.openRevision(); syncPrimary(f.archiveRoot, localHead, primary);
      await f.registry.withOwner(OWNER, f.archiveId, signal(), async lease => { const all = (lease.configuration("replicas") as Record<string, Replica>) ?? {}; lease.saveConfiguration("replicas", { ...all, [configured.id]: { ...record, state: "unknown", lastLocalRevision: head, expectedRevision: head } }); return C.success(true); });
      const reconciled = await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, localHead, signal());
      denied(reconciled, "revision_conflict");
      assert.equal(value2(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, localHead, signal())).revision, localHead, "after reconciliation the fast-forward push proceeds");
      // A transport whose remote is unreachable fails without leaking the credential environment.
      const deadPort = await freePort();
      // Both factories already return `NativeReplicaTransport`, so no cast is needed: the
      // interface is the contract, and asserting past it would hide a real mismatch.
      const dead: NativeReplicaTransport = createLoopbackReplicaTransport({
        resolve: (key: string) => {
          // Only the declared key resolves; anything else is a bug in the fixture, not a
          // destination the transport should guess at.
          if (key !== "dead") throw new Error("fixture does not declare that destination key");
          return `git://127.0.0.1:${deadPort}/missing.git`;
        },
        identity: "fixture-git-daemon", quarantineRoot: join(f.base, "quarantine"), primaryRoot: primary,
        authorize: () => true, environment: { REPLICA_TOKEN: SECRET }, timeoutMs: 3000,
      });
      const deadTarget: Replica = { ...record, state: "configured", expectedRevision: null };
      const deadContext = { primaryRoot: primary, destinationKey: "dead" };
      const deadCapability = { identity: "fixture-git-daemon", destinationKey: "dead" };
      const deadError = await dead.head(deadTarget, signal(), deadContext, deadCapability).then(() => null, (error: Error) => error.message);
      assert.ok(deadError !== null, "an unreachable remote must fail");
      assert.ok(!String(deadError).includes(SECRET), "transport failure detail must not carry the credential value");
      return { fixture: f.base, casRefused: "remote_conflict", ancestorRefused: ancestorGate.ok ? "unexpected-success" : ancestorGate.error.code, reconciledThenReread: reconciled.ok ? "unexpected-success" : reconciled.error.code, deadDetail: String(deadError).slice(0, 160) };
    } finally { f.close(); }
  } finally { daemon.close(); f0.close(); }
}

async function credentialContainment(runtime: string) {
  const f0 = await fixture(runtime);
  const daemon = await startGitDaemon(f0.base);
  const appearances: { where: string; text: string }[] = [];
  try {
    daemonRepo(daemon, "cred");
    const primary = bare(join(f0.base, "cred-primary.git"));
    seedPrimary(f0.archiveRoot, f0.head, primary);
    const urls = new Map<string, string>();
    const transport = createLoopbackReplicaTransport({ resolve: key => { const url = urls.get(key); if (!url) throw new Error("fixture does not declare that destination key"); return url; }, identity: "fixture-git-daemon", quarantineRoot: join(f0.base, "quarantine"), primaryRoot: primary, authorize: () => true, environment: { REPLICA_TOKEN: SECRET } });
    const f = await maintenanceFixture(runtime, transport);
    try {
      urls.set("cred", daemon.url("cred"));
      const handle = await f.networkReplicaHandle("cred", "remote");
      const configured = value2(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "opaque-cred-handle", expectedIdentity: "fixture-git-daemon" }, signal()));
      const head = await f.openRevision(); syncPrimary(f.archiveRoot, head, primary);
      const pushed = value2(await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, head, signal()));
      appearances.push({ where: "pushed receipt", text: JSON.stringify(pushed) });
      urls.set("missing-repo", daemon.url("missing-repo"));
      const brokenHandle = await f.networkReplicaHandle("missing-repo", "remote");
      const configureFailure = await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: brokenHandle, credentialHandle: "opaque-cred-handle", expectedIdentity: "fixture-git-daemon" }, signal());
      denied(configureFailure, "storage_unavailable");
      assert.ok(configureFailure.ok === false && !configureFailure.error.message.includes("fatal") && !configureFailure.error.message.includes("git@"), "engine configure failures carry the fixed sentence, never raw git stderr");
      appearances.push({ where: "configure failure message", text: JSON.stringify(configureFailure) });
      const broken: Replica = { ...configured, destinationHandle: brokenHandle };
      const rawStderr = await transport.head(broken, signal(), { primaryRoot: join(f.base, "cred-primary.git"), destinationKey: "missing-key" }, { identity: "fixture-git-daemon", destinationKey: "missing-key" }).then(() => null, (error: Error) => error.message);
      appearances.push({ where: "raw transport stderr (internal only)", text: String(rawStderr) });
      const persistedRecord = readFileSync(join(f.archiveRoot, "owner-configuration.json"), "utf8");
      appearances.push({ where: "persisted replica record", text: persistedRecord });
      appearances.push({ where: "snapshot", text: JSON.stringify(await f.registry.withOwner(OWNER, f.archiveId, signal(), async lease => C.success(lease.snapshot))) });
      const leaked = appearances.find(entry => entry.text.includes(SECRET));
      assert.ok(!leaked, `the fixture credential must never surface in a result, a receipt, a persisted record or the archive (${leaked?.where ?? "none"})`);
      assert.ok(persistedRecord.includes("opaque-cred-handle"), "the persisted record holds the opaque handle, never a credential value");
      denied2(loopbackEndpoint("https://user:pass@127.0.0.1:9418/repo.git"));
      denied2(loopbackEndpoint("https://git.example.com/team/repo.git"));
      denied2(loopbackEndpoint("file:///etc/passwd"));
      denied2(loopbackEndpoint("git://127.0.0.1:9418"));
      assert.ok(loopbackEndpoint(daemon.url("cred")).ok);
      assert.ok(allowlistedEndpoint(daemon.url("cred"), [`127.0.0.1:${daemon.port}`]).ok);
      denied2(allowlistedEndpoint(daemon.url("cred"), ["git.example.com"]));
      denied2(allowlistedEndpoint("ssh://git.example.com/team/repo.git", ["git.example.com"]));
      let gitEnvRefusal = "";
      try { createAllowlistedReplicaTransport({ allowlist: [`127.0.0.1:${daemon.port}`], resolve: () => daemon.url("cred"), identity: "fixture-git-daemon", quarantineRoot: join(f.base, "quarantine"), primaryRoot: primary, authorize: () => true, environment: { GIT_ASKPASS: SECRET } }); }
      catch (error) { gitEnvRefusal = (error as Error).message; }
      assert.ok(gitEnvRefusal.includes("deployment must not set GIT_"), `the deployment transport must refuse Git-redirecting environment names; got ${gitEnvRefusal}`);
      return { fixture: f.base, pushed: pushed.revision, secretContained: true, gitEnvRefusal: gitEnvRefusal.slice(0, 120), daemonUrl: daemon.url("cred") };
    } finally { f.close(); }
  } finally { daemon.close(); f0.close(); }
}

async function engineFailureClassifier(runtime: string) {
  const f0 = await fixture(runtime);
  try {
    const stub: NativeReplicaTransport = {
      authorize: async () => ({ identity: "stub-remote", destinationKey: "stub" }),
      head: async () => null,
      push: async () => { throw new Error(`boom ${SECRET} fatal: bad argument git@evil:secret-repo`); },
      fetch: async () => { throw new Error(`fetch failed ${SECRET}`); },
    };
    const f = await maintenanceFixture(runtime, stub);
    try {
      const handle = await f.networkReplicaHandle("stub", "remote");
      const configured = value2(await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "opaque-cred-handle", expectedIdentity: "stub-remote" }, signal()));
      const head = await f.openRevision();
      const pushed = await f.maintenance.replicas.push(OWNER, f.archiveId, configured.id, head, signal());
      assert.ok(pushed.ok === false && pushed.error.code === "outcome_unknown", `a failing transport must surface as outcome_unknown; got ${JSON.stringify(pushed)}`);
      assert.equal(pushed.error.message, "replica transfer outcome is unknown; re-read remote before retrying. the native transport failed without a classified reason (reason: unclassified_transport_failure)", "the engine collapses arbitrary transport errors to the fixed sentence");
      assert.ok(!pushed.error.message.includes(SECRET), "an arbitrary transport Error carrying a credential must not surface");
      const record = value2(await f.registry.withOwner(OWNER, f.archiveId, signal(), async lease => C.success(((lease.configuration("replicas") as Record<string, Replica>) ?? {})[configured.id]!)));
      assert.equal(record.state, "unknown", "the intention is persisted before the transfer, so the state is unknown after a failure");
      assert.equal(record.lastLocalRevision, head);
      const deniedFetch = await f.maintenance.replicas.fetch(OWNER, f.archiveId, configured.id, "0".repeat(40), signal());
      assert.ok(deniedFetch.ok === false && !JSON.stringify(deniedFetch).includes(SECRET), "a failing fetch never surfaces transport text");
      const classified: NativeReplicaTransport = { ...stub, push: async () => { throw new ReplicaTransportError("credential_unavailable", `token ${SECRET}`); } };
      const f2 = await maintenanceFixture(runtime, classified);
      try {
        const handle2 = await f2.networkReplicaHandle("stub", "remote");
        const configured2 = value2(await f2.maintenance.replicas.configure(OWNER, f2.archiveId, { destinationHandle: handle2, credentialHandle: "opaque-cred-handle", expectedIdentity: "stub-remote" }, signal()));
        const head2 = await f2.openRevision();
        const pushed2 = await f2.maintenance.replicas.push(OWNER, f2.archiveId, configured2.id, head2, signal());
        assert.ok(pushed2.ok === false && pushed2.error.message.includes("reason: credential_unavailable"), `a classified transport error keeps its closed reason; got ${JSON.stringify(pushed2)}`);
        assert.ok(!pushed2.error.message.includes(SECRET), "even a classified error message body never reaches the engine surface");
        return { fixture: f.base, classifiedReason: "credential_unavailable", secretContained: true, persistedState: record.state };
      } finally { f2.close(); }
    } finally { f.close(); }
  } finally { f0.close(); }
}

async function productCredentialRevocation(runtime: string) {
  const f0 = await fixture(runtime);
  const daemon = await startGitDaemon(f0.base);
  try {
    daemonRepo(daemon, "prod");
    const runtimeRoot = realpathSync(resolve(runtime));
    const require = createRequire(join(runtimeRoot, "package.json"));
    const built = await Bun.build({ entrypoints: [resolve("adapters/dsh/native/replication.ts")], target: "node", format: "esm", plugins: [{ name: "release-externals", setup(build) { build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: require.resolve(args.path), external: true })); } }] });
    if (!built.success) throw new AggregateError(built.logs, "product replication compilation failed");
    const bundlePath = join(f0.base, "product-replication.mjs");
    await Bun.write(bundlePath, await built.outputs[0]!.text());
    const product = await import(pathToFileURL(bundlePath).href);
    const parsed = product.parseReplicaDestinations(undefined);
    assert.ok(parsed.ok && parsed.value === undefined, "no declared destinations means no network capability");
    const refusedGitEnv = product.parseReplicaDestinations(JSON.stringify({ net: { url: daemon.url("prod"), identity: "fixture-git-daemon", credential_ref: "team_token", credential_env: "REPLICA_TOKEN" } }));
    assert.ok(refusedGitEnv.ok === false, `the typed product schema must refuse a plain credential_env (only credential_username + askpass bridge is supported); got ${JSON.stringify(refusedGitEnv)}`);
    const ctxMod = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href);
    const ctx = new ctxMod.Context();
    let credentialValue: string | undefined = SECRET;
    ctx.provide("credentials", { resolve: async () => credentialValue === undefined ? undefined : { value: credentialValue } });
    const rootA = bare(join(f0.base, "product-root-a.git"));
    seedPrimary(f0.archiveRoot, f0.head, rootA);
    const rootARefs = () => git(["for-each-ref"], { cwd: rootA }).stdout.trim();
        const deployment = product.parseReplicaDestinations(JSON.stringify({ net: { url: daemon.url("prod"), identity: "fixture-git-daemon", credential_ref: "team_token", credential_username: "ensemble-replica" } }));
    assert.ok(deployment.ok, `the deployment configuration must parse; got ${JSON.stringify(deployment)}`);
    const transport = product.createProductReplicaTransport(ctx, deployment.value, { quarantineRoot: join(f0.base, "quarantine") });
    const replica: Replica = { id: "replica_prod", archiveId: f0.archiveId, destinationHandle: "net", expectedIdentity: "fixture-git-daemon", credentialHandle: "opaque-cred-handle", expectedRevision: null, state: "configured" };
    const context = { primaryRoot: rootA, destinationKey: "net" };
    const capability = await transport.authorize(OWNER, replica, signal(), context);
    assert.ok(capability !== undefined && capability.identity === "fixture-git-daemon" && capability.destinationKey === "net", "a current owner with a resolvable credential and a declared destination receives the capability");
    assert.equal(await transport.authorize({ ...ALICE }, replica, signal(), context), undefined, "a session actor cannot authorize a network transfer");
    credentialValue = undefined;
    assert.equal(await transport.authorize(OWNER, replica, signal(), context), undefined, "an unresolvable credential is a refusal, not an unauthenticated transfer");
    credentialValue = SECRET;
    assert.equal(await transport.authorize(OWNER, { ...replica, destinationHandle: "undeclared" }, signal(), { ...context, destinationKey: "undeclared-key" }), undefined, "an undeclared deployment destination key is refused before any process starts");
    assert.equal(await transport.head(replica, signal(), context, capability!), null, "the daemon repository is empty");
    const noContext = await transport.head(replica, signal).then(() => "resolved", (error: Error) => error.message);
    assert.notEqual(noContext, "resolved", `a transfer without the leased repository context is refused, never silently resolved; got ${noContext}`);
    const emptyCapability = await transport.authorize(OWNER, replica, signal(), { primaryRoot: "", destinationKey: "net" });
    assert.ok(emptyCapability !== undefined, "authorize does not validate the primary root (only the engine lease can)");
    const emptyContext = await transport.head(replica, signal(), { primaryRoot: "" }, emptyCapability).then(() => "resolved", (error: Error) => error.message);
    assert.notEqual(emptyContext, "resolved", `an empty repository context is refused, got: ${emptyContext}`);
        const freshDeployment = product.parseReplicaDestinations(JSON.stringify({ net: { url: daemon.url("prod"), identity: "fixture-git-daemon" } }));
    const fresh = product.createProductReplicaTransport(ctx, freshDeployment.value, { quarantineRoot: join(f0.base, "quarantine") });
    const unauthorized = await fresh.head(replica, signal(), context).then(() => "resolved", (error: Error) => error.message);
    assert.notEqual(unauthorized, "resolved", `a transfer without prior authorization for that replica is refused, got: ${unauthorized}`);
    // Relocation seam: the per-call context root is the one actually pushed from; the old root
    // is neither read nor written by later transfers.
    const pushedRevision = f0.head;
    await transport.push(replica, pushedRevision, null, signal(), context, capability!);
    assert.equal(daemonHead(daemon.url("prod")), pushedRevision, "the daemon holds the revision pushed through the leased context root");
    const refsBefore = rootARefs();
    const rootB = join(f0.base, "product-root-b.git");
    mkdirSync(rootB, { recursive: true, mode: 0o700 });
    const copied = spawnSync("cp", ["-a", `${rootA}/.`, rootB], { encoding: "utf8" });
    assert.equal(copied.status, 0, String(copied.stderr));
    const tree = git(["-C", rootB, "rev-parse", pushedRevision + "^{tree}"]);
    assert.equal(tree.code, 0, tree.stderr);
    const commit = git(["-C", rootB, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit-tree", tree.stdout.trim(), "-p", pushedRevision, "-m", "post-relocate"]);
    assert.equal(commit.code, 0, commit.stderr);
    const newRevision = commit.stdout.trim();
    // Authorization is consumed by each transfer: the engine re-authorizes before every push.
    const reauthorization = await transport.authorize(OWNER, replica, signal(), context);
    assert.ok(reauthorization !== undefined, "re-authorization for the next transfer succeeds");
    await transport.push(replica, newRevision, pushedRevision, signal(), { primaryRoot: rootB, destinationKey: "net" }, reauthorization!);
    assert.equal(daemonHead(daemon.url("prod")), newRevision, "after the context root moved, the new root is the one pushed from");
    assert.equal(rootARefs(), refsBefore, "the previous primary root was never touched by later transfers");
    await ctx.fiber.dispose().catch(() => {});
    return { fixture: f0.base, daemon: daemon.url("prod"), revocationRefused: true, missingContextRefused: true, relocatedPushFromNewRoot: newRevision.slice(0, 12), gitEnvRefusedByParser: true };
  } finally { daemon.close(); f0.close(); }
}

/** Decisive credential-consumption probe: a local smart-HTTP remote (child process) that
 * REQUIRES Basic auth before running the real git-http-backend CGI. The full production
 * chain runs: ctx.credentials resolve -> credential_username + secret -> the deployment
 * transport's askpass bridge -> a real Git child. The child server counts every
 * Authorization header, so "resolve was called" is never confused with "authenticated".
 * The child is generated by this script into its own fixture and killed at the end.
 */
async function httpCredentialUsage(runtime: string) {
  const f0 = await fixture(runtime);
  const childPath = join(f0.base, "auth-http-child.mjs");
  await Bun.write(childPath, [
    "import { spawnSync } from 'node:child_process';",
    "import { mkdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const repos = join(process.argv[2], 'http-repos');",
    "const secret = process.argv[3];",
    "const user = process.argv[4];",
    "mkdirSync(repos, { recursive: true, mode: 0o700 });",
    "spawnSync('git', ['init', '--bare', '--quiet', join(repos, 'authed.git')], { encoding: 'utf8' });",
    "spawnSync('git', ['-C', join(repos, 'authed.git'), 'config', 'http.receivepack', 'true'], { encoding: 'utf8' });",
    "const expected = `Basic ${Buffer.from(user + ':' + secret).toString('base64')}`;",
    "const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();",
    "let authHeaderCount = 0, authValidCount = 0; const paths = [];",
    "async function backend(req, url) {",
    "  const body = req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined;",
    "  const child = spawnSync(join(execPath, 'git-http-backend'), [], { env: { PATH: execPath + ':' + process.env.PATH, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers.get('content-type') ?? '', CONTENT_LENGTH: body ? String(body.length) : '', GIT_PROTOCOL: req.headers.get('git-protocol') ?? '', REMOTE_USER: user }, input: body, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });",
    "  const raw = child.stdout ?? new Uint8Array();",
    "  const text = new TextDecoder().decode(raw);",
    "  const sep = text.indexOf('\\r\\n\\r\\n');",
    "  const headerBlock = sep >= 0 ? text.slice(0, sep) : text;",
    "  const responseBody = sep >= 0 ? raw.slice(Buffer.byteLength(headerBlock) + 4) : new Uint8Array();",
    "  let status = 200; const headers = {};",
    "  for (const line of headerBlock.split('\\r\\n')) {",
    "    if (line.startsWith('Status:')) status = Number(line.slice(7).trim().split(' ')[0]);",
    "    else if (line.startsWith('Content-Type:')) headers['Content-Type'] = line.slice(14).trim();",
    "  }",
    "  return new Response(responseBody, { status, headers });",
    "}",
    "const authed = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {",
    "  const url = new URL(req.url); paths.push('authed ' + req.method + ' ' + url.pathname + url.search);",
    "  const auth = req.headers.get('authorization');",
    "  if (auth !== null && auth.length > 0) authHeaderCount++;",
    "  const presented = auth === null ? '' : Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').slice(1).join(':');",
    "  if (presented !== secret) return new Response('authentication required\\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm=ensemble-replica-fixture' } });",
    "  authValidCount++;",
    "  return backend(req, url);",
    "} });",
    "const redirect = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {",
    "  const url = new URL(req.url); paths.push('redirect ' + req.method + ' ' + url.pathname);",
    "  return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${authed.port}/authed.git` } });",
    "} });",
    "const stats = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return Response.json({ authHeaderCount, authValidCount, paths }); } });",
    "console.log('PORTS ' + authed.port + ' ' + redirect.port + ' ' + stats.port);",
  ].join("\n") + "\n");
  const child = Bun.spawn([process.execPath, childPath, f0.base, SECRET, "ensemble-replica"], { stdout: "pipe", stderr: "pipe" });
  try {
    const firstLine = await (async () => { const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = ""; for (;;) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const newline = buffer.indexOf("\n"); if (newline >= 0) return buffer.slice(0, newline); } return buffer; })();
    const ports = String(firstLine ?? "").trim().split(" ");
    assert.equal(ports[0], "PORTS", "the fixture server must announce its ports; got " + ports.join(" "));
    const authedPort = Number(ports[1]), redirectPort = Number(ports[2]), statsPort = Number(ports[3]);
    const stats = async () => await (await fetch("http://127.0.0.1:" + statsPort + "/__stats")).json();
    const authedHead = () => git(["for-each-ref", "--format=%(objectname)", "refs/ensemble/main"], { cwd: join(f0.base, "http-repos", "authed.git") }).stdout.trim() || null;
    const runtimeRoot = realpathSync(resolve(runtime));
    const require = createRequire(join(runtimeRoot, "package.json"));
    const built = await Bun.build({ entrypoints: [resolve("adapters/dsh/native/replication.ts")], target: "node", format: "esm", plugins: [{ name: "release-externals", setup(build) { build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: require.resolve(args.path), external: true })); } }] });
    if (!built.success) throw new AggregateError(built.logs, "product replication compilation failed");
    const bundlePath = join(f0.base, "product-replication.mjs");
    await Bun.write(bundlePath, await built.outputs[0]!.text());
    const product = await import(pathToFileURL(bundlePath).href);
    const ctxMod = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href);
    const ctx = new ctxMod.Context();
    let credentialValue: string | undefined = SECRET;
    ctx.provide("credentials", { resolve: async () => credentialValue === undefined ? undefined : { value: credentialValue } });
    const rootA = bare(join(f0.base, "http-primary.git"));
    seedPrimary(f0.archiveRoot, f0.head, rootA);
    const deployment = product.parseReplicaDestinations(JSON.stringify({ net: { url: "http://127.0.0.1:" + authedPort + "/authed.git", identity: "fixture-auth-http", credential_ref: "team_token", credential_username: "ensemble-replica" } }));
    assert.ok(deployment.ok, "the authenticated-http deployment must parse with a credential_username; got " + JSON.stringify(deployment));
    const transport = product.createProductReplicaTransport(ctx, deployment.value, { quarantineRoot: join(f0.base, "quarantine") });
    const replica: Replica = { id: "replica_http", archiveId: f0.archiveId, destinationHandle: "net", expectedIdentity: "fixture-auth-http", credentialHandle: "opaque-cred-handle", expectedRevision: null, state: "configured" };
    const context = { primaryRoot: rootA, destinationKey: "net" };
    // 1. Positive: the resolved username+secret must actually authenticate the push.
    const capability = await transport.authorize(OWNER, replica, signal(), context);
    assert.ok(capability !== undefined && capability.identity === "fixture-auth-http", "authorize succeeds with a resolvable credential and returns the remote identity capability (resolve is called)");
    const pushed = await transport.push(replica, f0.head, null, signal(), context, capability!).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.equal(pushed, "pushed", "the resolved credential must authenticate the push against the auth-required remote; got " + pushed);
    assert.equal(authedHead(), f0.head, "the server-side repository holds the authenticated push");
    const afterPositive = await stats();
    assert.ok(afterPositive.authValidCount > 0, "Git presented a valid Authorization header to the auth-required remote");
    assert.ok(afterPositive.authHeaderCount > 0, "an Authorization header was actually sent");
    // 2. Wrong secret: resolution succeeds, authentication must not.
    credentialValue = SECRET + "-wrong";
    const wrongCapability = await transport.authorize(OWNER, replica, signal(), context);
    assert.ok(wrongCapability !== undefined, "re-authorization with a wrong-but-resolvable credential still passes authorize (resolution is not authentication)");
    const beforeWrong = await stats();
    const wrongPush = await transport.push(replica, f0.head, null, signal(), context, wrongCapability!).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.notEqual(wrongPush, "pushed", "a wrong secret must not authenticate the push");
    assert.equal(authedHead(), f0.head, "the remote did not move on a wrong credential");
    const afterWrong = await stats();
    assert.equal(afterWrong.authValidCount, beforeWrong.authValidCount, "the wrong secret produced no authenticated request");
    // 3. Revoked credential: authorize refuses and no anonymous fallback transfer happens.
    credentialValue = undefined;
    assert.equal(await transport.authorize(OWNER, replica, signal(), context), undefined, "a revoked credential is a refusal, not an anonymous push");
    const beforeRevoked = await stats();
    const revokedPush = await transport.push(replica, f0.head, null, signal(), context).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.notEqual(revokedPush, "pushed", "a revoked credential must not authenticate the push");
    assert.equal(authedHead(), f0.head, "the remote did not move on a revoked credential");
    const afterRevoked = await stats();
    assert.equal(afterRevoked.authValidCount, beforeRevoked.authValidCount, "the revoked phase produced no authenticated request");
    credentialValue = SECRET;
    // 4. Cross-origin redirect: Git must refuse to follow, and no request (let alone the secret) reaches the authed origin through it.
    const redirectDeployment = product.parseReplicaDestinations(JSON.stringify({ net: { url: "http://127.0.0.1:" + redirectPort + "/redirected.git", identity: "fixture-auth-http", credential_ref: "team_token", credential_username: "ensemble-replica" } }));
    assert.ok(redirectDeployment.ok, "the redirect deployment parses");
    const redirectTransport = product.createProductReplicaTransport(ctx, redirectDeployment.value, { quarantineRoot: join(f0.base, "quarantine") });
    const redirectReplica: Replica = { ...replica, id: "replica_redirect", destinationHandle: "net" };
    const redirectCapability = await redirectTransport.authorize(OWNER, redirectReplica, signal(), context);
    assert.ok(redirectCapability !== undefined, `authorize does not fetch, so it cannot see the redirect; capability ${JSON.stringify(redirectCapability)}`);
    const redirectPush = await redirectTransport.push(redirectReplica, f0.head, null, signal(), context, redirectCapability!).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.notEqual(redirectPush, "pushed", "Git must not follow a cross-origin redirect to the authenticated remote");
    const afterRedirect = await stats();
    assert.equal(afterRedirect.authValidCount, afterRevoked.authValidCount, "no authenticated request reached the real remote through the redirect");
    // 5. Leak checks: the secret must not appear in engine failures, server-requested URLs, receipts or the persisted record.
    const appearances: { where: string; text: string }[] = [
      { where: "push result", text: JSON.stringify(pushed) },
      { where: "server-requested paths", text: JSON.stringify(afterRedirect.paths) },
      { where: "snapshot", text: JSON.stringify(await f0.registry.withOwner(OWNER, f0.archiveId, signal(), async lease => C.success(lease.snapshot))) },
    ];
    const persistedRecord = join(f0.archiveRoot, "owner-configuration.json");
    if (existsSync(persistedRecord)) appearances.push({ where: "persisted replica record", text: readFileSync(persistedRecord, "utf8") });
    const leaked = appearances.find(entry => entry.text.includes(SECRET));
    assert.ok(!leaked, "the credential secret must never surface in a URL, a result, a receipt or the archive (" + (leaked?.where ?? "none") + ")");
    await ctx.fiber.dispose().catch(() => {});
    return { fixture: f0.base, authedPort, redirectPort, authenticatedPush: pushed, wrongSecretRefused: wrongPush !== "pushed", revokedRefused: revokedPush !== "pushed", redirectFollowed: redirectPush === "pushed", authHeaderCount: afterRedirect.authHeaderCount, authValidCount: afterRedirect.authValidCount, credentialResolvedByProduct: true };
  } finally { child.kill("SIGTERM"); }
}
/** Interleaved deployments: two declared destinations, per-destination credentials.
 * Proves under interleaving that each transfer uses its own context credential (never the
 * other deployment's secret), a revoked destination does not affect the other one, and
 * records the last-authorized-key semantics of identity().
 */
async function interleavedDestinations(runtime: string) {
  const f0 = await fixture(runtime);
  const secretA = SECRET + "-A", secretB = SECRET + "-B";
  const childPath = join(f0.base, "auth-http-child.mjs");
  await Bun.write(childPath, [
    "import { spawnSync } from 'node:child_process';",
    "import { mkdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const repos = join(process.argv[2], 'http-repos');",
    "const user = process.argv[3];",
    "const secrets = { a: process.argv[4], b: process.argv[5] };",
    "mkdirSync(repos, { recursive: true, mode: 0o700 });",
    "for (const name of ['a', 'b']) { spawnSync('git', ['init', '--bare', '--quiet', join(repos, name + '.git')], { encoding: 'utf8' }); spawnSync('git', ['-C', join(repos, name + '.git'), 'config', 'http.receivepack', 'true'], { encoding: 'utf8' }); }",
    "const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();",
    "let authHeaderCount = 0; const validByRepo = { a: 0, b: 0 }; const paths = [];",
    "async function backend(req, url) {",
    "  const body = req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined;",
    "  const child = spawnSync(join(execPath, 'git-http-backend'), [], { env: { PATH: execPath + ':' + process.env.PATH, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers.get('content-type') ?? '', CONTENT_LENGTH: body ? String(body.length) : '', GIT_PROTOCOL: req.headers.get('git-protocol') ?? '', REMOTE_USER: user }, input: body, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });",
    "  const raw = child.stdout ?? new Uint8Array();",
    "  const text = new TextDecoder().decode(raw);",
    "  const sep = text.indexOf('\\r\\n\\r\\n');",
    "  const headerBlock = sep >= 0 ? text.slice(0, sep) : text;",
    "  const responseBody = sep >= 0 ? raw.slice(Buffer.byteLength(headerBlock) + 4) : new Uint8Array();",
    "  let status = 200; const headers = {};",
    "  for (const line of headerBlock.split('\\r\\n')) {",
    "    if (line.startsWith('Status:')) status = Number(line.slice(7).trim().split(' ')[0]);",
    "    else if (line.startsWith('Content-Type:')) headers['Content-Type'] = line.slice(14).trim();",
    "  }",
    "  return new Response(responseBody, { status, headers });",
    "}",
    "const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {",
    "  const url = new URL(req.url); paths.push(req.method + ' ' + url.pathname + url.search);",
    "  const repo = url.pathname.split('/')[1].replace('.git', '');",
    "  const auth = req.headers.get('authorization');",
    "  if (auth !== null && auth.length > 0) authHeaderCount++;",
    "  const expected = `Basic ${Buffer.from(user + ':' + secrets[repo]).toString('base64')}`;",
    "  const presented = auth === null ? '' : Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').slice(1).join(':');",
    "  if (presented !== secrets[repo]) return new Response('authentication required\\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm=ensemble-replica-fixture' } });",
    "  validByRepo[repo]++;",
    "  return backend(req, url);",
    "} });",
    "const stats = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return Response.json({ authHeaderCount, validByRepo, paths }); } });",
    "console.log('PORTS ' + server.port + ' ' + stats.port);",
  ].join("\n") + "\n");
  const child = Bun.spawn([process.execPath, childPath, f0.base, "ensemble-replica", secretA, secretB], { stdout: "pipe", stderr: "pipe" });
  try {
    const firstLine = await (async () => { const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = ""; for (;;) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const newline = buffer.indexOf("\n"); if (newline >= 0) return buffer.slice(0, newline); } return buffer; })();
    const ports = String(firstLine ?? "").trim().split(" ");
    assert.equal(ports[0], "PORTS", "the fixture server must announce its ports; got " + ports.join(" "));
    const serverPort = Number(ports[1]), statsPort = Number(ports[2]);
    const stats = async () => await (await fetch("http://127.0.0.1:" + statsPort + "/__stats")).json();
    const repoHead = (name: string) => git(["for-each-ref", "--format=%(objectname)", "refs/ensemble/main"], { cwd: join(f0.base, "http-repos", name + ".git") }).stdout.trim() || null;
    const runtimeRoot = realpathSync(resolve(runtime));
    const require = createRequire(join(runtimeRoot, "package.json"));
    const built = await Bun.build({ entrypoints: [resolve("adapters/dsh/native/replication.ts")], target: "node", format: "esm", plugins: [{ name: "release-externals", setup(build) { build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: require.resolve(args.path), external: true })); } }] });
    if (!built.success) throw new AggregateError(built.logs, "product replication compilation failed");
    const bundlePath = join(f0.base, "product-replication.mjs");
    await Bun.write(bundlePath, await built.outputs[0]!.text());
    const product = await import(pathToFileURL(bundlePath).href);
    const ctxMod = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href);
    const ctx = new ctxMod.Context();
    const credentials: Record<string, string | undefined> = { cred_a: secretA, cred_b: secretB };
    ctx.provide("credentials", { resolve: async (ref: string) => credentials[ref] === undefined ? undefined : { value: credentials[ref] } });
    const rootA = bare(join(f0.base, "interleaved-primary.git"));
    seedPrimary(f0.archiveRoot, f0.head, rootA);
    const destinationA = { url: "http://127.0.0.1:" + serverPort + "/a.git", identity: "fixture-a", credential_ref: "cred_a", credential_username: "ensemble-a" };
    const destinationB = { url: "http://127.0.0.1:" + serverPort + "/b.git", identity: "fixture-b", credential_ref: "cred_b", credential_username: "ensemble-b" };
    const deployment = product.parseReplicaDestinations(JSON.stringify({ a: destinationA, b: destinationB }));
    assert.ok(deployment.ok, "the two-destination deployment parses");
    const transport = product.createProductReplicaTransport(ctx, deployment.value, { quarantineRoot: join(f0.base, "quarantine") });
    const replica: Replica = { id: "replica_shared", archiveId: f0.archiveId, destinationHandle: "a", expectedIdentity: "fixture-a", credentialHandle: "opaque-cred-handle", expectedRevision: null, state: "configured" };
    const contextA = { primaryRoot: rootA, destinationKey: "a" };
    const contextB = { primaryRoot: rootA, destinationKey: "b" };
    const capabilityA = await transport.authorize(OWNER, replica, signal(), contextA);
    assert.ok(capabilityA !== undefined && capabilityA.identity === "fixture-a", "authorize A returns the A capability");
    const identityAfterA = capabilityA!.identity;
    const capabilityB = await transport.authorize(OWNER, replica, signal(), contextB);
    assert.ok(capabilityB !== undefined && capabilityB.identity === "fixture-b", "authorize B returns the B capability");
    const identityAfterB = capabilityB!.identity;
    const pushA = await transport.push(replica, f0.head, null, signal(), contextA, capabilityA!).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.equal(pushA, "pushed", "the interleaved push to A uses the A context and succeeds");
    assert.equal(repoHead("a"), f0.head, "A holds its own revision");
    assert.equal(repoHead("b"), null, "B did not receive the A push");
    const pushB = await transport.push(replica, f0.head, null, signal(), contextB, capabilityB!).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.equal(pushB, "pushed", "the interleaved push to B uses the B context and succeeds");
    assert.equal(repoHead("b"), f0.head, "B holds its own revision");
    credentials.cred_a = undefined;
    assert.equal(await transport.authorize(OWNER, replica, signal(), contextA), undefined, "a revoked A authorizes nobody");
    const revokedPushA = await transport.push(replica, f0.head, null, signal(), contextA).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    assert.notEqual(revokedPushA, "pushed", "a revoked A cannot push");
    const capabilityB2 = await transport.authorize(OWNER, replica, signal(), contextB);
    assert.ok(capabilityB2 !== undefined && capabilityB2.identity === "fixture-b", "B authorization is unaffected by the A revocation");
    const afterRevocation = await stats();
    const borrowPush = await transport.push(replica, f0.head, null, signal(), contextA).then(() => "pushed", (error: Error) => ((error as { reason?: string }).reason ?? "unclassified") + ": " + error.message.slice(0, 160));
    await ctx.fiber.dispose().catch(() => {});
    return { fixture: f0.base, identityAfterA, identityAfterB, pushA, pushB, revokedPushA, borrowPush, validByRepo: afterRevocation.validByRepo, note: "authorize returns the per-call capability (identity travels with the answer), so no shared latest-authorized state is observable" };
  } finally { child.kill("SIGTERM"); }
}
async function noNetworkByDefault(runtime: string) {
  const f = await maintenanceFixture(runtime);
  try {
    const handle = await f.networkReplicaHandle("remote-target", "remote");
    const refused = await f.maintenance.replicas.configure(OWNER, f.archiveId, { destinationHandle: handle, credentialHandle: "opaque-cred-handle", expectedIdentity: "fixture-git-daemon" }, signal());
    assert.ok(refused.ok === false && refused.error.code === "not_authorized" && refused.error.message.includes("separately approved native network capability"), `the default composition must refuse a foreign-world replica with the missing-capability reason; got ${JSON.stringify(refused)}`);
    const revoked = await maintenanceFixture(runtime);
    try {
      const revokedHandle = await revoked.localReplicaHandle(revoked.bare);
      const configured = value2(await revoked.maintenance.replicas.configure(OWNER, revoked.archiveId, { destinationHandle: revokedHandle, credentialHandle: "none", expectedIdentity: "host" }, signal()));
      const head = await revoked.openRevision();
      revoked.handles.revoke(revokedHandle);
      const revokedPush = await revoked.maintenance.replicas.push(OWNER, revoked.archiveId, configured.id, head, signal());
      assert.ok(revokedPush.ok === false && ["not_found", "not_authorized"].includes(revokedPush.error.code), `a revoked location handle must stop replica pushes; got ${JSON.stringify(revokedPush)}`);
      return { fixture: f.base, defaultRefused: refused.error.code, revokedRefused: revokedPush.ok ? "unexpected-success" : revokedPush.error.code };
    } finally { revoked.close(); }
  } finally { f.close(); }
}

export const REPLICA_ACCEPTANCE_CASES = { "file-replica-roundtrip": fileReplicaRoundtrip, "network-replica-roundtrip": networkReplicaRoundtrip, "network-cas-ancestor-unknown": networkCasAndAncestor, "http-credential-usage": httpCredentialUsage, "interleaved-destinations": interleavedDestinations, "credential-containment": credentialContainment, "product-credential-revocation": productCredentialRevocation, "engine-failure-classifier": engineFailureClassifier, "no-network-by-default": noNetworkByDefault } as const;
export type ReplicaCase = keyof typeof REPLICA_ACCEPTANCE_CASES;
export function parseArgs(args: readonly string[]): { runtime: string; only?: ReplicaCase } {
  if (args.length !== 2 && args.length !== 4 || args[0] !== "--runtime" || !args[1] || !isAbsolute(resolve(args[1]))) throw new Error("Usage: bun scripts/verify-dsh-replica-acceptance.ts --runtime <isolated rc4/rc5 install> [--case <case-name>]");
  if (args.length === 4 && (args[2] !== "--case" || !Object.hasOwn(REPLICA_ACCEPTANCE_CASES, args[3]!))) throw new Error(`Unknown case; choose ${Object.keys(REPLICA_ACCEPTANCE_CASES).join(", ")}`);
  return { runtime: resolve(args[1]), ...(args[3] ? { only: args[3] as ReplicaCase } : {}) };
}
export async function verifyReplicaAcceptance(runtime: string, only?: ReplicaCase) {
  const results: { name: string; status: "PASS" | "FAIL"; evidence?: unknown; error?: string }[] = [];
  for (const [name, run] of Object.entries(REPLICA_ACCEPTANCE_CASES)) {
    if (only && name !== only) continue;
    try { results.push({ name, status: "PASS", evidence: await run(runtime) }); }
    catch (error) { results.push({ name, status: "FAIL", error: error instanceof Error ? error.message : String(error) }); }
  }
  const credentialLeak = results.some(result => JSON.stringify(result).includes(SECRET));
  return { status: results.every(r => r.status === "PASS") && !credentialLeak ? "PASS" : "FAIL", runtime: resolve(runtime), fixtureParent: resolve(".scratch/production-cycle"), boundary: "Real loopback git daemon + released runtime providers; fixture Actor injection, not Remote authentication; no real network, no power-loss durability; credential containment proven with a live fixture secret", ...(credentialLeak ? { credentialLeak: true } : {}), results };
}
if (import.meta.main) {
  let args: ReturnType<typeof parseArgs> | undefined;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
  if (args) { const report = await verifyReplicaAcceptance(args.runtime, args.only); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === "PASS" ? 0 : 1; }
}
