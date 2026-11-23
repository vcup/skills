import { expect, test } from "bun:test";
import { createRecoveryMaintenance, type ActivationRequest } from "./recovery.ts";
import { success, type Actor } from "../../../modules/ensemble/contracts.ts";
const actor: Actor = { kind: "owner", ownerId: "o", hostAuthorityId: "h", channel: "authenticated-remote" };
const signal = new AbortController().signal;
const request: ActivationRequest = { operationId: "activate", expectedRevision: "a".repeat(40), candidateId: "candidate", mode: "lossy", source: { worldIdentity: "h", canonicalAddress: "/source", nativeWorkspaceRef: "workspace" }, grants: [{ subject: { kind: "session", sessionId: "new", rootSessionId: "root" }, rights: ["read", "open"], scope: { kind: "project" } }], approvalId: "approved", sourceStopEvidence: [], lossStatement: "Unknown last hour" };
function setup() { let activations = 0; let final = "a".repeat(40); let approved = true; const manager = createRecoveryMaintenance({ candidate: () => ({ root: "/quarantine", candidate: { id: "candidate", identity: { archiveId: "old", head: "a".repeat(40), format: "ensemble-archive/v2", renderer: "v2" }, refs: { "refs/ensemble/main": "a".repeat(40) }, readOnly: true, backupDigest: "d".repeat(64) } }), access: { approval: async () => approved, finalHead: async () => success({ archiveId: "old", head: final, stopped: true }), activate: async (_a, _id, _candidate, _root, r) => { activations++; expect(r.grants[0]?.subject).toEqual(request.grants[0]!.subject); return success({ archiveId: r.mode === "lossy" ? "new" : "old", projectId: "project", revision: "b".repeat(40), rebound: true, reauthorized: true }); } } }); return { manager, count: () => activations, stale: () => { final = "c".repeat(40); }, deny: () => { approved = false; } }; }
test("unknown latest never becomes writable as original identity", async () => { const f = setup(); const r = await f.manager.activate(actor, "old", { ...request, mode: "lossless" }, signal); expect(!r.ok && r.error.code).toBe("source_stop_required"); expect(f.count()).toBe(0); });
test("stale final-head proof rejects lossless even with approval", async () => { const f = setup(); f.stale(); const r = await f.manager.activate(actor, "old", { ...request, mode: "lossless", finalHeadEvidence: "proof", sourceStopEvidence: [{ kind: "reported", statement: "stopped", source_label: "owner", supporting_refs: [] }] }, signal); expect(!r.ok && r.error.code).toBe("restore_read_only"); expect(f.count()).toBe(0); });
test("lossy activation explicitly requires loss and fresh grants; old grants are never forwarded", async () => { const f = setup(); expect((await f.manager.activate(actor, "old", { ...request, lossStatement: "" }, signal)).ok).toBe(false); expect((await f.manager.activate(actor, "old", { ...request, grants: [] }, signal)).ok).toBe(false); const r = await f.manager.activate(actor, "old", request, signal); expect(r.ok && r.value.archiveId).toBe("new"); expect(f.count()).toBe(1); });
test("approval is verified against the candidate archive identity, not a project id", async () => {
    // The restore preview can only name the candidate's archive identity (a
    // lossy recovery has no project yet), so verification must use the same key
    // the owner approval was issued for; using a project id made every real
    // activation fail closed through the shipped Remote.
    const seen: { archiveId: string; action: string; digest: string }[] = [];
    const manager = createRecoveryMaintenance({
        candidate: () => ({ root: "/quarantine", candidate: { id: "candidate", identity: { archiveId: "old-archive", head: "a".repeat(40), format: "ensemble-archive/v2", renderer: "v2" }, refs: { "refs/ensemble/main": "a".repeat(40) }, readOnly: true, backupDigest: "d".repeat(64) } }),
        access: {
            approval: async (_a, archiveId, _id, action, digest) => { seen.push({ archiveId, action, digest }); return true; },
            finalHead: async () => success({ archiveId: "old-archive", head: "a".repeat(40), stopped: true }),
            activate: async () => success({ archiveId: "new-archive", projectId: "project", revision: "b".repeat(40), rebound: true, reauthorized: true }),
        },
    });
    expect((await manager.activate(actor, "some-project-id", request, signal)).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.archiveId).toBe("old-archive");
    expect(seen[0]!.action).toBe("activate_restore");
    expect(seen[0]!.digest).toBe("d".repeat(64));
});
test("owner approval revocation prevents activation", async () => { const f = setup(); f.deny(); expect((await f.manager.activate(actor, "old", request, signal)).ok).toBe(false); expect(f.count()).toBe(0); });
