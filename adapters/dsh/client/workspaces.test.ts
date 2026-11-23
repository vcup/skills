/**
 * The Client must offer a real Workspace selection instead of asking a user to
 * type an internal id, and must refuse to build a descriptor from anything but a
 * registry row. These tests exercise that interface with malformed rows, because
 * a row shaped wrongly must never become a selectable value.
 */

import { describe, expect, test } from "bun:test";
import { sourceDescriptor, workspaceChoices, type WorkspaceRegistry } from "./workspaces.ts";

const registry = (items: readonly unknown[]): WorkspaceRegistry => ({ list: { getSnapshot: () => ({ items }) } });
const row = (overrides: Record<string, unknown> = {}) => ({ workspaceId: "ws-1", path: "/work/source", title: "source", ...overrides });

describe("Workspace choices", () => {
  test("reports unavailable when the registry is not composed", () => {
    expect(workspaceChoices(undefined)).toEqual({ available: false, choices: [] });
    expect(workspaceChoices({} as WorkspaceRegistry)).toEqual({ available: false, choices: [] });
  });

  test("reads id, path and title in registry order", () => {
    const { available, choices } = workspaceChoices(registry([row(), row({ workspaceId: "ws-2", path: "/work/other", title: "other" })]));
    expect(available).toBe(true);
    expect(choices).toEqual([
      { workspace_id: "ws-1", title: "source", path: "/work/source" },
      { workspace_id: "ws-2", title: "other", path: "/work/other" },
    ]);
  });

  test("drops rows the Host could not have produced", () => {
    const { choices } = workspaceChoices(registry([
      row(), row({ workspaceId: "" }), row({ path: "" }), row({ workspaceId: 7 }), row({ path: null }), null, "row", [],
      row({ workspaceId: "ws-1", path: "/work/duplicate" }),
    ]));
    expect(choices).toHaveLength(1);
    expect(choices[0]?.workspace_id).toBe("ws-1");
  });

  test("falls back to the path as a title rather than rendering an empty row", () => {
    expect(workspaceChoices(registry([row({ title: "" })])).choices[0]?.title).toBe("/work/source");
  });

  test("a non-array snapshot is empty, not a crash", () => {
    expect(workspaceChoices({ list: { getSnapshot: () => ({ items: undefined }) } }).choices).toEqual([]);
  });
});

describe("Source descriptor", () => {
  test("takes both native facts from the selection and the world from configuration", () => {
    const descriptor = sourceDescriptor({ workspace_id: "ws-1", title: "source", path: "/work/source" }, "host");
    expect(descriptor).toEqual({ worldIdentity: "host", canonicalAddress: "/work/source", nativeWorkspaceRef: "ws-1" });
  });

  test("carries no extra fields that the Host's closed decoder would refuse", () => {
    expect(Object.keys(sourceDescriptor({ workspace_id: "w", title: "t", path: "/p" }, "w")).sort())
      .toEqual(["canonicalAddress", "nativeWorkspaceRef", "worldIdentity"]);
  });
});
