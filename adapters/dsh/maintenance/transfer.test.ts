import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocationHandles, localSourceReader, safeLogicalPath } from "./handles.ts";
import { createTransferMaintenance, type TransferLease } from "./transfer.ts";
import { failure, success, type Actor, type MutationPlan, type Receipt, type Result, type Snapshot } from "../../../modules/ensemble/contracts.ts";
const owner: Actor = { kind: "owner", ownerId: "o", hostAuthorityId: "h", channel: "authenticated-remote" };
const signal = new AbortController().signal;
function val<T>(r: Result<T>): T { if (!r.ok)
    throw new Error(JSON.stringify(r.error)); return r.value; }
async function setup() {
    const base = mkdtempSync(join(tmpdir(), "ensemble-transfer-"));
    const source = join(base, "source");
    mkdirSync(source);
    writeFileSync(join(source, "unknown.bin"), new Uint8Array([255, 0, 128, 10]));
    writeFileSync(join(source, "STATE.md"), "completed: true\nunknown: preserved\n[bad](missing.md)\n");
    writeFileSync(join(source, "state.md"), "different case");
    symlinkSync("/etc/passwd", join(source, "outside-link"));
    let allowed = true;
    let approved = true;
    let plan: MutationPlan | undefined;
    let count = 0;
    const receipts = new Map<string, Receipt>();
    const handles = createLocationHandles({ authorizeSelection: async (_a, r) => success({ world: r.world, path: r.path, check: async () => allowed, ...(r.kind === "source" && r.path !== undefined ? { reader: localSourceReader(r.path) } : {}) }) });
    const lease: TransferLease = { artifactBytes: 64 * 1024 * 1024, destinationAllowed: path => !path.startsWith(source), snapshot: async () => ({ sequence: 0 } as Snapshot), commit: async (p, r) => { const previous = receipts.get(r.operationId); if (previous)
            return success(previous); plan = p; count++; const result: Receipt = { status: "committed", operation_id: r.operationId, committed_revision: "a".repeat(40), head_revision: "a".repeat(40), sequence: 1, changed: p.upserts.map(o => ({ id: o.id, object_revision: 1 })), documents: p.views, result: p.result }; receipts.set(r.operationId, result); return success(result); }, files: async () => [{ path: "originals/unknown.bin", kind: "original", bytes: new Uint8Array([255, 0, 128, 10]) }, { path: "views/overview.md", kind: "generated", bytes: Buffer.from("overview") }] };
    const access = { withOwner: async <T>(actor: Actor, _id: string, _s: AbortSignal, run: (lease: TransferLease) => Promise<Result<T>>) => actor.kind === "owner" ? run(lease) : failure("not_authorized", "owner required"), approval: async () => approved };
    const manager = createTransferMaintenance({ handles, access, hostWorld: "host" });
    const sh = val(await handles.choose(owner, { kind: "source", path: source, world: "host" }, signal));
    return { base, source, handles, manager, sh, deny: () => { allowed = false; }, denyApproval: () => { approved = false; }, plan: () => plan, count: () => count };
}
describe("owner inventory, import and export", () => {
    test("complete binary/unknown/link inventory and atomic original plan, duplicate digest returns same receipt", async () => { const f = await setup(); const before = readFileSync(join(f.source, "unknown.bin")); const inventory = val(await f.manager.inventoryImport(owner, "a", f.sh.handle, [], 10000, signal)); expect(inventory.completeness).toBe("complete"); expect(inventory.entries).toHaveLength(4); expect(inventory.entries.find(e => e.path === "outside-link")?.link).toBe("/etc/passwd"); expect(inventory.entries.filter(e => e.export_path.startsWith("_collisions/"))).toHaveLength(1); const request = { inventoryId: inventory.id, acceptedExceptions: [], approvalId: "approval", expectedRevision: "a".repeat(40), operationId: "first" }; const first = val(await f.manager.commitImport(owner, "a", request, signal)); const again = val(await f.manager.commitImport(owner, "a", { ...request, operationId: "second" }, signal)); expect(again.committed_revision).toBe(first.committed_revision); expect(f.count()).toBe(1); const p = f.plan()!; expect(p.upserts.filter(o => o.kind === "artifact")).toHaveLength(5); expect(p.upserts.find(o => o.kind === "invocation")?.body.lifecycle).toBe("active"); expect(p.content.some(c => c.kind === "inline" && Buffer.from(c.bytes).equals(before))).toBe(true); expect(readFileSync(join(f.source, "unknown.bin"))).toEqual(before); expect(readdirSync(f.source)).toHaveLength(4); });
    test("member set or byte change rejects whole import with unchanged commit count", async () => { const f = await setup(); const inventory = val(await f.manager.inventoryImport(owner, "a", f.sh.handle, [], 10000, signal)); writeFileSync(join(f.source, "new"), "changed"); const r = await f.manager.commitImport(owner, "a", { inventoryId: inventory.id, acceptedExceptions: [], approvalId: "ok", expectedRevision: "a".repeat(40), operationId: "x" }, signal); expect(!r.ok && r.error.code).toBe("stale_inventory"); expect(f.count()).toBe(0); });
    test("overbudget is explicitly partial and requires exact owner-approved exceptions", async () => { const f = await setup(); const inventory = val(await f.manager.inventoryImport(owner, "a", f.sh.handle, [], 1, signal)); expect(inventory.completeness).toBe("partial"); const req = { inventoryId: inventory.id, acceptedExceptions: [], approvalId: "a", expectedRevision: "a".repeat(40), operationId: "x" }; expect((await f.manager.commitImport(owner, "a", req, signal)).ok).toBe(false); f.denyApproval(); expect((await f.manager.commitImport(owner, "a", { ...req, acceptedExceptions: inventory.exceptions }, signal)).ok).toBe(false); expect(f.count()).toBe(0); });
    test("handle actor/world/native revocation and traversal checks", async () => { const f = await setup(); expect((await f.handles.use({ ...owner, ownerId: "stranger" }, f.sh.handle, "source", signal)).ok).toBe(false); f.deny(); expect((await f.manager.inventoryImport(owner, "a", f.sh.handle, [], 100, signal)).ok).toBe(false); for (const path of ["/abs", "../escape", "a/../b", "C:/x", "a\\b", "a//b"]) {
        expect(safeLogicalPath(path)).toBe(false);
    } const scan = val(await localSourceReader(f.source).scan(["outside-link/secret"], 100, signal)); expect(scan.completeness).toBe("partial"); expect(scan.contents.size).toBe(0); });
    test("export distinguishes originals/views, checks digest and refuses existing destinations", async () => { const f = await setup(); const destination = join(f.base, "export"); const h = val(await f.handles.choose(owner, { kind: "destination", path: destination, world: "host" }, signal)); expect((await f.manager.exportRevision(owner, "a", "a".repeat(40), [], h.handle, signal)).ok).toBe(true); expect(readFileSync(join(destination, "originals/unknown.bin"))).toEqual(Buffer.from([255, 0, 128, 10])); const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")); expect(manifest.files.map((f: {
        kind: string;
    }) => f.kind)).toEqual(["original", "generated"]); const retry = await f.manager.exportRevision(owner, "a", "a".repeat(40), [], h.handle, signal); expect(!retry.ok && retry.error.code).toBe("destination_exists"); });
});
