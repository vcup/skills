import { expect, test } from "bun:test";
import { nativeFacts, type BridgeRuntime, type NativeEvent } from "./bridge.ts";
import type { NativeAgent } from "./identity.ts";
const root: NativeAgent = { id: "root", session: { id: "root" } };
function fixture(events: readonly NativeEvent[]) {
  let releases = 0;
  const runtime: BridgeRuntime<NativeAgent> = {
    rootOf: () => root,
    descendants: async () => [{ kind: "child", id: "member", path: "reviewer", mode: "continuable" }],
    observe: async () => ({ inheritedEventCount: 1, events, release: () => { releases++; } }),
    tasks: () => [{ id: "task-1", revision: 3 }],
  };
  return { runtime, releases: () => releases };
}
test("catalog descriptor proves created identity, prepared route alone is not actual use", async () => {
  const { runtime, releases } = fixture([
    { type: "subagent/descriptor", seq: 0, data: { mode: "continuable", agentProvider: "inherited" } },
    { type: "subagent/descriptor", seq: 1, data: { mode: "continuable", agentProvider: "created", agentModel: "m" } },
    { type: "request/header", seq: 2, data: { header: { config: { provider: "requested", model: "m" } } } },
  ]);
  const facts = await nativeFacts(runtime, root, new AbortController().signal);
  expect(facts.members[0]).toEqual({ sessionId: "member", rootSessionId: "root", name: "reviewer", contextMode: "fork", creationRef: { kind: "native_event", session_id: "member", event_seq: 1 } });
  expect(facts.routeObservations.map(route => route.stage)).toEqual(["created"]);
  expect(facts.taskRefs).toEqual([{ kind: "native_task", root_session_id: "root", task_id: "task-1", task_revision: 3 }]);
  expect(releases()).toBe(1);
});
test("actual route records only native source fields and does not expose prompts or infer effort", async () => {
  const { runtime } = fixture([
    { type: "subagent/descriptor", seq: 1, data: { mode: "continuable", agentProvider: "created", agentModel: "m" } },
    { type: "request/header", seq: 2, data: { header: { config: { provider: "actual", model: "m", reasoningEffort: "high" }, adapterDefaults: { reasoningEffort: true } } } },
    { type: "assistant/message", seq: 3, data: { message: { source: { kind: "model", provider: "actual", model: "m" }, content: [{ text: "private body" }] } } },
  ]);
  const facts = await nativeFacts(runtime, root, new AbortController().signal);
  expect(facts.routeObservations[1]).toEqual({ session_id: "member", stage: "actual", ref: { kind: "native_event", session_id: "member", event_seq: 3 }, provider: "actual", model: "m" });
  expect(JSON.stringify(facts)).not.toContain("private body");
});
test("unknown children cannot become members and ownership is rechecked after observation", async () => {
  const { runtime } = fixture([]);
  expect((await nativeFacts({ ...runtime, descendants: async () => [{ kind: "diagnostic", id: "bad" }] }, root, new AbortController().signal)).members).toEqual([]);
  let calls = 0;
  await expect(nativeFacts({ ...runtime, rootOf: () => ++calls === 1 ? root : { ...root } }, root, new AbortController().signal)).rejects.toThrow("ownership changed");
});
