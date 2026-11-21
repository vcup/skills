import { describe, expect, test } from "bun:test";
import {
  isSatisfied,
  MAX_TIMER_DELAY_MS,
  narrowStopReason,
  normalizeArguments,
  projectResult,
  WaitArgumentError,
  type MemberStatus,
} from "./wait.ts";

describe("normalizeArguments", () => {
  test("defaults are change + any + no timeout", () => {
    expect(normalizeArguments({})).toEqual({
      targetNames: undefined,
      event: "change",
      condition: "any",
      timeoutMs: undefined,
    });
  });

  test("accepts explicit values and an explicit timeout", () => {
    expect(
      normalizeArguments({ agents: ["a", "b"], event: "idle", condition: "all", timeout_ms: 50 }),
    ).toEqual({ targetNames: ["a", "b"], event: "idle", condition: "all", timeoutMs: 50 });
  });

  test("accepts null timeout as unbounded", () => {
    expect(normalizeArguments({ timeout_ms: null })).toMatchObject({ timeoutMs: undefined });
  });

  test("rejects duplicate target names", () => {
    expect(() => normalizeArguments({ agents: ["b", "a", "b"] })).toThrow(/duplicate agent name: "b"/);
  });

  test("rejects an empty agents array (omit to mean every member)", () => {
    expect(() => normalizeArguments({ agents: [] })).toThrow(WaitArgumentError);
    expect(() => normalizeArguments({ agents: [] })).toThrow(/non-empty/);
  });

  test("rejects a bad event, condition, and timeout with stable codes", () => {
    expect(() => normalizeArguments({ event: "both" as never })).toThrowError("event must be");
    expect(() => normalizeArguments({ condition: "none" as never })).toThrowError("condition must be");
    expect(() => normalizeArguments({ timeout_ms: 0 })).toThrow(/timeout_ms/);
    expect(() => normalizeArguments({ timeout_ms: MAX_TIMER_DELAY_MS + 1 })).toThrow(/timeout_ms/);
    expect(() => normalizeArguments({ timeout_ms: 1.5 })).toThrow(/timeout_ms/);
  });

  test("rejects NUL and whitespace-only names", () => {
    expect(() => normalizeArguments({ agents: ["ok", "a\0b"] })).toThrow(/non-empty name/);
    expect(() => normalizeArguments({ agents: ["   "] })).toThrow(/non-empty name/);
  });
});

describe("narrowStopReason", () => {
  test("passes known reasons through", () => {
    for (const reason of ["completed", "aborted", "error", "max-tokens", "refusal"] as const) {
      expect(narrowStopReason(reason)).toBe(reason);
    }
  });

  test("an unknown backend-added reason fails closed to error", () => {
    expect(narrowStopReason("future-variant")).toBe("error");
  });
});

describe("isSatisfied — latched change, not live status", () => {
  const targets = ["a", "b"];

  test("empty targets never satisfy", () => {
    expect(isSatisfied("any", "change", [], new Set(), new Map())).toBe(false);
    expect(isSatisfied("all", "change", [], new Set(), new Map())).toBe(false);
  });

  test("change + any satisfies on the first latched change", () => {
    expect(isSatisfied("any", "change", targets, new Set(["a"]), new Map())).toBe(true);
    expect(isSatisfied("any", "change", targets, new Set(), new Map())).toBe(false);
  });

  test("change + all requires every target to be latched", () => {
    expect(isSatisfied("all", "change", targets, new Set(["a"]), new Map())).toBe(false);
    expect(isSatisfied("all", "change", targets, new Set(["a", "b"]), new Map())).toBe(true);
  });

  test("a member that changed then reverted still counts for all", () => {
    // A is latched as changed; its *latest* status is back to the baseline value.
    // This must NOT erase A from the change set.
    const latest = new Map<string, MemberStatus>([["a", "inactive"], ["b", "inactive"]]);
    expect(isSatisfied("all", "change", targets, new Set(["a", "b"]), latest)).toBe(true);
  });

  test("idle + all is satisfied once every target's latest is inactive", () => {
    const latest = new Map<string, MemberStatus>([["a", "inactive"], ["b", "inactive"]]);
    expect(isSatisfied("all", "idle", targets, new Set(), latest)).toBe(true);
    const running = new Map<string, MemberStatus>([["a", "inactive"], ["b", "running"]]);
    expect(isSatisfied("all", "idle", targets, new Set(), running)).toBe(false);
  });

  test("idle ignores the change set entirely", () => {
    const latest = new Map<string, MemberStatus>([["a", "inactive"], ["b", "inactive"]]);
    expect(isSatisfied("any", "idle", targets, new Set(), latest)).toBe(true);
  });
});

describe("projectResult", () => {
  const args = { condition: "any", event: "change" } as const;
  const targets = ["b", "a"];
  const changed = new Set(["a"]); // a changed, even though its latest reverted
  const latest = new Map<string, MemberStatus>([
    ["a", "inactive"], // reverted to baseline
    ["b", "inactive"],
  ]);
  const stopReasons = new Map<string, "completed">([["a", "completed"]]);

  test("a satisfied wait reports latched changed, not baseline-vs-latest", () => {
    const result = projectResult(args, targets, changed, latest, stopReasons, false);
    expect(result.timedOut).toBe(false);
    expect(result.satisfiedBy).toEqual(["a"]);
    expect(result.changed).toEqual(["a"]); // a is still reported as changed
    expect(result.members).toEqual([
      { name: "a", status: "inactive", stopReason: "completed" },
      { name: "b", status: "inactive" },
    ]);
  });

  test("a timed-out wait reports empty satisfiedBy but keeps latched changed", () => {
    const result = projectResult(args, targets, changed, latest, stopReasons, true);
    expect(result.timedOut).toBe(true);
    expect(result.satisfiedBy).toEqual([]);
    expect(result.changed).toEqual(["a"]);
  });
});
