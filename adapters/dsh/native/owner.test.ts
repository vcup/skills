import { expect, test } from "bun:test";
import { createProductOwner, type OwnerProductDeps } from "./owner.ts";
import { success, type Actor, type OwnerContext } from "../../../modules/ensemble/contracts.ts";
const authenticated = { peer: { principal: { kind: "owner" } } };
function fixture() {
  let epoch = 1;
  let listener: (() => void) | undefined;
  let subscriptions = 0;
  let calls = 0;
  const value = (actor: Actor): OwnerContext => ({ capabilities: ["initialize"], root_handles: [], source_handles: [], destination_handles: [], current_owner: actor.kind === "owner" ? { kind: "owner", ownerId: actor.ownerId, hostAuthorityId: actor.hostAuthorityId } : (() => { throw new Error("fixture is owner-only"); })(), projects: [{ project_id: "p", title: "project", read_revision: "a".repeat(40), authorization_epoch: epoch, capabilities: ["read", "grant"] }] });
  const deps: OwnerProductDeps = {
    hostAuthorityId: "deployment", ownerId: "owner", authorizationRefreshMs: 60000,
    projects: async (actor) => { calls++; return success(value(actor)); },
    query: async (actor, query) => { calls++; return success({ actor, query }); },
    manage: async (actor, command) => { calls++; return success({ actor, command }); },
    choose: async () => { calls++; return success({ handle: "opaque" }); },
    approve: async () => success({ approval_id: "opaque" }),
    subscribe: next => { listener = next; subscriptions++; return () => { subscriptions--; }; },
  };
  return { owner: createProductOwner(deps), calls: () => calls, subscriptions: () => subscriptions, revoke: () => { epoch++; listener?.(); } };
}
test("management refuses missing Remote and asserted identities before executor access", async () => {
  const { owner, calls } = fixture();
  const signal = new AbortController().signal;
  expect(await owner.projects({}, undefined, signal)).toMatchObject({ ok: false, error: { code: "not_authorized" } });
  expect(await owner.query({ kind: "context", owner: true }, authenticated, signal)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(await owner.manage({ action: "pause", payload: { reason: "review" }, expected_revision: "a".repeat(40), operation_id: "pause", project_id: "p", actor: { kind: "owner" } }, authenticated, signal)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(calls()).toBe(0);
});
test("authenticated management constructs authority outside the request", async () => {
  const { owner } = fixture();
  expect(await owner.manage({ action: "pause", payload: { reason: "review" }, expected_revision: "a".repeat(40), operation_id: "pause", project_id: "p" }, authenticated, new AbortController().signal)).toMatchObject({ ok: true, value: { actor: { kind: "owner", ownerId: "owner", hostAuthorityId: "deployment", channel: "authenticated-remote" }, command: { action: "pause" } } });
});
test("authorization stream sends current snapshot, observes commits, releases subscriptions on cancellation", async () => {
  const { owner, subscriptions, revoke } = fixture();
  const abort = new AbortController();
  const stream = owner.watch({ project_id: "p" }, authenticated, abort.signal);
  expect((await stream.next()).value).toMatchObject({ project_id: "p", authorization_epoch: 1 });
  expect(subscriptions()).toBe(1);
  const next = stream.next();
  revoke();
  expect((await next).value).toMatchObject({ authorization_epoch: 2 });
  const ended = stream.next();
  abort.abort();
  expect((await ended).done).toBe(true);
  expect(subscriptions()).toBe(0);
});

test("the owner context states the verified owner, and a request cannot assert a different one", async () => {
  const { owner } = fixture();
  const signal = new AbortController().signal;

  // The subject comes from the authenticated invocation, so it equals the owner the
  // deployment configured — not anything the caller sent.
  const plain = await owner.projects({}, authenticated, signal) as { ok: boolean; value?: OwnerContext };
  expect(plain.ok).toBe(true);
  expect(plain.value?.current_owner).toEqual({ kind: "owner", ownerId: "owner", hostAuthorityId: "deployment" });

  // A body that tries to mint a subject is refused by the closed request shape, and
  // never reaches the executor. This is the spoofing path that would let a caller
  // build a grant for an identity it invented.
  const spoofed = await owner.projects({ current_owner: { kind: "owner", ownerId: "attacker", hostAuthorityId: "attacker-host" } }, authenticated, signal) as { ok: boolean; error?: { code?: string } };
  expect(spoofed.ok).toBe(false);
  expect(spoofed.error?.code).toBe("invalid_input");
});

test("a non-owner principal cannot obtain an owner subject at all", async () => {
  const { owner, calls } = fixture();
  const signal = new AbortController().signal;
  for (const invocation of [undefined, { peer: { principal: { kind: "user" } } }, { peer: {} }, { peer: { principal: { kind: "session" } } }]) {
    const refused = await owner.projects({}, invocation as never, signal) as { ok: boolean; error?: { code?: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("not_authorized");
  }
  // Nothing reached the executor, so no context was ever built for a non-owner.
  expect(calls()).toBe(0);
});
