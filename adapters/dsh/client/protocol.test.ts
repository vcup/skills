/**
 * The `current_owner` contract, on the Client side.
 *
 * The Host reports who the authenticated caller is on the owner catalogue, and that report
 * is the **only** legitimate source for a grant subject: the Host derives it from the
 * trusted connection, never from a request payload. Everything here exists because a
 * fabricated or leniently-decoded identity would silently build a grant for the wrong
 * actor — the failure mode that made the fresh journey unprovable in the first place.
 *
 * @module adapters/dsh/client/protocol.test
 */
import { describe, expect, test } from "bun:test";
import { ClientFailure, decodeOwner } from "./protocol.ts";

/** A complete owner answer, with the subject this file varies. */
const answer = (current_owner: unknown) => ({
  ok: true,
  value: {
    capabilities: ["initialize"],
    root_handles: ["default"],
    source_handles: [],
    destination_handles: [],
    projects: [],
    current_owner,
  },
});

const SUBJECT = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1" } as const;

describe("current_owner", () => {
  test("a well-formed owner subject is decoded exactly", () => {
    expect(decodeOwner(answer(SUBJECT)).current_owner).toEqual(SUBJECT);
  });

  test("a missing subject is refused rather than defaulted", () => {
    // Defaulting would mean inventing an actor, so the whole catalogue read must fail.
    expect(() => decodeOwner(answer(undefined))).toThrow(ClientFailure);
  });

  test("a session subject is refused: this endpoint is owner-guarded", () => {
    // A session identity arriving here means the guard failed; building a grant from it
    // would attribute the archive to the wrong actor.
    expect(() => decodeOwner(answer({ kind: "session", sessionId: "s", rootSessionId: "r" }))).toThrow(ClientFailure);
  });

  test("an unknown kind is refused", () => {
    expect(() => decodeOwner(answer({ kind: "someone", ownerId: "o", hostAuthorityId: "h" }))).toThrow(ClientFailure);
  });

  test("empty or non-string ids are refused", () => {
    expect(() => decodeOwner(answer({ kind: "owner", ownerId: "", hostAuthorityId: "host-1" }))).toThrow(ClientFailure);
    expect(() => decodeOwner(answer({ kind: "owner", ownerId: "owner-1", hostAuthorityId: "" }))).toThrow(ClientFailure);
    expect(() => decodeOwner(answer({ kind: "owner", ownerId: 1, hostAuthorityId: "host-1" }))).toThrow(ClientFailure);
    expect(() => decodeOwner(answer({ kind: "owner", hostAuthorityId: "host-1" }))).toThrow(ClientFailure);
  });

  test("extra fields on the subject are refused, so the projection stays closed", () => {
    // Unknown keys are not ignored: the Client can only act safely on the three fields the
    // contract names, and the Host emits exactly those, so an extra one means the two sides
    // are not speaking the settled contract.
    expect(() => decodeOwner(answer({ kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", extra: "x" }))).toThrow(ClientFailure);
    expect(() => decodeOwner(answer({ kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" }))).toThrow(ClientFailure);
  });

  test("the other owner fields are still validated", () => {
    // Guards the surrounding decode from being loosened while this one is extended.
    expect(() => decodeOwner({ ok: true, value: { ...answer(SUBJECT).value, capabilities: "nope" } })).toThrow(ClientFailure);
  });
});
