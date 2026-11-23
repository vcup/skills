/** Published DSH binding. Kept separate so the pure/core suite needs no Host dependencies. */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-session-query";
import { SessionId } from "@deepseek-ai/dsh-session";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { parentAgentOptionsForDelegation } from "@deepseek-ai/dsh-subagent";
import { array, decode, object, str } from "../../../modules/ensemble/validation.ts";
import { failure, type Result } from "../../../modules/ensemble/contracts.ts";
import type { EnvironmentCatalog, Route } from "../../../modules/ensemble/environment.ts";
import { discoverEnvironmentCatalog } from "./native.ts";
import type { SelectionSource } from "./selection.ts";

/**
 * Bind the published Session query to the selection-evidence seam.
 *
 * The collector stays a pure function of one detached log: the caller resolves
 * the exact attempt/member/requested facts from the archive first, so a model
 * tool argument can never name its own member or claim its own route. A Session
 * the Host cannot observe yields `undefined`, which the assembler records as an
 * explicit `unavailable` stage rather than invented creation/use evidence.
 */
export function createNativeSelectionSource(ctx: Context): SelectionSource {
  return {
    async observe(sessionId, signal) {
      try {
        const observation = await ctx.sessionQuery.observeSession(SessionId(sessionId), { signal });
        return { session_id: observation.header.id, inherited_event_count: observation.inheritedEventCount,
          events: observation.events.map(event => ({ seq: event.seq, type: event.type, data: event.data })),
          release: () => observation[Symbol.dispose]() };
      } catch { return undefined; }
    },
  };
}

/** Native events are read through the published query face; no source-module runtime imports. */
export async function createNativeCatalogReader(ctx: Context, freshToolName = "subagent"): Promise<(caller: Agent, signal: AbortSignal) => Promise<Result<EnvironmentCatalog>>> {
  return async (caller, signal) => {
    try {
      const root = ctx.subagents.rootOf(caller);
      const validate = () => ctx.agents.get(caller.id) === caller && ctx.subagents.rootOf(caller) === root;
      if (!validate()) return failure("not_authorized", "Native environment discovery requires an exact live caller.");
      const parent = parentAgentOptionsForDelegation(caller);
      const selection = caller.model.current();
      if (!selection) return failure("storage_unavailable", "No effective native model selection is available.");
      const tools = await caller.ctx.tools.resolve({ agent: caller, modelSelection: selection, signal });
      try {
        const tool = caller.ctx.tools.get(freshToolName, scopeOf(caller.ctx), tools);
        // Definition/schema are actual admitted native tool facts, not profile setting guesses.
        const parameters = tool?.parameters as Record<string, { enum?: unknown }> | undefined;
        const presetChoices = parameters?.agent_preset?.enum;
        const observation = await ctx.sessionQuery.observeSession(caller.id, { signal });
        let routes: readonly Route[] | undefined;
        try {
          // Optional upstream plugins extend the event vocabulary; validate this payload at runtime.
          const events: readonly { type: string; data: unknown }[] = observation.events;
          const event = events.find(event => event.type === "subagent/model-selection-policy");
          if (event !== undefined) {
            const decoded = decode<{ allowedModels: Route[] }>(event.data, object({ allowedModels: array(object({ provider: str(1, 256), model: str(1, 256) }), 1, 256) }));
            if (!decoded.ok) return failure("archive_corrupt", "Recorded native route policy is invalid; no authorization inferred.");
            routes = decoded.value.allowedModels;
          }
        } finally { observation[Symbol.dispose](); }
        return await discoverEnvironmentCatalog({ sessionId: caller.id, validate,
          ...(routes === undefined ? {} : { policy: routes }),
          ...(parent.provider && parent.model ? { parent: { provider: parent.provider, model: parent.model, ...(parent.reasoningEffort === undefined ? {} : { reasoning_effort: parent.reasoningEffort }) } } : {}),
          selectionEnabled: parameters?.provider !== undefined && parameters.model !== undefined && parameters.reasoning_effort !== undefined,
          allowedPresets: Array.isArray(presetChoices) && presetChoices.every(p => typeof p === "string") ? presetChoices : [],
          llm: caller.ctx.get("llm"), presets: caller.ctx.get("agentPresets"),
        }, signal);
      } finally { tools.dispose(); }
    } catch { return failure("storage_unavailable", "Native catalog or live Session could not be resolved; no authority was inferred."); }
  };
}
