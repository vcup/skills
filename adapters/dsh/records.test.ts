/**
 * Tests for the v1 archive tree layout.
 *
 * These are the rules that make a commit readable and a retry safe, and none of
 * them need Git: the layout is bytes, so it is tested as bytes.
 */

import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_FORMAT,
  canonicalJson,
  digestOf,
  initialMeta,
  isSafeSegment,
  judgeRetry,
  operationPath,
  operationRecord,
  parseMeta,
  parseRecord,
  receiptPath,
  receiptRecord,
  recordEnvelope,
  recordPath,
  RECORD_KINDS,
  validateBinding,
  validateExpectedRevision,
  validateGrants,
} from "./records.ts";
import type { ReceiptRecord } from "./records.ts";

const BINDING = {
  worldIdentity: "host-local",
  canonicalAddress: "/home/user/project",
  nativeWorkspaceRef: "workspace:1",
};

describe("canonical JSON", () => {
  test("key order does not change the bytes, so a retry digests identically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("nested objects and arrays are canonicalised too", () => {
    const left = canonicalJson({ list: [{ y: 1, x: 2 }], z: null });
    const right = canonicalJson({ z: null, list: [{ x: 2, y: 1 }] });
    expect(left).toBe(right);
  });

  test("undefined entries are omitted rather than serialised as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("the digest is stable across key order", () => {
    expect(digestOf(canonicalJson({ a: 1, b: 2 }))).toBe(digestOf(canonicalJson({ b: 2, a: 1 })));
  });
});

describe("path segments", () => {
  test("plain identifiers are accepted", () => {
    for (const value of ["abc", "a1", "A.b-c_d", "x".repeat(128)]) {
      expect(isSafeSegment(value)).toBe(true);
    }
  });

  test("traversal, separators, empty and overlong names are refused", () => {
    for (const value of ["", ".", "..", "../x", "a/b", "/abs", ".hidden", "x".repeat(129), "a b", "a\nb"]) {
      expect(isSafeSegment(value)).toBe(false);
    }
  });

  test("a record path is built only from validated parts", () => {
    expect(recordPath("checkpoint", "cp-1")).toBe("records/checkpoint/cp-1.json");
    expect(operationPath(3)).toBe("operations/3.json");
    expect(receiptPath("owner", "key-1")).toBe("receipts/owner/key-1.json");
  });
});

describe("binding and grants", () => {
  test("a complete binding is accepted", () => {
    expect(validateBinding(BINDING).ok).toBe(true);
  });

  test("an empty field is refused, because the world would be unprovable", () => {
    for (const field of ["worldIdentity", "canonicalAddress", "nativeWorkspaceRef"] as const) {
      const verdict = validateBinding({ ...BINDING, [field]: "  " });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(field);
    }
  });

  test("grants must name at least one subject with at least one right", () => {
    expect(validateGrants([{ subjectId: "owner", rights: ["manage"] }]).ok).toBe(true);
    expect(validateGrants([]).ok).toBe(false);
    expect(validateGrants([{ subjectId: "owner", rights: [] }]).ok).toBe(false);
    // A subject id becomes a path segment in receipts, so it is validated here.
    expect(validateGrants([{ subjectId: "../escape", rights: ["manage"] }]).ok).toBe(false);
  });
});

describe("meta", () => {
  test("initial metadata carries the format, id, binding and grants", () => {
    const meta = initialMeta({ archiveId: "arch-1", binding: BINDING, grants: [{ subjectId: "owner", rights: ["manage"] }], renderer: "v1" });
    expect(meta.format).toBe(ARCHIVE_FORMAT);
    expect(meta.sequence).toBe(1);
    expect(meta.archiveId).toBe("arch-1");
  });

  test("a round trip parses back to the same values", () => {
    const meta = initialMeta({ archiveId: "arch-1", binding: BINDING, grants: [{ subjectId: "owner", rights: ["manage"] }], renderer: "v1" });
    const parsed = parseMeta(canonicalJson(meta));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.meta).toEqual(meta);
  });

  test("an unknown format is refused rather than read leniently", () => {
    const verdict = parseMeta(JSON.stringify({ format: "ensemble-archive/v2", archiveId: "a", sequence: 1, binding: BINDING }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("unknown_format");
  });

  test("malformed or incomplete metadata is refused", () => {
    expect(parseMeta("not json").ok).toBe(false);
    expect(parseMeta("[]").ok).toBe(false);
    const noId = parseMeta(JSON.stringify({ format: ARCHIVE_FORMAT, sequence: 1, binding: BINDING }));
    expect(noId.ok).toBe(false);
    const badSequence = parseMeta(JSON.stringify({ format: ARCHIVE_FORMAT, archiveId: "a", sequence: 0, binding: BINDING }));
    expect(badSequence.ok).toBe(false);
  });
});

describe("record envelopes", () => {
  test("a complete envelope is built and parses back", () => {
    const built = recordEnvelope({ kind: "checkpoint", id: "cp-1", objectRevision: 1, createdSequence: 1, updatedSequence: 1, body: { note: "x" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parseRecord(canonicalJson(built.record));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.record.id).toBe("cp-1");
  });

  test("an unknown kind is refused in both directions", () => {
    const built = recordEnvelope({ kind: "mystery", id: "x", objectRevision: 1, createdSequence: 1, updatedSequence: 1, body: {} });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe("unknown_kind");

    const parsed = parseRecord(JSON.stringify({ format: ARCHIVE_FORMAT, kind: "mystery", id: "x" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("unknown_kind");
  });

  test("every declared kind is accepted", () => {
    for (const kind of RECORD_KINDS) {
      const built = recordEnvelope({ kind, id: "x", objectRevision: 1, createdSequence: 1, updatedSequence: 1, body: {} });
      expect(built.ok).toBe(true);
    }
  });

  test("sequence ordering is enforced", () => {
    const built = recordEnvelope({ kind: "checkpoint", id: "x", objectRevision: 1, createdSequence: 5, updatedSequence: 4, body: {} });
    expect(built.ok).toBe(false);
    const zero = recordEnvelope({ kind: "checkpoint", id: "x", objectRevision: 0, createdSequence: 1, updatedSequence: 1, body: {} });
    expect(zero.ok).toBe(false);
  });
});

describe("operations and receipts", () => {
  test("an operation stores the payload digest, not the payload", () => {
    const operation = operationRecord({ sequence: 2, actor: "owner", action: "bind", payload: { secret: "do-not-store" }, changedIds: ["meta"], result: { ok: true } });
    expect(operation.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(operation)).not.toContain("do-not-store");
  });

  test("a receipt stores the sequence, never a commit hash", () => {
    const receipt = receiptRecord({ payloadDigest: "a".repeat(64), sequence: 7, result: { ok: true } });
    // A commit hash in the receipt would be self-referential: the hash depends
    // on the tree that contains the receipt. So the receipt names the sequence
    // and the payload digest (SHA-256, 64 hex) and carries no 40-hex field.
    expect(Object.keys(receipt).sort()).toEqual(["format", "payloadDigest", "result", "sequence"]);
    for (const value of Object.values(receipt)) {
      if (typeof value !== "string") continue;
      expect(value).not.toMatch(/^[0-9a-f]{40}$/);
    }
    expect(receipt.sequence).toBe(7);
  });
});

describe("retry semantics", () => {
  const receipt: ReceiptRecord = { format: ARCHIVE_FORMAT, payloadDigest: "a".repeat(64), sequence: 3, result: { committed: true } };

  test("an unused key is a new operation", () => {
    expect(judgeRetry(undefined, "b".repeat(64))).toEqual({ kind: "new" });
  });

  test("the same key with the same payload replays the original result", () => {
    const verdict = judgeRetry(receipt, "a".repeat(64));
    expect(verdict).toMatchObject({ kind: "replay" });
    if ("receipt" in verdict) expect(verdict.receipt.sequence).toBe(3);
  });

  test("the same key with a different payload is refused, not answered", () => {
    const verdict = judgeRetry(receipt, "b".repeat(64));
    expect("ok" in verdict && verdict.ok === false).toBe(true);
    if ("reason" in verdict) expect(verdict.reason).toContain("different payload");
  });
});

describe("expected revision", () => {
  test("absent is accepted only for a first write", () => {
    expect(validateExpectedRevision("absent", { allowAbsent: true }).ok).toBe(true);
    const refused = validateExpectedRevision("absent", { allowAbsent: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("first initialisation");
  });

  test("latest and HEAD are refused as revisions", () => {
    for (const value of ["latest", "HEAD"]) {
      const verdict = validateExpectedRevision(value, { allowAbsent: false });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("is not a revision");
    }
  });

  test("a commit id is accepted and anything else refused", () => {
    expect(validateExpectedRevision("a".repeat(40), { allowAbsent: false }).ok).toBe(true);
    for (const value of ["", "   ", "abc", "A".repeat(40), "a".repeat(41), 7, null]) {
      expect(validateExpectedRevision(value, { allowAbsent: false }).ok).toBe(false);
    }
  });
});
