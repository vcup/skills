/**
 * The learning journey's own contract, testable without a Host.
 *
 * The journey's *subject* is the installed product (a booted profile, real
 * members, real receipts); that is driven by `scripts/verify-dsh-product.ts`. What
 * is testable here is the part that was wrong before and would be wrong again
 * silently — the parsing and completeness rules the journey relies on to make its
 * claims about real records:
 *
 *   - a commit's changed records can be attributed to object kinds, because that
 *     is the only way a caller learns opaque ids, and a receipt without a changed
 *     list must not be interpreted as "nothing happened";
 *   - a paged read is only reassembled when every page agrees on object identity,
 *     revision and total size, offsets are contiguous, and the last page claims no
 *     continuation — a truncated read must never compare equal to the written
 *     bytes;
 *   - a success is a success and a refusal is the exact refusal code, so a
 *     `not_authorized` cannot be mistaken for a pass and vice versa.
 *
 * Nothing here asserts product behaviour: no reducer, registry or Host is
 * imported.
 */
import { describe, expect, test } from "bun:test";
// The journey module is plain ESM JavaScript with no declaration file; the sibling
// product fixture is consumed the same way. Only these four helpers are used here,
// and each is exercised through its public behaviour.
import * as journey from "./verify-learning.mjs";
const { reassemble, requireOk, requireRefusal, changedByKind } = journey as unknown as {
  reassemble: (pages: readonly Record<string, any>[], field: "text" | "base64") => { bytes: Buffer; total: number; objectRef: unknown };
  requireOk: (answer: unknown, label: string) => any;
  requireRefusal: (answer: unknown, code: string, label: string) => void;
  changedByKind: (receipt: unknown) => Record<string, { id: string; object_revision: number }>;
};

/**
 * One artifact content page, shaped like the archive's `ArtifactPage`.
 * @param offset - byte offset this page starts at.
 * @param text - the page's UTF-8 text.
 * @param total - the complete content length in bytes.
 * @param next - the continued offset, absent on the last page.
 * @returns the page.
 */
function page(offset: number, text: string, total: number, next?: number): Record<string, any> {
  return {
    object_ref: { kind: "object", object_id: "artifact-a", object_revision: 1 },
    media_type: "text/plain; charset=utf-8",
    bytes: total,
    total_bytes: total,
    offset,
    ...(next === undefined ? {} : { next_offset: next }),
    text,
  };
}

describe("commit attribution", () => {
  test("changed records are grouped by object kind, longest prefix first", () => {
    const ids = changedByKind({
      changed: [
        { id: "invocation-1", object_revision: 1 },
        { id: "coverage-2", object_revision: 1 },
        { id: "criterion-3", object_revision: 2 },
        { id: "application-4", object_revision: 1 },
        { id: "assessment-5", object_revision: 1 },
      ],
    });
    expect(Object.keys(ids).sort()).toEqual(["application", "assessment", "coverage", "criterion", "invocation"]);
    expect(ids.criterion.object_revision).toBe(2);
    // A prefix must not be stolen by a shorter kind: `application` is not `app`.
    expect(ids.application.id).toBe("application-4");
  });

  test("a receipt with no changed list is refused, not read as an empty success", () => {
    expect(() => changedByKind({ status: "committed" })).toThrow(/changed records/);
    expect(() => changedByKind(undefined)).toThrow(/changed records/);
  });
});

describe("page completeness", () => {
  const text = "alphabet";
  const first = page(0, "alpha", text.length, 5);
  const second = page(5, "bet", text.length);

  test("a complete two-page read reassembles byte-for-byte", () => {
    const result = reassemble([first, second], "text");
    expect(result.bytes.toString("utf8")).toBe(text);
    expect(result.total).toBe(text.length);
  });

  test("a truncated read never passes as complete", () => {
    // Only the first page arrived. It claims a continuation and the pages seen do
    // not cover the declared total, so this is a truncation — never "alpha".
    expect(() => reassemble([first], "text")).toThrow(/declared total/);
    // A final page that still advertises a continuation is the same lie.
    const more = page(5, "bet", text.length, 8);
    expect(() => reassemble([first, more], "text")).toThrow(/continuation must leave content|cover the declared total/);
    // Dropping the continuation flag hides it from the page flags, so the declared
    // total is what must catch a short read.
    const clipped = { ...page(0, "alph", text.length), next_offset: undefined };
    expect(() => reassemble([clipped], "text")).toThrow(/declared total/);
  });

  test("a non-contiguous, mis-sized or mixed-revision page is refused", () => {
    // A gap between the advertised continuation and the next page's offset.
    expect(() => reassemble([page(0, "alpha", text.length, 6), page(6, "bet", text.length)], "text")).toThrow(/continuation must be contiguous/);
    // A page that repeats an offset an earlier page already covered.
    expect(() => reassemble([first, second, page(5, "bet", text.length)], "text")).toThrow(/must start where the previous page ended/);
    expect(() => reassemble([first, page(5, "bet", 99)], "text")).toThrow(/same total byte count/);
    expect(() => reassemble([first, { ...second, object_ref: { kind: "object", object_id: "artifact-b", object_revision: 1 } }], "text")).toThrow(/same object/);
    expect(() => reassemble([first, { ...second, object_ref: { kind: "object", object_id: "artifact-a", object_revision: 2 } }], "text")).toThrow(/same object revision/);
    expect(() => reassemble([], "text")).toThrow(/at least one page/);
  });

  test("byte pages reassemble from canonical base64", () => {
    const bytes = Buffer.from([0, 255, 254, 128, 13, 10, 65, 0]);
    const result = reassemble(
      [
        { object_ref: { kind: "object", object_id: "artifact-a", object_revision: 1 }, bytes: bytes.length, total_bytes: bytes.length, offset: 0, base64: bytes.toString("base64") },
      ],
      "base64",
    );
    expect(Buffer.compare(result.bytes, bytes)).toBe(0);
  });
});

describe("answer polarity", () => {
  test("a refusal is never read as a success, and the code is exact", () => {
    const refused = { ok: false, error: { code: "not_authorized", message: "no" } };
    expect(() => requireOk(refused, "write")).toThrow(/not_authorized/);
    expect(() => requireRefusal({ ok: true, value: {} }, "not_authorized", "write")).toThrow(/must be refused/);
    expect(() => requireRefusal({ ok: false, error: { code: "invalid_input" } }, "not_authorized", "write")).toThrow(/must be not_authorized/);
    expect(() => requireRefusal(refused, "not_authorized", "write")).not.toThrow();
  });

  test("a success returns its value unchanged", () => {
    const value = { committed_revision: "a".repeat(40), status: "committed" };
    expect(requireOk({ ok: true, value }, "write")).toBe(value);
  });
});
