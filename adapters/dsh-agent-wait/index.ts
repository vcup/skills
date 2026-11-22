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

import { setMaxListeners } from "node:events";
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
  assertTargetBudget,
  MAX_ACTIVE_WAITS,
  MAX_DISCOVERY_ENTRIES,
  MAX_OBSERVED_AGENTS,
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
  signal.throwIfAborted();
  const root = ctx.subagents.rootOf(caller);
  const entries = await ctx.subagents.listDescendants(root.id, signal);
  // A late read must not access services after timeout/unload.
  signal.throwIfAborted();
  if (entries.length > MAX_DISCOVERY_ENTRIES) {
    throw new WaitArgumentError("subagent catalog exceeds the discovery budget", "WAIT_RESOURCE_LIMIT");
  }

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

/**
 * One owner for discovery, event subscriptions, caller cancellation and deadline.
 * Before discovery we retain a bounded baseline; afterwards only fixed targets
 * survive. Events for other trees/targets cannot grow a long-lived wait.
 */
function waitForChange(
  ctx: Context,
  caller: Agent,
  requested: readonly string[] | undefined,
  args: WaitRequest,
  signal: AbortSignal,
  lifetime: AbortSignal,
): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve, reject) => {
    const discovery = new AbortController();
    const lastById = new Map<SessionId, MemberStatus>();
    const changedIds = new Set<SessionId>();
    const stopReasons = new Map<SessionId, SubagentStopReasonText>();
    const ids = new Map<string, SessionId>();
    let selected: Set<SessionId> | undefined;
    const satisfiedIds = new Set<SessionId>();
    let targets: readonly string[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposers: (() => void)[] = [];

    const cleanup = (): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const off of disposers.splice(0)) off();
      signal.removeEventListener("abort", onAbort);
      lifetime.removeEventListener("abort", onUnload);
      // All exits, including deadline and success, release an outstanding read.
      discovery.abort(new WaitUnavailableError("wait_subagents observation ended"));
      lastById.clear(); changedIds.clear(); stopReasons.clear(); ids.clear(); selected?.clear(); satisfiedIds.clear();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      cleanup(); reject(error);
    };
    const onAbort = (): void => fail(signal.reason);
    const onUnload = (): void => fail(lifetime.reason ?? new WaitUnavailableError("wait_subagents ended because its plugin was unloaded"));
    const snapshot = () => {
      const changed = new Set<string>();
      const latest = new Map<string, MemberStatus>();
      const stops = new Map<string, SubagentStopReasonText>();
      for (const name of targets) {
        const id = ids.get(name)!;
        if (changedIds.has(id)) changed.add(name);
        latest.set(name, lastById.get(id) ?? "inactive");
        const reason = stopReasons.get(id);
        if (reason !== undefined) stops.set(name, reason);
      }
      return { changed, latest, stops };
    };
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      try {
        const { changed, latest, stops } = snapshot();
        const result = projectResult(args, targets, changed, latest, stops, timedOut);
        cleanup(); resolve(result);
      } catch (error) { fail(error); }
    };
    const check = (): void => {
      if (settled || selected === undefined) return;
      if (args.condition === "any" ? satisfiedIds.size > 0 : satisfiedIds.size === selected.size) finish(false);
    };
    const observe = (id: SessionId, status: MemberStatus, reason?: SubagentStopReasonText): void => {
      if (settled) return;
      if (id === caller.id && status === "unavailable") {
        fail(new WaitUnavailableError("wait_subagents ended because its calling agent was disposed"));
        return;
      }
      if (selected !== undefined && !selected.has(id)) return;
      if (!lastById.has(id) && lastById.size >= MAX_OBSERVED_AGENTS) {
        fail(new WaitArgumentError("wait discovery observation budget exceeded", "WAIT_RESOURCE_LIMIT"));
        return;
      }
      const previous = lastById.get(id);
      lastById.set(id, status);
      if ((previous !== undefined && previous !== status) || (previous === undefined && status === "unavailable")) changedIds.add(id);
      // A resumed run must never report a previous run's terminal reason.
      if (status === "running") stopReasons.delete(id);
      if (reason !== undefined) stopReasons.set(id, reason);
      if (selected !== undefined) {
        const satisfied = args.event === "change" ? changedIds.has(id) : status === "inactive";
        if (satisfied) satisfiedIds.add(id); else satisfiedIds.delete(id);
      }
      // Same-state repeats may enrich stopReason but cannot satisfy a change.
      if (previous !== status) check();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    lifetime.addEventListener("abort", onUnload, { once: true });
    if (lifetime.aborted) { onUnload(); return; }
    if (signal.aborted) { onAbort(); return; }
    if (args.timeoutMs !== undefined) timer = setTimeout(() => finish(true), args.timeoutMs);
    try {
      // Synchronous seed+subscribe has no await gap; discovery begins only after
      // subscriptions and abort handlers are owned by this call.
      for (const agent of ctx.agents.list()) {
        if (lastById.size >= MAX_OBSERVED_AGENTS) throw new WaitArgumentError("live agent baseline exceeds the observation budget", "WAIT_RESOURCE_LIMIT");
        lastById.set(agent.id, agent.status === "running" ? "running" : "inactive");
      }
      disposers.push(ctx.on("subagent/start", (info: SubagentRunInfo) => observe(info.id, "running")));
      disposers.push(ctx.on("subagent/end", (info: SubagentRunEndInfo) => observe(info.id, "inactive", narrowStopReason(info.stopReason))));
      disposers.push(ctx.on("agent/status", ({ agent, status }: { agent: Agent; status: string }) => observe(agent.id, status === "running" ? "running" : "inactive")));
      disposers.push(ctx.on("agent/disposed", ({ agent }: { agent: Agent }) => observe(agent.id, "unavailable")));
      void observeTree(ctx, caller, discovery.signal).then(observation => {
        if (settled) return;
        targets = resolveTargets(observation, requested);
        assertTargetBudget(targets);
        selected = new Set();
        for (const name of targets) {
          const member = observation.memberOf(name)!;
          ids.set(name, member.id); selected.add(member.id);
          if (!lastById.has(member.id)) lastById.set(member.id, member.status);
          if (args.event === "change" ? changedIds.has(member.id) : lastById.get(member.id) === "inactive") satisfiedIds.add(member.id);
        }
        for (const id of lastById.keys()) if (!selected.has(id)) {
          lastById.delete(id); changedIds.delete(id); stopReasons.delete(id);
        }
        check();
      }).catch(fail);
    } catch (error) { fail(error); }
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
  setMaxListeners(MAX_ACTIVE_WAITS + 1, lifetime.signal);
  let activeWaits = 0;
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
        try {
          if (exec.agent === undefined) {
            throw new WaitUnavailableError("wait_subagents requires a calling agent (exec.agent was undefined)");
          }
          if (lifetime.signal.aborted) {
            throw new WaitUnavailableError("wait_subagents ended because its plugin was unloaded");
          }
          const normalized = normalizeArguments(args);
          if (activeWaits >= MAX_ACTIVE_WAITS) {
            throw new WaitArgumentError("too many concurrent waits in this plugin; cancel an existing wait first", "WAIT_RESOURCE_LIMIT");
          }
          activeWaits++;
          try { return await waitForChange(
            ctx,
            exec.agent,
            normalized.targetNames,
            { condition: normalized.condition, event: normalized.event, timeoutMs: normalized.timeoutMs },
            exec.signal,
            lifetime.signal,
          ); } finally { activeWaits--; }
        } catch (error) {
          // The dependency-free validator carries codes, but native ToolRunner
          // preserves structured codes only for the shared HarnessError class.
          if (error instanceof WaitArgumentError) throw new HarnessError(error.message, error.code, { cause: error });
          throw error;
        }
      },
    }),
  );
}

export default { name, inject, apply };
