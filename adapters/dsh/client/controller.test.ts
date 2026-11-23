import { describe, expect, test } from "bun:test";
import { WorkspaceController } from "./controller.ts";
import { decodePage, decodeProjects, type ArchiveRemote, type Fields, type WatchHandle } from "./protocol.ts";
import { decodeEnvironmentRequest } from "../environment/service.ts";
import { decodeAdminEnvelope, decodeQuery } from "../../../modules/ensemble/codec.ts";
import { formPayload, management } from "./management.ts";
const R1 = "a".repeat(40), R2 = "b".repeat(40);
const project = (id = "p", epoch = 1, revision = R1) => ({ project_id: id, title: `Project ${id}`, authorization_epoch: epoch, read_revision: revision, capabilities: Object.keys(management) });
const page = (items: Fields[] = [], extra: Fields = {}) => ({ ok: true, value: { project_id: "p", read_revision: R1, authorization_epoch: 1, items, completeness: "complete", ...extra } });
const owner = (projects: Fields[] = [project(), project("q")]) => ({ ok: true, value: { capabilities: ["initialize"], root_handles: ["default"], source_handles: [], destination_handles: [], current_owner: { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1" }, projects } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function stream(first: Fields) {
  let pending = deferred<IteratorResult<unknown>>(); let started = false; let ended = false;
  const handle: WatchHandle = { dispose() { ended = true; pending.resolve({ done: true, value: undefined }); }, [Symbol.asyncIterator]() { return { next() { if (ended) return Promise.resolve({ done: true as const, value: undefined }); if (!started) { started = true; return Promise.resolve({ done: false as const, value: { ok: true, value: first } }); } return pending.promise; } }; } };
  return { handle, push(frame: unknown) { const old = pending; pending = deferred(); old.resolve({ done: false, value: frame }); }, get ended() { return ended; } };
}
async function fixture(overrides: Partial<ArchiveRemote> = {}) {
  const calls: Fields[] = []; const watches: ReturnType<typeof stream>[] = [];
  const remote: ArchiveRemote = { projects: async () => owner(), query: async request => { calls.push(request); return page([{ id: "evidence", title: "Full evidence" }]); }, environment: async () => ({ ok: true, value: { read_revision: "e".repeat(40), desired_revision: "d".repeat(40), preferences: { roles: [] }, applications: [], native_targets: [] } }), approve: async () => ({ ok: true, value: { approval_id: "approval" } }), choose: async () => ({ ok: true, value: { handle: "chosen", kind: "root", world: "host", expires_at: 1000 } }), destinations: async () => ({ ok: true, value: [{ key: "mirror", identity: "git@mirror.example:archive" }] }), manage: async request => { calls.push(request); return { ok: true, value: { status: "committed", operation_id: request.operation_id, committed_revision: R2 } }; }, watch: request => { const watcher = stream(project(String(request.project_id))); watches.push(watcher); return watcher.handle; }, ...overrides };
  const controller = new WorkspaceController(remote, () => "op-1");
  await controller.connection(true); controller.select("p"); await Promise.resolve();
  return { controller, calls, watches };
}
describe("workspace authorization and snapshot lifetime", () => {
  test("empty authenticated owner inventory can initialize without inventing a project id", async () => {
    const { controller: c, calls } = await fixture({ projects: async () => owner([]) });
    expect(c.canManage("initialize")).toBe(true);
    c.prepare("initialize", { root_handle: "default", source_descriptor: { worldIdentity: "host", canonicalAddress: "/project", nativeWorkspaceRef: "workspace" }, initial_grants: [], limits: {} });
    expect(c.getSnapshot().preview?.request.expected_revision).toBe("absent");
    expect(c.getSnapshot().preview?.request.project_id).toBeUndefined();
    await c.submit(); expect(calls).toHaveLength(1); c.dispose();
  });
  test("form-generated grant is accepted by the real shared admin decoder", () => {
    const payload = formPayload("grant", { subject: JSON.stringify({ kind: "session", sessionId: "member", rootSessionId: "root" }), rights: "read, member-submit", scope: JSON.stringify({ kind: "project" }), reason: "Task contribution" });
    const request = { project_id: "p", action: "grant", expected_revision: R1, operation_id: "op", payload };
    expect(decodeAdminEnvelope(request).ok).toBe(true);
  });
  test("every rendered read request crosses the real shared query decoder", async () => {
    const { controller: c, calls } = await fixture();
    await c.read({ kind: "list", object_kind: "contribution", invocation_id: "invocation" });
    await c.read({ kind: "artifact", object_id: "artifact", object_revision: 1, content_mode: "bytes" });
    await c.read({ kind: "reading", domain_id: "domain", include_drafts: true });
    await c.read({ kind: "lessons", task_context: { task_types: ["review"], interface_versions: [], required_capabilities: [] }, status: "proposed" });
    await c.read({ kind: "history", object_id: "object" });
    expect(calls).toHaveLength(5); for (const request of calls) expect(decodeQuery(request).ok).toBe(true); c.dispose();
  });
  test("lists projects, pins a read, reviews and submits exact management input", async () => {
    const { controller: c, calls } = await fixture();
    await c.read({ kind: "list", object_kind: "artifact" });
    expect(c.getSnapshot().page?.items[0]?.title).toBe("Full evidence"); expect(calls[0]?.revision).toBe(R1);
    c.prepare("pause", { reason: "Maintenance" }); expect(c.getSnapshot().preview?.request.expected_revision).toBe(R1);
    await c.submit(); expect(calls[1]).toEqual({ project_id: "p", action: "pause", payload: { reason: "Maintenance" }, expected_revision: R1, operation_id: "op-1" }); c.dispose();
  });
  test("does not infer capability from a project title or owner label", async () => {
    const { controller: c, calls } = await fixture({ projects: async () => owner([{ ...project(), capabilities: [], title: "owner" }]) });
    c.prepare("grant", {}); await c.submit(); expect(calls).toHaveLength(0); expect(c.getSnapshot().preview).toBeUndefined(); c.dispose();
  });
  test("native and domain refusal envelopes both deny without leaking projects", async () => {
    for (const response of [{ ok: false, error: { code: "not_authorized", message: "Denied" } }, { ok: true, value: { ok: false, error: { status: "refused", code: "not_authorized", message: "Denied" } } }]) {
      const { controller: c } = await fixture({ projects: async () => response }); expect(c.getSnapshot().status).toBe("denied"); expect(c.getSnapshot().projects).toEqual([]); c.dispose();
    }
  });
  test("a late previous project response cannot replace the selected project's content", async () => {
    const old = deferred<unknown>(); const { controller: c } = await fixture({ query: () => old.promise });
    const read = c.read({ kind: "list", object_kind: "artifact" }); c.select("q"); old.resolve(page([{ title: "secret p" }])); await read;
    expect(c.getSnapshot().selected?.project_id).toBe("q"); expect(c.getSnapshot().page).toBeUndefined(); c.dispose();
  });
  test("last navigation wins even if the previous query returns later", async () => {
    const old = deferred<unknown>(); const { controller: c } = await fixture({ query: () => old.promise });
    const read = c.read({ kind: "list", object_kind: "artifact" }); c.navigate("lessons"); old.resolve(page([{ title: "stale" }])); await read;
    expect(c.getSnapshot().view).toBe("lessons"); expect(c.getSnapshot().page).toBeUndefined(); c.dispose();
  });
  test("disconnect clears caches and previews, disables writes and closes the stream", async () => {
    const { controller: c, calls, watches } = await fixture(); await c.read({ kind: "list", object_kind: "artifact" }); c.prepare("pause", { reason: "x" }); await c.connection(false); await c.submit();
    expect(c.getSnapshot().projects).toEqual([]); expect(c.getSnapshot().page).toBeUndefined(); expect(c.getSnapshot().preview).toBeUndefined(); expect(calls).toHaveLength(1); expect(watches[0]!.ended).toBe(true); c.dispose();
  });
  test("stream epoch invalidation clears a page before an in-flight response can restore it", async () => {
    const old = deferred<unknown>(); const { controller: c, watches } = await fixture({ query: () => old.promise });
    const read = c.read({ kind: "list", object_kind: "artifact" }); watches[0]!.push({ ok: true, value: project("p", 2) }); await Promise.resolve();
    old.resolve(page([{ title: "revoked" }])); await read; expect(c.getSnapshot().status).toBe("denied"); expect(c.getSnapshot().page).toBeUndefined(); c.dispose();
  });
  test("new head is a refresh notice, never a mixed snapshot", async () => {
    const { controller: c, watches } = await fixture(); await c.read({ kind: "list", object_kind: "artifact" }); watches[0]!.push({ ok: true, value: project("p", 1, R2) }); await Promise.resolve();
    expect(c.getSnapshot().newer_revision).toBe(R2); expect(c.getSnapshot().page?.read_revision).toBe(R1); c.dispose();
  });
  test("pagination resends the original revision, query and cursor", async () => {
    const calls: Fields[] = []; const { controller: c } = await fixture({ query: async request => { calls.push(request); return page([{ id: String(calls.length) }], calls.length === 1 ? { completeness: "partial", next_cursor: "cursor-one", partial_reason: "page limit" } : {}); } });
    await c.read({ kind: "list", object_kind: "artifact", page_size: 1 }); await c.read({ kind: "lessons", task_context: { task_types: [], interface_versions: [], required_capabilities: [] } }, true);
    expect(calls[1]).toEqual({ kind: "list", object_kind: "artifact", page_size: 1, project_id: "p", revision: R1, cursor: "cursor-one" }); expect(c.getSnapshot().page?.items).toHaveLength(2); c.dispose();
  });
  test("wrong snapshot or epoch cannot enter cache", async () => {
    // Each case is its own page builder: a union of partial objects would make the
    // fixture itself the thing under test.
    const cases: readonly (() => Fields)[] = [
      () => ({ read_revision: R2 }),
      () => ({ authorization_epoch: 2 }),
    ];
    for (const extra of cases) {
      const { controller: c } = await fixture({ query: async () => page([], extra()) }); await c.read({ kind: "list", object_kind: "artifact" }); expect(c.getSnapshot().page).toBeUndefined(); expect(c.getSnapshot().error).toBeDefined(); c.dispose();
    }
  });
  test("changed head expires management preview instead of rewriting its revision", async () => {
    let revision = R1; const { controller: c, calls } = await fixture({ projects: async () => owner([project("p", 1, revision)]) });
    c.prepare("pause", { reason: "x" }); revision = R2; await c.refreshProjects(); await c.submit(); expect(calls).toHaveLength(0); expect(c.getSnapshot().error?.code).toBe("preview_expired"); c.dispose();
  });
  test("an unknown write is recoverable through the receipt after the epoch moved", async () => {
    // The reviewer's exact RED: the manage answer is genuinely unknown, then the epoch moves
    // (post-commit), and the generic epoch guard clears the selection. The old receipt path
    // required `state.selected` to still match, so it could never run and the operation was
    // stranded as permanently uncertain. Recovery must revalidate current authority, read
    // the receipt for the SAME operation, and accept it — without a second write.
    let manageCalls = 0;
    const { controller: c, watches } = await fixture({
      manage: async () => { manageCalls += 1; throw new Error("transport lost"); },
      query: async request => {
        if (request.kind === "receipt") return { ok: true, value: { project_id: "p", read_revision: R2, authorization_epoch: 2, completeness: "complete", items: [{ operation_id: "op-1", status: "committed", committed_revision: R2 }] } };
        return page([{ id: "evidence", title: "Full evidence" }]);
      },
    });
    c.prepare("pause", { reason: "Maintenance" });
    await c.submit();
    expect(c.getSnapshot().uncertain_operation).toBe("op-1");
    // The archive advances to a new epoch (the commit landed, the confirmation was lost).
    watches[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    for (let turn = 0; turn < 50 && c.getSnapshot().status !== "denied"; turn += 1) await Promise.resolve();
    expect(c.getSnapshot().status).toBe("denied");
    // The key survives the denial: recovery must still be possible.
    expect(c.getSnapshot().uncertain_operation).toBe("op-1");
    await c.receipt();
    const state = c.getSnapshot();
    expect(state.uncertain_operation).toBeUndefined();
    expect(state.result?.status).toBe("committed");
    expect(state.recovery).toBe("settled");
    expect(manageCalls).toBe(1); // no second write
    c.dispose();
  });
  test("a receipt refused by current authority keeps the key and shows nothing protected", async () => {
    const { controller: c } = await fixture({
      manage: async () => { throw new Error("transport lost"); },
      query: async () => ({ ok: false, error: { code: "not_authorized", message: "Denied" } }),
    });
    c.prepare("pause", { reason: "Maintenance" });
    await c.submit();
    await c.receipt();
    const state = c.getSnapshot();
    expect(state.uncertain_operation).toBe("op-1"); // key retained for a later attempt
    expect(state.recovery).toBe("denied");
    expect(state.result).toBeUndefined();
    expect(state.page).toBeUndefined();
    c.dispose();
  });
  test("a foreign revocation during a pending write never shows protected data", async () => {
    // A genuine revocation means the project is no longer available to this owner. The
    // write's answer may still say "committed" — the commit is a fact — but the Client
    // must not present it as current, usable state. Arrival order alone is never used to
    // decide this: the watch and the RPC are independent channels, so the decision is made
    // by re-reading current authority, which here no longer lists the project.
    const pendingManage = deferred<unknown>();
    let revoked = false;
    const { controller: c, watches } = await fixture({
      manage: () => pendingManage.promise,
      projects: async () => revoked ? owner([project("q")]) : owner(),
    });
    c.prepare("pause", { reason: "Maintenance" });
    const submit = c.submit();
    // The epoch moves before the answer arrives (independent channels).
    watches[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    for (let turn = 0; turn < 50 && c.getSnapshot().status !== "denied"; turn += 1) await Promise.resolve();
    expect(c.getSnapshot().status).toBe("denied");
    revoked = true;
    pendingManage.resolve({ ok: true, value: { status: "committed", operation_id: "op-1", committed_revision: R2 } });
    await submit;
    const state = c.getSnapshot();
    // No protected content and no live selection: authority does not currently include it.
    expect(state.page).toBeUndefined();
    expect(state.selected).toBeUndefined();
    expect(state.watching).toBe(false);
    c.dispose();
  });
  test("switching to another project during a pending write discards its answer", async () => {
    const pendingManage = deferred<unknown>();
    const { controller: c } = await fixture({ manage: () => pendingManage.promise });
    c.prepare("pause", { reason: "Maintenance" });
    const submit = c.submit();
    c.select("q");
    pendingManage.resolve({ ok: true, value: { status: "committed", operation_id: "op-1", committed_revision: R2 } });
    await submit;
    expect(c.getSnapshot().result).toBeUndefined();
    expect(c.getSnapshot().selected?.project_id).toBe("q");
    c.dispose();
  });
  test("disposing during a pending write never publishes its answer", async () => {
    const pendingManage = deferred<unknown>();
    const { controller: c } = await fixture({ manage: () => pendingManage.promise });
    c.prepare("pause", { reason: "Maintenance" });
    const submit = c.submit();
    c.dispose();
    pendingManage.resolve({ ok: true, value: { status: "committed", operation_id: "op-1", committed_revision: R2 } });
    await submit;
    expect(c.getSnapshot().result).toBeUndefined();
  });
  test("two concurrent submits do not share the pending write", async () => {
    // The second preview must not inherit the first write's registration: if it could,
    // its own foreign epoch change would be excused as "ours".
    let call = 0;
    const gates = [deferred<unknown>(), deferred<unknown>()];
    const ids = ["op-1", "op-2"];
    const { controller: c } = await fixture({ manage: () => gates[call++]!.promise });
    c.prepare("pause", { reason: "first" });
    const first = c.submit();
    c.prepare("pause", { reason: "second" });
    const second = c.submit();
    gates[0]!.resolve({ ok: true, value: { status: "committed", operation_id: ids[0], committed_revision: R2 } });
    await first;
    gates[1]!.resolve({ ok: true, value: { status: "committed", operation_id: ids[1], committed_revision: R2 } });
    await second;
    // Each submit reported its own answer; the second did not silently reuse the first.
    expect(c.getSnapshot().uncertain_operation).toBeUndefined();
    c.dispose();
  });
  test("a committed write survives the epoch change its own write causes", async () => {
    // The real sequence, measured on a live Host: the manage call answers
    // {status:"committed"} while the archive's own watch reports the new authorization
    // epoch the write just created. That watch event invalidates cached state by design,
    // but it must not discard the confirmation of the write that caused it — otherwise a
    // successful owner write is reported to the user as "not confirmed" and the revision
    // it produced is thrown away.
    const committed = { ok: true, value: { status: "committed", operation_id: "op-1", committed_revision: R2 } };
    let watcher: ReturnType<typeof stream> | undefined;
    const { controller: c, watches } = await fixture({
      manage: async () => { watcher = watches[0]; return committed; },
    });
    c.prepare("pause", { reason: "Maintenance" });
    watcher = watches[0];
    const pending = c.submit();
    // The write's own effect: the archive reports a new epoch before submit resumes.
    watcher?.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await pending;
    const state = c.getSnapshot();
    expect(state.result).toEqual({ status: "committed", operation_id: "op-1", committed_revision: R2 });
    expect(state.uncertain_operation).toBeUndefined();
    c.dispose();
  });
  test("uncertain writes block repetition and retain their receipt key", async () => {
    const { controller: c } = await fixture({ manage: async () => { throw new Error("transport lost"); } }); c.prepare("pause", { reason: "x" }); await c.submit();
    expect(c.getSnapshot().uncertain_operation).toBe("op-1"); expect(c.canManage("pause")).toBe(false); await c.connection(false); expect(c.getSnapshot().uncertain_operation).toBe("op-1"); c.dispose();
  });
  test("receipt query carries no illegal revision field", async () => {
    const { controller: c, calls } = await fixture(); await c.read({ kind: "receipt", operation_id: "op" }); expect(calls[0]).toEqual({ kind: "receipt", project_id: "p", operation_id: "op" }); c.dispose();
  });
  test("unload discards every late response and releases the stream", async () => {
    const old = deferred<unknown>(); const { controller: c, watches } = await fixture({ query: () => old.promise }); const pending = c.read({ kind: "list", object_kind: "artifact" }); c.dispose(); old.resolve(page([{ title: "late" }])); await pending; expect(c.getSnapshot().page).toBeUndefined(); expect(watches[0]!.ended).toBe(true);
  });
});
describe("own-write epoch race across both arrival orders", () => {
  // These drive the real WorkspaceController against a deferred ArchiveRemote: the test
  // decides *when* each independent channel answers, so the arrival order is exact and
  // deterministic rather than a timing hope. No controller state is mirrored here.
  //
  // The watch models a real Host notification stream: its first frame reports the epoch the
  // archive is actually in now, not the epoch the page was rendered from.
  function harness() {
    const gates: ReturnType<typeof deferred<unknown>>[] = [];
    const watchers: ReturnType<typeof stream>[] = [];
    let reads = 0;
    let archived = false;
    // The watch frame must describe the project the caller is actually watching, at the
    // epoch that project is currently in — a Host reports exactly that, so a mismatch here
    // would be the fixture inventing a revocation.
    const card = (id: string) => id === "p" ? project("p", archived ? 2 : 1, archived ? R2 : R1) : project(id);
    return {
      gates,
      watchers,
      get reads() { return reads; },
      watch: (request: Fields) => { const watcher = stream(card(String(request.project_id))); watchers.push(watcher); return watcher.handle; },
      projects: async () => {
        reads += 1;
        if (reads === 1) return owner();
        const gate = deferred<unknown>();
        gates.push(gate);
        return gate.promise;
      },
      query: async () => page([{ id: "evidence", title: "evidence" }], archived ? { authorization_epoch: 2, read_revision: R2 } : {}),
      /** The write landed: the archive is now at the new epoch and revision. */
      landed: () => { archived = true; },
    };
  }

  /** Resolve each catalogue read the controller makes, in order, until `submit` finishes. */
  async function drive(submit: Promise<void>, h: ReturnType<typeof harness>, respond: (index: number) => unknown): Promise<void> {
    let handled = 0;
    let finished = false;
    const done = submit.then(() => { finished = true; });
    for (let turn = 0; turn < 200 && !finished; turn += 1) {
      while (handled < h.gates.length) { const gate = h.gates[handled]; handled += 1; gate.resolve(respond(handled - 1)); }
      await Promise.resolve();
    }
    await done;
  }
  async function until(predicate: () => boolean): Promise<void> {
    for (let turn = 0; turn < 50 && !predicate(); turn += 1) await Promise.resolve();
  }

  test("a watch reporting our committed revision while the refresh is in flight still revalidates access", async () => {
    // The RED measured on a live Host (one resume, operation 74d0fcee): the manage answer is
    // `committed`, and the archive's own watch reports the new epoch **while `submit` is
    // awaiting `refreshProjects({ownWrite})`**. That invalidation is properly attributed to
    // our write (same immutable revision the Host named) — but the old code decided "did the
    // epoch move before the answer?" *before* that await, so the commit was recorded and the
    // client stayed denied forever while the Host had already committed. Arrival order across
    // two independent channels must not decide the outcome.
    const h = harness();
    const { controller: c } = await fixture({ projects: h.projects, query: h.query, watch: h.watch });
    await c.read({ kind: "list", object_kind: "artifact" });
    c.prepare("resume", { reason: "Maintenance" });
    const submit = c.submit();
    await until(() => h.gates.length >= 1);
    expect(h.gates).toHaveLength(1); // submit is now inside refreshProjects({ownWrite:true})
    // Our own write's effect arrives on the other channel during that await.
    h.landed();
    h.watchers[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await until(() => c.getSnapshot().status === "denied");
    expect(c.getSnapshot().status).toBe("denied"); // protected content cleared first, always
    expect(c.getSnapshot().page).toBeUndefined();
    // The stale catalogue response lands; its generation is gone, so it publishes nothing.
    h.gates[0]!.resolve(owner([project("p", 2, R2)]));
    await drive(submit, h, () => owner([project("p", 2, R2)]));
    const state = c.getSnapshot();
    expect(h.reads).toBe(3); // initial, the stale one, and the revalidation the old code skipped
    expect(state.status).toBe("ready");
    expect(state.selected?.project_id).toBe("p");
    expect(state.selected?.authorization_epoch).toBe(2);
    expect(state.recovery).toBe("settled");
    expect(state.newer_revision).toBe(R2);
    expect(state.page).toBeUndefined(); // the old page was read under the old authority
    // The denial banner raised by the watch is stale once access is re-established. Leaving
    // it set renders "ready" and an `authorization_changed` alert at the same time.
    expect(state.error).toBeUndefined();
    expect(h.watchers).toHaveLength(2); // watching re-established under the new epoch
    await c.read({ kind: "list", object_kind: "artifact" }); // readable again under current authority
    expect(c.getSnapshot().page?.read_revision).toBe(R2);
    c.dispose();
  });

  test("a watch that arrives before the manage answer still settles, once", async () => {
    // The other arrival order: the Host's watch reports the epoch while the RPC is still
    // pending. That ordering already worked; it must keep working, without a second write or
    // a duplicate revalidation.
    const h = harness();
    const calls: Fields[] = [];
    const pending = deferred<unknown>();
    const { controller: c } = await fixture({
      projects: h.projects, query: h.query, watch: h.watch,
      manage: async request => { calls.push(request); return pending.promise; },
    });
    c.prepare("resume", { reason: "Maintenance" });
    const submit = c.submit();
    h.landed();
    h.watchers[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await until(() => c.getSnapshot().status === "denied");
    expect(c.getSnapshot().status).toBe("denied");
    pending.resolve({ ok: true, value: { status: "committed", operation_id: "op-1", committed_revision: R2 } });
    await drive(submit, h, () => owner([project("p", 2, R2)]));
    const state = c.getSnapshot();
    expect(h.reads).toBe(3); // initial, the post-write refresh, one revalidation — never a loop
    expect(state.status).toBe("ready");
    expect(state.selected?.authorization_epoch).toBe(2);
    expect(state.recovery).toBe("settled");
    expect(state.error).toBeUndefined(); // settled access must not keep the denial banner
    expect(calls).toHaveLength(1); // the write is never repeated to "confirm" it
    c.dispose();
  });

  test("a revalidation refused by current authority keeps the commit fact and shows nothing protected", async () => {
    const h = harness();
    const { controller: c } = await fixture({ projects: h.projects, query: h.query, watch: h.watch });
    await c.read({ kind: "list", object_kind: "artifact" });
    c.prepare("resume", { reason: "Maintenance" });
    const submit = c.submit();
    await until(() => h.gates.length >= 1);
    h.landed();
    h.watchers[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await until(() => c.getSnapshot().status === "denied");
    h.gates[0]!.resolve(owner([project("p", 2, R2)]));
    // The owner has genuinely lost this project in the meantime.
    await drive(submit, h, () => ({ ok: false, error: { code: "not_authorized", message: "Denied" } }));
    expect(h.reads).toBe(3); // the refusal is the answer to a real revalidation, not an assumption
    const state = c.getSnapshot();
    expect(state.status).toBe("denied");
    expect(state.selected).toBeUndefined();
    expect(state.page).toBeUndefined();
    expect(state.watching).toBe(false);
    // A refused revalidation must NOT look settled: the failure is reported, not cleared.
    expect(state.recovery).toBe("denied");
    expect(state.recoveryError?.code).toBe("not_authorized");
    // The commit is still a recorded Host fact; it is just not presented as current access.
    expect(state.result).toEqual({ status: "committed", operation_id: "op-1", committed_revision: R2 });
    c.dispose();
  });

  test("a project no longer listed by the revalidation is not resurrected from the stale selection", async () => {
    // The revalidation must ask about the operation's own project. If the project is gone
    // from the fresh catalogue, nothing protected may come back — even though the project id
    // is still in `uncertain_project`, and even if some other project is selected later.
    const h = harness();
    const { controller: c } = await fixture({ projects: h.projects, query: h.query, watch: h.watch });
    await c.read({ kind: "list", object_kind: "artifact" });
    c.prepare("resume", { reason: "Maintenance" });
    const submit = c.submit();
    await until(() => h.gates.length >= 1);
    h.landed();
    h.watchers[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await until(() => c.getSnapshot().status === "denied");
    h.gates[0]!.resolve(owner([project("p", 2, R2)]));
    await drive(submit, h, () => owner([project("q")])); // p is no longer authorised
    const state = c.getSnapshot();
    expect(state.selected).toBeUndefined();
    expect(state.page).toBeUndefined();
    expect(state.status).toBe("denied");
    expect(state.recovery).toBe("denied");
    c.dispose();
  });

  test("switching project during revalidation never restores the abandoned one", async () => {
    const h = harness();
    const { controller: c } = await fixture({ projects: h.projects, query: h.query, watch: h.watch });
    await c.read({ kind: "list", object_kind: "artifact" });
    c.prepare("resume", { reason: "Maintenance" });
    const submit = c.submit();
    await until(() => h.gates.length >= 1);
    h.landed();
    h.watchers[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await until(() => c.getSnapshot().status === "denied");
    h.gates[0]!.resolve(owner([project("p", 2, R2)]));
    await until(() => h.gates.length >= 2);
    expect(h.gates).toHaveLength(2); // the revalidation read is genuinely in flight
    // The user refreshes the catalogue themselves and picks another project. That bumps the
    // lifetime, so the revalidation still in flight is stale and must not restore `p`.
    const refresh = c.refreshProjects();
    await until(() => h.gates.length >= 3);
    h.gates[2]!.resolve(owner([project("p", 2, R2), project("q")]));
    await refresh;
    c.select("q");
    h.gates[1]!.resolve(owner([project("p", 2, R2)]));
    await submit;
    const state = c.getSnapshot();
    expect(state.selected?.project_id).toBe("q");
    expect(state.page).toBeUndefined();
    c.dispose();
  });

  test("unloading during revalidation never publishes its late answer", async () => {
    const h = harness();
    const { controller: c } = await fixture({ projects: h.projects, query: h.query, watch: h.watch });
    await c.read({ kind: "list", object_kind: "artifact" });
    c.prepare("resume", { reason: "Maintenance" });
    const submit = c.submit();
    await until(() => h.gates.length >= 1);
    h.landed();
    h.watchers[0]!.push({ ok: true, value: { project_id: "p", authorization_epoch: 2, read_revision: R2 } });
    await until(() => c.getSnapshot().status === "denied");
    h.gates[0]!.resolve(owner([project("p", 2, R2)]));
    await until(() => h.gates.length >= 2);
    expect(h.gates).toHaveLength(2); // the revalidation read is genuinely in flight
    c.dispose();
    h.gates[1]!.resolve(owner([project("p", 2, R2)]));
    await submit;
    const state = c.getSnapshot();
    expect(state.status).toBe("disconnected");
    expect(state.selected).toBeUndefined();
    expect(state.page).toBeUndefined();
    c.dispose();
  });
});

describe("repeating the current tab or project keeps the rendered context", () => {
  // The user-visible RED: a real pointer click on the tab that is already current calls
  // `navigate(view)` unconditionally (workspace.tsx), while the query effect only re-runs
  // when `project_id`/`view` change — so the click cleared `page`/`query` and bumped the
  // request token, and nothing ever re-issued the read. The same shape applies to re-selecting
  // the project that is already selected. Both are driven through the real controller here;
  // no controller state is mirrored.
  const repeats: readonly (readonly [string, (c: WorkspaceController) => void])[] = [
    ["tab", c => c.navigate("work")],
    ["project", c => c.select("p")],
  ];

  for (const [label, repeat] of repeats) {
    test(`repeating the current ${label} keeps the page and its query`, async () => {
      const { controller: c, calls } = await fixture();
      await c.read({ kind: "list", object_kind: "artifact" });
      const before = c.getSnapshot();
      expect(before.page).toBeDefined();
      repeat(c);
      const after = c.getSnapshot();
      expect(after.page).toBe(before.page);
      expect(after.query).toEqual(before.query);
      expect(after.loading).toBe(false);
      expect(calls).toHaveLength(1); // and it does not smuggle in a second read
      c.dispose();
    });

    test(`repeating the current ${label} does not cancel an in-flight read`, async () => {
      const gate = deferred<unknown>();
      const { controller: c } = await fixture({ query: () => gate.promise });
      const read = c.read({ kind: "list", object_kind: "artifact" });
      expect(c.getSnapshot().loading).toBe(true);
      repeat(c);
      // The request token must not move, or the answer below is discarded as stale.
      expect(c.getSnapshot().loading).toBe(true);
      gate.resolve(page([{ title: "arrived" }]));
      await read;
      expect(c.getSnapshot().page?.items[0]?.title).toBe("arrived");
      c.dispose();
    });
  }

  test("a genuinely different view still clears the page and cancels the in-flight read", async () => {
    // The guard must not turn navigation into a no-op in general.
    const gate = deferred<unknown>();
    const { controller: c } = await fixture({ query: () => gate.promise });
    const read = c.read({ kind: "list", object_kind: "artifact" });
    c.navigate("lessons");
    expect(c.getSnapshot().view).toBe("lessons");
    expect(c.getSnapshot().page).toBeUndefined();
    gate.resolve(page([{ title: "stale" }]));
    await read;
    expect(c.getSnapshot().page).toBeUndefined(); // superseded, never published
    c.dispose();
  });

  test("a genuinely different project still clears the page and cancels the in-flight read", async () => {
    const gate = deferred<unknown>();
    const { controller: c } = await fixture({ query: () => gate.promise });
    const read = c.read({ kind: "list", object_kind: "artifact" });
    c.select("q");
    expect(c.getSnapshot().selected?.project_id).toBe("q");
    expect(c.getSnapshot().page).toBeUndefined();
    gate.resolve(page([{ title: "stale" }]));
    await read;
    expect(c.getSnapshot().page).toBeUndefined();
    c.dispose();
  });

  test("repeating the current project does not churn the watch or the lifetime", async () => {
    // `select` bumped `lifetime` and stopped/restarted the watch even for the project that was
    // already selected. That churn is what made a repeat destructive: the fresh watch
    // re-reports the same epoch from scratch and the live subscription is torn down.
    const { controller: c, watches } = await fixture();
    await c.read({ kind: "list", object_kind: "artifact" });
    expect(watches).toHaveLength(1);
    c.select("p");
    expect(watches).toHaveLength(1); // no restart
    expect(watches[0]!.ended).toBe(false); // the live subscription was not torn down
    expect(c.getSnapshot().page).toBeDefined();
    c.dispose();
  });

});

describe("owner location selection shapes", () => {
  test("a replica selection carries the declared destination name and never a path", async () => {
    const calls: Fields[] = [];
    const { controller: c } = await fixture({ choose: async request => { calls.push(request); return { ok: true, value: { handle: "h", kind: "replica", world: "host", expires_at: 1 } }; } });
    await c.choose("replica", { world: "host", destinationKey: "primary" });
    expect(calls[0]).toEqual({ kind: "replica", world: "host", destinationKey: "primary" });
    expect("path" in (calls[0] ?? {})).toBe(false);
    c.dispose();
  });

  test("a filesystem selection carries the absolute path and never a destination name", async () => {
    const calls: Fields[] = [];
    const { controller: c } = await fixture({ choose: async request => { calls.push(request); return { ok: true, value: { handle: "h", kind: "source", world: "host", expires_at: 1 } }; } });
    await c.choose("source", { world: "host", path: "/work/source" });
    expect(calls[0]).toEqual({ kind: "source", world: "host", path: "/work/source" });
    expect("destinationKey" in (calls[0] ?? {})).toBe(false);
    c.dispose();
  });

  test("a replica with no destination is refused locally, without a request", async () => {
    const calls: Fields[] = [];
    const { controller: c } = await fixture({ choose: async request => { calls.push(request); return { ok: true, value: {} }; } });
    await c.choose("replica", { world: "host", path: "/looks/like/a/path" });
    expect(calls).toHaveLength(0);
    expect(c.getSnapshot().error?.code).toBe("invalid_input");
    c.dispose();
  });

  test("a filesystem selection with no path is refused locally, without a request", async () => {
    const calls: Fields[] = [];
    const { controller: c } = await fixture({ choose: async request => { calls.push(request); return { ok: true, value: {} }; } });
    await c.choose("source", { world: "host", destinationKey: "primary" });
    expect(calls).toHaveLength(0);
    expect(c.getSnapshot().error?.code).toBe("invalid_input");
    c.dispose();
  });
});

describe("a catalogue refresh is authority work, not selection work", () => {
  // The catalogue read establishes *authority* (owner + projects). Picking a project is a
  // selection change. Treating them as one lifetime is what stranded `status` in "loading"
  // and dropped a refusal that landed after the user picked a project. These drive the real
  // controller against a deferred catalogue: the test decides when each answer arrives.
  function gatedCatalogue() {
    const gates: ReturnType<typeof deferred<unknown>>[] = [];
    let reads = 0;
    return {
      gates,
      get reads() { return reads; },
      projects: async () => { reads += 1; if (reads === 1) return owner(); const gate = deferred<unknown>(); gates.push(gate); return gate.promise; },
    };
  }
  async function until(predicate: () => boolean): Promise<void> {
    for (let turn = 0; turn < 60 && !predicate(); turn += 1) await Promise.resolve();
  }

  test("selecting a project while the refresh is pending still finishes ready on that selection", async () => {
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const refresh = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    expect(c.getSnapshot().status).toBe("loading");
    // The user picks another project from the still-usable cached options.
    c.select("q");
    expect(c.getSnapshot().selected?.project_id).toBe("q");
    expect(c.getSnapshot().status).toBe("loading"); // still in flight, not decided yet
    cat.gates[0]!.resolve(owner());
    await refresh;
    const state = c.getSnapshot();
    expect(state.status).toBe("ready"); // never stranded in loading
    expect(state.selected?.project_id).toBe("q"); // the selection current when it arrived
    expect(state.projects).toHaveLength(2);
    expect(state.watching).toBe(true);
    c.dispose();
  });

  test("a refusal that lands after a selection change is still reported as denied", async () => {
    // Losing a 401 is not cosmetic: the authority answer must reach `denied` whatever the
    // user selected while it was in flight.
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const refresh = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    c.select("q");
    cat.gates[0]!.resolve({ ok: false, error: { code: "not_authorized", message: "Denied" } });
    await refresh;
    const state = c.getSnapshot();
    expect(state.status).toBe("denied");
    expect(state.projects).toEqual([]);
    expect(state.selected).toBeUndefined();
    expect(state.page).toBeUndefined();
    c.dispose();
  });

  test("the newest catalogue wins and an older answer never overwrites it", async () => {
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const first = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    const second = c.refreshProjects();
    await until(() => cat.gates.length >= 2);
    cat.gates[1]!.resolve(owner([project("p"), project("q"), project("r")]));
    await second;
    expect(c.getSnapshot().projects).toHaveLength(3);
    cat.gates[0]!.resolve(owner([project("p")])); // stale, superseded by the newer request
    await first;
    expect(c.getSnapshot().projects).toHaveLength(3);
    expect(c.getSnapshot().status).toBe("ready");
    c.dispose();
  });

  test("a late catalogue cannot restore state after a disconnect", async () => {
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const refresh = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    await c.connection(false);
    cat.gates[0]!.resolve(owner());
    await refresh;
    const state = c.getSnapshot();
    expect(state.status).toBe("disconnected");
    expect(state.projects).toEqual([]);
    expect(state.selected).toBeUndefined();
    c.dispose();
  });

  test("a late catalogue cannot restore state after a revocation", async () => {
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const refresh = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    c.invalidate(); // the watch reported an authority change
    cat.gates[0]!.resolve(owner());
    await refresh;
    const state = c.getSnapshot();
    expect(state.status).toBe("denied");
    expect(state.projects).toEqual([]);
    expect(state.selected).toBeUndefined();
    c.dispose();
  });

  test("a late catalogue cannot publish after disposal", async () => {
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const refresh = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    c.dispose();
    cat.gates[0]!.resolve(owner());
    await refresh;
    expect(c.getSnapshot().projects).toEqual([]);
  });

  test("refreshing without a selection change still behaves as before", async () => {
    // Control: the new fence must not break the plain path.
    const cat = gatedCatalogue();
    const { controller: c } = await fixture({ projects: cat.projects });
    const refresh = c.refreshProjects();
    await until(() => cat.gates.length >= 1);
    cat.gates[0]!.resolve(owner());
    await refresh;
    expect(c.getSnapshot().status).toBe("ready");
    expect(c.getSnapshot().selected?.project_id).toBe("p");
    c.dispose();
  });

  test("a selection change mid-refresh still cancels an unrelated in-flight read", async () => {
    // Selection semantics are unchanged: a rendered page belongs to the old selection.
    const gate = deferred<unknown>();
    const { controller: c } = await fixture({ query: () => gate.promise });
    const read = c.read({ kind: "list", object_kind: "artifact" });
    c.select("q");
    gate.resolve(page([{ title: "stale" }]));
    await read;
    expect(c.getSnapshot().page).toBeUndefined();
    c.dispose();
  });
});

describe("declared replica destinations", () => {
  test("an available list is published with its state", async () => {
    const { controller: c } = await fixture();
    await c.readDestinations();
    expect(c.getSnapshot().destinationsState).toBe("available");
    expect(c.getSnapshot().destinations).toEqual([{ key: "mirror", identity: "git@mirror.example:archive" }]);
    expect(c.getSnapshot().error).toBeUndefined();
    c.dispose();
  });

  test("storage_unavailable is a state, never an error banner", async () => {
    // The Host declaring no destinations is an answer, not a failure: an empty
    // picker with no explanation is what makes a user guess a key.
    const { controller: c } = await fixture({ destinations: async () => ({ ok: false, error: { status: "refused", code: "storage_unavailable", message: "this Host declares no network replica destinations", retryable: true } }) });
    await c.readDestinations();
    expect(c.getSnapshot().destinationsState).toBe("unconfigured");
    expect(c.getSnapshot().destinations).toEqual([]);
    expect(c.getSnapshot().error).toBeUndefined();
    c.dispose();
  });

  test("any other refusal is surfaced as an error and leaves the state unknown", async () => {
    const { controller: c } = await fixture({ destinations: async () => ({ ok: false, error: { status: "refused", code: "not_authorized", message: "owner only" } }) });
    await c.readDestinations();
    expect(c.getSnapshot().destinationsState).toBeUndefined();
    expect(c.getSnapshot().error?.code).toBe("not_authorized");
    c.dispose();
  });

  test("a row carrying anything but key/identity is refused", async () => {
    // A URL or credential reference in a browser payload is a deployment fact leak.
    const { controller: c } = await fixture({ destinations: async () => ({ ok: true, value: [{ key: "mirror", identity: "x", url: "https://leak.example" }] }) });
    await c.readDestinations();
    expect(c.getSnapshot().destinations).toBeUndefined();
    expect(c.getSnapshot().error?.code).toBe("invalid_response");
    c.dispose();
  });

  test("the read is not attempted while disconnected", async () => {
    const calls: number[] = [];
    const { controller: c } = await fixture({ destinations: async () => { calls.push(1); return { ok: true, value: [] }; } });
    await c.connection(false); await c.readDestinations();
    expect(calls).toHaveLength(0);
    c.dispose();
  });
});

describe("bounded wire and owner form decoding", () => {
  test("malformed, duplicate and oversized records are refused", () => {
    expect(() => decodeProjects({ projects: [project(), project()] })).toThrow();
    expect(() => decodeProjects({ projects: [{ ...project(), authorization_epoch: "1" }] })).toThrow();
    expect(() => decodePage({ read_revision: R1, authorization_epoch: 1, items: Array(101).fill({}), completeness: "complete" })).toThrow();
  });
  test("each journey has an explicit owner action and structured input is not guessed", () => {
    for (const action of ["initialize", "grant", "revoke", "takeover", "assign_reviewer", "pause", "resume", "inventory_import", "commit_import", "backup", "restore"] as const) expect(action in management).toBe(true);
    expect(formPayload("revoke", { grant_id: "g", reason: "expired" })).toEqual({ grant_id: "g", reason: "expired" });
    expect(() => formPayload("grant", { grant: "{broken", reason: "x" })).toThrow();
    expect(() => formPayload("inventory_import", { source_handle: "s", selection: "[]", budget: "NaN" })).toThrow();
  });
});

describe("independent environment ledger", () => {
  test("environment writes never borrow the selected archive revision", async () => {
    const { controller: c } = await fixture(); await c.readEnvironment();
    c.prepareEnvironment({ action: "environment_set", preferences: { roles: [] } });
    const request = c.getSnapshot().environmentPending!;
    expect(request.expected_revision).toBe("e".repeat(40)); expect(request.project_id).toBeUndefined(); expect(decodeEnvironmentRequest(request).ok).toBe(true); c.dispose();
  });
  test("environment responses are discarded after disconnect", async () => {
    const delayed = deferred<unknown>(); const { controller: c } = await fixture({ environment: () => delayed.promise });
    const read = c.readEnvironment(); await c.connection(false); delayed.resolve({ ok: true, value: { read_revision: "e".repeat(40), preferences: { roles: [] } } }); await read;
    expect(c.getSnapshot().environment).toBeUndefined(); expect(c.getSnapshot().environmentPending).toBeUndefined(); c.dispose();
  });
  test("an unknown environment outcome blocks a new write until reconciliation", async () => {
    const { controller: c } = await fixture({ environment: async () => { throw new Error("transport unavailable"); } });
    c.prepareEnvironment({ action: "environment_set", preferences: { roles: [] } }); await c.submitEnvironment();
    expect(c.getSnapshot().environmentUncertain).toBe("op-1"); c.prepareEnvironment({ action: "environment_set", preferences: { roles: [] } });
    expect(c.getSnapshot().error?.code).toBe("outcome_unknown"); c.dispose();
  });
});
