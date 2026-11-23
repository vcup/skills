/** Released DSH objects admitted to the domain's trusted facts Interface. */
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-team";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-working-directory";
import type {} from "@deepseek-ai/dsh-workspace";
import type { Actor, TrustedFacts } from "../../../modules/ensemble/contracts.ts";
import { nativeFacts, teamTasks } from "./bridge.ts";
import { nativeIdentity, NativeIdentityError, type NativeIdentity } from "./identity.ts";

/**
 * Bind one declared execution world to its actual public Cordis service scopes.
 *
 * The deployment supplies the *label* (`DSH_ENSEMBLE_SOURCE_WORLD`); the
 * mapping to real objects is decided here from the live service scopes, never
 * from caller text or a path. A caller is in this world only when each
 * execution service resolves inside the same isolation scope as this plugin and
 * a filesystem service is actually present.
 *
 * The labels are read on every call, never captured at activation: a peer
 * service such as `subprocess` is frequently provided after this plugin
 * activates, and a captured snapshot then matched nothing for every real
 * caller while the unit fixture (which provides all services before the
 * plugin) still passed.
 */
export function sourceWorld(ctx: Context, identity: string): (agent: Agent) => string | undefined {
  if (!identity.trim()) throw new Error("execution world identity must be configured");
  if (ctx.get("fs") === undefined) throw new Error("execution world requires the native filesystem service");
  const names = ["fs", "subprocess", "sandbox"] as const;
  return agent => names.every(name => agent.ctx[Context.isolate][name] === ctx[Context.isolate][name]) && agent.ctx.get("fs") !== undefined ? identity : undefined;
}

export function createNativeBridge(ctx: Context, worldIdentity: string) {
  const worldOf = sourceWorld(ctx, worldIdentity);
  function identity(caller: Agent | undefined): NativeIdentity {
    return nativeIdentity<Agent>({
      agents: { get: id => ctx.agents.get(SessionId(id)) },
      subagents: ctx.subagents,
      workspaces: ctx.workspaceRegistry,
      workingDirectory: ctx.workingDirectory,
      worldOf,
    }, caller);
  }
  return {
    identity,
    actor(caller: Agent | undefined, callId: string): { actor: Extract<Actor, { kind: "session" }>; identity: NativeIdentity } {
      const value = identity(caller);
      return { actor: { kind: "session", sessionId: value.sessionId, rootSessionId: value.rootSessionId, workspaceRef: value.workspaceId, callId }, identity: value };
    },
    async facts(caller: Agent, signal: AbortSignal): Promise<Pick<TrustedFacts, "nativeMembers" | "nativeTaskRefs" | "observedEventRefs">> {
      identity(caller);
      const facts = await nativeFacts<Agent>({
        rootOf: agent => ctx.subagents.rootOf(agent),
        descendants: (id, control) => ctx.subagents.listDescendants(SessionId(id), control),
        observe: async (id, control) => {
          const observation = await ctx.sessionQuery.observeSession(SessionId(id), { signal: control });
          return { inheritedEventCount: observation.inheritedEventCount, events: observation.events, release: () => observation[Symbol.dispose]() };
        },
        // A Session with Agent Teams off has no task board, and asking for one
        // throws `TEAM_DISABLED`. That is not a storage failure and must not
        // become one: Team mode is optional, and the ensemble method explicitly
        // works without it. Treat it as "no native task facts", so
        // `nativeTaskRefs` is empty and a command that *cites* a task ref fails
        // precisely ("Native task revision has not been verified") instead of
        // poisoning every work/learn write with `storage_unavailable`.
        tasks: agent => teamTasks(() => ctx.get("agentTeams")?.listTasks(agent) ?? []),
      }, caller, signal);
      // A deployment world change while reading cannot authorize a pending write.
      identity(caller);
      return { nativeMembers: facts.members, nativeTaskRefs: facts.taskRefs, observedEventRefs: facts.routeObservations.map(route => route.ref) };
    },
    assertCurrent(caller: Agent | undefined, previous: NativeIdentity): void {
      const current = identity(caller);
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new NativeIdentityError("native caller context changed during the operation");
    },
  };
}
