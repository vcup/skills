import { describe, expect, test } from "bun:test";
import { executionWorld, nativeIdentity, type IdentityRuntime, type NativeAgent } from "./identity.ts";

function fixture() {
  const root: NativeAgent = { id: "root", session: { id: "root" } };
  const member: NativeAgent = { id: "member", session: { id: "member" } };
  const agents = new Map([[root.id, root], [member.id, member]]);
  const runtime: IdentityRuntime<NativeAgent> = {
    agents,
    subagents: { rootOf: () => root },
    workspaces: { list: () => [{ id: "workspace", path: "/source", sessionIds: [root.id] }] },
    workingDirectory: { get: () => "/source/member-subdir" },
    worldOf: () => "source-container",
  };
  return { root, member, agents, runtime };
}

describe("native authority", () => {
  test("member uses live tree ownership and registered Workspace, not current cwd", () => {
    const { runtime, member } = fixture();
    expect(nativeIdentity(runtime, member)).toEqual({ sessionId: "member", rootSessionId: "root", workspaceId: "workspace", workspaceAddress: "/source", worldIdentity: "source-container", currentDirectory: "/source/member-subdir" });
  });
  test("matching strings cannot impersonate the live Agent", () => {
    const { runtime, member } = fixture();
    expect(() => nativeIdentity(runtime, { ...member })).toThrow("exact live");
    expect(() => nativeIdentity(runtime, undefined)).toThrow("exact live");
  });
  test("unowned or disposed trees and ambiguous Workspace membership refuse", () => {
    const { runtime, member, agents } = fixture();
    expect(() => nativeIdentity({ ...runtime, subagents: { rootOf: () => { throw new Error("unowned"); } } }, member)).toThrow("current native tree owner");
    expect(() => nativeIdentity({ ...runtime, workspaces: { list: () => [] } }, member)).toThrow("exactly one");
    expect(() => nativeIdentity({ ...runtime, workspaces: { list: () => [{ id: "a", path: "/source", sessionIds: ["root"] }, { id: "b", path: "/source", sessionIds: ["root"] }] } }, member)).toThrow("exactly one");
    agents.delete("root");
    expect(() => nativeIdentity(runtime, member)).toThrow("no longer live");
  });
  test("an unknown source world fails before any archive access", () => {
    const { runtime, member } = fixture();
    expect(() => nativeIdentity({ ...runtime, worldOf: () => undefined }, member)).toThrow("deployment mapping");
  });
  test("world mappings require exact service identity and cannot be guessed from a path", () => {
    const fs = {}, subprocess = {};
    const world = executionWorld([{ identity: "container", services: [fs, subprocess] }], (services: object[]) => services);
    expect(world([fs, subprocess])).toBe("container");
    expect(world([{}, subprocess])).toBeUndefined();
    expect(world([])).toBeUndefined();
    expect(executionWorld([{ identity: "a", services: [fs] }, { identity: "b", services: [fs] }], (s: object[]) => s)([fs])).toBeUndefined();
  });
});
