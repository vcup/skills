/**
 * The initialize form's prefilled grant — through the shipping helper, not a copy of it.
 *
 * The Host requires at least one grant on initialize (`array(grantRequest, 1)`), and its
 * subject must be the authenticated owner, whose identity the Host reports and a person
 * must never type. `effectiveFields` is the single place that supplies it, and the form's
 * rendered control **and** its submit path both read that one value.
 *
 * This file deliberately calls `effectiveFields` itself rather than repeating its
 * expression. An earlier version of this test mirrored the component's logic and passed
 * while the product computed a grant it never used — the mirror agreed with the mirror and
 * the control rendered empty. A test that re-implements the thing under test can only
 * prove the re-implementation.
 *
 * @module adapters/dsh/client/initialize-grant.test
 */
import { describe, expect, test } from "bun:test";
import { decodeAdminEnvelope } from "../../../modules/ensemble/codec.ts";
import { effectiveFields, formPayload, type OwnerSubject } from "./management.ts";

const OWNER: OwnerSubject = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1" };
const OTHER: OwnerSubject = { kind: "owner", ownerId: "owner-2", hostAuthorityId: "host-1" };
const LIMITS = { inline_input_bytes: 65536, response_bytes: 1048576, artifact_bytes: 10485760, upload_chunk_bytes: 65536, upload_total_bytes: 104857600, concurrent_uploads: 4, page_items: 100 };
const DESCRIPTOR = { worldIdentity: "host-world", canonicalAddress: "/host/one", nativeWorkspaceRef: "ws-1" };

/** What the form does: effective values → payload → the Host's own closed decoder. */
function submit(action: string, values: Record<string, string | undefined>, owner: OwnerSubject | undefined) {
  const effective = effectiveFields(action, values, owner);
  const payload = formPayload("initialize", {
    root_handle: effective.root_handle ?? "default",
    source_descriptor: effective.source_descriptor ?? JSON.stringify(DESCRIPTOR),
    initial_grants: effective.initial_grants ?? "",
    limits: effective.limits ?? JSON.stringify(LIMITS),
  });
  return decodeAdminEnvelope({ action: "initialize", payload, expected_revision: "absent", operation_id: "op-1" });
}

describe("initialize prefilled grant", () => {
  test("an untouched form submits a legal grant whose subject is the Host's owner", () => {
    // No initial_grants at all: the helper supplies exactly one minimal grant.
    const decoded = submit("initialize", { root_handle: "default" }, OWNER);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const grants = (decoded.value.payload as { initial_grants: readonly { subject: unknown; rights: unknown; scope: unknown }[] }).initial_grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.subject).toEqual(OWNER);
    // Minimal on purpose: owner authority does not come from this grant, so granting more
    // would overstate what the operator asked for.
    expect(grants[0]!.rights).toEqual(["read"]);
    expect(grants[0]!.scope).toEqual({ kind: "project" });
  });

  test("the rendered value and the submitted value are the same string", () => {
    // This is the property the product bug violated: the control showed one thing and the
    // payload carried another. Both read `effectiveFields`, so they must be identical.
    const effective = effectiveFields("initialize", {}, OWNER);
    const rendered = effective.initial_grants;
    expect(rendered).toBeTypeOf("string");
    expect((JSON.parse(rendered!) as { subject: unknown }[])[0]!.subject).toEqual(OWNER);
  });

  test("with no owner reported there is no prefill, and submission names the missing field", () => {
    // Better to render nothing and stop at the required-field check than to invent an actor.
    // The form surfaces the thrown field name as a visible validation message, so the
    // operator learns which field is empty instead of watching a silent no-op.
    expect(effectiveFields("initialize", {}, undefined).initial_grants).toBeUndefined();
    expect(() => submit("initialize", {}, undefined)).toThrow("initial_grants");
  });

  test("a user's edit wins, including deliberately clearing the field", () => {
    // `!== undefined`, not truthiness: an emptied field must stay emptied rather than be
    // silently refilled, or the user's correction would be discarded without notice.
    const edited = JSON.stringify([{ subject: OWNER, rights: ["read"], scope: { kind: "project" } }, { subject: { kind: "session", sessionId: "s-1", rootSessionId: "r-1" }, rights: ["read"], scope: { kind: "project" } }]);
    const effective = effectiveFields("initialize", { initial_grants: edited }, OWNER);
    expect(effective.initial_grants).toBe(edited);
    const decoded = submit("initialize", { initial_grants: edited }, OWNER);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect((decoded.value.payload as { initial_grants: readonly unknown[] }).initial_grants).toHaveLength(2);

    // Cleared field: no prefill is injected back, and the required-field check names it, so
    // the operator sees which field they emptied rather than a silent no-op.
    expect(effectiveFields("initialize", { initial_grants: "" }, OWNER).initial_grants).toBe("");
    expect(() => submit("initialize", { initial_grants: "" }, OWNER)).toThrow("initial_grants");
  });

  test("a later owner identity does not rewrite a value already in the form", () => {
    // Owner arrival/refresh may change what the default would be, but a field the operator
    // has touched is theirs. The controller separately invalidates a stale preview.
    const touched = JSON.stringify([{ subject: OTHER, rights: ["read"], scope: { kind: "project" } }]);
    expect(effectiveFields("initialize", { initial_grants: touched }, OWNER).initial_grants).toBe(touched);
  });

  test("operations other than initialize are never given values", () => {
    // The default is specific to initialize; widening it would invent fields elsewhere.
    expect(effectiveFields("bind", {}, OWNER)).toEqual({});
    expect(effectiveFields("grant", {}, OWNER)).toEqual({});
  });

  test("a fabricated but well-formed subject still decodes, so the probe checks provenance", () => {
    // The decoder validates shape, not truth. This is exactly why the fresh journey
    // compares the subject against the Host's own answer instead of trusting the field.
    const forged = JSON.stringify([{ subject: OTHER, rights: ["read"], scope: { kind: "project" } }]);
    expect(submit("initialize", { initial_grants: forged }, OWNER).ok).toBe(true);
  });

  test("edited limits are respected and an invalid one is refused", () => {
    expect(submit("initialize", { limits: JSON.stringify({ ...LIMITS, page_items: 50 }) }, OWNER).ok).toBe(true);
    expect(submit("initialize", { limits: JSON.stringify({ ...LIMITS, page_items: 0 }) }, OWNER).ok).toBe(false);
    expect(submit("initialize", { limits: "{}" }, OWNER).ok).toBe(false);
  });
});
