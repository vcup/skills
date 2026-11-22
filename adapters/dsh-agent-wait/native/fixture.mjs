/** Native test adapter: only model I/O is deterministic; DSH agents/tools/storage are real. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createFixture() {
  const root = process.env.WAIT_FIXTURE;
  const runtime = process.env.WAIT_RUNTIME;
  const home = process.env.WAIT_PROFILE_HOME;
  assert.ok(root && runtime && home && process.env.WAIT_PACKAGE, "use scripts/verify-dsh-wait.ts");
  const req = createRequire(join(runtime, "package.json"));
  const load = async name => import(pathToFileURL(req.resolve(name)).href);
  const { boot, loadProfile, createRuntimeResolution, PluginPackages, evaluatePluginCompatibility } = await load("@deepseek-ai/dsh-app-boot");
  const { LlmAdapter, createUserMessage, isAgentLoopRequest } = await load("@deepseek-ai/dsh-llm");
  const manifest = JSON.parse(await readFile(join(home, "profiles/web/node_modules/dsh-agent-wait/package.json"), "utf8"));
  assert.equal(manifest.version, process.env.WAIT_EXPECT_VERSION);
  for (const version of ["0.2.2-rc.4", "0.2.2-rc.5"]) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined);
  for (const version of ["0.2.2-rc.3", "0.2.2-rc.6", "0.2.2", "0.3.0"]) assert.ok(evaluatePluginCompatibility(manifest, {}, version));
  const installAnchor = req.resolve("@deepseek-ai/dsh/package.json");
  const profile = loadProfile("wait-native-check", "web", installAnchor, home);
  const resolution = await createRuntimeResolution({ installAnchor, profile, home });
  for (const name of Object.keys(manifest.peerDependencies)) {
    const rows = resolution.entries.filter(r => r.name === name);
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].scope, "installation", name);
  }
  const pnpmFiles = await readdir(join(home, "profiles/web/node_modules/.pnpm"));
  assert.ok(!pnpmFiles.some(n => n.startsWith("@deepseek-ai+")), "no profile-private runtime copies");
  await mkdir(root, { recursive: true });
  const modules = ["llm", "session", "agent", "system-prompt", "tools", "tool-executor-native", "session-projection", "agent-loop", "fs-local", "working-directory", "session-query-sqlite", "session-persistence-jsonl", "subagent", "subagent-spawn-in-process"];
  const configs = {
    "session-persistence-jsonl": { root: join(root, "sessions") }, "agent-loop": { agents: [] },
    "fs-local": { cwd: root }, "working-directory": { defaultDirectory: root },
    "session-query-sqlite": { path: ":memory:", openAt: "never" }, "subagent-spawn-in-process": { providerName: "spawn" },
  };
  const rows = modules.map(name => ({ id: name, name: req.resolve(`@deepseek-ai/dsh-${name}`), ...(configs[name] ? { config: configs[name] } : {}) }));
  // Installed entry, never source import or a manual module symlink. The minimal
  // composition lives outside the profile, so its entry path must be explicit;
  // PluginPackages below still resolves all peers through the official profile.
  rows.push({ id: "wait-plugin", name: process.env.WAIT_PACKAGE });
  await writeFile(join(root, "cordis.yml"), rows.map(row => `- ${JSON.stringify(row)}`).join("\n") + "\n");
  const ctx = await boot("wait-native-check", join(root, "cordis.yml"), [], async ctx => { await ctx.plugin(PluginPackages, { resolution }); });
  const script = [];
  function text(value) {
    return [{ type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text: value }, { type: "block-end", index: 0, block: { type: "text", text: value } }, { type: "finish", reason: { kind: "stop" } }];
  }
  function tool(id, args) {
    const call = { type: "tool-call", id, name: "wait_subagents", arguments: JSON.stringify(args) };
    return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name: call.name, argumentsDelta: call.arguments }, { type: "block-end", index: 0, block: call }, { type: "finish", reason: { kind: "tool-calls" } }];
  }
  class Deterministic extends LlmAdapter {
    async *stream(options) {
      const output = isAgentLoopRequest(options) && options.model === "parent" ? (script.shift() ?? text("parent done")) : text("child done");
      for (const chunk of output) { options.signal?.throwIfAborted(); yield chunk; }
    }
  }
  ctx.llm.registerAdapter(["fixture"], new Deterministic());
  const handle = await ctx.agents.create({ sessionId: "native-root", meta: { cwd: root }, agentOptions: { provider: "fixture", model: "parent" } });
  const parent = handle.agent;
  const controller = new AbortController();
  const outcomes = new Map();
  const calls = new Set();
  ctx.on("tools/result", (exec, result) => outcomes.set(exec.callId, result));
  let serial = 0;
  const call = (args, signal = controller.signal, agent = parent) => {
    const id = `direct-${++serial}`;
    const pending = ctx.tools.execute({ agent, signal, calls: [{ type: "tool-call", id, name: "wait_subagents", arguments: JSON.stringify(args) }] }).then(r => r.results[0].result);
    calls.add(pending);
    void pending.finally(() => calls.delete(pending)).catch(() => {});
    return pending;
  };
  const start = name => ctx.subagents.startActivation({ provider: "spawn", name, label: name, parent, prompt: [{ type: "text", text: "initial" }], agentOptions: { model: "child" }, delivery: "caller", signal: controller.signal });
  const wake = id => ctx.subagents.sendMessage(parent, id, [{ type: "text", text: "wake" }], { signal: controller.signal });
  const once = (event, predicate = () => true) => new Promise(resolve => { const off = ctx.on(event, payload => { if (predicate(payload)) { off(); resolve(payload); } }); });
  return {
    ctx, parent, root, call, start, wake, once, script, text, tool, outcomes, createUserMessage,
    async close() {
      controller.abort(new Error("fixture teardown"));
      await Promise.allSettled(calls);
      await ctx.subagents.drainDescendants([parent]);
      await handle.dispose();
      await ctx.fiber.dispose();
    },
  };
}
