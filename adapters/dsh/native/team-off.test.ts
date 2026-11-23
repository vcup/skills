/**
 * Agent Teams off must not look like a storage failure.
 *
 * A fresh `web` profile has Team mode disabled by default, and asking the task
 * board for its tasks throws `TEAM_DISABLED`. That error used to escape into the
 * registry's generic failure path, where an unrecognized throw becomes
 * `storage_unavailable` — so every `ensemble_work` command failed with a message
 * the user could not act on, even though the ensemble method is explicitly usable
 * without Team mode.
 *
 * These tests pin both halves of the fix: that one condition contributes *no* task
 * facts (so work proceeds, and a command citing a task ref fails on the precise
 * ref check), and that any other board failure still propagates rather than being
 * silently swallowed.
 */

import { expect, test } from "bun:test";
import { nativeFacts, type BridgeRuntime } from "./bridge.ts";
import type { NativeAgent } from "./identity.ts";

const root: NativeAgent = { id: "root", session: { id: "root" } };

/** A runtime whose task board is supplied per case. */
function runtimeWithTasks(tasks: BridgeRuntime<NativeAgent>["tasks"]): BridgeRuntime<NativeAgent> {
  return {
    rootOf: () => root,
    descendants: async () => [{ kind: "child", id: "member", path: "member", mode: "continuable" }],
    observe: async () => ({
      inheritedEventCount: 1,
      events: [
        { type: "subagent/descriptor", seq: 1, data: { mode: "continuable", agentProvider: "fixture", agentModel: "deterministic" } },
      ],
      release: () => {},
    }),
    tasks,
  };
}

const signal = AbortSignal.timeout(5_000);

test("a disabled Team board contributes no task facts, and is not a storage failure", async () => {
  const facts = await nativeFacts(runtimeWithTasks(() => {
    throw Object.assign(new Error("enable Agent Teams for this Session before using the task board"), { code: "TEAM_DISABLED" });
  }), root, signal);
  expect(facts.taskRefs).toEqual([]);
  // Members are still established from the same call: only task facts are absent.
  expect(facts.members.length).toBe(1);
});

test("any other task-board failure still propagates instead of being swallowed", async () => {
  const runtime = runtimeWithTasks(() => {
    throw Object.assign(new Error("board journal is corrupt"), { code: "TEAM_CORRUPT" });
  });
  await expect(nativeFacts(runtime, root, signal)).rejects.toThrow("board journal is corrupt");
});

test("a board that answers normally still contributes its verified task refs", async () => {
  const facts = await nativeFacts(runtimeWithTasks(() => [{ id: "task-1", revision: 3 }]), root, signal);
  expect(facts.taskRefs).toEqual([
    { kind: "native_task", root_session_id: "root", task_id: "task-1", task_revision: 3 },
  ]);
});
