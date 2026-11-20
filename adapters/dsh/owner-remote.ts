/**
 * The owner management Remote: the user-reachable entry for the archive.
 *
 * This module exists because the archive surface is useless if nothing can
 * reach it. `owner-service.ts` holds the logic and is testable without a
 * gateway; this file is the only part that knows about Typert, and its whole job
 * is to expose four methods over the authenticated Remote path.
 *
 * The guard is the point. Every method calls {@link ownerVerdict} on its own
 * `ctx.invocation` before delegating, so authority comes from the Peer the
 * connection layer authenticated, never from the request. A caller cannot reach
 * the archive by asserting an identity, and in-process code cannot reach it at
 * all: outside a Remote call `ctx.invocation` is `undefined`, which is refused.
 *
 * The service is registered under its own Cordis key and Typert namespace so a
 * Client or headless owner console calls `ensembleArchive.initialize(...)` and
 * friends through the gateway like any other Remote.
 *
 * Each method takes exactly one plain parameter named `request`. Two constraints
 * from the gateway shape this, and neither is a style choice:
 *
 * - The descriptor is derived from the method's source text, and destructuring,
 *   defaults and rest parameters are rejected. A default such as
 *   `status(request = {})` makes the endpoint unusable.
 * - The wire argument names must match the declared parameter names, so a caller
 *   sends `{ request: { ... } }` and every method uses the same name for it.
 *
 * @module adapters/dsh/owner-remote
 */

import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { ownerRefusal, type InvocationLike, type OwnerRefusal } from "./owner.ts";
import type { OwnerService, Outcome } from "./owner-service.ts";

/** Cordis service key and Typert namespace of the owner Remote. */
export const OWNER_SERVICE_KEY = "ensembleArchive";

/**
 * The context a Remote method sees.
 *
 * `invocation` is populated by the gateway for the duration of a call and is
 * `undefined` outside one; that distinction is exactly what the guard reads.
 */
export interface RemoteContext extends InvocationLike {
  readonly invocation?: InvocationLike | undefined;
}

/**
 * A refusal shaped for the wire.
 *
 * Returned rather than thrown: a Remote method that throws gives the caller a
 * transport error, which hides the distinction between "you are not allowed"
 * and "the gateway broke". A structured refusal is readable and actionable.
 */
export interface RemoteFailure {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

/**
 * Refuse a call whose caller is not the authenticated owner.
 *
 * The rule itself lives in `./owner.ts`, which has no DSH dependency, so the
 * guard is tested without an install and the Remote cannot quietly implement a
 * second, different rule.
 * @param invocation - the call's `ctx.invocation`.
 * @returns the refusal, or undefined when the caller is the owner.
 */
export function refusalFor(invocation: InvocationLike | undefined): OwnerRefusal | undefined {
  return ownerRefusal(invocation);
}

/**
 * The owner management Remote service.
 *
 * Constructing it registers it under {@link OWNER_SERVICE_KEY}, which also binds
 * the same key as the Typert namespace: one name for the Cordis service and the
 * wire namespace keeps the two from drifting.
 */
export class ArchiveOwnerRemote extends TypertRemoteService {
  /**
   * The archive logic, which knows nothing about Typert.
   *
   * An ordinary readonly field rather than `#private`: the gateway invokes the
   * method through a binding where a true private field is not reachable, and
   * the resulting "cannot read private member" error says nothing about the
   * real cause.
   */
  readonly archiveService: OwnerService;

  constructor(ctx: Context, service: OwnerService, serviceKey: string = OWNER_SERVICE_KEY) {
    super(ctx, serviceKey);
    this.archiveService = service;
  }

  /**
   * Create the archive and its initial binding/grant version.
   *
   * The only call that may use `expected_revision: absent`, because it is the
   * owner creating the archive for the first time.
   * @param request - root handle, source descriptor, initial grants, limits.
   * @returns the archive id and committed revision, or a refusal.
   */
  @Remote
  async initialize(request: Record<string, unknown>): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    return this.archiveService.initialize(request, this.ctx.invocation);
  }

  /**
   * Record a new source binding on an existing archive.
   * @param request - source descriptor, mapping evidence, reason, expected revision.
   * @returns the new binding version, or a refusal.
   */
  @Remote
  async bind(request: Record<string, unknown>): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    return this.archiveService.bind(request, this.ctx.invocation);
  }

  /**
   * Report the archive's current head, sequence and binding.
   * @param request - empty; retained so every method takes one shape.
   * @returns the status, or a refusal.
   */
  @Remote
  async status(request: Record<string, unknown>): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    return this.archiveService.status(request, this.ctx.invocation);
  }

  /**
   * Read one file at a concrete revision.
   * @param request - revision and path.
   * @returns the content and byte count, or a refusal.
   */
  @Remote
  async readBack(request: Record<string, unknown>): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    return this.archiveService.readBack(request, this.ctx.invocation);
  }
}

/**
 * Register the owner Remote on a plugin context.
 * @param ctx - the plugin's context.
 * @param service - the archive logic to expose.
 * @param serviceKey - Cordis key and Typert namespace.
 * @returns the constructed service, so a caller can inspect it.
 */
export function createOwnerRemote(
  ctx: Context,
  service: OwnerService,
  serviceKey: string = OWNER_SERVICE_KEY,
): ArchiveOwnerRemote {
  return new ArchiveOwnerRemote(ctx, service, serviceKey);
}

/** Re-exported so a caller can type a result without importing the logic module. */
export type { Outcome };
export type { OwnerRefusal };
