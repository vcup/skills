import { describe, expect, test } from "bun:test";
import { buildSelectionEvidence, collectSelectionEvidence, type NativeSessionLog } from "./selection.ts";
const request = { attempt_id: "attempt-1", evidence_id: "evidence-1", member_session_id: "member-1", requested: { provider: "p", model: "m", reasoning_effort: "high" } };
const log = (events: readonly { seq: number; type: string; data: unknown }[], inherited = 0): NativeSessionLog => ({ session_id: "member-1", inherited_event_count: inherited, events });
const descriptor = (seq: number, data: Record<string, unknown>) => ({ seq, type: "subagent/descriptor", data: { mode: "continuable", ...data } });
const header = (seq: number, config: Record<string, unknown>, defaults?: unknown) => ({ seq, type: "request/header", data: { header: { config, ...(defaults === undefined ? {} : { adapterDefaults: defaults }) } } });
const response = (seq: number, source: Record<string, unknown>) => ({ seq, type: "assistant/message", data: { message: { source: { kind: "model", ...source }, content: [{ text: "private body" }] } } });

describe("selection evidence keeps requested, created and actual separate", () => {
  test("reports each observed stage with its own native event reference", () => {
    const evidence = buildSelectionEvidence(request, log([
      descriptor(2, { agentProvider: "p", agentModel: "m", agentReasoningEffort: "high" }),
      header(3, { provider: "p", model: "m", reasoningEffort: "high" }),
      response(4, { provider: "p", model: "m" }),
    ]));
    expect(evidence.requested).toEqual({ provider: "p", model: "m", reasoning_effort: "high" });
    expect(evidence.created).toEqual({ status: "observed", session_id: "member-1", event_seq: 2, provider: "p", model: "m", reasoning_effort: "high" });
    expect(evidence.actual).toEqual({ status: "observed", session_id: "member-1", event_seq: 4, provider: "p", model: "m", reasoning_effort: "high" });
  });
  test("never copies a fork-inherited prefix or a prompt body into evidence", () => {
    const evidence = buildSelectionEvidence(request, log([
      descriptor(0, { agentProvider: "parent", agentModel: "parent" }),
      response(1, { provider: "parent", model: "parent" }),
      response(6, { provider: "p", model: "m" }),
    ], 5));
    expect(evidence.created).toEqual({ status: "unknown", reason: "No native continuation descriptor in this member Session's own events." });
    expect(evidence.actual).toEqual({ status: "observed", session_id: "member-1", event_seq: 6, provider: "p", model: "m" });
    expect(JSON.stringify(evidence)).not.toContain("private body");
    expect(JSON.stringify(evidence)).not.toContain("parent");
  });
  test("a prepared header or a model claim is neither creation nor actual use", () => {
    const evidence = buildSelectionEvidence(request, log([header(3, { provider: "claimed", model: "claimed" })]));
    expect(evidence.created.status).toBe("unknown");
    expect(evidence.actual.status).toBe("unknown");
    expect(JSON.stringify(evidence)).not.toContain("claimed");
  });
  test("an adapter-materialized default effort is not reported as an observed effort", () => {
    const evidence = buildSelectionEvidence(request, log([
      descriptor(2, { agentProvider: "p", agentModel: "m" }),
      header(3, { provider: "p", model: "m", reasoningEffort: "adapter-default" }, { reasoningEffort: true }),
      response(4, { provider: "p", model: "m" }),
    ]));
    expect(evidence.actual).toEqual({ status: "observed", session_id: "member-1", event_seq: 4, provider: "p", model: "m" });
  });
  test("a response for a different route never inherits the previous header's effort", () => {
    const evidence = buildSelectionEvidence(request, log([
      descriptor(2, { agentProvider: "p", agentModel: "m" }),
      header(3, { provider: "p", model: "other", reasoningEffort: "high" }),
      response(4, { provider: "p", model: "m" }),
    ]));
    expect(evidence.actual).toEqual({ status: "observed", session_id: "member-1", event_seq: 4, provider: "p", model: "m" });
  });
});

describe("collecting evidence from a native observation", () => {
  const source = (value: NativeSessionLog | undefined) => ({ async observe() { return value; } });
  test("an unreadable member log is unavailable, not invented creation or use", async () => {
    const result = await collectSelectionEvidence(source(undefined), request, new AbortController().signal);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.created.status).toBe("unavailable");
    expect(result.value.actual.status).toBe("unavailable");
    expect(result.value.requested).toEqual(request.requested);
  });
  test("rejects a log for another Session, unpaired routes, unknown fields and credentials", async () => {
    const signal = new AbortController().signal;
    expect((await collectSelectionEvidence(source({ ...log([]), session_id: "other" }), request, signal)).ok).toBe(false);
    expect((await collectSelectionEvidence(source(log([])), { ...request, requested: { provider: "p" } }, signal)).ok).toBe(false);
    expect((await collectSelectionEvidence(source(log([])), { ...request, requested: { reasoning_effort: "high" } }, signal)).ok).toBe(false);
    expect((await collectSelectionEvidence(source(log([])), { ...request, credential: "never" }, signal)).ok).toBe(false);
    expect((await collectSelectionEvidence(source(log([])), null, signal)).ok).toBe(false);
  });
  test("releases the observation even when the request is refused", async () => {
    let released = 0;
    const source = { async observe() { return { ...log([]), session_id: "other", release: () => { released++; } }; } };
    expect((await collectSelectionEvidence(source, request, new AbortController().signal)).ok).toBe(false);
    expect(released).toBe(1);
  });
});
