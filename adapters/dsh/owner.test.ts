/**
 * Tests for the owner authorization rule.
 *
 * The first test in this file is the reason the file exists: an in-process
 * caller with no Remote invocation must be refused. Everything else in the
 * slice is built on top of that answer, and getting it wrong would hand owner
 * authority to any model tool call.
 */

import { describe, expect, test } from "bun:test";
import {
  assertedIdentityFields,
  FORBIDDEN_REQUEST_FIELDS,
  ownerVerdict,
  type InvocationLike,
} from "./owner.ts";

/** A Remote invocation whose Peer principal the connection layer fixed. */
function invocation(kind: string | undefined): InvocationLike {
  return { peer: { principal: kind === undefined ? {} : { kind } } };
}

describe("ownerVerdict", () => {
  test("no Remote invocation is refused, not treated as owner", () => {
    // The single most important assertion in the slice. `principalOf()` returns
    // undefined for the owner AND for trusted in-process code, so "no
    // invocation" must never be read as "owner".
    const verdict = ownerVerdict(undefined);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("not_authorized");
      expect(verdict.reason).toContain("no Remote invocation");
    }
  });

  test("an invocation whose peer carries no principal is refused", () => {
    const verdict = ownerVerdict({});
    expect(verdict.ok).toBe(false);

    const noPrincipal = ownerVerdict({ peer: {} });
    expect(noPrincipal.ok).toBe(false);
    if (!noPrincipal.ok) expect(noPrincipal.reason).toContain("no peer principal");

    const emptyPrincipal = ownerVerdict(invocation(undefined));
    expect(emptyPrincipal.ok).toBe(false);
  });

  test("an authenticated owner principal is allowed", () => {
    const verdict = ownerVerdict(invocation("owner"));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.principalKind).toBe("owner");
  });

  test("any other principal kind is refused", () => {
    // `owner` is the only member of this release's PrincipalMap, but the check
    // is written so that adding a member cannot accidentally grant authority.
    for (const kind of ["member", "reviewer", "guest", "Owner", "OWNER", ""]) {
      const verdict = ownerVerdict(invocation(kind));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("not_authorized");
    }
  });

  test("a non-owner refusal names the principal it saw", () => {
    const verdict = ownerVerdict(invocation("member"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("member");
      expect(verdict.reason).toContain("not the owner");
    }
  });
});

describe("asserted identity fields", () => {
  test("a clean request has none", () => {
    expect(assertedIdentityFields({ root_handle: "h", expected_revision: "absent" })).toEqual([]);
  });

  test("every forbidden field is reported", () => {
    for (const field of FORBIDDEN_REQUEST_FIELDS) {
      expect(assertedIdentityFields({ [field]: true })).toEqual([field]);
    }
  });

  test("a request asserting several identities reports all of them", () => {
    const found = assertedIdentityFields({ owner: true, actor: "someone", author: "x" });
    expect(found).toContain("owner");
    expect(found).toContain("actor");
    expect(found).toContain("author");
  });
});
