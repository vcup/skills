/** Run the public native Agent/Workspace/ToolRunner identity path without paid model I/O. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeIdentity, executionWorld } from "./identity.ts";

const install = resolve(process.argv[2] ?? "");
const require = createRequire(join(install, "package.json"));
const load = async name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load("@deepseek-ai/cordis");
const { boot } = await load("@deepseek-ai/dsh-app-boot");
const { LlmAdapter, createUserMessage, isAgentLoopRequest } = await load("@deepseek-ai/dsh-llm");
const { defineTool } = await load("@deepseek-ai/dsh-tools");
const scratch = await mkdtemp(join(process.env.TMPDIR ?? "/var/tmp", "ensemble-native-identity-"));
const source = join(scratch, "source");
await mkdir(source);
const modules = ["llm", "session", "agent", "system-prompt", "tools", "tool-executor-native", "session-projection", "agent-loop", "fs-local", "working-directory", "session-query-sqlite", "session-persistence-jsonl", "storage", "storage-domain", "storage-json", "workspace", "subagent", "subagent-spawn-in-process"];
const configs = {
  "session-persistence-jsonl": { root: join(scratch, "sessions") },
  "agent-loop": { agents: [] }, "fs-local": { cwd: source },
  "working-directory": { defaultDirectory: source },
  "session-query-sqlite": { path: ":memory:", openAt: "never" },
  "storage-json": { root: join(scratch, "storage") },
  "storage-domain": { backend: "json" },
  "subagent-spawn-in-process": { providerName: "spawn" },
};
const rows = modules.map(name => ({ id: name, name: require.resolve("@deepseek-ai/dsh-" + name), ...(configs[name] ? { config: configs[name] } : {}) }));
await writeFile(join(scratch, "cordis.yml"), rows.map(row => "- " + JSON.stringify(row)).join("\n") + "\n");
const ctx = await boot("ensemble-native-identity", join(scratch, "cordis.yml"), []);
const captures = [];
const outcomes = [];
const script = [];
const text = value => [{ type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text: value }, { type: "block-end", index: 0, block: { type: "text", text: value } }, { type: "finish", reason: { kind: "stop" } }];
const tool = id => {
  const call = { type: "tool-call", id, name: "ensemble_identity_verification", arguments: "{}" };
  return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name: call.name, argumentsDelta: call.arguments }, { type: "block-end", index: 0, block: call }, { type: "finish", reason: { kind: "tool-calls" } }];
};
class DeterministicProvider extends LlmAdapter {
  async *stream(options) {
    const chunks = isAgentLoopRequest(options) ? (script.shift() ?? text("native completion")) : text("title");
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk; }
  }
}
ctx.llm.registerAdapter(["ensemble-verification"], new DeterministicProvider());
const sourceFs = ctx[Context.isolate].fs;
const runtime = {
  agents: ctx.agents, subagents: ctx.subagents, workspaces: ctx.workspaceRegistry,
  workingDirectory: ctx.workingDirectory,
  worldOf: executionWorld([{ identity: "fixture-source-world", services: [sourceFs] }], agent => [agent.ctx[Context.isolate].fs]),
};
ctx.tools.register(defineTool({
  name: "ensemble_identity_verification", description: "Verification fixture only", parameters: {},
  output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
  async execute(_args, exec) { const identity = nativeIdentity(runtime, exec.agent); captures.push(identity); return identity; },
}));
ctx.on("tools/result", (execution, result) => { if (execution.name === "ensemble_identity_verification") outcomes.push(result); });
let handle;
try {
  handle = await ctx.agents.create({ sessionId: "ensemble-native-" + crypto.randomUUID(), meta: { cwd: source }, agentOptions: { provider: "ensemble-verification", model: "deterministic" } });
  const parent = handle.agent;
  const workspace = await ctx.workspaceRegistry.create(source);
  await workspace.attachSession(parent.id);
  const signal = AbortSignal.timeout(15000);
  script.push(tool("root-native-call"), text("root observed result"));
  parent.followup(createUserMessage({ content: [{ type: "text", text: "verify root" }], source: { kind: "user" } }));
  await parent.whenIdle();
  if (!captures[0]) console.error(JSON.stringify({ outcomes, events: (await ctx.sessionQuery.readSession(parent.id)).events }, null, 2));
  assert.equal(captures[0]?.sessionId, parent.id);
  assert.equal(captures[0]?.rootSessionId, parent.id);
  assert.equal(captures[0]?.workspaceId, workspace.id);
  script.push(tool("child-native-call"), text("child observed result"));
  const child = await ctx.subagents.startActivation({ provider: "spawn", name: "member", label: "identity member", parent, prompt: [{ type: "text", text: "verify child" }], agentOptions: { model: "deterministic" }, delivery: "caller", signal });
  await child.result;
  assert.equal(captures[1]?.sessionId, child.childId);
  assert.equal(captures[1]?.rootSessionId, parent.id);
  assert.equal(captures[1]?.workspaceId, workspace.id);
  assert.equal(outcomes.filter(result => !result.isError).length, 2);
  const noAgent = await ctx.tools.execute({ signal, calls: [{ type: "tool-call", id: "no-agent", name: "ensemble_identity_verification", arguments: "{}" }] });
  assert.equal(noAgent.results[0].result.isError, true);
  assert.throws(() => nativeIdentity(runtime, { ...parent }), /exact live/);
  const log = (await ctx.sessionQuery.readSession(child.childId)).events;
  assert(log.some(event => event.type === "tool/result"));
  await writeFile(join(scratch, "evidence.json"), JSON.stringify({ captures, noAgentDenied: true, copiedAgentDenied: true, nativeToolResults: outcomes.length, paidModel: false }, null, 2));
  console.log("PASS real native AgentLoop, ToolRunner, parent/child root, Workspace, no-agent and copied-agent refusal");
  console.log("EVIDENCE " + join(scratch, "evidence.json"));
} finally {
  if (handle) { await ctx.subagents.drainDescendants([handle.agent]); await handle.dispose(); }
  await ctx.fiber.dispose();
}
