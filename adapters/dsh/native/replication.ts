/**
 * Native network replication for the installed product.
 *
 * The archive's replica engine takes an injected `NativeReplicaTransport`; this
 * module is the Host-side adapter that supplies one from **deployment**
 * configuration. Three rules shape it, and each exists because the alternative
 * is a model-reachable network capability:
 *
 * 1. **The destination comes from the deployment, not the request.** A replica
 *    names an opaque `destinationHandle`; only a handle declared in this Host's
 *    destination map resolves to a remote URL, and the URL's host must also be on
 *    the deployment's allowlist. A model tool argument cannot introduce a URL, a
 *    host or a path, and an unknown handle is refused before a process starts.
 * 2. **No declared capability means no network.** Without
 *    `DSH_ENSEMBLE_REPLICA_DESTINATIONS` the product mounts no transport at all,
 *    so the replica engine reports that a separately approved native network
 *    capability is required. A default install therefore reaches only the
 *    Host-local `file` path, which is a deliberate default rather than an
 *    oversight.
 * 3. **The primary repository path comes from the engine, under its lock.** The
 *    engine calls a transfer from inside the archive's owner lease and passes
 *    `{ primaryRoot }` in the call context; this adapter never asks the registry
 *    for a path, so it cannot re-enter the per-archive lock and cannot keep a
 *    path past the lease that produced it.
 *
 * Credentials never cross this boundary as values. A replica carries an opaque
 * `credentialHandle`; when the deployment maps that handle to a credential
 * reference, this adapter resolves it **per transfer** through the released
 * `ctx.credentials` provider and passes Git one fixed environment entry. The
 * value is never logged, never returned, and never stored in the archive.
 *
 * @module adapters/dsh/native/replication
 */

import type { Context } from "@deepseek-ai/cordis";
/**
 * The credential-reference grammar, mirrored from `@deepseek-ai/dsh-credentials`
 * (`REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`).
 *
 * Kept here rather than imported so this module's own tests run without a DSH
 * install; the value is validated against the provider at resolve time anyway, so
 * a divergence fails closed on the first transfer rather than silently passing.
 */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
import type { Actor } from "../../../modules/ensemble/contracts.ts";
import { createAllowlistedReplicaTransport, DEPLOYMENT_PROTOCOLS, SUPPORTED_REPLICA_PROTOCOLS } from "../maintenance/network-deployment.ts";
import type { ReplicaHttpCredential } from "../maintenance/credential-bridge.ts";
import type { NativeReplicaTransport, Replica, ReplicaTransferCapability, ReplicaTransferContext } from "../maintenance/replication.ts";

/** What one deployment-declared destination may say about itself. */
export interface ReplicaDestination {
  /** Remote URL. Its host must also appear in the deployment allowlist. */
  readonly url: string;
  /** Remote identity the owner must state when configuring the replica. */
  readonly identity: string;
  /**
   * Optional credential reference resolved through `ctx.credentials` on every
   * transfer. Only the **reference name** is configuration; the value is never
   * written back, logged, or put in the archive.
   */
  readonly credential_ref?: string;
  /**
   * Non-secret HTTP Basic user name.
   *
   * HTTP Basic authentication has two independent fields, and a token alone is not
   * enough: Git asks for a *user name* and a *password* separately. This is the
   * deployment's statement of the former, so it is required (and strictly
   * validated) whenever a credential reference is declared. It is not a secret and
   * never carries the token.
   *
   * The carrier variable is deliberately not configuration: the transport owns a
   * fixed, trusted askpass helper and puts the secret into its own private
   * environment variable. A deployment can neither name a `GIT_*` carrier nor a
   * helper program path.
   */
  readonly credential_username?: string;
}

export interface ReplicaConfiguration {
  readonly destinations: Readonly<Record<string, ReplicaDestination>>;
  /**
   * Canonical `host[:port]` entries this deployment may contact.
   *
   * Derived from the declared destination URLs unless the deployment states it
   * explicitly via `allow`. It is separate because the transport checks it, so a
   * destination whose URL is later edited to another host still fails unless
   * that host was allowed on purpose.
   */
  readonly allowlist: readonly string[];
}

/** The deployment variable that declares replica destinations. */
export const REPLICA_DESTINATIONS_ENV = "DSH_ENSEMBLE_REPLICA_DESTINATIONS";

/**
 * A non-secret HTTP Basic user name.
 *
 * It reaches Git's askpass prompt verbatim, so control characters, surrounding
 * whitespace and `:` (Basic auth's field separator) are refused.
 */
const USERNAME = /^[^\u0000-\u001f\u007f:]+$/;
const HANDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Canonical `host[:port]` of a URL, or `undefined` when it is not absolute. */
export function authorityOf(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) return undefined;
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch { return undefined; }
}

/**
 * Read and strictly validate the deployment's replica destinations.
 *
 * Parsing is strict so a malformed configuration fails at boot, where an operator
 * sees it, instead of at the first push, where it looks like a network fault.
 * @param raw - the environment value, if any.
 * @returns the configuration, `undefined` when unset, or a reason it is invalid.
 */
export function parseReplicaDestinations(raw: string | undefined): { ok: true; value: ReplicaConfiguration | undefined } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { return { ok: false, reason: `replica destinations are not valid JSON: ${(error as Error).message}` }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "replica destinations must be a JSON object keyed by destination handle" };
  // `allow` is validated before the destination walk: an empty array is an
  // object, so walking first reported it as "must be an object" instead of the
  // real problem, which is that an explicitly empty allowlist permits nothing.
  const top = parsed as Record<string, unknown>;
  if (top.allow !== undefined && !Array.isArray(top.allow)) return { ok: false, reason: "allow must be an array of host[:port] strings" };
  const destinations: Record<string, ReplicaDestination> = {};
  for (const [handle, value] of Object.entries(top)) {
    if (handle === "allow") continue;
    if (!HANDLE_NAME.test(handle)) return { ok: false, reason: `destination handle ${JSON.stringify(handle)} is not a plain name` };
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: `destination ${handle} must be an object` };
    const entry = value as Record<string, unknown>;
    const unknown = Object.keys(entry).filter(key => !["url", "identity", "credential_ref", "credential_username"].includes(key));
    if (unknown.length > 0) return { ok: false, reason: `destination ${handle} has unknown fields: ${unknown.join(", ")}` };
    if (typeof entry.url !== "string" || entry.url.trim() === "") return { ok: false, reason: `destination ${handle} needs a url` };
    if (typeof entry.identity !== "string" || entry.identity.trim() === "") return { ok: false, reason: `destination ${handle} needs a stated remote identity` };
    if (entry.credential_ref !== undefined && (typeof entry.credential_ref !== "string" || !HANDLE_NAME.test(entry.credential_ref))) {
      return { ok: false, reason: `destination ${handle} has an invalid credential_ref` };
    }
    // The user name is a plain, non-secret Basic-auth field. It is validated
    // strictly because it reaches Git's askpass prompt verbatim: a control
    // character or a surrounding space would corrupt the prompt protocol, and a
    // colon is how Basic auth separates its two fields.
    if (entry.credential_username !== undefined) {
      if (typeof entry.credential_username !== "string" || !USERNAME.test(entry.credential_username)) {
        return { ok: false, reason: `destination ${handle} has an invalid credential_username: use characters without control codes, surrounding spaces or ":"` };
      }
    }
    if (entry.credential_ref !== undefined && entry.credential_username === undefined) {
      return { ok: false, reason: `destination ${handle} names a credential_ref but no credential_username: HTTP Basic authentication needs a user name as well as the secret` };
    }
    if (entry.credential_ref === undefined && entry.credential_username !== undefined) {
      return { ok: false, reason: `destination ${handle} names a credential_username but no credential_ref: a user name alone cannot authenticate` };
    }
    destinations[handle] = {
      url: entry.url,
      identity: entry.identity,
      ...(entry.credential_ref === undefined ? {} : { credential_ref: entry.credential_ref as string }),
      ...(entry.credential_username === undefined ? {} : { credential_username: entry.credential_username as string }),
    };
  }
  if (Object.keys(destinations).length === 0) return { ok: true, value: undefined };
  // Unknown top-level keys are refused so a typo cannot silently do nothing.
  const unknownTop = Object.keys(top).filter(key => key !== "allow" && !(key in destinations));
  if (unknownTop.length > 0) return { ok: false, reason: `unknown top-level fields: ${unknownTop.join(", ")}` };
  const derived: string[] = [];
  for (const [handle, destination] of Object.entries(destinations)) {
    const authority = authorityOf(destination.url);
    if (authority === undefined) return { ok: false, reason: `destination ${handle} url is not an absolute URL` };
    // Refuse an unsupported scheme here rather than after construction: the
    // transport's own set is the single fact, and this parse is where an operator
    // sees the mistake. `ssh` was removed from the supported set on purpose.
    let scheme: string;
    try { scheme = new URL(destination.url).protocol; } catch { return { ok: false, reason: `destination ${handle} url is not an absolute URL` }; }
    if (!DEPLOYMENT_PROTOCOLS.has(scheme)) {
      return { ok: false, reason: `destination ${handle} uses ${scheme}, which this release does not support (supported: ${SUPPORTED_REPLICA_PROTOCOLS})` };
    }
    derived.push(authority);
  }
  let allowlist = derived;
  if (top.allow !== undefined) {
    const stated = top.allow;
    if (!Array.isArray(stated) || stated.length === 0 || stated.some(entry => typeof entry !== "string" || entry.trim() === "")) {
      return { ok: false, reason: "allow must be a non-empty array of host[:port] strings when present" };
    }
    allowlist = (stated as string[]).map(entry => entry.trim().toLowerCase());
    // An allowlist that does not cover the declared destinations would make every
    // transfer fail later; refuse it now, where the operator can see it.
    for (const authority of derived) {
      if (!allowlist.includes(authority.toLowerCase())) return { ok: false, reason: `allow does not cover declared destination host ${authority}` };
    }
  }
  return { ok: true, value: { destinations, allowlist } };
}

export interface ProductReplicaOptions {
  /** Private directory for fetched quarantine candidates. */
  readonly quarantineRoot: string;
}

/**
 * Build the transport the product mounts, or `undefined` when the deployment
 * declared no network capability.
 *
 * Every transfer re-reads the deployment map and re-resolves the credential, so
 * removing a destination or rotating a secret takes effect on the next operation
 * without rewriting replica records. `authorize` re-checks the current caller
 * each time rather than caching a verdict, and remembers that actor only for the
 * transfer that immediately follows — a transfer with no fresh authorization for
 * its replica is refused.
 * @param ctx - Host context, used only to resolve credentials.
 * @param configuration - validated deployment configuration.
 * @param options - quarantine root.
 * @returns the transport, or `undefined` for a Host-local-only deployment.
 */
export function createProductReplicaTransport(
  ctx: Context,
  configuration: ReplicaConfiguration,
  options: ProductReplicaOptions,
): NativeReplicaTransport {
  // There is deliberately no "last authorized" memory here. A map keyed by
  // replica id looks convenient and is wrong: two archives can interleave
  // `authorize(A)`, `authorize(B)`, then a transfer for A, and a remembered
  // "latest" would let B's decision describe A's destination. Every method takes
  // the trusted per-call context instead, so a decision cannot outlive the call
  // that made it and nothing is shared between concurrent transfers.

  /** The declared destination for exactly this call's context. */
  function destinationFor(context: ReplicaTransferContext | undefined): ReplicaDestination {
    if (context === undefined) throw new Error("this operation requires the deployment destination key from the owner's location capability");
    return declared(context);
  }

  /**
   * Resolve the HTTP credential for one transfer.
   *
   * Resolved on every transfer, never cached, so a rotated or revoked secret
   * reaches the next operation. The result is the transport's typed pair: a
   * non-secret user name from the deployment plus the secret from the credential
   * provider, because HTTP Basic authentication has two independent fields and a
   * token alone cannot fill both. The secret is handed straight to the transport,
   * which puts it only into its own private helper environment.
   * @param destination - the declared destination being contacted.
   * @returns the credential, or undefined when the destination needs none.
   */
  async function credentialFor(destination: ReplicaDestination): Promise<ReplicaHttpCredential | undefined> {
    if (destination.credential_ref === undefined) return undefined;
    const provider = ctx.get("credentials");
    if (provider === undefined) throw new Error("a credential reference is configured but no native credential provider is mounted");
    if (!CREDENTIAL_REF.test(destination.credential_ref)) throw new Error(`credential reference ${JSON.stringify(destination.credential_ref)} is not a plain reference name`);
    const resolved = await provider.resolve(destination.credential_ref as never);
    if (resolved === undefined) throw new Error(`credential ${destination.credential_ref} is not configured`);
    const value = (resolved as { value?: unknown }).value;
    if (typeof value !== "string" || value === "") throw new Error(`credential ${destination.credential_ref} has no usable value`);
    // The user name is deployment configuration, not a credential; the parser has
    // already refused a reference that declares none.
    if (destination.credential_username === undefined) throw new Error(`destination ${destination.identity} declares a credential reference without a user name`);
    return { username: destination.credential_username, secret: value };
  }
  /**
   * Resolve a destination from the **deployment key the capability carried**.
   *
   * Never from `replica.destinationHandle`: that field stores the opaque runtime
   * location handle (`location_<uuid>`) the owner's `choose` returned, which
   * expires with the capability and can never be a deployment name. Looking it up
   * here made every real network `configure_replica` fail with `not_authorized`,
   * because the handle is not, and must not be, a key in the deployment map. There
   * is deliberately no fallback between the two shapes: a runtime id must never be
   * able to masquerade as a declared destination.
   * @param context - the engine's transfer context, carrying the capability's key.
   * @returns the declared destination.
   */
  function declared(context: ReplicaTransferContext): ReplicaDestination {
    const key = context.destinationKey;
    if (typeof key !== "string" || key === "") {
      throw new Error("a replica transfer requires the deployment destination key from the owner's location capability");
    }
    const destination = configuration.destinations[key];
    if (destination === undefined) throw new Error("this deployment does not declare that replica destination");
    return destination;
  }
  /**
   * Build one transport for exactly this replica, caller and lease.
   *
   * The primary repository path is the only thing taken from the lease context;
   * nothing about it is cached, so a transfer after a relocate uses the archive's
   * current location.
   */
  async function instanceFor(replica: Replica, context: ReplicaTransferContext): Promise<NativeReplicaTransport> {
    if (typeof context?.primaryRoot !== "string" || context.primaryRoot === "") {
      throw new Error("replica transfer requires the archive's leased repository path");
    }
    const destination = declared(context);
    const credential = await credentialFor(destination);
    return createAllowlistedReplicaTransport({
      allowlist: configuration.allowlist,
      // The engine passes the capability's deployment key here; anything else is
      // not a declared destination and must not resolve to a URL.
      resolve: handle => {
        const found = configuration.destinations[handle];
        if (found === undefined) throw new Error("this deployment does not declare that replica destination");
        return found.url;
      },
      identity: destination.identity,
      quarantineRoot: `${options.quarantineRoot}/${replica.id}`,
      primaryRoot: context.primaryRoot,
      // The current-caller check is real and repeated: `authorize` below also
      // gates on it before any transfer reaches this transport.
      authorize: (caller: Actor) => caller.kind === "owner" && caller.channel === "authenticated-remote",
      ...(credential === undefined ? {} : { credential: () => credential }),
    });
  }
  /** Build the transport for a transfer whose context and capability are in hand. */
  async function transferFor(replica: Replica, context: ReplicaTransferContext, capability: ReplicaTransferCapability): Promise<NativeReplicaTransport> {
    // The capability's key must match the context it travels with: a capability
    // issued for one destination can never drive a transfer to another.
    if (capability.destinationKey !== context.destinationKey) {
      throw new Error("replica transfer capability does not match the transfer context");
    }
    return instanceFor(replica, context);
  }
  return {
    /**
     * Authorize one transfer and return the capability for exactly that transfer.
     *
     * The capability carries the destination key and the declared identity, so the
     * caller never has to ask a second question that could be answered differently.
     * Nothing is stored: an expiry, a revocation or a restart drops the capability
     * with the call, and the next transfer must authorize again.
     * @param actor - the current caller.
     * @param replica - the replica being operated on.
     * @param signal - cancellation.
     * @param context - the engine's transfer context; required, carrying the key.
     * @returns the capability, or undefined when the transfer is not allowed.
     */
    async authorize(actor: Actor, replica: Replica, signal: AbortSignal, context?: ReplicaTransferContext): Promise<ReplicaTransferCapability | undefined> {
      if (signal.aborted) return undefined;
      // Current authenticated owner only. `channel` is assigned by the Remote
      // layer, so an in-process caller cannot present it.
      if (actor.kind !== "owner" || actor.channel !== "authenticated-remote") return undefined;
      // No context means no capability-derived key, and there is no fallback.
      if (context === undefined) return undefined;
      try {
        const destination = declared(context);
        // A declared credential the provider cannot resolve is a refusal, not a
        // push with no authentication.
        await credentialFor(destination);
        // The host must be on the allowlist; the transport re-checks, but a
        // refusal here names the destination rather than surfacing later.
        const authority = authorityOf(destination.url);
        if (authority === undefined || !configuration.allowlist.some(entry => entry.toLowerCase() === authority.toLowerCase())) return undefined;
        return { identity: destination.identity, destinationKey: context.destinationKey as string };
      } catch { return undefined; }
    },
    async head(replica: Replica, signal: AbortSignal, context: ReplicaTransferContext, capability: ReplicaTransferCapability): Promise<string | null> {
      return (await transferFor(replica, context, capability)).head(replica, signal, context, capability);
    },
    async push(replica: Replica, revision: string, expected: string | null, signal: AbortSignal, context: ReplicaTransferContext, capability: ReplicaTransferCapability): Promise<void> {
      return (await transferFor(replica, context, capability)).push(replica, revision, expected, signal, context, capability);
    },
    async fetch(replica: Replica, expected: string, signal: AbortSignal, context: ReplicaTransferContext, capability: ReplicaTransferCapability) {
      return (await transferFor(replica, context, capability)).fetch(replica, expected, signal, context, capability);
    },
  };
}
