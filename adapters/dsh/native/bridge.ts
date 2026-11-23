/** Native catalog/task evidence. This module never creates another agent or task board. */
import type { NativeMember, Ref } from "../../../modules/ensemble/contracts.ts";
import { NativeIdentityError, type NativeAgent } from "./identity.ts";

export interface NativeEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}
export interface NativeObservation {
  readonly inheritedEventCount: number;
  readonly events: readonly NativeEvent[];
  release(): void;
}
export interface BridgeRuntime<A extends NativeAgent> {
  rootOf(caller: A): A;
  descendants(rootId: string, signal: AbortSignal): Promise<readonly { readonly kind: string; readonly id: string; readonly path?: string; readonly mode?: string }[]>;
  observe(sessionId: string, signal: AbortSignal): Promise<NativeObservation>;
  tasks(caller: A): readonly { readonly id: string; readonly revision: number }[];
}
export interface NativeRouteObservation {
  readonly session_id: string;
  readonly stage: "created" | "actual";
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly ref: Extract<Ref, { kind: "native_event" }>;
}
export interface NativeFacts {
  readonly members: readonly NativeMember[];
  readonly taskRefs: readonly Extract<Ref, { kind: "native_task" }>[];
  readonly routeObservations: readonly NativeRouteObservation[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function route(data: Record<string, unknown>, keys: readonly [string, string, string]): { provider?: string; model?: string; reasoning_effort?: string } {
  return {
    ...(typeof data[keys[0]] === "string" ? { provider: data[keys[0]] as string } : {}),
    ...(typeof data[keys[1]] === "string" ? { model: data[keys[1]] as string } : {}),
    ...(typeof data[keys[2]] === "string" ? { reasoning_effort: data[keys[2]] as string } : {}),
  };
}

/**
 * Read a Session's native task board, treating "Team mode is off" as "no tasks".
 *
 * A fresh profile has Agent Teams disabled, and asking the board then throws
 * `TEAM_DISABLED`. That is a legitimate deployment state, not a storage failure:
 * the ensemble method explicitly works without Team mode, so the board simply
 * contributes no task facts. Letting the throw escape made the registry's generic
 * failure mapping turn it into `storage_unavailable`, which poisoned every
 * work/learn command with a message the user could not act on.
 *
 * Only that one code is absorbed. Any other board failure still propagates, so a
 * genuinely broken journal is never mistaken for "Team is off".
 * @param list - reads the board for one caller.
 * @returns the tasks, or an empty list when Team mode is disabled.
 */
export function teamTasks(list: () => readonly { readonly id: string; readonly revision: number }[]): readonly { readonly id: string; readonly revision: number }[] {
  try { return list(); }
  catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === "TEAM_DISABLED") return [];
    throw error;
  }
}

/** Capture only reachable native identities and references; prompt/log bodies never leave this module. */
export async function nativeFacts<A extends NativeAgent>(runtime: BridgeRuntime<A>, caller: A, signal: AbortSignal, maxMembers = 256): Promise<NativeFacts> {
  signal.throwIfAborted();
  const root = runtime.rootOf(caller);
  const entries = await runtime.descendants(root.id, signal);
  if (entries.length > maxMembers) throw new NativeIdentityError("native tree exceeds the evidence budget");
  const members: NativeMember[] = [];
  const routeObservations: NativeRouteObservation[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.kind !== "child" || entry.mode !== "continuable") continue;
    const observed = await runtime.observe(entry.id, signal);
    try {
      const own = observed.events.filter(event => event.seq >= observed.inheritedEventCount);
      const descriptor = own.find(event => event.type === "subagent/descriptor" && record(event.data) && event.data.mode === "continuable");
      if (descriptor === undefined || !record(descriptor.data)) continue;
      const creationRef: Extract<Ref, { kind: "native_event" }> = { kind: "native_event", session_id: entry.id, event_seq: descriptor.seq };
      members.push({ sessionId: entry.id, rootSessionId: root.id, name: entry.path ?? entry.id, contextMode: observed.inheritedEventCount > 0 ? "fork" : "fresh", creationRef });
      routeObservations.push({ session_id: entry.id, stage: "created", ref: creationRef, ...route(descriptor.data, ["agentProvider", "agentModel", "agentReasoningEffort"]) });
      // A prepared header alone does not prove dispatch. Pair it with a native
      // model response and retain only route metadata, never response content.
      let config: Record<string, unknown> | undefined;
      let adapterDefaultEffort = false;
      for (const event of own) {
        if (event.type === "request/header" && record(event.data) && record(event.data.header) && record(event.data.header.config)) {
          config = event.data.header.config;
          adapterDefaultEffort = record(event.data.header.adapterDefaults) && event.data.header.adapterDefaults.reasoningEffort === true;
        }
        if (event.type !== "assistant/message" || !record(event.data) || !record(event.data.message) || !record(event.data.message.source)) continue;
        const source = event.data.message.source;
        if (source.kind !== "model") continue;
        const matchingHeader = config?.provider === source.provider && config?.model === source.model;
        routeObservations.push({ session_id: entry.id, stage: "actual", ref: { kind: "native_event", session_id: entry.id, event_seq: event.seq },
          ...route(source, ["provider", "model", "__absent"]),
          ...(matchingHeader && !adapterDefaultEffort && typeof config?.reasoningEffort === "string" ? { reasoning_effort: config.reasoningEffort } : {}),
        });
      }
    } finally { observed.release(); }
  }
  signal.throwIfAborted();
  // Re-resolve after asynchronous observations: a detached caller cannot use a
  // historical catalog to keep authorizing a new write.
  if (runtime.rootOf(caller) !== root) throw new NativeIdentityError("native tree ownership changed during observation");
  return { members, routeObservations, taskRefs: teamTasks(() => runtime.tasks(caller)).map(task => ({ kind: "native_task", root_session_id: root.id, task_id: task.id, task_revision: task.revision })) };
}
