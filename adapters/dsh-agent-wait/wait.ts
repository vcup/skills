/**
 * Pure wait semantics for the subagent-wait tool, dependency-free.
 *
 * Everything that can be decided without a live Cordis context lives here and
 * is unit-tested in this repository: argument normalization, the target-set
 * derivation contract, the change matcher, and the terminal-result projection.
 * The plugin glue in `index.ts` supplies the live observations and owns event
 * subscription/cancellation.
 *
 * The one deliberate omission here is any timer or event loop: this module only
 * decides "is this call satisfied by what we have latched so far". `index.ts`
 * blocks on a promise that is resolved by the first matching event, a timer, or
 * the caller's abort signal.
 *
 * @module adapters/dsh-agent-wait/wait
 */

import { TOOL_NAME } from "./meta.ts";

/** A member's live status, in the same vocabulary as the built-in `list_agents`. */
export type MemberStatus =
  | "running"
  | "inactive"
  | "corrupt"
  | "unsupported"
  | "unavailable";

/**
 * The stop-reason vocabulary of `@deepseek-ai/dsh-subagent`, narrowed to the
 * values a change event can actually carry. The seam declares the map
 * merge-extensible; a backend-added variant cannot be listed, so an unknown
 * reason is treated as `error` instead of being reported as success.
 */
export type SubagentStopReasonText =
  | "completed"
  | "aborted"
  | "error"
  | "max-tokens"
  | "refusal";

/** Argument shape accepted by the model-facing tool. */
export interface WaitArguments {
  /**
   * Full names (path from the tree root, e.g. `reviewer/checker`) or Session
   * ids of the subagents to wait on. Omit to wait on every visible subagent
   * (the caller and the root are always excluded). An empty array is an error:
   * the caller is never a valid target.
   */
  readonly agents?: readonly string[];
  /** `change` (default) or `idle`. */
  readonly event?: "change" | "idle";
  /** How the fixed target set must satisfy the event: `any` (default) or `all`. */
  readonly condition?: "any" | "all";
  /** Millisecond deadline; omit or `null` waits until satisfied or cancelled. */
  readonly timeout_ms?: number | null;
}

/** Normalized, validated arguments. */
export interface NormalizedWait {
  readonly targetNames: readonly string[] | undefined;
  readonly event: "change" | "idle";
  readonly condition: "any" | "all";
  readonly timeoutMs: number | undefined;
}

/** A caller error the tool renders as an explicit, model-readable failure. */
export class WaitArgumentError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "WaitArgumentError";
    this.code = code;
  }
}

/** The one reserved name that must never be a target of this tool. */
export const ROOT_NAME = "lead";

/** Upper bound for an explicit timeout: Node's largest un-clamped timer delay. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Upper bound for a safe target selection, matching a real tree's ceiling. */
export const MAX_TARGETS = 10_000;
/** Bound strings and rendered output without silently truncating an all wait. */
export const MAX_NAME_LENGTH = 1_024;
export const MAX_TOTAL_NAME_LENGTH = 65_536;
export const MAX_RESULT_BYTES = 1_048_576;
export const MAX_OBSERVED_AGENTS = 20_000;
export const MAX_DISCOVERY_ENTRIES = 50_000;
export const MAX_ACTIVE_WAITS = 64;

export function assertTargetBudget(names: readonly string[]): void {
  if (names.length > MAX_TARGETS || names.some(name => name.length > MAX_NAME_LENGTH)
      || names.reduce((total, name) => total + name.length, 0) > MAX_TOTAL_NAME_LENGTH) {
    throw new WaitArgumentError("wait selection exceeds the target/name budget; select fewer agents explicitly", "WAIT_RESOURCE_LIMIT");
  }
}

/**
 * Validate and normalize the model-facing arguments.
 *
 * Rules, all closed:
 * - `agents` entries must be non-empty strings without a `\0`; an empty array
 *   is rejected (omit `agents` to mean "every visible member").
 * - `event` must be `change` or `idle` (omitted means `change`).
 * - `condition` must be `any` or `all` (omitted means `any`).
 * - `timeout_ms` must be a positive safe integer no greater than
 *   {@link MAX_TIMER_DELAY_MS}, or `null`/absent for an unbounded wait.
 * @param args - raw parsed tool arguments.
 * @returns the normalized form.
 * @throws WaitArgumentError with a stable code on any violation.
 */
export function normalizeArguments(raw: unknown): NormalizedWait {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WaitArgumentError("wait arguments must be an object", "WAIT_INVALID_ARGUMENTS");
  }
  for (const key of Object.keys(raw)) {
    if (!["agents", "event", "condition", "timeout_ms"].includes(key)) {
      throw new WaitArgumentError("unknown wait argument; allowed: agents, event, condition, timeout_ms", "WAIT_INVALID_ARGUMENTS");
    }
  }
  const args = raw as WaitArguments;
  const event = args.event === undefined ? "change" : args.event;
  if (event !== "change" && event !== "idle") {
    throw new WaitArgumentError("event must be \"change\" or \"idle\"", "WAIT_INVALID_EVENT");
  }

  const condition = args.condition === undefined ? "any" : args.condition;
  if (condition !== "any" && condition !== "all") {
    throw new WaitArgumentError("condition must be \"any\" or \"all\"", "WAIT_INVALID_CONDITION");
  }

  let targetNames: readonly string[] | undefined;
  if (args.agents !== undefined) {
    if (!Array.isArray(args.agents) || args.agents.length === 0) {
      throw new WaitArgumentError(
        "agents must be a non-empty array of names, or omitted to wait on every visible member",
        "WAIT_INVALID_TARGETS",
      );
    }
    if (args.agents.length > MAX_TARGETS) {
      throw new WaitArgumentError(
        `agents may name at most ${MAX_TARGETS} members`,
        "WAIT_INVALID_TARGETS",
      );
    }
    const seen = new Set<string>();
    for (const name of args.agents) {
      if (typeof name !== "string" || name.trim() === "" || name.includes("\0")) {
        throw new WaitArgumentError(
          "agents entries must be non-empty name strings",
          "WAIT_INVALID_TARGETS",
        );
      }
      const key = name.trim();
      if (key.length > MAX_NAME_LENGTH) throw new WaitArgumentError("agent name exceeds the length budget", "WAIT_RESOURCE_LIMIT");
      if (seen.has(key)) {
        throw new WaitArgumentError(`duplicate agent name: ${JSON.stringify(key)}`, "WAIT_INVALID_TARGETS");
      }
      seen.add(key);
    }
    targetNames = [...seen];
    assertTargetBudget(targetNames);
  }

  let timeoutMs: number | undefined;
  if (args.timeout_ms !== undefined && args.timeout_ms !== null) {
    if (
      typeof args.timeout_ms !== "number"
      || !Number.isSafeInteger(args.timeout_ms)
      || args.timeout_ms <= 0
      || args.timeout_ms > MAX_TIMER_DELAY_MS
    ) {
      throw new WaitArgumentError(
        `timeout_ms must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}, or null/omitted to wait without a deadline`,
        "WAIT_INVALID_TIMEOUT",
      );
    }
    timeoutMs = args.timeout_ms;
  }

  return { targetNames, event, condition, timeoutMs };
}

/** One member of the final result. */
export interface WaitMemberResult {
  readonly name: string;
  readonly status: MemberStatus;
  /** Present when the wait observed this member's terminal `subagent/end`. */
  readonly stopReason?: SubagentStopReasonText;
}

/** The canonical value the tool returns. */
export interface WaitResult {
  readonly condition: "any" | "all";
  readonly event: "change" | "idle";
  readonly timedOut: boolean;
  /** Empty when `timedOut`; otherwise the members whose event satisfied the wait. */
  readonly satisfiedBy: string[];
  /** Names latched as changed at least once since the baseline, sorted. */
  readonly changed: string[];
  /** Every waited-on member and its latest observed status. */
  readonly members: WaitMemberResult[];
}

/**
 * Map an arbitrary stop reason to the narrow, renderable vocabulary. An
 * unknown (future, backend-added) reason must not read as success: it is
 * reported as `error`.
 */
export function narrowStopReason(value: string): SubagentStopReasonText {
  switch (value) {
    case "completed":
    case "aborted":
    case "error":
    case "max-tokens":
    case "refusal":
      return value;
    default:
      return "error";
  }
}

/**
 * Decide whether a call is satisfied by what has been latched so far.
 *
 * The distinction that matters here is between a *latched change* and the
 * *current status*:
 *
 * - `change`: a target satisfies once it has been latched into `changed` — it
 *   changed at least once since the baseline, even if its latest status has
 *   since reverted to the baseline value. `all` therefore completes when every
 *   target has changed at least once, never "when they all look different right
 *   now".
 * - `idle`: a target satisfies when its latest status is `inactive`
 *   (already-inactive at baseline satisfies immediately).
 *
 * An empty target set is never satisfied here; the caller turns that into an
 * explicit `EMPTY_SELECTION` failure before blocking.
 */
export function isSatisfied(
  condition: "any" | "all",
  event: "change" | "idle",
  targets: readonly string[],
  changed: ReadonlySet<string>,
  latest: ReadonlyMap<string, MemberStatus>,
): boolean {
  if (targets.length === 0) return false;
  const satisfied = (name: string): boolean =>
    event === "change" ? changed.has(name) : latest.get(name) === "inactive";
  return condition === "any"
    ? targets.some(satisfied)
    : targets.every(satisfied);
}

/**
 * Project the wait's settled observations into the bounded model-facing result.
 *
 * `satisfiedBy` reports the targets whose event satisfied the wait (in target
 * order, stable and deterministic). `changed` reports the latched change set,
 * sorted for determinism — it is *not* recomputed from baseline-vs-latest, so a
 * member that changed and then reverted is still reported as changed. `members`
 * reports every waited-on target with its latest status, sorted by name.
 */
export function projectResult(
  args: Pick<NormalizedWait, "condition" | "event">,
  targets: readonly string[],
  changed: ReadonlySet<string>,
  latest: ReadonlyMap<string, MemberStatus>,
  stopReasons: ReadonlyMap<string, SubagentStopReasonText>,
  timedOut: boolean,
): WaitResult {
  const sorted = [...targets].sort();
  const satisfiedBy = timedOut
    ? []
    : sorted.filter((name) =>
        args.event === "change" ? changed.has(name) : latest.get(name) === "inactive",
      );
  const changedList = sorted.filter((name) => changed.has(name));
  const members = sorted.map((name) => {
    const status = latest.get(name) ?? "unavailable";
    const stopReason = stopReasons.get(name);
    return stopReason === undefined ? { name, status } : { name, status, stopReason };
  });
  const result = {
    condition: args.condition,
    event: args.event,
    timedOut,
    satisfiedBy,
    changed: changedList,
    members,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RESULT_BYTES) {
    throw new WaitArgumentError("wait result exceeds the output budget; select fewer agents explicitly", "WAIT_RESOURCE_LIMIT");
  }
  return result;
}

/** The tool name this module's semantics describe. */
export const WAIT_TOOL = TOOL_NAME;
