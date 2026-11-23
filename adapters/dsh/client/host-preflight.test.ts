/**
 * The preflight must read the Host's own envelopes exactly as the gateway sends
 * them, and must not confuse a domain refusal with a transport fault or an empty
 * answer with a successful one. These are pure decoder tests; the live assertions
 * (a real catalogue, a real head) can only be made against a running Host.
 */

import { describe, expect, test } from "bun:test";
import { business } from "./host-preflight.ts";

describe("Host answer envelopes", () => {
  test("an ok envelope is unwrapped to its business value", () => {
    expect(business({ ok: true, value: { projects: [{ project_id: "p" }] } })).toEqual({ projects: [{ project_id: "p" }] });
  });

  test("a plain business object is accepted as-is", () => {
    expect(business({ read_revision: "a".repeat(40) })).toEqual({ read_revision: "a".repeat(40) });
  });

  test("a domain refusal is reported with its code, not as a value", () => {
    expect(() => business({ ok: false, error: { status: "refused", code: "not_authorized", message: "Denied" } })).toThrow(/not_authorized Denied/u);
    expect(() => business({ ok: false, error: { code: "storage_unavailable", message: "no store" } })).toThrow(/storage_unavailable/u);
  });

  test("an unnamed refusal still fails instead of being read as success", () => {
    expect(() => business({ ok: false })).toThrow(/unknown/u);
  });

  test("a non-object answer is refused", () => {
    for (const value of [null, 42, "ok", [1, 2]]) expect(() => business(value)).toThrow(/non-object/u);
  });

  test("an ok envelope carrying a scalar is wrapped rather than dropped", () => {
    expect(business({ ok: true, value: 7 })).toEqual({ value: 7 });
  });
});
