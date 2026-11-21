/**
 * DSH subagent-wait plugin — an unbounded, native wait over subagent lifecycle.
 *
 * The plugin registers one model-facing tool, `wait_subagents`, which blocks the
 * calling tool execution until a change in the caller's own subagent tree
 * satisfies the request, a caller-supplied deadline elapses, or the caller's
 * `exec.signal` aborts. The wait is implemented with real Cordis event
 * subscriptions (`subagent/start`, `subagent/end`, `agent/status`,
 * `agent/disposed`) plus an optional timer — never a busy loop.
 *
 * The observers are attached **before** tree discovery and latch changes by
 * Session id, so a subagent that changes while `listDescendants` is still
 * awaiting is not lost: its transition is already latched by the time the
 * target set is fixed, and is replayed into the name-keyed result. The first
 * observation of a member establishes its baseline (a member whose id is
 * unknown until discovery cannot have an earlier reading); a later observation
 * with a different status latches a change. Same-status repeats do not latch
 * another change.
 *
 * It is deliberately independent of the ensemble probe: a separate package,
 * separate pack script, and its own manifest, so the two capabilities cannot
 * tangle their lifecycles. It does not swallow or suppress any upstream
 * notification; it only observes the same public lifecycle edges the built-in
 * `list_agents`/`wait_agent` control plugins already read.
 *
 * Only this module imports `@deepseek-ai/*`; the semantics and argument
 * validation live in the dependency-free siblings `wait.ts` and `meta.ts`.
 *
 * @module adapters/dsh-agent-wait
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {
  SubagentDescendantListEntry,
  SubagentRunEndInfo,
  SubagentRunInfo,
} from "@deepseek-ai/dsh-subagent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { INJECT, TOOL_NAME } from "./meta.ts";
import {
  isSatisfied,
  MAX_TIMER_DELAY_MS,
  narrowStopReason,
  normalizeArguments,
  projectResult,
  ROOT_NAME,
  WaitArgumentError,
  type MemberStatus,
  type NormalizedWait,
  type SubagentStopReasonText,
  type WaitResult,
} from "./wait.ts";

export const name = "agent-wait";
export const inject = INJECT;

/** A wait that ends because the plugin or the calling agent went away. */
class WaitUnavailableError extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "WAIT_UNAVAILABLE", options);
    this.name = "WaitUnavailableError";
  }
}

/** One live tree member as observed at snapshot time. */
interface LiveMember {
  readonly id: SessionId;
  /** Canonical model-facing name (tree path, or Session id for unnamed/diagnostic rows). */
  readonly name: string;
  readonly status: MemberStatus;
}

/** The caller's subagent tree, projected into the `list_agents` vocabulary. */
interface Observation {
  /** Every visible member name (root, continuable children, diagnostics), in catalog order. */
  readonly names: () => readonly string[];
  /**
   * Resolve a name OR Session id to its canonical member. The returned `name`
   * is always the canonical tree name, never the lookup key.
   */
  readonly memberOf: (key: string) => LiveMember | undefined;
  /** The Session id behind a canonical name. */
  readonly idOf: (name: string) => SessionId | undefined;
  /** Whether a canonical name is a corrupt/unavailable/unsupported catalog row. */
  readonly isDiagnosticOf: (name: string) => boolean;
  /** The caller's own model-facing name. */
  readonly callersName: string;
}

/** The wait shape `waitForChange` needs after argument normalization. */
type WaitRequest = Pick<NormalizedWait, "condition" | "event" | "timeoutMs">;

/**
 * Build the observation adapter from the caller's live subagent tree.
 *
 * This mirrors `list_agents`'s discovery (`rootOf` + `listDescendants`) plus
 * the live-status rule (`agents.get(id)?.status === "running" ? "running" :
 * "inactive"`), so the two tools agree on what "the caller's tree" means.
 *
 * A member may be addressed by its canonical tree name or by its Session id,
 * matching `send_message`/`list_agents`. The canonical name is stored separately
 * from the lookup key so a Session-id lookup still reports the real tree name
 * (and therefore self/root refusal cannot be bypassed with an id).
 */
async function observeTree(ctx: Context, caller: Agent, signal: AbortSignal): Promise<Observation> {
  const root = ctx.subagents.rootOf(caller);
  const entries = await ctx.subagents.listDescendants(root.id, signal);

  const byKey = new Map<string, SessionId>();
  const canonicalBySession = new Map<SessionId, string>();
  const diagnostics = new Set<string>();
  const memberNames: string[] = [];

  const liveStatus = (id: SessionId): MemberStatus =>
    ctx.agents.get(id)?.status === "running" ? "running" : "inactive";

  const memberOf = (key: string): LiveMember | undefined => {
    const id = byKey.get(key);
    if (id === undefined) return undefined;
    const canonical = canonicalBySession.get(id) ?? key;
    const override = diagnostics.has(canonical) ? "unavailable" : undefined;
    return { id, name: canonical, status: override ?? liveStatus(id) };
  };

  const put = (name: string, id: SessionId, diagnostic?: "corrupt" | "unsupported" | "unavailable"): void => {
    byKey.set(name, id);
    byKey.set(String(id), id);
    canonicalBySession.set(id, name);
    if (diagnostic !== undefined) diagnostics.add(name);
    memberNames.push(name);
  };

  put(ROOT_NAME, root.id);

  for (const entry of entries) {
    const name = entry.path ?? entry.id;
    if (isDiagnosticEntry(entry)) {
      put(name, entry.id, entry.reason);
      continue;
    }
    if (entry.mode !== "continuable") {
      // One-shot and external children cannot be continued, so the built-in
      // `list_agents` never offers them as members; match that visibility.
      continue;
    }
    put(name, entry.id);
  }

  const callersName = root.id === caller.id ? ROOT_NAME : nameOf(entries, caller.id);

  return {
    names: () => [...memberNames],
    memberOf,
    idOf: (name) => byKey.get(name),
    isDiagnosticOf: (name) => diagnostics.has(name),
    callersName,
  };
}

function isDiagnosticEntry(
  entry: SubagentDescendantListEntry,
): entry is SubagentDescendantListEntry & { readonly reason: "corrupt" | "unsupported" | "unavailable" } {
  return "reason" in entry;
}

/** Derive a member's model-facing name for one catalog entry. */
function nameOf(entries: readonly SubagentDescendantListEntry[], id: string): string {
  for (const entry of entries) {
    if (entry.id !== id) continue;
    if ("path" in entry && entry.path !== undefined && entry.path !== "") return entry.path;
    return entry.id;
  }
  return id;
}

/**
 * Resolve the requested target set against the live tree.
 *
 * Omitted targets mean "every visible continuable member except the caller and
 * the root". The caller is always refused (waiting on the agent running this
 * very tool call can never complete), and `lead` is refused because the user
 * asked for subagents, not the tree root. A name or Session id that resolves to
 * the caller or the root is refused the same way. A corrupt/unavailable/
 * unsupported catalog row is refused explicitly (`UNREACHABLE_TARGET`) rather
 * than silently waiting forever.
 *
 * @returns the resolved canonical target names in stable order.
 * @throws WaitArgumentError with a stable code.
 */
function resolveTargets(observation: Observation, requested: readonly string[] | undefined): readonly string[] {
  const isCallerName = (key: string): boolean => {
    const member = observation.memberOf(key);
    return member !== undefined && member.name === observation.callersName;
  };

  if (requested === undefined) {
    // Default selection must not silently drop an unreadable catalog row and
    // then wait forever (or fake an `all` success). Refuse it explicitly, with
    // the same clear error as an explicit selection, listing name and reason.
    for (const name of observation.names()) {
      if (observation.isDiagnosticOf(name)) {
        const member = observation.memberOf(name);
        throw new WaitArgumentError(
          `cannot wait on every visible subagent: ${JSON.stringify(name)} is ${member?.status ?? "unreachable"}; select reachable members explicitly with \`agents\``,
          "UNREACHABLE_TARGET",
        );
      }
    }
    const targets = observation.names().filter((name) => name !== ROOT_NAME && !isCallerName(name));
    if (targets.length === 0) {
      throw new WaitArgumentError(
        "no subagents to wait on: this tree has no visible member other than the caller",
        "EMPTY_SELECTION",
      );
    }
    return targets;
  }

  const resolved: string[] = [];
  const seenCanonical = new Set<string>();
  for (const rawName of requested) {
    const member = observation.memberOf(rawName);
    if (member === undefined) {
      throw new WaitArgumentError(
        `agent ${JSON.stringify(rawName)} is not a visible member of your subagent tree`,
        "UNKNOWN_TARGET",
      );
    }
    const name = member.name;
    if (isCallerName(rawName)) {
      throw new WaitArgumentError(
        `cannot wait on yourself (${JSON.stringify(rawName)}): the caller is running for the duration of this tool call and never changes`,
        "SELF_TARGET",
      );
    }
    if (name === ROOT_NAME) {
      throw new WaitArgumentError(
        `cannot wait on the root agent (${JSON.stringify(ROOT_NAME)}): wait_subagents observes subagents, not the tree root`,
        "ROOT_TARGET",
      );
    }
    if (observation.isDiagnosticOf(name)) {
      throw new WaitArgumentError(
        `agent ${JSON.stringify(rawName)} is unreachable (${member.status}); it cannot be waited on`,
        "UNREACHABLE_TARGET",
      );
    }
    // A name and its Session id are aliases for the same member; reject the
    // duplicate rather than silently producing a doubled target.
    if (seenCanonical.has(name)) {
      throw new WaitArgumentError(
        `agent ${JSON.stringify(rawName)} duplicates ${JSON.stringify(name)} (a name and its Session id are the same target)`,
        "DUPLICATE_TARGET",
      );
    }
    seenCanonical.add(name);
    resolved.push(name);
  }
  return resolved;
}

/** Live status for one Session id, without an observation adapter. */
function liveStatusOf(ctx: Context, id: SessionId): MemberStatus {
  return ctx.agents.get(id)?.status === "running" ? "running" : "inactive";
}

/**
 * Attach the four lifecycle observers. They latch state by Session id:
 *
 * - `lastById[id]` is the most recently observed status;
 * - `changedIds` latches an id the first time its observed status differs from
 *   the previous observation (same-status repeats never latch again);
 * - `stopReasons[id]` records the terminal `subagent/end` reason.
 *
 * The caller must seed `lastById` with every live agent's current status before
 * attaching, so an event that fires during discovery for a *known* member is a
 * real transition relative to that seeded baseline. The first observation of an
 * id with no seeded baseline establishes it without latching a change.
 *
 * `onChange` runs after every state mutation so the wait can re-evaluate
 * satisfaction; it is a no-op when the wait has already settled.
 *
 * @returns a disposer removing all four listeners.
 */
function attachObservers(
  ctx: Context,
  lastById: Map<SessionId, MemberStatus>,
  changedIds: Set<SessionId>,
  stopReasons: Map<SessionId, SubagentStopReasonText>,
  onChange: () => void,
): () => void {
  const observe = (id: SessionId, status: MemberStatus): void => {
    const previous = lastById.get(id);
    lastById.set(id, status);
    if (previous !== undefined && previous !== status) changedIds.add(id);
    onChange();
  };

  const offStart = ctx.on("subagent/start", (info: SubagentRunInfo) => {
    observe(info.id, "running");
  });

  const offEnd = ctx.on("subagent/end", (info: SubagentRunEndInfo) => {
    stopReasons.set(info.id, narrowStopReason(info.stopReason));
    // Settlement is terminal for this residency epoch: observe it as inactive.
    observe(info.id, "inactive");
  });

  const offStatus = ctx.on("agent/status", (payload: { readonly agent: Agent; readonly status: string }) => {
    observe(payload.agent.id, payload.status === "running" ? "running" : "inactive");
  });

  const offDisposed = ctx.on("agent/disposed", (payload: { readonly agent: Agent }) => {
    // Disposal is its own terminal state, distinct from "inactive": it is a
    // change even when the last observed status was already inactive.
    changedIds.add(payload.agent.id);
    lastById.set(payload.agent.id, "unavailable");
    onChange();
  });

  return () => {
    offStart();
    offEnd();
    offStatus();
    offDisposed();
  };
}

/**
 * Run one wait with a single owner for the whole tool call: observers, the
 * abort listeners, the deadline, discovery, and settlement.
 *
 * The observers are attached synchronously first, the deadline starts
 * immediately (from tool start, not from discovery completion), and discovery
 * is then resolved. Every settle path — satisfied, timeout, caller abort, or
 * plugin unload — runs one cleanup that removes the observers, both abort
 * listeners, and the timer. A discovery that ignores its abort signal is
 * fire-and-forget guarded so it neither hangs the call nor becomes an unhandled
 * rejection; it holds no global subscriptions and does not touch the context
 * after settlement.
 */
function waitForChange(
  ctx: Context,
  caller: Agent,
  requested: readonly string[] | undefined,
  args: WaitRequest,
  signal: AbortSignal,
  lifetime: AbortSignal,
): Promise<WaitResult> {
  const lastById = new Map<SessionId, MemberStatus>();
  const changedIds = new Set<SessionId>();
  const stopReasons = new Map<SessionId, SubagentStopReasonText>();

  // Seed a baseline for every live agent so an event that fires during
  // discovery for a *known* member is a real transition relative to it, not a
  // "first observation" that would swallow an inactive→running that persists.
  for (const agent of ctx.agents.list()) {
    lastById.set(agent.id, agent.status === "running" ? "running" : "inactive");
  }

  // The observers may fire before the Promise executor below defines `check`;
  // this indirection lets them re-evaluate satisfaction as soon as it exists.
  let onChange: () => void = () => {};
  const offObservers = attachObservers(ctx, lastById, changedIds, stopReasons, () => onChange());

  // Start discovery immediately, fused with caller cancellation and plugin
  // unload. `listDescendants` is the only await; the rest of observeTree is
  // synchronous once it resolves.
  const discoverySignal = AbortSignal.any([signal, lifetime]);
  const discovery = observeTree(ctx, caller, discoverySignal);
  // A stuck read that later settles is harmless; never let it reject unhandled.
  void discovery.catch(() => {});

  return new Promise<WaitResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let targets: readonly string[] = [];
    const nameById = new Map<string, SessionId>();

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      offObservers();
      signal.removeEventListener("abort", onAbort);
      lifetime.removeEventListener("abort", onUnload);
    };

    const finish = (timedOut: boolean): void => {
      cleanup();
      resolve(projectResult(args, targets, snapshotChanged(), snapshotLatest(), snapshotStops(), timedOut));
    };

    const fail = (error: unknown): void => {
      cleanup();
      reject(error);
    };

    /** Name-keyed change set derived from the authoritative id-keyed latches. */
    const snapshotChanged = (): Set<string> => {
      const result = new Set<string>();
      for (const name of targets) {
        const id = nameById.get(name);
        if (id !== undefined && changedIds.has(id)) result.add(name);
      }
      return result;
    };

    const snapshotLatest = (): Map<string, MemberStatus> => {
      const result = new Map<string, MemberStatus>();
      for (const name of targets) {
        const id = nameById.get(name);
        if (id !== undefined) result.set(name, lastById.get(id) ?? "inactive");
      }
      return result;
    };

    const snapshotStops = (): Map<string, SubagentStopReasonText> => {
      const result = new Map<string, SubagentStopReasonText>();
      for (const name of targets) {
        const id = nameById.get(name);
        const reason = id === undefined ? undefined : stopReasons.get(id);
        if (reason !== undefined) result.set(name, reason);
      }
      return result;
    };

    const check = (): void => {
      if (settled) return;
      if (targets.length === 0) return; // discovery not resolved yet
      if (isSatisfied(args.condition, args.event, targets, snapshotChanged(), snapshotLatest())) {
        finish(false);
      }
    };

    // Wire the observers' callback to the check defined here.
    onChange = check;

    const onAbort = (): void => {
      // Preserve the caller's exact abort reason, mirroring the built-in
      // `wait_agent` tool's cancellation contract.
      fail(signal.reason);
    };

    const onUnload = (): void => {
      fail(new WaitUnavailableError("wait_subagents ended because its plugin was unloaded"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    lifetime.addEventListener("abort", onUnload, { once: true });

    // Deadline runs from tool start, covering discovery too.
    if (args.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(true);
      }, args.timeoutMs);
    }

    discovery.then(
      (observation) => {
        if (settled) return;
        try {
          targets = resolveTargets(observation, requested);
        } catch (error) {
          fail(error);
          return;
        }
        for (const name of targets) {
          const id = observation.idOf(name);
          if (id === undefined) continue;
          nameById.set(name, id);
          if (!lastById.has(id)) {
            // Only reachable for ids that were not live at seed time (e.g. a
            // short-lived member that already settled). Baseline on first read;
            // any observed transition is already latched in changedIds.
            const member = observation.memberOf(name);
            lastById.set(id, member?.status ?? liveStatusOf(ctx, id));
          }
        }
        // Re-check cancellation after discovery: an abort or unload that landed
        // while discovery was in flight must settle now, not after a wait.
        if (lifetime.aborted) {
          onUnload();
        } else if (signal.aborted) {
          onAbort();
        } else {
          check();
        }
      },
      (error) => {
        if (settled) return;
        if (lifetime.aborted) {
          onUnload();
        } else if (signal.aborted) {
          onAbort();
        } else {
          fail(error);
        }
      },
    );
  });
}

/**
 * Tool registration and plugin lifetime.
 *
 * Every wait is owned by a plugin-scoped abort controller: unloading the plugin
 * aborts all outstanding waits with `WAIT_UNAVAILABLE`, so a listener or timer
 * never outlives the plugin fiber.
 */
export function apply(ctx: Context): void {
  const lifetime = new AbortController();
  ctx.effect(() => () => {
    lifetime.abort(new WaitUnavailableError("wait_subagents ended because its plugin was unloaded"));
  }, "agent-wait.waits()");

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        "Wait for a subagent tree change without ending your turn. Blocks until any or all of the " +
        "selected subagents change status since this call began (running→inactive, inactive→running, " +
        "disposal, or unreachable), or until they are all inactive with event=idle. " +
        "`agents` defaults to every visible subagent (the caller and the root are excluded). " +
        "`timeout_ms` omitted or null waits without a deadline; the deadline starts when the call " +
        "starts and the call is cancellable. Returns which members changed (a change is latched even " +
        "if the status later reverts) and each member's latest status. It observes, never delivers, " +
        "messages: use send_message to act.",
      parameters: {
        agents: {
          type: "array",
          items: { type: "string" },
          description:
            "Full names (path from the tree root, e.g. \"reviewer/checker\") or Session ids of the " +
            "subagents to wait on. Omit to wait on every visible subagent. The caller and the root " +
            "(lead) are never valid targets.",
        },
        event: {
          type: "string",
          enum: ["change", "idle"],
          description:
            "change (default): each target must change from its baseline at least once. idle: each target must reach inactive.",
        },
        condition: {
          type: "string",
          enum: ["any", "all"],
          description:
            "any (default): satisfied by the first target change. all: every target must have changed at least once.",
        },
        timeout_ms: {
          oneOf: [{ type: "integer" }, { type: "null" }],
          description:
            `Deadline in milliseconds, from 1 to ${MAX_TIMER_DELAY_MS}; omit or null to wait without a deadline.`,
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            condition: { type: "string", required: true, enum: ["any", "all"] },
            event: { type: "string", required: true, enum: ["change", "idle"] },
            timedOut: { type: "boolean", required: true },
            satisfiedBy: { type: "array", items: { type: "string" }, required: true },
            changed: { type: "array", items: { type: "string" }, required: true },
            members: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string", required: true },
                  status: {
                    type: "string",
                    required: true,
                    enum: ["running", "inactive", "corrupt", "unsupported", "unavailable"],
                  },
                  stopReason: {
                    type: "string",
                    enum: ["completed", "aborted", "error", "max-tokens", "refusal"],
                  },
                },
              },
              required: true,
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec): Promise<WaitResult> {
        if (exec.agent === undefined) {
          throw new WaitUnavailableError("wait_subagents requires a calling agent (exec.agent was undefined)");
        }
        if (lifetime.signal.aborted) {
          throw new WaitUnavailableError("wait_subagents ended because its plugin was unloaded");
        }
        const normalized = normalizeArguments(args as never);
        return await waitForChange(
          ctx,
          exec.agent,
          normalized.targetNames,
          { condition: normalized.condition, event: normalized.event, timeoutMs: normalized.timeoutMs },
          exec.signal,
          lifetime.signal,
        );
      },
    }),
  );
}

export default { name, inject, apply };
