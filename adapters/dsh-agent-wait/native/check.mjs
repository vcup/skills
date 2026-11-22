/** Maintained native lifecycle gate. Fault injection is confined to this process. */
import assert from "node:assert/strict";
import { writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import { createFixture } from "./fixture.mjs";

const fixture = await createFixture();
const { ctx, parent, call, start, wake, once, script, text, tool, outcomes, createUserMessage } = fixture;
const failures = [];
async function check(name, action) {
  try { await action(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
const originalList = ctx.subagents.listDescendants.bind(ctx.subagents);
try {
  const a = await start("a"); await a.result;
  const b = await start("b"); await b.result;
  await check("timeout aborts outstanding discovery", async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let discoverySignal;
    ctx.subagents.listDescendants = async (id, signal) => {
      discoverySignal = signal; entered.resolve(); await release.promise;
      return originalList(id, signal);
    };
    try {
      const pending = call({ agents: ["a"], timeout_ms: 30 });
      await entered.promise;
      const result = await pending;
      assert.equal(result.value?.timedOut, true);
      assert.equal(discoverySignal.aborted, true, "deadline must cancel the underlying read");
    } finally { ctx.subagents.listDescendants = originalList; release.resolve(); }
  });
  await check("same native wait latches A reversion before B and resumes same turn", async () => {
    const entered = Promise.withResolvers();
    ctx.subagents.listDescendants = async (...args) => { const rows = await originalList(...args); entered.resolve(); return rows; };
    script.push(tool("same-turn-all", { agents: ["a", "b"], condition: "all" }), text("continued after one wait"));
    parent.followup(createUserMessage({ content: [{ type: "text", text: "wait all" }], source: { kind: "user" } }));
    await entered.promise;
    ctx.subagents.listDescendants = originalList;
    const aEnded = once("subagent/end", info => info.id === a.childId);
    await wake(a.childId); await aEnded;
    assert.equal(outcomes.has("same-turn-all"), false);
    const bEnded = once("subagent/end", info => info.id === b.childId);
    await wake(b.childId); await parent.whenIdle(); await bEnded;
    assert.deepEqual(outcomes.get("same-turn-all")?.value?.changed, ["a", "b"]);
    const events = (await ctx.sessionQuery.readSession(parent.id)).events;
    await writeFile(join(fixture.root, "parent-events.json"), JSON.stringify(events, null, 2));
    const waits = events.filter(e => e.type === "tool/result" && e.data.message.toolCallId === "same-turn-all");
    assert.equal(waits.length, 1);
    assert.equal(waits[0].data.turn, 1);
    const continued = events.filter(e => e.type === "assistant/message" && e.data.message.content.some(b => b.type === "text" && b.text === "continued after one wait"));
    assert.equal(continued.length, 1);
    assert.equal(continued[0].data.turn, 1);
  });
  await check("ToolRunner refuses invalid or unauthorized selections", async () => {
    for (const args of [{ agents: ["missing"] }, { agents: ["lead"] }, { agents: [parent.id] }, { agents: [] }, { agents: ["a", a.childId] }, { timeout_ms: 0 }, { event: "completed" }, { timeoutMs: 1 }, { event: null }]) {
      assert.equal((await call(args)).isError, true, JSON.stringify(args));
    }
  });
  await check("idle mode and canonical Session IDs remain compatible", async () => {
    assert.equal((await call({ agents: [a.childId], event: "idle" })).value?.members[0]?.name, "a");
    assert.deepEqual((await call({ agents: ["b", "a"], event: "idle", condition: "all" })).value?.satisfiedBy, ["a", "b"]);
    const result = await call({ agents: ["a"], timeout_ms: 10 });
    assert.equal(result.value?.timedOut, true);
    assert.deepEqual(result.value?.changed, []);
  });
  await check("caller cancellation detaches listeners and aborts in-flight discovery", async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const abort = new AbortController();
    const packagePath = await realpath(process.env.WAIT_PACKAGE);
    const subscriptions = [];
    const add = AbortSignal.prototype.addEventListener;
    let discoverySignal;
    AbortSignal.prototype.addEventListener = function (event, listener, options) {
      if (event === "abort" && new Error().stack.split("\n")[2]?.includes(packagePath)) subscriptions.push({ signal: this, listener });
      return add.call(this, event, listener, options);
    };
    ctx.subagents.listDescendants = async (id, signal) => { discoverySignal = signal; entered.resolve(); await release.promise; return originalList(id, signal); };
    try {
      const pending = call({ agents: ["a"] }, abort.signal);
      await entered.promise;
      abort.abort(new Error("native cancellation marker"));
      const result = await pending;
      assert.equal(result.isError, true);
      assert.equal(discoverySignal.aborted, true);
      assert.ok(subscriptions.length >= 2, "positive control: observe actual plugin listeners");
      assert.equal(subscriptions.filter(s => getEventListeners(s.signal, "abort").includes(s.listener)).length, 0);
    } finally {
      AbortSignal.prototype.addEventListener = add;
      ctx.subagents.listDescendants = originalList; release.resolve();
    }
  });
  await check("unbounded waits allocate no timer; finite deadline has one and cleans it", async () => {
    const packagePath = await realpath(process.env.WAIT_PACKAGE);
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
    const active = new Set(); let allocated = 0;
    globalThis.setTimeout = function (fn, ms, ...args) {
      const own = new Error().stack.split("\n")[2]?.includes(packagePath);
      let handle; handle = set(() => { active.delete(handle); fn(...args); }, ms);
      if (own) { allocated++; active.add(handle); }
      return handle;
    };
    globalThis.clearTimeout = function (handle) { active.delete(handle); return clear(handle); };
    try {
      for (const [options, expected] of [[{ timeout_ms: 10000 }, 1], [{}, 0], [{ timeout_ms: null }, 0]]) {
        allocated = 0;
        const entered = Promise.withResolvers();
        const abort = new AbortController();
        ctx.subagents.listDescendants = async (...args) => { const rows = await originalList(...args); entered.resolve(); return rows; };
        const pending = call({ agents: ["a"], ...options }, abort.signal);
        try {
          await entered.promise; await nextTick();
          assert.equal(allocated, expected);
          abort.abort(new Error("timer cleanup")); await pending;
          assert.equal(active.size, 0);
        } finally { abort.abort(); await pending; }
      }
    } finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; ctx.subagents.listDescendants = originalList; }
  });
  await check("native transitions during discovery are latched", async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    ctx.subagents.listDescendants = async (...args) => { const rows = await originalList(...args); entered.resolve(); await release.promise; return rows; };
    try {
      const pending = call({ agents: ["a"], timeout_ms: 10000 });
      await entered.promise;
      const ended = once("subagent/end", info => info.id === a.childId);
      await wake(a.childId); await ended;
      release.resolve();
      assert.deepEqual((await pending).value?.changed, ["a"]);
    } finally { ctx.subagents.listDescendants = originalList; release.resolve(); }
  });
  await check("large catalog and long name budgets fail explicitly, never truncate", async () => {
    // Public discovery fault injection, not synthetic native lifecycle evidence.
    const rows = await originalList(parent.id);
    const template = rows.find(row => row.id === a.childId);
    assert.ok(template);
    try {
      ctx.subagents.listDescendants = async () => Array.from({ length: 10001 }, (_, i) => ({ ...template, id: `id-${i}`, path: `n${i}` }));
      const oversized = await call({ event: "idle", condition: "all" });
      assert.equal(oversized.isError, true);
      assert.equal(oversized.error?.info?.code, "WAIT_RESOURCE_LIMIT");
      assert.match(JSON.stringify(oversized), /budget/);
      // Explicit selection remains possible within a large but bounded tree.
      assert.equal((await call({ agents: ["n0"], event: "idle" })).value?.members.length, 1);
      ctx.subagents.listDescendants = async () => Array.from({ length: 10000 }, (_, i) => ({ ...template, id: `id-${i}`, path: `n${i}` }));
      const large = await call({ event: "idle", condition: "all" });
      assert.equal(large.isError, false);
      assert.equal(large.value.members.length, 10000);
      assert.ok(Buffer.byteLength(JSON.stringify(large.value)) <= 1048576);
      ctx.subagents.listDescendants = async () => [{ ...template, path: "x".repeat(1025) }];
      assert.equal((await call({ event: "idle" })).isError, true);
    } finally { ctx.subagents.listDescendants = originalList; }
  });
  await check("concurrent wait budget releases capacity on cancellation", async () => {
    const aborts = Array.from({ length: 64 }, () => new AbortController());
    const entered = Promise.withResolvers(); let reads = 0;
    ctx.subagents.listDescendants = async (...args) => { const rows = await originalList(...args); if (++reads === 64) entered.resolve(); return rows; };
    const pending = aborts.map(abort => call({ agents: ["a"] }, abort.signal));
    try {
      await entered.promise;
      const overflow = await call({ agents: ["a"] });
      assert.equal(overflow.isError, true);
      assert.match(JSON.stringify(overflow), /too many concurrent waits/);
    } finally {
      aborts.forEach(abort => abort.abort(new Error("concurrent cleanup")));
      await Promise.allSettled(pending);
      ctx.subagents.listDescendants = originalList;
    }
    assert.equal((await call({ agents: ["a"], event: "idle" })).isError, false);
  });
  await check("caller disposal cancels an otherwise unbounded wait", async () => {
    const other = await ctx.agents.create({ sessionId: "disposal-root", meta: { cwd: fixture.root }, agentOptions: { provider: "fixture", model: "child" } });
    const abort = new AbortController();
    let pending;
    try {
      const child = await ctx.subagents.startActivation({ provider: "spawn", name: "target", label: "target", parent: other.agent, prompt: [{ type: "text", text: "init" }], agentOptions: { model: "child" }, delivery: "caller", signal: abort.signal });
      await child.result;
      const entered = Promise.withResolvers();
      ctx.subagents.listDescendants = async (...args) => { const rows = await originalList(...args); entered.resolve(); return rows; };
      pending = call({ agents: ["target"] }, abort.signal, other.agent);
      await entered.promise; await nextTick();
      await other.dispose();
      const result = await pending;
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /calling agent was disposed/);
    } finally {
      abort.abort(); if (pending) await pending;
      ctx.subagents.listDescendants = originalList;
      await other.dispose();
    }
  });
  await check("plugin restart aborts old waits and registers a fresh usable tool", async () => {
    const entered = Promise.withResolvers();
    ctx.subagents.listDescendants = async (...args) => { const rows = await originalList(...args); entered.resolve(); return rows; };
    const pending = call({ agents: ["a"] });
    await entered.promise;
    ctx.subagents.listDescendants = originalList;
    const entry = [...ctx.loader.entries()].find(e => e.options.id === "wait-plugin");
    await entry.fiber.restart();
    const old = await pending;
    assert.equal(old.isError, true);
    assert.match(JSON.stringify(old), /unloaded/);
    assert.equal((await call({ agents: ["a"], event: "idle" })).isError, false);
  });
  await check("real Loader unload cancels discovery before read release", async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    ctx.subagents.listDescendants = async (...args) => { entered.resolve(); await release.promise; return originalList(...args); };
    try {
      const pending = call({ agents: ["a"], timeout_ms: null });
      await entered.promise;
      const entry = [...ctx.loader.entries()].find(e => e.options.id === "wait-plugin");
      assert.ok(entry);
      await entry.fiber.dispose();
      const result = await pending;
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /unloaded/);
      assert.equal(ctx.tools.get("wait_subagents"), undefined);
    } finally { ctx.subagents.listDescendants = originalList; release.resolve(); }
  });
} finally {
  ctx.subagents.listDescendants = originalList;
  await fixture.close();
}
console.log(JSON.stringify({ failures }));
process.exitCode = failures.length ? 1 : 0;
