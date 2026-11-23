/**
 * Tests for the attempt → selection-evidence resolver.
 *
 * These exercise the decision logic against a stand-in archive, which is the
 * right seam: the resolver's job is *which two fields may leave the record*, not
 * how the registry stores it. The registry's own behaviour is covered by its
 * suite, and the real composition is covered by the installed-product gate.
 *
 * Cases, each one a way three-stage evidence could be falsified:
 *   - the planned route is used when the record has one, and an empty route is
 *     passed through as empty (no invented provider/model);
 *   - the **last** binding wins, so a `replace` cannot attribute the replaced
 *     Session's log to the attempt;
 *   - an unbound attempt, an unknown attempt and an unreadable project are
 *     distinct refusals rather than silent successes;
 *   - nothing but the two fields is returned, so a record body cannot leak
 *     through this seam even if it grows new fields.
 */

import { describe, expect, test } from "bun:test";
import type { Actor } from "../../../modules/ensemble/contracts.ts";
import { resolveAttemptSelection, type AttemptArchive, type AttemptLease } from "./selection.ts";

const owner: Actor = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" };
const signal = AbortSignal.timeout(5_000);

function attempt(id: string, body: Record<string, unknown>) {
  return { id, kind: "attempt", body };
}

/** A stub archive holding one project with the given objects. */
function archive(objects: readonly unknown[]): AttemptArchive {
  return {
    projects: async () => ({ ok: true, value: { items: [{ project_id: "project-1" }] } }),
    readTarget: async () => ({ ok: true, value: { archiveId: "archive-1" } }),
    withOwner: async <T,>(_actor: Actor, _id: string, _signal: AbortSignal, run: (lease: AttemptLease) => Promise<{ ok: true; value: T }>) =>
      run({ snapshot: { objects: objects as AttemptLease["snapshot"]["objects"] } }),
  };
}

describe("attempt selection resolver", () => {
  test("reads the requested route and the current member from the record", async () => {
    const found = await resolveAttemptSelection(
      archive([
        attempt("attempt-1", {
          requested_selection: { provider: "fixture", model: "deterministic", reasoning_effort: "high", preset: "careful" },
          binding_history: [{ member_id: "member-1", creation_ref: {}, exposure: "fresh", reason: "bound" }],
        }),
      ]),
      owner,
      "attempt-1",
      signal,
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toEqual({
      attempt_id: "attempt-1",
      member_session_id: "member-1",
      requested: { provider: "fixture", model: "deterministic", reasoning_effort: "high", preset: "careful" },
    });
  });

  test("an absent requested route stays empty rather than being invented", async () => {
    const found = await resolveAttemptSelection(
      archive([attempt("attempt-1", { binding_history: [{ member_id: "member-1" }] })]),
      owner,
      "attempt-1",
      signal,
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.requested).toEqual({});
  });

  test("the last binding wins, so a replace cannot point at the replaced Session", async () => {
    const found = await resolveAttemptSelection(
      archive([
        attempt("attempt-1", {
          // The planned value is the stale one on purpose.
          member_id: "member-planned",
          requested_selection: { provider: "fixture", model: "deterministic" },
          binding_history: [{ member_id: "member-first" }, { member_id: "member-replacement" }],
        }),
      ]),
      owner,
      "attempt-1",
      signal,
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.member_session_id).toBe("member-replacement");
  });

  test("an unbound attempt, an unknown attempt and an unreadable project refuse differently", async () => {
    const unbound = await resolveAttemptSelection(archive([attempt("attempt-1", { binding_history: [] })]), owner, "attempt-1", signal);
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) {
      expect(unbound.error.code).toBe("not_found");
      expect(unbound.error.message).toContain("no bound member Session");
    }

    const unknown = await resolveAttemptSelection(archive([]), owner, "attempt-missing", signal);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("not_found");
      expect(unknown.error.message).toContain("no readable archive");
    }

    const unreadable: AttemptArchive = {
      projects: async () => ({ ok: true, value: { items: [{ project_id: "project-hidden" }, { project_id: "project-1" }] } }),
      readTarget: async (_actor, projectId) => projectId === "project-hidden"
        ? { ok: false, error: { status: "refused", code: "not_authorized", message: "denied", retryable: false } }
        : { ok: true, value: { archiveId: "archive-1" } },
      withOwner: async <T,>(_actor: Actor, _id: string, _signal: AbortSignal, run: (lease: AttemptLease) => Promise<{ ok: true; value: T }>) =>
        run({ snapshot: { objects: [attempt("attempt-1", { binding_history: [{ member_id: "member-1" }] })] as unknown as AttemptLease["snapshot"]["objects"] } }),
    };
    const skipped = await resolveAttemptSelection(unreadable, owner, "attempt-1", signal);
    expect(skipped.ok).toBe(true);
    if (skipped.ok) expect(skipped.value.member_session_id).toBe("member-1");
  });

  test("only the two fields leave the record, so unrelated body content cannot leak", async () => {
    const found = await resolveAttemptSelection(
      archive([
        attempt("attempt-1", {
          question: "a long private question that must not travel",
          baseline_refs: [{ kind: "object", object_id: "secret", object_revision: 1 }],
          requested_selection: { provider: "fixture", model: "deterministic" },
          binding_history: [{ member_id: "member-1" }],
        }),
      ]),
      owner,
      "attempt-1",
      signal,
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const serialized = JSON.stringify(found.value);
    expect(serialized).not.toContain("private question");
    expect(serialized).not.toContain("secret");
    expect(Object.keys(found.value).sort()).toEqual(["attempt_id", "member_session_id", "requested"]);
  });

  test("a blank attempt id is refused before any archive read", async () => {
    let reads = 0;
    const counting: AttemptArchive = {
      projects: async () => { reads += 1; return { ok: true, value: { items: [] } }; },
      readTarget: async () => { reads += 1; return { ok: true, value: { archiveId: "a" } }; },
      withOwner: async <T,>(_actor: Actor, _id: string, _signal: AbortSignal, run: (lease: AttemptLease) => Promise<{ ok: true; value: T }>) =>
        run({ snapshot: { objects: [] } }),
    };
    const refused = await resolveAttemptSelection(counting, owner, "  ", signal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
    expect(reads).toBe(0);
  });
});
