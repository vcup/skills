import { describe, expect, test } from "bun:test";
import { decodeEnvironmentRequest, decodeEnvironmentResult } from "./service.ts";

describe("receipt result decoder accepts only shapes this domain commits", () => {
  test("accepts every real reducer result", () => {
    for (const value of [
      { action: "set", desired_sequence: 1 },
      { action: "set" },
      { action: "begin_apply", application_id: "apply" },
      { action: "read_grants" },
      { action: "observe_apply" },
      { action: "record_selection" },
      { action: "environment_recover", previous_environment_id: "environment-a", environment_id: "environment-b",
        recovered_from: "a".repeat(40), read_grants_restored: false, native_actions_replayed: false },
    ]) expect(decodeEnvironmentResult(value).ok).toBe(true);
  });
  test("rejects a rewritten result instead of replaying it as a genuine answer", () => {
    for (const value of [
      null, [], "committed",
      { action: "unknown_action" },
      { action: "set", desired_sequence: 1, granted: ["read"] },
      { action: "set", desired_sequence: 0 },
      { action: "begin_apply" },
      { action: "environment_recover", previous_environment_id: "a", environment_id: "b", recovered_from: "a".repeat(40), read_grants_restored: true, native_actions_replayed: false },
      { action: "environment_recover", previous_environment_id: "a", environment_id: "b", recovered_from: "a".repeat(40), read_grants_restored: false, native_actions_replayed: false, extra: 1 },
    ]) expect(decodeEnvironmentResult(value).ok).toBe(false);
  });
});

describe("owner request surface stays closed", () => {
  test("unknown actions, channels and extra fields are refused before any native or ledger effect", () => {
    for (const value of [
      null,
      { action: "environment_set", expected_revision: "absent", operation_id: "set", preferences: { roles: [] }, owner: true },
      { action: "environment_set", expected_revision: "latest", operation_id: "set", preferences: { roles: [] } },
      { action: "environment_apply", expected_revision: "absent", operation_id: "apply", desired_revision: "a".repeat(40), targets: [{ target_id: "t", expected_native_revision: 1, force: true }] },
      { action: "environment_recover", expected_revision: "a".repeat(40), operation_id: "recover", backup_handle: "h" },
      { action: "environment_history", revision: "a".repeat(40), page_size: 0 },
      { action: "environment_history", revision: "a".repeat(40), page_size: 101 },
    ]) expect(decodeEnvironmentRequest(value).ok).toBe(false);
  });
  test("a well-formed owner request decodes to its exact closed shape", () => {
    const request = { action: "environment_apply" as const, expected_revision: "absent" as const, operation_id: "apply",
      desired_revision: "a".repeat(40), targets: [{ target_id: "ensemble-environment", expected_native_revision: 3 }] };
    expect(decodeEnvironmentRequest(request)).toEqual({ ok: true, value: request });
    const selection = { action: "environment_record_selection" as const, expected_revision: "a".repeat(40), operation_id: "sel", attempt_id: "attempt-1" };
    expect(decodeEnvironmentRequest(selection)).toEqual({ ok: true, value: selection });
  });
  test("selection evidence cannot carry a claimed route, member or role", () => {
    for (const value of [
      { action: "environment_record_selection", expected_revision: "absent", operation_id: "sel", attempt_id: "a", member_session_id: "other" },
      { action: "environment_record_selection", expected_revision: "absent", operation_id: "sel", attempt_id: "a", requested: { provider: "p", model: "m" } },
      { action: "environment_record_selection", expected_revision: "absent", operation_id: "sel", attempt_id: "a", actor: "owner" },
      { action: "environment_record_selection", operation_id: "sel", attempt_id: "a" },
    ]) expect(decodeEnvironmentRequest(value).ok).toBe(false);
  });
});
