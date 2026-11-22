/** An ordinary scenario plugin inserted into the installed default web profile. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";

const req = createRequire(`${process.env.WAIT_RUNTIME}/package.json`);
const { LlmAdapter, createUserMessage, isAgentLoopRequest } = await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-llm")).href);
export const name = "wait-native-cli-check";
export const inject = ["llm", "agents", "subagents", "tools", "sessionQuery", "appReady", "appExit"];
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { void run(ctx).catch(error => { console.error(error); ctx.appExit(1); }); }));
}
async function run(ctx) {
  assert.ok(ctx.tools.get("wait_subagents"), "the standard profile must activate the installed bundle");
  const root = process.env.WAIT_FIXTURE;
  await mkdir(root, { recursive: true });
  let step = 0;
  class Deterministic extends LlmAdapter {
    async *stream(options) {
      const parentRequest = isAgentLoopRequest(options) && options.model === "wait-parent";
      if (parentRequest && step++ === 0) {
        const call = { type: "tool-call", id: "cli-wait", name: "wait_subagents", arguments: '{"agents":["worker"]}' };
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
        yield { type: "block-end", index: 0, block: call };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        const text = parentRequest ? "native CLI continued" : "child done";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  }
  ctx.llm.registerAdapter(["wait-native"], new Deterministic());
  const handle = await ctx.agents.create({ sessionId: `wait-cli-${randomUUID()}`, meta: { cwd: root }, agentOptions: { provider: "wait-native", model: "wait-parent" } });
  const parent = handle.agent;
  const controller = new AbortController();
  const list = ctx.subagents.listDescendants.bind(ctx.subagents);
  let exit = 1;
  try {
    const child = await ctx.subagents.startActivation({ provider: "spawn", name: "worker", label: "worker", parent, prompt: [{ type: "text", text: "initialize" }], agentOptions: { model: "wait-child" }, delivery: "caller", signal: controller.signal });
    await child.result;
    const entered = Promise.withResolvers();
    ctx.subagents.listDescendants = async (...args) => { const entries = await list(...args); entered.resolve(); return entries; };
    parent.followup(createUserMessage({ content: [{ type: "text", text: "wait" }], source: { kind: "user" } }));
    await entered.promise;
    ctx.subagents.listDescendants = list;
    const ended = new Promise(resolve => { const off = ctx.on("subagent/end", info => { if (info.id === child.childId) { off(); resolve(); } }); });
    await ctx.subagents.sendMessage(parent, child.childId, [{ type: "text", text: "resume" }], { signal: controller.signal });
    await parent.whenIdle(); await ended;
    const events = (await ctx.sessionQuery.readSession(parent.id)).events;
    const results = events.filter(e => e.type === "tool/result" && e.data.message.toolCallId === "cli-wait");
    assert.equal(results.length, 1);
    assert.equal(results[0].data.message.isError, false);
    const continuation = events.find(e => e.type === "assistant/message" && e.data.message.content.some(block => block.type === "text" && block.text === "native CLI continued"));
    assert.equal(results[0].data.turn, 1);
    assert.equal(continuation?.data.turn, 1);
    console.log("PASS standard CLI bundle activation and native same-turn continuation");
    exit = 0;
  } finally {
    ctx.subagents.listDescendants = list;
    controller.abort();
    await ctx.subagents.drainDescendants([parent]);
    await handle.dispose();
  }
  ctx.appExit(exit);
}
