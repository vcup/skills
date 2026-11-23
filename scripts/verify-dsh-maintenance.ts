/** Mandatory real-kernel maintenance gate. --install-dir must name an isolated supported DSH install. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ArchiveKernel } from "../adapters/dsh/store/kernel.ts";
import { createHistoryMaintenance } from "../adapters/dsh/maintenance/history.ts";
import { createArchiveMaintenance } from "../adapters/dsh/maintenance/index.ts";
import { createLoopbackReplicaTransport } from "../adapters/dsh/maintenance/network.ts";
import { createArchiveRegistry, DEFAULT_LIMITS } from "../adapters/dsh/store/index.ts";
import { applyCoordination } from "../modules/ensemble/coordination.ts";
import { createLocationHandles, localSourceReader } from "../adapters/dsh/maintenance/handles.ts";
import type { UploadCommand } from "../modules/ensemble/contracts.ts";
import { createUploadManager, digestBytes } from "../adapters/dsh/uploads/index.ts";
import { success, actorIdentity, type Actor, type Result, type Snapshot, type WorkCommand, type AdminEnvelope } from "../modules/ensemble/contracts.ts";
function value<T>(result: Result<T>): T { if (!result.ok)
    throw new Error(JSON.stringify(result.error)); return result.value; }
function assert(truth: unknown, label: string): asserts truth { if (!truth)
    throw new Error(label); }
export async function verifyMaintenance(installDir: string, fixtureParent = resolve(".scratch/production-cycle")) {
    const install = resolve(installDir);
    const { Context } = await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"));
    const { LocalSubprocessRuntime } = await import(join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js"));
    const { LocalSandboxProvider } = await import(join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js"));
    const kernel = new ArchiveKernel({ context: new Context(), factories: { subprocess: c => new LocalSubprocessRuntime(c), sandbox: c => new LocalSandboxProvider(c, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }) } });
    mkdirSync(fixtureParent, { recursive: true });
    const fixture = mkdtempSync(join(fixtureParent, "maintenance-"));
    const root = join(fixture, "archive");
    mkdirSync(root, { mode: 0o700 });
    const signal = new AbortController().signal;
    const actor: Actor = { kind: "owner", ownerId: "fixture-owner", hostAuthorityId: "fixture-host", channel: "authenticated-remote" };
    const access = { authorizeOwner: async () => success({}), async withOwner<T>(_actor: Actor, _id: string, _signal: AbortSignal, run: (root: string, protectedRoots: readonly string[]) => Promise<Result<T>>) { return kernel.withLock(root, signal, () => run(root, [])); } };
    const handles = createLocationHandles({ authorizeSelection: async (_actor, r) => success({ world: "fixture-host", path: r.path, check: async () => true, ...(r.kind === "replica" ? { deploymentKey: "fixture" } : {}) }) });
    const history = createHistoryMaintenance({ kernel, access, handles, hostWorld: "fixture-host", quarantineRoot: join(fixture, "quarantine") });
    const uploads = createUploadManager({ root: join(fixture, "uploads"), withAccess: async <T>(_a: Actor, _id: string, _s: unknown, _signal: AbortSignal, run: (s: Snapshot) => Promise<Result<T>>) => kernel.withLock(root, signal, () => run({} as Snapshot)) });
    try {
        await kernel.initialize(root, signal);
        const raw = new Uint8Array(1024 * 1024 + 7);
        for (let i = 0; i < raw.length; i++)
            raw[i] = i % 256;
        const begin = value(await uploads.execute(actor, "archive-fixture", { action: "begin", payload: { invocation_id: "inv", total_bytes: raw.length, digest: digestBytes(raw), media_type: "application/octet-stream" } }, signal));
        for (let offset = 0; offset < raw.length; offset += 1024 * 1024) {
            const chunk = raw.slice(offset, offset + 1024 * 1024);
            value(await uploads.execute(actor, "archive-fixture", { action: "chunk", payload: { upload_id: begin.upload_id, offset, bytes: Buffer.from(chunk).toString("base64"), digest: digestBytes(chunk) } }, signal));
        }
        value(await uploads.execute(actor, "archive-fixture", { action: "commit", payload: { upload_id: begin.upload_id } }, signal));
        const first = await kernel.withLock(root, signal, async () => { const sealed = value(uploads.resolveSealed(actor, "archive-fixture", "inv", begin.upload_id, begin.digest)); const content = await kernel.hash(root, sealed.bytes, signal); const meta = await kernel.hash(root, Buffer.from(JSON.stringify({ archiveId: "archive-fixture", format: "ensemble-archive/v2", rendererVersion: "1" })), signal); const tree = await kernel.tree(root, [{ path: `content/${begin.digest}`, oid: content }, { path: "meta.json", oid: meta }], signal); const head = await kernel.commit(root, tree, null, 1, signal); await kernel.publish(root, head, null, signal); return head; });
        const second = await kernel.withLock(root, signal, async () => { const entries = await kernel.entries(root, first, signal); entries.push({ path: "receipts/owner/second.json", oid: await kernel.hash(root, Buffer.from('{"sequence":2}'), signal) }); const tree = await kernel.tree(root, entries, signal); const head = await kernel.commit(root, tree, first, 2, signal); await kernel.publish(root, head, first, signal); return head; });
        assert(digestBytes((await kernel.read(root, second, `content/${begin.digest}`, signal))!) === begin.digest, "raw Git roundtrip failed");
        const destination = join(fixture, "backup");
        const dh = value(await handles.choose(actor, { kind: "destination", path: destination, world: "fixture-host" }, signal));
        const manifest = value(await history.backup(actor, "archive-fixture", second, dh.handle, signal));
        const duplicate = await history.backup(actor, "archive-fixture", second, dh.handle, signal);
        assert(!duplicate.ok && duplicate.error.code === "destination_exists", "backup overwrote destination");
        const bh = value(await handles.choose(actor, { kind: "backup", path: destination, world: "fixture-host" }, signal));
        const restored = value(await history.restore(actor, "archive-fixture", bh.handle, signal));
        assert(restored.readOnly, "unknown latest restored writable");
        const restoredRoot = history.candidateRoot(restored.id)!;
        assert((await kernel.history(restoredRoot, second, signal)).join(",") === [second, first].join(","), "backup lost history");
        assert(digestBytes((await kernel.read(restoredRoot, first, `content/${begin.digest}`, signal))!) === begin.digest, "independent restore lost original bytes");
        assert((await kernel.read(restoredRoot, second, "receipts/owner/second.json", signal)) !== null, "restore lost receipt");
        const backupPath = join(destination, "archive.bundle");
        const valid = readFileSync(backupPath);
        writeFileSync(backupPath, valid.subarray(0, valid.length - 7));
        const corrupt = await history.restore(actor, "archive-fixture", bh.handle, signal);
        assert(!corrupt.ok, "corrupt bundle accepted");
        assert(await kernel.head(root, signal) === second, "restore changed authoritative head");
        const registryChecks = await verifyRegistryTransfers(install, fixture);
        const latest = await verifyLatestSemantics(install, fixture);
        return { status: "PASS", fixture, registryChecks, bytes: raw.length, digest: begin.digest, head: second, commits: 2, backupBytes: manifest.bundle.bytes, latest, checks: ["raw upload → Git bytes", "independent full-history restore", "receipts preserved", "unknown latest read-only", "destination overwrite refused", "corrupt bundle rejected", "authoritative ref unchanged"] };
    }
    finally {
        kernel.dispose();
        handles.dispose();
    }
}
async function verifyRegistryTransfers(install: string, fixture: string) {
    const { Context } = await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"));
    const { LocalSubprocessRuntime } = await import(join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js"));
    const { LocalSandboxProvider } = await import(join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js"));
    const context = new Context();
    const factories = { subprocess: (c: any) => new LocalSubprocessRuntime(c), sandbox: (c: any) => new LocalSandboxProvider(c, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }) };
    const kernel = new ArchiveKernel({ context, factories });
    const source = join(fixture, "import-source");
    mkdirSync(source);
    writeFileSync(join(source, "unknown.bin"), new Uint8Array([255, 0, 128, 192]));
    writeFileSync(join(source, "notes.md"), "unknown column\ncompleted in old log\n");
    const owner: Actor = { kind: "owner", ownerId: "o", hostAuthorityId: "registry-host", channel: "authenticated-remote" };
    const lead: Actor = { kind: "session", sessionId: "lead", rootSessionId: "lead", workspaceRef: "source", callId: "one" };
    const signal = new AbortController().signal;
    const options = { root: join(fixture, "registry"), hostAuthorityId: "registry-host", worldIdentity: "host", context, factories, reducer: (s: Snapshot, c: any, f: any) => applyCoordination(s, c, f) };
    const registry = createArchiveRegistry(options);
    const handles = createLocationHandles({ authorizeSelection: async (_a, r) => success({ world: "host", path: r.path, check: async () => true, ...(r.kind === "source" && r.path !== undefined ? { reader: localSourceReader(r.path) } : {}), ...(r.kind === "replica" ? { deploymentKey: "fixture" } : {}) }) });
    const maintenance = createArchiveMaintenance({ registry, kernel, handles, hostWorld: "host", quarantineRoot: join(fixture, "registry-quarantine"), verifyApproval: async () => true, proveStopped: async () => true });
    try {
        const initial = value(await registry.admin(owner, { action: "initialize", expected_revision: "absent", operation_id: "init", payload: { root_handle: "default", source_descriptor: { worldIdentity: "host", canonicalAddress: source, nativeWorkspaceRef: "source" }, initial_grants: [{ subject: actorIdentity(lead), rights: ["read", "open"], scope: { kind: "project" } }], limits: DEFAULT_LIMITS } }, signal));
        const target = value(await registry.resolve(lead, { worldIdentity: "host", nativeWorkspaceRef: "source", canonicalAddress: source }, signal));
        const sh = value(await handles.choose(owner, { kind: "source", path: source, world: "host" }, signal));
        const inventory = value(await maintenance.transfer.inventoryImport(owner, target.archiveId, sh.handle, [], 100000, signal));
        const imported = value(await maintenance.transfer.commitImport(owner, target.archiveId, { inventoryId: inventory.id, acceptedExceptions: [], approvalId: "fixture-approval", expectedRevision: initial.committed_revision, operationId: "import-one" }, signal));
        const replay = value(await maintenance.transfer.commitImport(owner, target.archiveId, { inventoryId: inventory.id, acceptedExceptions: [], approvalId: "fixture-approval", expectedRevision: initial.committed_revision, operationId: "import-again" }, signal));
        assert(replay.committed_revision === imported.committed_revision, "duplicate import was not deduplicated");
        const exported = join(fixture, "registry-export");
        const eh = value(await handles.choose(owner, { kind: "destination", path: exported, world: "host" }, signal));
        value(await maintenance.transfer.exportRevision(owner, target.archiveId, imported.committed_revision, [], eh.handle, signal));
        const exportManifest = JSON.parse(readFileSync(join(exported, "manifest.json"), "utf8"));
        const rawFile = exportManifest.files.find((f: any) => f.path.endsWith("/unknown.bin"));
        assert(rawFile, "source logical path mapping missing from export");
        assert(Buffer.from(readFileSync(join(exported, rawFile.path))).equals(Buffer.from([255, 0, 128, 192])), "registry import/export changed original bytes");
        const stale = value(await maintenance.transfer.inventoryImport(owner, target.archiveId, sh.handle, [], 100000, signal));
        writeFileSync(join(source, "notes.md"), "source changed");
        const denied = await maintenance.transfer.commitImport(owner, target.archiveId, { inventoryId: stale.id, acceptedExceptions: [], approvalId: "fixture-approval", expectedRevision: imported.committed_revision, operationId: "stale-import" }, signal);
        assert(!denied.ok && denied.error.code === "stale_inventory", "registry accepted changed source");
        const after = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        assert(after.revision === imported.committed_revision, "stale inventory moved head");
        const bk = join(fixture, "registry-backup");
        const bh = value(await handles.choose(owner, { kind: "destination", path: bk, world: "host" }, signal));
        value(await maintenance.history.backup(owner, target.archiveId, after.revision, bh.handle, signal));
        const freshRegistry = createArchiveRegistry({ ...options, root: join(fixture, "fresh-host-registry") });
        const freshMaintenance = createArchiveMaintenance({ registry: freshRegistry, kernel, handles, hostWorld: "host", quarantineRoot: join(fixture, "fresh-host-quarantine"), verifyApproval: async () => true, proveStopped: async () => true });
        const freshBackup = value(await handles.choose(owner, { kind: "backup", path: bk, world: "host" }, signal));
        const independent = value(await freshMaintenance.history.restore(owner, "lost-project", freshBackup.handle, signal));
        assert(independent.readOnly && independent.identity.head === after.revision, "fresh host restore requires a pre-existing project");
        const freshActivation = value(await freshMaintenance.recovery.activate(owner, "lost-project", { candidateId: independent.id, operationId: "fresh-lossy", expectedRevision: after.revision, mode: "lossy", source: { worldIdentity: "host", canonicalAddress: source, nativeWorkspaceRef: "recovered-source" }, grants: [{ subject: { kind: "session", sessionId: "new-reader", rootSessionId: "new-root" }, rights: ["read"], scope: { kind: "project" } }], approvalId: "fixture-approval", sourceStopEvidence: [], lossStatement: "Final primary head is unknown; accept unknown interval" }, signal));
        assert(freshActivation.archiveId !== target.archiveId, "lossy restore reused original identity");
        const freshState = value(await freshRegistry.withOwner(owner, freshActivation.archiveId, signal, async (l) => success(l.snapshot)));
        assert(freshState.policy.grants.length === 1 && freshState.policy.grants[0]!.subject.kind === "session" && freshState.policy.grants[0]!.subject.sessionId === "new-reader", "restore resurrected old grants");
        assert(freshState.policy.paused, "restored writer was enabled before diagnostics");
        const originalLocation = value(await freshRegistry.withOwner(owner, freshActivation.archiveId, signal, async (l) => success(l.root)));
        const relocationPath = join(fixture, "relocated-primary");
        const relocationHandle = value(await handles.choose(owner, { kind: "destination", path: relocationPath, world: "host" }, signal));
        value(await freshMaintenance.execute(owner, { action: "relocate", project_id: freshActivation.projectId, expected_revision: freshActivation.revision, operation_id: "relocate-approved", payload: { destination_handle: relocationHandle.handle, source_stop_evidence: [{ kind: "reported", statement: "fixture primary paused", source_label: "fixture", supporting_refs: [] }], mapping_evidence: [], source_descriptor: { worldIdentity: "host", canonicalAddress: source, nativeWorkspaceRef: "recovered-source" }, initial_grants: [{ subject: { kind: "session", sessionId: "relocated-reader", rootSessionId: "new-root" }, rights: ["read"], scope: { kind: "project" } }], approval_ref: { approval_id: "fixture-approval" } } }, signal));
        const relocated = value(await freshRegistry.withOwner(owner, freshActivation.archiveId, signal, async (l) => success({ root: l.root, snapshot: l.snapshot })));
        assert(relocated.root === relocationPath && existsSync(originalLocation) && existsSync(join(originalLocation, "ensemble-retired.json")), "relocation did not preserve and disable old location");
        assert(relocated.snapshot.policy.paused && relocated.snapshot.policy.grants.length === 1, "relocation reused old authority or resumed without diagnostics");
        freshRegistry.dispose();
        // A separate v1 source is preserved as both every original tree byte and a complete bundle.
        const old = join(fixture, "legacy-v1");
        mkdirSync(old, { mode: 0o700 });
        await kernel.initialize(old, signal);
        const oldMeta = { format: "ensemble-archive/v1", archiveId: "legacy-identity", sequence: 1, renderer: "legacy", binding: {}, grants: [{ subjectId: "old-admin", rights: ["manage"] }] };
        const oldTree = await kernel.tree(old, [{ path: "meta.json", oid: await kernel.hash(old, Buffer.from(JSON.stringify(oldMeta)), signal) }, { path: "content/old", oid: await kernel.hash(old, new Uint8Array([254, 128, 0]), signal) }], signal);
        const oldHead = await kernel.commit(old, oldTree, null, 1, signal);
        await kernel.publish(old, oldHead, null, signal);
        const lh = value(await handles.choose(owner, { kind: "backup", path: old, world: "host" }, signal));
        const preview = value(await maintenance.legacy.preview(owner, target.archiveId, lh.handle, signal));
        value(await maintenance.legacy.commit(owner, target.archiveId, { previewId: preview.id, approvalId: "fixture-approval", stopEvidence: "fixture-stopped", expectedRevision: after.revision, operationId: "legacy-import" }, signal));
        const migrated = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        assert(migrated.archiveId !== "legacy-identity", "legacy migration reused identity");
        assert(!JSON.stringify(migrated.policy).includes("old-admin"), "legacy grant revived");
        assert(await kernel.head(old, signal) === oldHead, "legacy original history changed");
        assert(migrated.objects.some(o => o.kind === "artifact" && o.body.title === "legacy-history/archive.bundle"), "legacy complete history missing");
        const remote = join(fixture, "file-replica");
        mkdirSync(remote, { mode: 0o700 });
        await kernel.initialize(remote, signal);
        const rh = value(await handles.choose(owner, { kind: "replica", path: remote, world: "host" }, signal));
        const replica = value(await maintenance.replicas.configure(owner, target.archiveId, { destinationHandle: rh.handle, credentialHandle: "none", expectedIdentity: "host" }, signal));
        value(await maintenance.replicas.push(owner, target.archiveId, replica.id, migrated.revision, signal));
        assert(await kernel.head(remote, signal) === migrated.revision, "file remote push did not CAS publish");
        const remoteEntries = await kernel.entries(remote, migrated.revision, signal);
        remoteEntries.push({ path: "remote-only.txt", oid: await kernel.hash(remote, Buffer.from("foreign writer"), signal) });
        const remoteTree = await kernel.tree(remote, remoteEntries, signal);
        const divergent = await kernel.commit(remote, remoteTree, migrated.revision, 99, signal);
        await kernel.publish(remote, divergent, migrated.revision, signal);
        const conflict = await maintenance.replicas.push(owner, target.archiveId, replica.id, migrated.revision, signal);
        assert(!conflict.ok && conflict.error.code === "remote_conflict", "remote conflict was overwritten");
        const fetched = value(await maintenance.replicas.fetch(owner, target.archiveId, replica.id, divergent, signal));
        assert(fetched.readOnly && fetched.head === divergent, "fetch was not verified quarantine");
        const primary = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot.revision)));
        assert(primary === migrated.revision, "fetch modified primary ref");
        const paused = value(await registry.admin(owner, { action: "pause", project_id: target.projectId, expected_revision: migrated.revision, operation_id: "pause-gc", payload: { reason: "verified backup and GC" } }, signal));
        const gcBackupPath = join(fixture, "gc-backup");
        const gcDest = value(await handles.choose(owner, { kind: "destination", path: gcBackupPath, world: "host" }, signal));
        value(await maintenance.history.backup(owner, target.archiveId, paused.committed_revision, gcDest.handle, signal));
        const gcBackup = value(await handles.choose(owner, { kind: "backup", path: gcBackupPath, world: "host" }, signal));
        const plan = value(await maintenance.plans.preview(owner, target.archiveId, { kind: "gc", backupHandle: gcBackup.handle, reason: "owner approved GC" }, signal));
        value(await maintenance.plans.maintain(owner, target.archiveId, { planRef: plan.plan_ref, approvalId: "fixture-approval", expectedRevision: paused.committed_revision, operationId: "gc-approved" }, signal));
        const gcHead = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => { assert((await l.kernel.history(l.root, l.snapshot.revision, l.signal)).includes(imported.committed_revision), "GC lost import history"); await l.kernel.fsck(l.root, l.signal); return success(l.snapshot.revision); }));
        const oldPhysicalRoot = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.root)));
        const beforePurge = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        let purgeRevision = gcHead;
        for (const grant of beforePurge.policy.grants) {
            const revoked = value(await registry.admin(owner, { action: "revoke", project_id: target.projectId, expected_revision: purgeRevision, operation_id: `purge-revoke-${grant.id}`, payload: { grant_id: grant.id, reason: "quarantine sensitive data" } }, signal));
            purgeRevision = revoked.committed_revision;
        }
        const pbPath = join(fixture, "purge-backup");
        const pbDest = value(await handles.choose(owner, { kind: "destination", path: pbPath, world: "host" }, signal));
        value(await maintenance.history.backup(owner, target.archiveId, purgeRevision, pbDest.handle, signal));
        const pb = value(await handles.choose(owner, { kind: "backup", path: pbPath, world: "host" }, signal));
        const sensitiveDigest = digestBytes(new Uint8Array([255, 0, 128, 192]));
        const purgePlan = value(await maintenance.plans.preview(owner, target.archiveId, { kind: "purge", backupHandle: pb.handle, reason: "remove fixture sensitive material", contentDigests: [sensitiveDigest] }, signal));
        assert(purgePlan.affectedArtifacts.length > 0, "purge preview missed affected original");
        const purgeRequest: AdminEnvelope = { action: "maintain", project_id: target.projectId, expected_revision: purgeRevision, operation_id: "purge-approved", payload: { plan_ref: purgePlan.plan_ref, approval_ref: { approval_id: "fixture-approval" } } };
        const purged = value(await maintenance.execute(owner, purgeRequest, signal)) as {
            archiveId: string;
            projectId: string;
            revision: string;
            completeness: string;
            retiredPrimary?: string;
        };
        assert(purged.retiredPrimary === "disposed" && !existsSync(oldPhysicalRoot), "purge retained managed old physical repository");
        assert(purged.archiveId !== target.archiveId && purged.completeness === "partial", "purge did not expose new identity and unresolved external copies");
        value(await registry.withOwner(owner, purged.archiveId, signal, async (l) => { assert(l.snapshot.policy.grants.length === 0 && l.snapshot.policy.paused, "purge revived grants"); assert((await l.kernel.history(l.root, l.snapshot.revision, l.signal)).length === 1, "purge retained old Git history"); assert((await l.kernel.read(l.root, l.snapshot.revision, `content/${sensitiveDigest}`, l.signal)) === null, "purge retained targeted bytes"); return success({}); }));
        assert(!(await registry.withOwner(owner, target.archiveId, signal, async () => success({}))).ok, "retired old identity remained accessible");
        const restartedRegistry = createArchiveRegistry(options);
        const restartedMaintenance = createArchiveMaintenance({ registry: restartedRegistry, kernel, handles, hostWorld: "host", quarantineRoot: join(fixture, "restarted-quarantine"), verifyApproval: async () => false, proveStopped: async () => false });
        const reconciled = value(await restartedMaintenance.execute(owner, purgeRequest, signal)) as {
            archiveId: string;
            revision: string;
            reconciled: boolean;
        };
        assert(reconciled.reconciled && reconciled.archiveId === purged.archiveId && reconciled.revision === purged.revision, "restart did not reconcile original destructive receipt");
        const keyConflict = await restartedMaintenance.execute(owner, { ...purgeRequest, payload: { ...purgeRequest.payload, approval_ref: { approval_id: "different-business-input" } } }, signal);
        assert(!keyConflict.ok && keyConflict.error.code === "operation_key_conflict", "restart replay accepted changed owner payload");
        restartedRegistry.dispose();
        return { status: "PASS", archiveId: target.archiveId, importedRevision: imported.committed_revision, migratedRevision: migrated.revision, gcRevision: gcHead, purgedArchiveId: purged.archiveId, checks: ["real registry atomic import", "digest dedup receipt", "raw logical-path export", "stale inventory head unchanged", "v2 history backup", "fresh-host read-only restore without project", "lossy activation new identity and only fresh grants", "relocation atomically switches and retains disabled original", "v1 explicit new identity migration", "old grants never activated", "v1 source history preserved", "file remote CAS push", "remote conflict refused", "isolated fetch leaves primary unchanged", "paused verified-backup approved GC preserves history", "approved purge creates new history without targeted bytes", "retired identity inaccessible and external copies reported", "destructive receipt replay survives restart and rejects changed payload"] };
    }
    finally {
        registry.dispose();
        kernel.dispose();
        handles.dispose();
    }
}
/**
 * Latest-tail semantics through the real maintenance entry: upload authorization
 * at the store seam, relocated/retired copy inventory and disposal, a real
 * loopback network replica, and project-scoped destructive replay.
 */
async function verifyLatestSemantics(install: string, fixture: string) {
    const { Context } = await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"));
    const { LocalSubprocessRuntime } = await import(join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js"));
    const { LocalSandboxProvider } = await import(join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js"));
    const context = new Context();
    const factories = { subprocess: (c: any) => new LocalSubprocessRuntime(c), sandbox: (c: any) => new LocalSandboxProvider(c, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }) };
    const kernel = new ArchiveKernel({ context, factories });
    const base = join(fixture, "latest");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const source = join(base, "source");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "a.txt"), "alpha\n");
    const owner: Actor = { kind: "owner", ownerId: "latest-owner", hostAuthorityId: "latest-host", channel: "authenticated-remote" };
    const lead: Actor = { kind: "session", sessionId: "latest-lead", rootSessionId: "latest-lead", workspaceRef: "latest-source", callId: "call-1" };
    const outsider: Actor = { kind: "session", sessionId: "latest-outsider", rootSessionId: "latest-root", workspaceRef: "latest-source", callId: "call-2" };
    const signal = new AbortController().signal;
    const options = { root: join(base, "registry"), hostAuthorityId: "latest-host", worldIdentity: "host", context, factories, reducer: (s: Snapshot, c: any, f: any) => applyCoordination(s, c, f) };
    const registry = createArchiveRegistry(options);
    let remoteAllowed = true;
    const handles = createLocationHandles({
        authorizeSelection: async (_a, r) => success({
            world: r.world,
            path: r.path,
            check: async () => r.world === "loopback" ? remoteAllowed : true,
            ...(r.kind === "source" && r.path !== undefined ? { reader: localSourceReader(r.path) } : {}),
            // A replica selection carries the deployment key the native authorizer vouched
            // for; without it a network transfer is refused before any child process.
            ...(r.kind === "replica" ? { deploymentKey: "loopback" } : {}),
        }),
    });
    const server = loopbackDaemon(base);
    const networkTransport = (primaryRoot: string) => createLoopbackReplicaTransport({ resolve: () => server.url, identity: "loopback-remote", quarantineRoot: join(base, "network-quarantine"), primaryRoot, authorize: () => remoteAllowed });
    const maintenance = createArchiveMaintenance({ registry, kernel, handles, hostWorld: "host", quarantineRoot: join(base, "quarantine"), verifyApproval: async () => true, proveStopped: async () => true });
    const uploads = createUploadManager({ root: join(base, "uploads"), withAccess: (actor, id, access, signal, run) => registry.withAccess(actor, id, access, signal, run) });
    const checks: string[] = [];
    try {
        const initial = value(await registry.admin(owner, { action: "initialize", expected_revision: "absent", operation_id: "init", payload: { root_handle: "default", source_descriptor: { worldIdentity: "host", canonicalAddress: source, nativeWorkspaceRef: lead.workspaceRef }, initial_grants: [{ subject: actorIdentity(lead), rights: ["read", "open"], scope: { kind: "project" } }], limits: DEFAULT_LIMITS } }, signal));
        const target = value(await registry.resolve(lead, { worldIdentity: "host", nativeWorkspaceRef: lead.workspaceRef, canonicalAddress: source }, signal));
        const command: WorkCommand = { action: "open", payload: { title: "upload authority", goal: "prove current grants", deliverable: "sealed bytes", subject: "uploads", constraints: "current grant only", exclusions: "none", coverage: [{ key: "u", title: "Upload", requirement: "byte staging obeys current grants", required: true, authority_refs: [] }], criteria: [{ key: "c", coverage_targets: [{ kind: "request_key", key: "u" }], statement: "revocation refuses", critical: true, method: "store seam" }] } };
        value(await registry.execute(lead, { archiveId: target.archiveId, expectedRevision: initial.committed_revision, operationId: "open", command }, signal));
        const openedSnapshot = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        const invocationId = openedSnapshot.objects.find(o => o.kind === "invocation")!.id;
        const raw = Uint8Array.from([0, 255, 128, 7, 9, 11]);
        const started = value(await uploads.execute(lead, target.archiveId, { action: "begin", payload: { invocation_id: invocationId, total_bytes: raw.length, digest: digestBytes(raw), media_type: "application/octet-stream" } }, signal));
        value(await uploads.execute(lead, target.archiveId, { action: "chunk", payload: { upload_id: started.upload_id, offset: 0, bytes: Buffer.from(raw.slice(0, 3)).toString("base64"), digest: digestBytes(raw.slice(0, 3)) } }, signal));
        const stranger = await uploads.execute(outsider, target.archiveId, { action: "status", payload: { upload_id: started.upload_id } }, signal);
        assert(!stranger.ok, "an unrelated session reached another actor's upload");
        const granted = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        const leadGrant = granted.policy.grants.find(g => g.subject.kind === "session" && g.subject.sessionId === lead.sessionId && !g.revoked)!;
        value(await registry.admin(owner, { action: "revoke", project_id: target.projectId, expected_revision: granted.revision, operation_id: "revoke-upload", payload: { grant_id: leadGrant.id, reason: "stop uploads" } }, signal));
        // Each command is written out against the closed `UploadCommand` union rather than
        // asserted into it, so a change to that union becomes a compile error here instead of a
        // silently wrong request at run time.
        const revokedUploads: readonly UploadCommand[] = [
            { action: "status", payload: { upload_id: started.upload_id } },
            { action: "chunk", payload: { upload_id: started.upload_id, offset: 3, bytes: Buffer.from(raw.slice(3)).toString("base64"), digest: digestBytes(raw.slice(3)) } },
            { action: "commit", payload: { upload_id: started.upload_id } },
        ];
        for (const request of revokedUploads) {
            const action = request.action;
            const refused = await uploads.execute(lead, target.archiveId, request, signal);
            assert(!refused.ok && refused.error.code === "not_authorized", `revoked actor kept upload ${action}`);
        }
        checks.push("upload begin/chunk authorized by the current grant; unrelated Session and revoked Lead refused at the real store seam");
        const regrantRevision = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot.revision)));
        value(await registry.admin(owner, { action: "grant", project_id: target.projectId, expected_revision: regrantRevision, operation_id: "grant-upload", payload: { subject: actorIdentity(lead), rights: ["read", "open"], scope: { kind: "project" }, reason: "continue acceptance" } }, signal));
        // A real import so the later purge targets published original bytes.
        const sh = value(await handles.choose(owner, { kind: "source", path: source, world: "host" }, signal));
        const inventory = value(await maintenance.transfer.inventoryImport(owner, target.archiveId, sh.handle, [], 100_000, signal));
        const importRevision = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot.revision)));
        value(await maintenance.transfer.commitImport(owner, target.archiveId, { inventoryId: inventory.id, acceptedExceptions: [], approvalId: "fixture-approval", expectedRevision: importRevision, operationId: "latest-import" }, signal));
        checks.push("owner inventory and commit_import published the source originals through the maintenance entry");
        const current = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success({ root: l.root, snapshot: l.snapshot })));
        const oldRoot = current.root;
        const paused = value(await registry.admin(owner, { action: "pause", project_id: target.projectId, expected_revision: current.snapshot.revision, operation_id: "pause-relocate", payload: { reason: "relocate acceptance" } }, signal));
        const destination = join(base, "relocated");
        const dh = value(await handles.choose(owner, { kind: "destination", path: destination, world: "host" }, signal));
        const relocatePayload = { destination_handle: dh.handle, source_stop_evidence: [{ kind: "reported" as const, statement: "fixture primary paused", source_label: "fixture", supporting_refs: [] }], mapping_evidence: [], source_descriptor: { worldIdentity: "host", canonicalAddress: source, nativeWorkspaceRef: lead.workspaceRef }, initial_grants: [{ subject: actorIdentity(lead), rights: ["read"] as const, scope: { kind: "project" as const } }], approval_ref: { approval_id: "fixture-approval" } };
        const noStop = await maintenance.execute(owner, { action: "relocate", project_id: target.projectId, expected_revision: paused.committed_revision, operation_id: "relocate-no-stop", payload: { ...relocatePayload, source_stop_evidence: [] } } as AdminEnvelope, signal);
        assert(!noStop.ok && noStop.error.code === "source_stop_required", "relocation accepted without stopped-writer evidence");
        value(await maintenance.execute(owner, { action: "relocate", project_id: target.projectId, expected_revision: paused.committed_revision, operation_id: "relocate", payload: relocatePayload } as AdminEnvelope, signal));
        const copies = value(await registry.knownCopies(owner, target.archiveId, signal));
        const retired = copies.find(c => c.kind === "relocated-primary");
        assert(retired && retired.state === "retained" && existsSync(oldRoot) && existsSync(join(oldRoot, "ensemble-retired.json")), "relocation did not inventory its retained old primary");
        const relocatedNow = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success({ root: l.root, snapshot: l.snapshot })));
        assert(relocatedNow.root === destination && relocatedNow.snapshot.policy.paused && relocatedNow.snapshot.policy.grants.length === 1, "relocation did not keep paused authority with only fresh grants");
        const wrongHead = await registry.disposeKnownCopy(owner, { copyId: retired.copyId, replacementArchiveId: target.archiveId, expectedHead: relocatedNow.snapshot.revision }, signal);
        assert(!wrongHead.ok, "disposal accepted the live head for a retired copy");
        value(await registry.disposeKnownCopy(owner, { copyId: retired.copyId, replacementArchiveId: target.archiveId, expectedHead: retired.revision }, signal));
        assert(!existsSync(oldRoot) && existsSync(destination), "disposal removed the wrong location or kept the retired one");
        const afterDisposal = value(await registry.knownCopies(owner, target.archiveId, signal));
        assert(afterDisposal.find(c => c.copyId === retired.copyId)?.state === "disposed", "disposed copy not reported as disposed");
        checks.push("relocation retains one inventoried retired primary, refuses a head mismatch, disposes only that exact copy and keeps the live root");
        const networkMaintenance = createArchiveMaintenance({ registry, kernel, handles, hostWorld: "host", quarantineRoot: join(base, "network-quarantine"), verifyApproval: async () => true, proveStopped: async () => true, network: networkTransport(relocatedNow.root) });
        const rh = value(await handles.choose(owner, { kind: "replica", path: join(base, "remote-endpoint"), world: "loopback" }, signal));
        const replica = value(await networkMaintenance.replicas.configure(owner, target.archiveId, { destinationHandle: rh.handle, credentialHandle: "native:loopback", expectedIdentity: "loopback-remote" }, signal));
        const live = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot.revision)));
        value(await networkMaintenance.replicas.push(owner, target.archiveId, replica.id, live, signal));
        assert(server.remoteHead() === live, "network replica push did not CAS publish over git://");
        server.advance();
        const conflict = await networkMaintenance.replicas.push(owner, target.archiveId, replica.id, live, signal);
        assert(!conflict.ok && conflict.error.code === "remote_conflict", "network replica overwrote a divergent remote");
        const fetched = value(await networkMaintenance.replicas.fetch(owner, target.archiveId, replica.id, server.remoteHead()!, signal));
        assert(fetched.readOnly && fetched.head === server.remoteHead(), "network fetch was not an isolated verified candidate");
        assert(value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot.revision))) === live, "network fetch moved the primary ref");
        remoteAllowed = false;
        const deniedNetwork = await networkMaintenance.replicas.push(owner, target.archiveId, replica.id, live, signal);
        assert(!deniedNetwork.ok && deniedNetwork.error.code === "not_authorized", "network push ignored native authorization");
        remoteAllowed = true;
        checks.push("real loopback git:// replica: CAS push, conflict refused, isolated fetch, native authorization revocation; no auto-merge");
        let purgeRevision = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        for (const grant of purgeRevision.policy.grants) {
            value(await registry.admin(owner, { action: "revoke", project_id: target.projectId, expected_revision: purgeRevision.revision, operation_id: `purge-revoke-${grant.id}`, payload: { grant_id: grant.id, reason: "purge acceptance" } }, signal));
            purgeRevision = value(await registry.withOwner(owner, target.archiveId, signal, async (l) => success(l.snapshot)));
        }
        const backupPath = join(base, "purge-backup");
        const bh = value(await handles.choose(owner, { kind: "destination", path: backupPath, world: "host" }, signal));
        value(await maintenance.history.backup(owner, target.archiveId, purgeRevision.revision, bh.handle, signal));
        const backup = value(await handles.choose(owner, { kind: "backup", path: backupPath, world: "host" }, signal));
        const sensitive = digestBytes(Buffer.from("alpha\n"));
        const plan = value(await maintenance.plans.preview(owner, target.archiveId, { kind: "purge", backupHandle: backup.handle, reason: "owner purge approval", contentDigests: [sensitive] }, signal));
        assert(plan.knownLocalCopies.length >= 1 && plan.unconfirmedExternalCopies, "purge preview hid known or unconfirmed copies");
        const purgeRequest: AdminEnvelope = { action: "maintain", project_id: target.projectId, expected_revision: purgeRevision.revision, operation_id: "purge", payload: { plan_ref: plan.plan_ref, approval_ref: { approval_id: "fixture-approval" } } };
        const purged = value(await maintenance.execute(owner, purgeRequest, signal)) as { archiveId: string; localCopies?: readonly { state: string }[] };
        assert(purged.archiveId !== target.archiveId, "purge reused the purged identity");
        assert((purged.localCopies ?? []).every(c => c.state === "disposed" || c.state === "missing"), "purge left a known local copy unaccounted");
        const purgedState = value(await registry.withOwner(owner, purged.archiveId, signal, async (l) => success(l.snapshot)));
        assert(purgedState.policy.grants.length === 0 && purgedState.policy.paused, "purged archive resumed with authority");
        assert(!(await registry.withOwner(owner, target.archiveId, signal, async () => success({}))).ok, "purged identity remained reachable");
        checks.push("approved purge dispositions known local copies, allocates a new paused identity with no grants, and retires the old one");
        const replay = value(await maintenance.execute(owner, purgeRequest, signal)) as { reconciled?: boolean; archiveId: string };
        assert(replay.reconciled === true && replay.archiveId === purged.archiveId, "destructive replay lost its receipt after relocation/purge");
        checks.push("destructive receipt replay stays bound to the original project scope");
        return { status: "PASS", base, checks, networkRemote: server.url };
    }
    finally {
        server.stop();
        registry.dispose();
        kernel.dispose();
        handles.dispose();
    }
}
/** A real git daemon on loopback serving one bare repository, both inside the fixture. */
function loopbackDaemon(base: string) {
    const served = join(base, "served.git");
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const run = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf8", env });
    run(["init", "--bare", "--quiet", served]);
    run(["config", "--file", join(served, "config"), "daemon.receivepack", "true"]);
    const port = 19600 + Math.floor(Math.random() * 300);
    const daemon = spawn("git", ["daemon", "--reuseaddr", "--base-path=" + base, "--export-all", "--enable=receive-pack", "--listen=127.0.0.1", "--port=" + String(port), "--log-destination=stderr"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    daemon.stderr?.setEncoding("utf8");
    daemon.stderr?.on("data", chunk => { log += String(chunk); });
    const url = "git://127.0.0.1:" + String(port) + "/served.git";
    const remoteHead = (): string | null => {
        const result = run(["ls-remote", "--refs", url, "refs/ensemble/main"]);
        if (result.status !== 0) throw new Error("cannot read loopback remote: " + result.stderr);
        const match = /^([0-9a-f]{40})\t/.exec(result.stdout);
        return match ? match[1]! : null;
    };
    const ready = spawnSync("node", ["-e", "const net=require('net');const s=net.connect(" + String(port) + ",'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));"]);
    if (ready.status !== 0) throw new Error("loopback git daemon did not start: " + log.slice(0, 500));
    return {
        url,
        remoteHead,
        advance() {
            const inside = (args: string[], input?: string) => spawnSync("git", ["--git-dir", served, ...args], { encoding: "utf8", env, ...(input === undefined ? {} : { input }) });
            const tree = inside(["mktree"], "").stdout.trim();
            if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error("cannot create divergent tree in the loopback remote");
            const head = remoteHead();
            const created = inside(["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "fixture divergent"]);
            if (created.status !== 0) throw new Error("cannot create divergent commit: " + created.stderr);
            const update = inside(["update-ref", "refs/ensemble/main", created.stdout.trim()]);
            if (update.status !== 0) throw new Error("cannot advance loopback remote: " + update.stderr);
        },
        stop() { daemon.kill("SIGTERM"); rmSync(join(base, "served.git"), { recursive: true, force: true }); },
    };
}

/**
 * Live maintenance acceptance against the *installed packaged product*.
 *
 * `--install-dir` is a read-only supported DSH install; the product itself is
 * installed from the tarball that `make pack` produced, into a throwaway
 * DSH_HOME, with the standard `dsh plugin --profile web add`. Then:
 *
 *   1. the Host boots and the product proves its authenticated owner Remote;
 *   2. `maintenance/live-acceptance.mjs` drives the whole maintenance lifecycle
 *      over that Remote with the package's own client transport;
 *   3. this wrapper reports the exact exit codes and the tarball digest.
 *
 *   bun scripts/verify-dsh-maintenance.ts --live --install-dir <isolated DSH install> [--tarball <tgz>]
 *
 * Without `--live` the older in-process gate runs (its own fixture kernels).
 * `--live` needs Node (the packaged CLI and Host are Node programs) and never
 * touches a live profile.
 */

export interface LiveResult {
  readonly installDir: string;
  readonly tarball: string;
  readonly tarballSha256: string;
  readonly home: string;
  readonly installation: { code: number | null; log: string };
  readonly host: { code: number | null; log: string; handoff?: unknown };
  readonly driver: { code: number | null; log: string; result?: unknown };
  readonly status: "PASS" | "FAILED";
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; log: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout?.on("data", chunk => { log += String(chunk); });
    child.stderr?.on("data", chunk => { log += String(chunk); });
    child.on("error", error => { clearTimeout(timer); resolvePromise({ code: null, log: log + String(error) }); });
    child.on("exit", code => { clearTimeout(timer); resolvePromise({ code, log }); });
  });
}

export async function verifyMaintenanceLive(installDir: string, tarball: string): Promise<LiveResult> {
  const install = resolve(installDir);
  const pack = resolve(tarball);
  if (!existsSync(join(install, "node_modules/@deepseek-ai/dsh/package.json"))) throw new Error(`${install} is not an isolated DSH install`);
  if (!existsSync(pack)) throw new Error(`${pack} does not exist; run the pack target first`);
  const tarballSha256 = createHash("sha256").update(readFileSync(pack)).digest("hex");
  const home = mkdtempSync("/var/tmp/ensemble-live-");
  const temporary = join(home, "tmp");
  // The Host composes its own `source` directory when it boots, so the fixture
  // bytes are staged beside it and placed into that directory once it exists.
  const source = join(home, "source");
  const fixtureSource = join(home, "fixture-source");
  mkdirSync(temporary);
  mkdirSync(fixtureSource, { recursive: true });
  // A binary original with NUL/0xFF bytes so a text-only path would show up.
  writeFileSync(join(fixtureSource, "original.bin"), Buffer.from([0, 255, 254, 128, 13, 10, 65, 0]));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: join(home, "dsh-home"),
    PNPM_HOME: join(home, "pnpm"),
    TMPDIR: temporary,
    npm_config_cache: join(home, "npm-cache"),
    DSH_ENSEMBLE_ARCHIVE_ROOT: join(home, "archive"),
    DSH_ENSEMBLE_AUTHORITY_ID: "live-acceptance-host",
    DSH_ENSEMBLE_ARCHIVE_WORLD: "acceptance-host-world",
    DSH_ENSEMBLE_SOURCE_WORLD: "acceptance-host-world",
    ENSEMBLE_PRODUCT_RUNTIME: install,
    ENSEMBLE_PRODUCT_ROOT: home,
    ENSEMBLE_PRODUCT_SERVE: "1",
  };
  // The live driver must name the worlds the Host was told about, instead of
  // hard-coding them and disagreeing with the deployed configuration.
  const driverEnv = { ...env, ENSEMBLE_LIVE_HOST_WORLD: env.DSH_ENSEMBLE_ARCHIVE_WORLD!, ENSEMBLE_LIVE_SOURCE_WORLD: env.DSH_ENSEMBLE_SOURCE_WORLD! };
  const result: { -readonly [K in keyof LiveResult]: LiveResult[K] } = {
    installDir: install, tarball: pack, tarballSha256, home,
    installation: { code: null, log: "" }, host: { code: null, log: "" }, driver: { code: null, log: "" }, status: "FAILED",
  };
  let hostProcess: ReturnType<typeof spawn> | undefined;
  try {
    const installation = await run("node", [join(install, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "plugin", "--profile", "web", "add", pack, "--offline"], { cwd: home, env, timeoutMs: 300_000 });
    result.installation.code = installation.code;
    result.installation.log = installation.log;
    if (installation.code !== 0) return result;

    // Boot the installed product as a live Host. `live-serve.mjs` composes nothing
    // itself: it boots the published web profile, initializes the archive through the
    // authenticated owner Remote, and then keeps serving so this driver can exercise
    // the same endpoints a Client or the packaged CLI uses.
    hostProcess = spawn("node", [resolve("adapters/dsh/maintenance/live-serve.mjs")], {
      cwd: home,
      env: {
        ...env,
        ENSEMBLE_LIVE_PACKAGE_ROOT: join(env.DSH_HOME!, "profiles/web/node_modules/dsh-ensemble"),
        ENSEMBLE_LIVE_RUNTIME: install,
        ENSEMBLE_LIVE_HANDOFF: join(home, "connection.json"),
        ENSEMBLE_LIVE_SOURCE: source,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let hostLog = "";
    hostProcess.stdout?.setEncoding("utf8");
    hostProcess.stderr?.setEncoding("utf8");
    hostProcess.stdout?.on("data", chunk => { hostLog += String(chunk); });
    hostProcess.stderr?.on("data", chunk => { hostLog += String(chunk); });
    const handoffPath = join(home, "connection.json");
    const deadline = Date.now() + 180_000;
    while (!existsSync(handoffPath)) {
      if (Date.now() > deadline) throw new Error(`Host did not publish a handoff: ${hostLog.slice(-2000)}`);
      if (hostProcess.exitCode !== null && hostProcess.exitCode !== undefined) throw new Error(`Host exited ${hostProcess.exitCode}: ${hostLog.slice(-2000)}`);
      await new Promise(wait => setTimeout(wait, 250));
    }
    result.host = { code: null, log: hostLog, handoff: JSON.parse(readFileSync(handoffPath, "utf8")) };
    if (!existsSync(source)) throw new Error(`the Host did not compose its source directory: ${source}`);
    for (const name of ["original.bin"]) writeFileSync(join(source, name), readFileSync(join(fixtureSource, name)));

    const driver = await run("node", [resolve("adapters/dsh/maintenance/live-acceptance.mjs")], {
      cwd: home,
      env: { ...driverEnv, ENSEMBLE_LIVE_HANDOFF: handoffPath, ENSEMBLE_LIVE_SOURCE: source, ENSEMBLE_LIVE_RESULT: join(home, "live-result.json") },
      timeoutMs: 300_000,
    });
    result.driver.code = driver.code;
    result.driver.log = driver.log;
    if (existsSync(join(home, "live-result.json"))) result.driver.result = JSON.parse(readFileSync(join(home, "live-result.json"), "utf8"));
    result.status = driver.code === 0 ? "PASS" : "FAILED";
    return result;
  } finally {
    if (hostProcess && hostProcess.exitCode === null) {
      hostProcess.kill("SIGTERM");
      await new Promise(wait => setTimeout(wait, 1500));
      if (hostProcess.exitCode === null) hostProcess.kill("SIGKILL");
    }
    // A live run writes a whole installed profile, an archive and its quarantines into
    // `home`. Remove it on every outcome, so repeated or failing runs cannot accumulate
    // hundreds of megabytes in /var/tmp. It is kept only when explicitly asked for, so a
    // failure can still be inspected.
    if (result.status === "PASS" || process.env.ENSEMBLE_KEEP_LIVE_HOME !== "1") {
      rmSync(home, { recursive: true, force: true });
    }
    else console.error(`kept live home for inspection: ${home}`);
  }
}


if (import.meta.main) {
    const args = process.argv.slice(2);
    const installIndex = args.indexOf("--install-dir");
    if (args.includes("--live")) {
        const tarballIndex = args.indexOf("--tarball");
        if (installIndex === -1 || !args[installIndex + 1]) {
            console.error("Usage: bun scripts/verify-dsh-maintenance.ts --live --install-dir <isolated DSH install> [--tarball <tgz>]");
            process.exitCode = 2;
        }
        else
            try {
                const outcome = await verifyMaintenanceLive(args[installIndex + 1]!, tarballIndex === -1 ? "build/pack/dsh/dsh-ensemble-1.0.0.tgz" : args[tarballIndex + 1]!);
                console.log(JSON.stringify(outcome, null, 2));
                process.exitCode = outcome.status === "PASS" ? 0 : 1;
            }
            catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
    }
    else {
        const pos = installIndex;
        if (pos === -1 || !args[pos + 1] || args.length !== 2) {
            console.error("Usage: bun scripts/verify-dsh-maintenance.ts --install-dir <isolated DSH install>");
            console.error("       bun scripts/verify-dsh-maintenance.ts --live --install-dir <isolated DSH install> [--tarball <tgz>]");
            process.exitCode = 2;
        }
        else
            try {
                console.log(JSON.stringify(await verifyMaintenance(args[pos + 1]!), null, 2));
            }
            catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
    }
}
