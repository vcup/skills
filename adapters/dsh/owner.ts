/**
 * Owner authorization for the archive management surface.
 *
 * This module exists because the obvious implementation is wrong in a way that
 * looks right. The tempting version is:
 *
 *     const principal = principalOf(this.ctx.invocation);
 *     if (principal === undefined) allow;      // WRONG
 *
 * `principalOf()` returns `undefined` both for the owner *and* for trusted
 * in-process code outside a Remote call (`dsh-typert-protocol`
 * `lib/types/principal.d.ts`). So "no principal" does not mean "owner": it also
 * covers a model tool call, a plugin's own startup code, and any other
 * in-process caller. Treating it as owner would silently promote every
 * non-Remote caller to the local user.
 *
 * The only sound rule is the one DSH's own connection layer supports: a Peer's
 * principal is fixed by in-process Host code when the Peer is created, and
 * `PeerScope.principal` says plainly that no wire field can set it. So owner
 * authority exists only when a Remote invocation is present *and* that fixed
 * principal is the owner. Everything else — no invocation, no peer, any other
 * principal kind — is refused.
 *
 * Nothing here reads an identity from the request. A caller cannot send
 * `owner: true`, an actor, an author or a verification flag: authorization is
 * derived from the invocation context and nowhere else.
 *
 * @module adapters/dsh/owner
 */

/**
 * The subset of `RemoteInvocation` this module needs.
 *
 * Structural on purpose: the repository's dependency-free typecheck compiles
 * this module without `@deepseek-ai/*` present, and the Host type gate proves
 * the real types still fit. `peer.principal` is the field DSH fixes at Peer
 * creation; `kind` is its only discriminator in this release.
 */
export interface InvocationLike {
  readonly peer?: {
    readonly principal?: { readonly kind?: string } | undefined;
  } | undefined;
}

/** Why a management action was refused, or that it was allowed. */
export type OwnerVerdict =
  | { readonly ok: true; readonly principalKind: "owner" }
  | { readonly ok: false; readonly code: "not_authorized"; readonly reason: string };

/**
 * Decide whether the current call may perform an owner management action.
 *
 * Three outcomes, and only the first is allowed:
 * - no invocation at all: refused. Trusted in-process code is not the owner,
 *   and neither is a model tool call — neither carries a Peer.
 * - an invocation whose peer has no principal: refused. The connection layer
 *   always fixes one, so an absent principal is a shape this code does not
 *   understand, and an unknown shape must not grant authority.
 * - a peer principal that is not `owner`: refused. Only `owner` exists in this
 *   release's `PrincipalMap`, and this check stays correct if that map grows.
 *
 * @param invocation - the value of `ctx.invocation`, `undefined` outside a
 *   Remote call.
 * @returns the verdict, with the reason a refusal happened.
 */
export function ownerVerdict(invocation: InvocationLike | undefined): OwnerVerdict {
  if (invocation === undefined) {
    return {
      ok: false,
      code: "not_authorized",
      reason:
        "no Remote invocation: this action is available only to the authenticated owner through a Remote call",
    };
  }
  const principal = invocation.peer?.principal;
  if (principal === undefined) {
    return {
      ok: false,
      code: "not_authorized",
      reason: "the Remote invocation carries no peer principal, so owner authority cannot be established",
    };
  }
  if (principal.kind !== "owner") {
    return {
      ok: false,
      code: "not_authorized",
      reason: `the caller's principal is ${JSON.stringify(principal.kind ?? null)}, not the owner`,
    };
  }
  return { ok: true, principalKind: "owner" };
}

/**
 * The request fields a management call must never carry.
 *
 * Authorization comes from the invocation, so an identity in the payload is at
 * best redundant and at worst an attempt to assert authority the caller does
 * not have. Refusing them explicitly is better than ignoring them: a caller who
 * sends `owner: true` gets told it does not work, instead of believing it did.
 */
export const FORBIDDEN_REQUEST_FIELDS = [
  "owner",
  "actor",
  "author",
  "isOwner",
  "isVerified",
  "principal",
  "principalKind",
  "verified",
] as const;

/**
 * Reject a request that tries to carry its own identity.
 * @param request - the decoded management request.
 * @returns the offending field names, empty when the request is clean.
 */
export function assertedIdentityFields(request: Readonly<Record<string, unknown>>): readonly string[] {
  return FORBIDDEN_REQUEST_FIELDS.filter((field) => Object.hasOwn(request, field));
}

/**
 * The refusal shape a Remote endpoint returns for a non-owner caller.
 *
 * Kept here rather than in the Typert-aware module so the guard is testable
 * without an installation, and so the wire shape and the guard cannot drift.
 */
export interface OwnerRefusal {
  readonly ok: false;
  readonly code: "not_authorized";
  readonly reason: string;
}

/**
 * Refuse a call whose caller is not the authenticated owner.
 * @param invocation - the call's `ctx.invocation`.
 * @returns the refusal, or undefined when the caller is the owner.
 */
export function ownerRefusal(invocation: InvocationLike | undefined): OwnerRefusal | undefined {
  const verdict = ownerVerdict(invocation);
  if (verdict.ok) return undefined;
  return { ok: false, code: "not_authorized", reason: verdict.reason };
}
