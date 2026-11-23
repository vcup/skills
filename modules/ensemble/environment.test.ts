import { describe, expect, test } from "bun:test";
import { decodeEnvironmentState, decodePreferences, mayReadEnvironment, recommendEnvironment, reduceEnvironment, type EnvironmentCatalog, type EnvironmentState, type Preferences } from "./environment.ts";
const applicability = { task_types: ["implementation"], interface_versions: [], required_capabilities: ["tools"] };
const preferences: Preferences = { roles: [{ role: "worker", candidates: [
  { provider: "permitted", model: "first", effort: { mode: "explicit", value: "careful" }, applicability, reason: "Owner preference for this task; not a quality ranking." },
  { provider: "denied", model: "second", effort: { mode: "default" }, applicability, reason: "A stored preference does not grant access." },
] }] };
const catalog: EnvironmentCatalog = { session_id: "session", observed_at: 1, selection_enabled: true, inheritance_known: true,
  parent: { provider: "permitted", model: "first", reasoning_effort: "fast" }, authorized_routes: [{ provider: "permitted", model: "first" }],
  routes: [{ provider: "permitted", model: "first", availability: "available", efforts: ["fast", "careful"] }], presets: [], allowed_presets: [] };
const state: EnvironmentState = { format: "ensemble-environment/v1", environment_id: "env", authorization_epoch: 1, read_grants: [], desired: { operation_id: "initial", sequence: 1, preferences }, applications: [], evidence: [] };

describe("environment advice through the public interface", () => {
  test("keeps owner order, explains allowance, and supplies only explicit native arguments", () => {
    const r = recommendEnvironment(preferences, "worker", applicability, catalog);
    expect(r.candidates[0]?.request).toEqual({ provider: "permitted", model: "first", reasoning_effort: "careful" });
    expect(r.candidates[1]?.availability).toBe("unavailable");
    expect(r.candidates[1]?.request).toBeUndefined();
    expect(r.candidates[1]?.reasons.join(" ")).toContain("authorization");
    expect(r.candidates.map(c => c.preference.model)).toEqual(["first", "second"]);
  });
  test("does not synthesize a fallback when first choice disappears", () => {
    const r = recommendEnvironment(preferences, "worker", applicability, { ...catalog, routes: [{ ...catalog.routes[0]!, availability: "unavailable" }] });
    expect(r.next_action).toBe("resolve_gap");
    expect(r.candidates.every(c => c.request === undefined)).toBe(true);
  });
  test("unknown metadata and task context are not affirmative recommendations", () => {
    const r = recommendEnvironment(preferences, "worker", { task_types: [], interface_versions: [], required_capabilities: [] }, { ...catalog, routes: [] });
    expect(r.candidates[0]?.availability).toBe("unknown");
    expect(r.candidates[0]?.applicability).toBe("unknown");
    expect(r.candidates[0]?.request).toBeUndefined();
  });
  test("efforts and presets need exact native support", () => {
    const p: Preferences = { roles: [{ role: "worker", candidates: [{ ...preferences.roles[0]!.candidates[0]!, preset: "admin" }] }] };
    expect(recommendEnvironment(p, "worker", applicability, catalog).candidates[0]?.availability).toBe("unavailable");
    expect(recommendEnvironment(preferences, "worker", applicability, { ...catalog, routes: [{ ...catalog.routes[0]!, efforts: ["fast"] }] }).candidates[0]?.availability).toBe("unavailable");
  });
  test("inherit omits every route field and refuses cross-route inheritance", () => {
    const p: Preferences = { roles: [{ role: "worker", candidates: [{ ...preferences.roles[0]!.candidates[0]!, effort: { mode: "inherit" } }] }] };
    expect(recommendEnvironment(p, "worker", applicability, { ...catalog, selection_enabled: false }).candidates[0]?.request).toEqual({});
    expect(recommendEnvironment(p, "worker", applicability, { ...catalog, parent: { provider: "other", model: "other" } }).candidates[0]?.request).toBeUndefined();
  });
  test("inherit does not claim parent selection when trusted defaults are unobserved", () => {
    const p: Preferences = { roles: [{ role: "worker", candidates: [{ ...preferences.roles[0]!.candidates[0]!, effort: { mode: "inherit" } }] }] };
    const r = recommendEnvironment(p, "worker", applicability, { ...catalog, inheritance_known: false });
    expect(r.candidates[0]?.availability).toBe("unknown"); expect(r.candidates[0]?.request).toBeUndefined();
  });
  test("explicit route with default effort never copies parent effort", () => {
    const p: Preferences = { roles: [{ role: "worker", candidates: [{ ...preferences.roles[0]!.candidates[0]!, effort: { mode: "default" } }] }] };
    expect(recommendEnvironment(p, "worker", applicability, catalog).candidates[0]?.request).toEqual({ provider: "permitted", model: "first" });
  });
});
describe("closed environment state", () => {
  test("rejects credential fields, unknown inputs, duplicate roles, and null", () => {
    for (const value of [null, { ...preferences, credentials: "never-store" }, { roles: [preferences.roles[0], preferences.roles[0]] }]) expect(decodePreferences(value).ok).toBe(false);
    expect(decodeEnvironmentState({ ...state, project_grants: [] }).ok).toBe(false);
  });
  test("desired is distinct from application; pending prevents competing mutation", () => {
    const desired = reduceEnvironment(state, { action: "set", operation_id: "new", preferences });
    expect(desired.ok && desired.value.applications).toEqual([]);
    const begun = reduceEnvironment(state, { action: "begin_apply", desired_sequence: 1, application: { operation_id: "apply", desired_revision: "a".repeat(40), preferences,
      targets: [{ target_id: "native", expected_native_revision: 3, status: "pending", detail: "Intent saved before native write." }] } });
    expect(begun.ok).toBe(true); if (!begun.ok) return;
    expect(reduceEnvironment(begun.value, { action: "set", operation_id: "race", preferences }).ok).toBe(false);
    const settled = reduceEnvironment(begun.value, { action: "observe_apply", operation_id: "apply", targets: [{ target_id: "native", expected_native_revision: 3, observed_native_revision: 4, status: "applied", detail: "Read back from native Settings." }] });
    expect(settled.ok && settled.value.applications[0]?.targets[0]?.status).toBe("applied");
    const uncertain = reduceEnvironment(begun.value, { action: "observe_apply", operation_id: "apply", targets: [{ target_id: "native", expected_native_revision: 3, status: "unknown", detail: "Read failed." }] });
    expect(uncertain.ok).toBe(true);
    if (uncertain.ok) {
      expect(reduceEnvironment(uncertain.value, { action: "set", operation_id: "unsafe", preferences }).ok).toBe(false);
      expect(reduceEnvironment(uncertain.value, { action: "read_grants", grants: [] }).ok).toBe(true);
    }
    expect(reduceEnvironment(state, { action: "begin_apply", desired_sequence: 9, application: { operation_id: "old", desired_revision: "a".repeat(40), preferences, targets: [{ target_id: "native", expected_native_revision: 3, status: "pending", detail: "Wrong desired revision." }] } }).ok).toBe(false);
    expect(reduceEnvironment(begun.value, { action: "observe_apply", operation_id: "apply", targets: [{ target_id: "forged", expected_native_revision: 3, status: "applied", detail: "claim" }] }).ok).toBe(false);
  });
  test("environment read requires its own current identity grant, not workspace or project grants", () => {
    const actor = { kind: "session" as const, sessionId: "s", rootSessionId: "r", workspaceRef: "workspace", callId: "c" };
    expect(mayReadEnvironment(state, actor, "host", 5)).toBe(false);
    const granted = { ...state, read_grants: [{ subject: { kind: "session" as const, sessionId: "s", rootSessionId: "r" }, expires_at: 10 }] };
    expect(mayReadEnvironment(granted, actor, "host", 5)).toBe(true);
    expect(mayReadEnvironment(granted, actor, "host", 10)).toBe(false);
    expect(mayReadEnvironment(granted, { ...actor, rootSessionId: "other" }, "host", 5)).toBe(false);
  });
  test("selection evidence distinguishes request, creation and actual unknown without prompt copies", () => {
    const evidence = { evidence_id: "e", attempt_id: "attempt", requested: { provider: "p", model: "m" }, created: { status: "observed" as const, session_id: "s", event_seq: 1, provider: "p", model: "m" }, actual: { status: "unknown" as const, reason: "No authorized actual request event." } };
    const r = reduceEnvironment(state, { action: "record_selection", evidence });
    expect(r.ok && r.value.evidence[0]?.actual.status).toBe("unknown");
    expect(reduceEnvironment(state, { action: "record_selection", evidence: { ...evidence, requested: { ...evidence.requested, prompt: "secret" } } } as never).ok).toBe(false);
  });
});
