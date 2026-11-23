#!/usr/bin/env bun
/**
 * Real native-log gate for selection evidence.
 *
 * Boots a real supported DSH Host (rc.4/rc.5) from an isolated install, spawns a
 * real continuable member through the published subagent runtime with a
 * deterministic metadata-only LLM adapter, then assembles evidence from that
 * member's own observed Session log through the real `ctx.sessionQuery` binding.
 *
 * The measured module closure is copied *inside* the fixture so its bare
 * `@deepseek-ai/*` imports resolve to that install, exactly as they do when the
 * packaged plugin is loaded. No paid model I/O and no repository writes.
 *
 *   bun adapters/dsh/environment/selection-check.mts <isolated supported DSH install>
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const install = process.argv[2];
if (!install) { console.error("Usage: bun adapters/dsh/environment/selection-check.mts <isolated supported DSH install>"); process.exit(2); }
const installed = resolve(install);
const require = createRequire(join(installed, "package.json"));
const runtimeVersion = JSON.parse(readFileSync(require.resolve("@deepseek-ai/dsh/package.json"), "utf8")).version;
assert.ok(["0.2.2-rc.4", "0.2.2-rc.5"].includes(runtimeVersion), "unsupported native gate version");

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = resolve(repo, ".scratch/production-cycle"); mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, "environment-selection-"));
symlinkSync(join(installed, "node_modules"), join(fixture, "node_modules"), "dir");
const source = join(fixture, "source"); mkdirSync(source);
const modules = ["llm", "session", "agent", "system-prompt", "tools", "tool-executor-native", "session-projection", "agent-loop",
  "fs-local", "working-directory", "session-query-sqlite", "session-persistence-jsonl", "storage", "storage-domain", "storage-json",
  "workspace", "subagent", "subagent-spawn-in-process"];
const configs: Record<string, unknown> = {
  "session-persistence-jsonl": { root: join(fixture, "sessions") }, "agent-loop": { agents: [] }, "fs-local": { cwd: source },
  "working-directory": { defaultDirectory: source }, "session-query-sqlite": { path: ":memory:", openAt: "never" },
  "storage-json": { root: join(fixture, "storage") }, "storage-domain": { backend: "json" },
  "subagent-spawn-in-process": { providerName: "spawn" },
};
const rows = modules.map(name => ({ id: name, name: require.resolve("@deepseek-ai/dsh-" + name), ...(configs[name] ? { config: configs[name] } : {}) }));
writeFileSync(join(fixture, "cordis.yml"), rows.map(row => "- " + JSON.stringify(row)).join("\n") + "\n");
writeFileSync(join(fixture, "package.json"), JSON.stringify({ private: true, type: "module" }));

// Copy the measured module closure inside the fixture so bare imports resolve to the install.
for (const tree of ["modules/ensemble", "adapters/dsh/environment"]) cpSync(join(repo, tree), join(fixture, tree), { recursive: true });
/**
 * The measured modules, described structurally.
 *
 * These are imported from the fixture copy so their bare `@deepseek-ai/*` imports
 * resolve to the install under test, which means the compiler sees a computed
 * specifier. Declaring the two functions' real signatures here keeps the checks
 * typed instead of `any`; the modules themselves are compiled by the plain and
 * Host programs, so a changed signature still fails there.
 */
type EvidenceStage =
  | { readonly status: "observed"; readonly session_id: string; readonly event_seq: number; readonly provider?: string; readonly model?: string; readonly reasoning_effort?: string }
  | { readonly status: "unknown" | "unavailable"; readonly reason: string };
interface Evidence {
  readonly evidence_id: string;
  readonly attempt_id: string;
  readonly requested: { readonly provider?: string; readonly model?: string; readonly reasoning_effort?: string; readonly preset?: string };
  readonly created: EvidenceStage;
  readonly actual: EvidenceStage;
}
type Collected = { readonly ok: true; readonly value: Evidence } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
const gateModules = await import(pathToFileURL(join(fixture, "adapters/dsh/environment/selection.ts")).href) as {
  collectSelectionEvidence(source: unknown, input: unknown, signal: AbortSignal): Promise<Collected> };
const gateHost = await import(pathToFileURL(join(fixture, "adapters/dsh/environment/host.ts")).href) as {
  createNativeSelectionSource(ctx: unknown): unknown };
const collectSelectionEvidence = gateModules.collectSelectionEvidence;

/** The booted Host surface these checks use. */
interface ObservedEvent { readonly seq: number; readonly type: string }
interface Observation extends Disposable { readonly events: readonly ObservedEvent[]; readonly inheritedEventCount: number }
interface BootedHost {
  readonly llm: { registerAdapter(names: readonly string[], adapter: unknown): void };
  readonly agents: { create(options: { sessionId: string; meta: { cwd: string }; agentOptions: { provider: string; model: string } }): Promise<{ agent: { readonly id: string }; dispose(): Promise<void> }> };
  readonly subagents: {
    startActivation(options: { provider: string; name: string; label: string; parent: unknown; prompt: readonly unknown[];
      agentOptions: { provider: string; model: string }; delivery: "caller"; signal: AbortSignal }): Promise<{ childId: string; result: Promise<unknown> }>;
    drainDescendants(agents: readonly unknown[]): Promise<void>;
  };
  readonly sessionQuery: { observeSession(sessionId: string, options: { signal: AbortSignal }): Promise<Observation> };
  readonly fiber: { dispose(): Promise<void> };
}

const { boot } = await import(require.resolve("@deepseek-ai/dsh-app-boot"));
const { LlmAdapter, isAgentLoopRequest } = await import(require.resolve("@deepseek-ai/dsh-llm"));
const ctx: BootedHost = await boot("ensemble-selection-check", join(fixture, "cordis.yml"), []);
const selectionSource = (gateHost.createNativeSelectionSource as (ctx: unknown) => unknown)(ctx);
const text = (value: string) => [{ type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text: value },
  { type: "block-end", index: 0, block: { type: "text", text: value } }, { type: "finish", reason: { kind: "stop" } }];
class DeterministicProvider extends LlmAdapter {
  async *stream(options: { readonly signal?: AbortSignal }) {
    const chunks = isAgentLoopRequest(options) ? text("native completion") : text("title");
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk; }
  }
}
ctx.llm.registerAdapter(["fixture"], new DeterministicProvider());
let passes = 0;
const passed = (label: string) => { passes++; console.log(`PASS ${label}`); };
const handle = await ctx.agents.create({ sessionId: `selection-check-${crypto.randomUUID()}`,
  meta: { cwd: source }, agentOptions: { provider: "fixture", model: "parent-model" } });
try {
  const parent = handle.agent;
  const signal = AbortSignal.timeout(60000);
  const member = await ctx.subagents.startActivation({ provider: "spawn", name: "selection-member", label: "selection member",
    parent, prompt: [{ type: "text", text: "produce one observed turn" }],
    agentOptions: { provider: "fixture", model: "member-model" }, delivery: "caller", signal });
  await member.result;

  // The requested effort is deliberately one the member never used: it must stay
  // a request and never be reported as an observed created/actual effort.
  const request = { attempt_id: "attempt-real", evidence_id: "evidence-real", member_session_id: member.childId,
    requested: { provider: "fixture", model: "member-model", reasoning_effort: "high" } };
  const collected = await collectSelectionEvidence(selectionSource, request, signal);
  assert.equal(collected.ok, true, JSON.stringify(collected));
  const evidence = collected.value!;

  const observed = await ctx.sessionQuery.observeSession(member.childId, { signal });
  const seqs = observed.events.map((event: { seq: number }) => event.seq);
  const types = observed.events.map((event: { type: string }) => event.type);
  const inherited = observed.inheritedEventCount;
  observed[Symbol.dispose]();

  assert.deepEqual(evidence.requested, request.requested);
  /** Assert one stage was observed and hand back its route fields. */
  const observedStage = (stage: "created" | "actual") => {
    const value = evidence[stage];
    assert.equal(value.status, "observed", `${stage}: ${JSON.stringify(value)}`);
    if (value.status !== "observed") throw new Error(`unreachable: ${stage} was asserted observed`);
    return value;
  };
  for (const stage of ["created", "actual"] as const) {
    const value = observedStage(stage);
    assert.equal(value.session_id, member.childId, `${stage} must cite the member Session`);
    assert.ok(seqs.includes(value.event_seq), `${stage} seq ${value.event_seq} must exist in the member log`);
    assert.ok(value.event_seq >= inherited, `${stage} must not cite a fork-inherited prefix event`);
  }
  assert.equal(observedStage("created").provider, "fixture");
  assert.equal(observedStage("created").model, "member-model");
  assert.equal(observedStage("actual").provider, "fixture");
  assert.equal(observedStage("actual").model, "member-model");
  assert.ok(types.includes("assistant/message"), "the actual stage needs a real model response");
  passed("real member log: created/actual cite existing native event seqs outside any fork prefix");

  // A requested route the native log never used stays a request, not a fact.
  const other = await collectSelectionEvidence(selectionSource, { ...request, requested: { provider: "fixture", model: "never-used" } }, signal);
  assert.equal(other.ok, true);
  const otherCreated = other.ok ? other.value.created : undefined;
  assert.equal(otherCreated?.status, "observed");
  assert.equal(otherCreated?.status === "observed" ? otherCreated.model : undefined, "member-model", "a requested model must not be reported as created");
  assert.equal(other.ok ? other.value.requested.model : undefined, "never-used");
  passed("requested never overrides observed created/actual");

  // An unreadable Session is unavailable; another Session is never attributed to this attempt.
  const missing = await collectSelectionEvidence(selectionSource, { ...request, member_session_id: "does-not-exist" }, signal);
  assert.equal(missing.ok, true);
  assert.equal(missing.ok ? missing.value.created.status : undefined, "unavailable");
  assert.equal(missing.ok ? missing.value.actual.status : undefined, "unavailable");
  const wrong = await collectSelectionEvidence(selectionSource, { ...request, member_session_id: parent.id }, signal);
  assert.equal(wrong.ok, true);
  const wrongCreated = wrong.ok ? wrong.value.created : undefined;
  assert.equal(wrongCreated?.status, "unknown", "the root log has no continuation descriptor");
  assert.equal(wrong.ok ? wrong.value.attempt_id : undefined, request.attempt_id, "a different Session is never attributed to the attempt");
  // Whatever that log does contain may only ever be attributed to the Session it
  // actually came from — never to the attempt's requested member.
  const wrongActual = wrong.ok ? wrong.value.actual : undefined;
  assert.ok(wrongActual?.status !== "observed" || wrongActual.session_id === parent.id,
    "an observed stage must cite the Session its log came from");
  passed("unreadable Session is unavailable; a different Session is never attributed to the attempt");

  const twice = await collectSelectionEvidence(selectionSource, request, signal);
  assert.equal(twice.ok && JSON.stringify(twice.value), JSON.stringify(evidence));
  passed("repeated collection of the same log is stable");
  writeFileSync(join(fixture, "evidence.json"), JSON.stringify({ release: runtimeVersion, member: member.childId,
    inherited, eventTypes: [...new Set(types)].sort(), evidence }, null, 2));
  console.log(`SELECTION ${runtimeVersion}: ${passes} checks PASS; fixture=${fixture}`);
} finally {
  await ctx.subagents.drainDescendants([handle.agent]);
  await handle.dispose();
  await ctx.fiber.dispose();
}
