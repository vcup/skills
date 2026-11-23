import { expect, test } from "bun:test";
import { createNativePreferences, discoverEnvironmentCatalog } from "./native.ts";

test("Settings binding uses actual registered ids and redacted field-only CAS", async () => {
  const calls: unknown[] = [];
  const native = createNativePreferences({ describe(options) { calls.push(options); return [{ ns: "actual-entry", revision: 4, value: { rolePreferences: { roles: [] }, secret: "not-copied" } }]; },
    async update(ns, patch, revision) { calls.push([ns, patch, revision]); } }, ["actual-entry"]);
  const signal = new AbortController().signal;
  expect(await native.read("actual-entry", signal)).toEqual({ ok: true, value: { target_id: "actual-entry", revision: 4, preferences: { roles: [] } } });
  expect((await native.read("guessed-entry", signal)).ok).toBe(false);
  expect((await native.apply("actual-entry", { roles: [] }, 4, signal)).ok).toBe(true);
  expect(calls).toEqual([{ redactSecrets: true }, ["actual-entry", { rolePreferences: { roles: [] } }, 4]]);
});

test("Settings transport loss is unknown and never retries internally", async () => {
  let writes = 0;
  const native = createNativePreferences({ describe: () => [], async update() { writes++; throw new Error("private endpoint credential text must not escape"); } }, ["entry"]);
  const result = await native.apply("entry", { roles: [] }, 0, new AbortController().signal);
  expect(writes).toBe(1);
  expect(result.ok).toBe(false);
  if (!result.ok) { expect(result.error.code).toBe("outcome_unknown"); expect(result.error.message).not.toContain("credential text"); }
});

test("discovery resolves only exact native-authorized routes and advertised efforts", async () => {
  const queried: string[] = [];
  const result = await discoverEnvironmentCatalog({ sessionId: "s", validate: () => true, policy: [{ provider: "p", model: "allowed" }], selectionEnabled: true, allowedPresets: ["safe"],
    llm: { listProviders: () => [{ id: "p" }, { id: "unrelated" }], async resolveModelInfo(p, m) { queried.push(`${p}/${m}`); return { id: m, reasoning: { efforts: [{ id: "careful" }] } }; }, async resolveCallConfig() { return {}; } },
    presets: { async list() { return [{ id: "safe" }, { id: "forbidden" }]; } },
  }, new AbortController().signal);
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(queried).toEqual(["p/allowed"]); expect(result.value.routes[0]?.efforts).toEqual(["careful"]);
  expect(result.value.presets).toEqual([{ id: "safe", availability: "available" }]);
  expect(result.value.inheritance_known).toBe(false);
});

test("native caller revocation during discovery rejects before facts escape", async () => {
  let valid = true;
  const result = await discoverEnvironmentCatalog({ sessionId: "s", validate: () => valid, parent: { provider: "p", model: "parent" }, selectionEnabled: true, allowedPresets: [],
    llm: { listProviders: () => [{ id: "p" }], async resolveModelInfo(_p, m) { valid = false; return { id: m }; }, async resolveCallConfig() { return {}; } },
  }, new AbortController().signal);
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe("not_authorized");
});

test("provider/preset outages remain unknown rather than synthetic availability", async () => {
  const result = await discoverEnvironmentCatalog({ sessionId: "s", validate: () => true, parent: { provider: "p", model: "m" }, selectionEnabled: false, allowedPresets: ["p"],
    llm: { listProviders: () => [{ id: "p" }], async resolveModelInfo() { throw Error("offline"); }, async resolveCallConfig() { return {}; } }, presets: { async list() { throw Error("offline"); } },
  }, new AbortController().signal);
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.value.routes[0]?.availability).toBe("unknown"); expect(result.value.presets[0]?.availability).toBe("unknown");
});
