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
import type { ProductOwner } from "./native/owner.ts";
import { failure } from "../../modules/ensemble/contracts.ts";

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
 * The refusal for a retired v1 method.
 *
 * The code is `unsupported_version` rather than `invalid_input` on purpose: the
 * call is well-formed, the *interface* is gone. The message names the exact
 * replacement so an operator can fix a script without reading the source, and it
 * never suggests that a retry with a different payload might work.
 * @param method - the retired wire method that was called.
 * @returns a structured refusal in the same `Result` shape every method returns.
 */
export function legacyRetired(method: "initialize" | "bind" | "status" | "readBack") {
  const replacement =
    method === "status" || method === "readBack"
      ? "Use `query` (kind `context` or `object`) for archive state and stored bytes; those read the v2 registry this Host actually writes."
      : `Use \`manage\` with action \`${method === "bind" ? "bind" : "initialize"}\`; the v1 ${method} entry is retired in 1.0 and cannot create or extend an archive.`;
  return failure(
    "unsupported_version",
    `ensembleArchive.${method} is retired in 1.0: it wrote a v1 archive that this version no longer creates. ${replacement} ` +
      "An existing 0.3.0 archive is migrated only by an explicit owner flow: read its handle, preview, back it up, stop the old writer, then initialize a new archive identity with fresh grants. The old repository, its head and its history are never written by this package.",
  );
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
  productService: ProductOwner | undefined;
  /**
   * Optional read-only view of a pre-1.0 archive.
   *
   * Only `status` and `readBack` consult it, and only for reading. Nothing here
   * can create, bind, extend or migrate a v1 archive: that path is retired in
   * 1.0 so one root cannot end up with two writers.
   */
  legacyReader: OwnerService | undefined;

  constructor(ctx: Context, service: OwnerService, serviceKey: string = OWNER_SERVICE_KEY, product?: ProductOwner, legacyReader?: OwnerService) {
    super(ctx, serviceKey);
    this.archiveService = service;
    this.productService = product;
    this.legacyReader = legacyReader;
  }

  /**
   * Retired archive-creation entry.
   *
   * Version 1.0 has exactly one archive writer: the `manage` executor over the
   * v2 registry. The older four-method surface wrote a *different* store from
   * the same root, so leaving it callable would have meant two writers and two
   * repositories behind one environment variable. It is therefore retired for
   * creation rather than silently adapted: an old payload shape must not become
   * a new archive.
   *
   * The method stays on the wire so an existing script gets a precise,
   * actionable refusal instead of "unknown method", and it remains behind the
   * same owner guard, so an unauthenticated caller learns nothing new.
   * @param request - ignored; the payload shape is no longer accepted. The name
   *   matters: the gateway derives wire argument names from the signature, so
   *   this must stay `request` even though it is unused.
   * @returns a refusal naming the replacement action.
   */
  @Remote
  async initialize(request: Record<string, unknown>): Promise<unknown> {
    void request;
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    return legacyRetired("initialize");
  }

  /**
   * Retired source-binding entry.
   *
   * Binding is now `manage` with `action: "bind"` (or `"rebind"`), which records
   * the same intent in the v2 transaction with a receipt. The v1 binding wrote a
   * separate store and is retired for the same reason as `initialize`.
   * @param request - ignored; the name must stay `request` for the gateway.
   * @returns a refusal naming the replacement action.
   */
  @Remote
  async bind(request: Record<string, unknown>): Promise<unknown> {
    void request;
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    return legacyRetired("bind");
  }

  /**
   * Read-only legacy diagnostics, or a refusal when no legacy archive is mounted.
   *
   * This is deliberately read-only: it never opens a writer, so asking a 1.0
   * Host about an old archive cannot create or extend one.
   * @param request - empty; retained so every method takes one shape.
   * @returns status, or a refusal naming the replacement query.
   */
  @Remote
  async status(request: Record<string, unknown>): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    if (this.legacyReader === undefined) return legacyRetired("status");
    return this.legacyReader.status(request, this.ctx.invocation);
  }

  /**
   * Read-only legacy read-back, or a refusal when no legacy archive is mounted.
   * @param request - revision and path.
   * @returns content and byte count, or a refusal.
   */
  @Remote
  async readBack(request: Record<string, unknown>): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation);
    if (refusal !== undefined) return refusal;
    if (this.legacyReader === undefined) return legacyRetired("readBack");
    return this.legacyReader.readBack(request, this.ctx.invocation);
  }

  @Remote
  async projects(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.projects(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote
  async query(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.query(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote
  async manage(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.manage(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote
  async destinations(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.destinations(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote
  async choose(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.choose(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote
  async environment(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.environment(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote
  async approve(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) return refusal;
    return this.productService?.approve(request, this.ctx.invocation, signal) ?? failure("storage_unavailable", "project registry is not configured");
  }

  @Remote({ mode: "stream" })
  async *watch(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<unknown> {
    const refusal = refusalFor(this.ctx.invocation); if (refusal) { yield refusal; return; }
    if (!this.productService) { yield failure("storage_unavailable", "project registry is not configured"); return; }
    yield* this.productService.watch(request, this.ctx.invocation, signal);
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
  product?: ProductOwner,
  legacyReader?: OwnerService,
): ArchiveOwnerRemote {
  return new ArchiveOwnerRemote(ctx, service, serviceKey, product, legacyReader);
}

/** Re-exported so a caller can type a result without importing the logic module. */
export type { Outcome };
export type { OwnerRefusal };
