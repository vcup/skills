/**
 * Allowlisted replica transport for a real deployment.
 *
 * `./network.ts` ships two transports and they are deliberately different:
 *
 * - {@link createLoopbackReplicaTransport} is **acceptance evidence only**. It
 *   refuses every non-loopback host so a test can prove the network pipeline
 *   against a real `git daemon` without reaching a real network. It must never be
 *   the transport a deployment runs.
 * - this module is the **deployment** transport. It accepts exactly the
 *   endpoints the operator declared in an allowlist, for `https://`, `http://` or
 *   `git://`, and nothing else. A host that is not on the list cannot be reached
 *   even if every other check passes, because the endpoint never comes from the
 *   request: it comes from the deployment map, keyed by an opaque handle. The
 *   supported set is stated once, in {@link SUPPORTED_REPLICA_PROTOCOLS}, and the
 *   native adapter and the docs use the same three schemes.
 *
 * Both share the same hardened Git invocation: fixed argv with no shell and no
 * caller-supplied argument, a scrubbed environment (no ambient `GIT_*`,
 * `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, empty
 * `GIT_ASKPASS`/`GIT_SSH_COMMAND`), expected-remote CAS with fast-forward only,
 * isolated fetch into a private quarantine, and a post-push re-read that confirms
 * the remote actually moved to the pushed revision.
 *
 * **Credentials never cross this boundary as values in the archive.** The native
 * adapter resolves a credential reference through the Host credential provider and
 * passes the result in one fixed environment entry named by the deployment; this
 * module only forwards that map to the Git child, never logs it, and never returns
 * it. The engine sees only an opaque `credentialHandle`.
 *
 * **Failures are classified, never quoted.** Every failure this module raises after
 * construction is a {@link ReplicaTransportError} carrying one token from the
 * closed {@link ReplicaTransportFailure} vocabulary. The Git child's stderr, the
 * remote URL and any provider text are deliberately dropped, because the engine
 * turns the reason into an archive refusal and a receipt.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Actor } from "../../../modules/ensemble/contracts.ts";
import { ReplicaTransportError, type NativeReplicaTransport, type Replica, type ReplicaTransferContext, type ReplicaTransportFailure } from "./replication.ts";
import { createCredentialBridge, type BridgedCredential, type ReplicaHttpCredential } from "./credential-bridge.ts";

/**
 * Endpoint schemes a deployment allowlist may contain.
 *
 * This is the release's supported replication set and it matches the native
 * adapter and the published docs: `https`, `http` and `git`. SSH is deliberately
 * absent rather than silently accepted-then-rejected: `git+ssh` needs an SSH
 * transport and key material this release does not manage, so a deployment that
 * configures an `ssh://` endpoint is refused by name at construction, where the
 * operator sees it.
 */
export const DEPLOYMENT_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "git:"]);
/** Human-readable supported set, used verbatim in refusals and docs. */
export const SUPPORTED_REPLICA_PROTOCOLS = "https, http, git" as const;

/** Re-exported so callers can validate one endpoint without building a transport. */
export interface AllowlistedEndpoint {
    /** Canonical URL string this transport will use. */
    readonly url: string;
    /** Canonical `host[:port]` the URL names. */
    readonly authority: string;
}

/**
 * Validate one endpoint against a deployment allowlist.
 *
 * An endpoint carrying userinfo is refused outright: a password in a URL would end
 * up in argv, in a process listing and possibly in a log. The deployment must pass
 * a credential reference instead.
 * @param raw - the URL declared by the deployment.
 * @param allowlist - canonical `host[:port]` entries the deployment permits.
 * @returns the endpoint, or the reason it was refused.
 */
export function allowlistedEndpoint(raw: string, allowlist: readonly string[]): { ok: true; value: AllowlistedEndpoint } | { ok: false; reason: string } {
    if (allowlist.length === 0) return { ok: false, reason: "this deployment declares no replica endpoint allowlist" };
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return { ok: false, reason: "replica endpoint is not an absolute URL" }; }
    if (!DEPLOYMENT_PROTOCOLS.has(parsed.protocol)) return { ok: false, reason: `replica endpoint must use one of the supported transports (${SUPPORTED_REPLICA_PROTOCOLS}); ${parsed.protocol} is not supported by this release` };
    if (parsed.username || parsed.password) return { ok: false, reason: "replica endpoint must not embed credentials; use a native credential reference" };
    if (!parsed.hostname) return { ok: false, reason: "replica endpoint must name a host" };
    if (!parsed.pathname || parsed.pathname === "/") return { ok: false, reason: "replica endpoint must name a repository path" };
    const authority = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    const allowed = new Set(allowlist.map(entry => entry.trim().toLowerCase()));
    if (!allowed.has(authority.toLowerCase())) return { ok: false, reason: `replica host ${authority} is not on this deployment's allowlist` };
    return { ok: true, value: { url: parsed.toString(), authority } };
}

export interface AllowlistedTransportOptions {
    /** Deployment allowlist of `host[:port]` values. Empty means no network at all. */
    readonly allowlist: readonly string[];
    /** Resolve an opaque destination handle to its deployment-declared URL. */
    resolve(destinationHandle: string): string;
    /** Deployment-stated remote identity the owner must confirm. */
    readonly identity: string;
    /** Private directory for fetched quarantine candidates. */
    readonly quarantineRoot: string;
    /**
     * Fallback Host-local repository for a call that carries no transfer context.
     *
     * The engine normally passes the repository per call
     * (ReplicaTransferContext.primaryRoot), because only the held lease knows the
     * archive's *current* location after a relocation. This value is only a
     * constructor-time default used when a caller has no lease (for example a
     * standalone transport check).
     */
    readonly primaryRoot: string;
    /** Native authorization; re-evaluated by the caller before every transfer. */
    authorize(actor: Actor, replica: Replica): boolean;
    /**
     * Resolve the HTTP credential for one transfer, or `undefined` for an
     * unauthenticated one.
     *
     * Supplied by the native adapter from the Host credential provider, per call, so
     * a rotated or revoked secret reaches the next operation and nothing is cached
     * here. The username is a separate non-secret field: this release never guesses
     * a token's username by sending the token as both halves of the pair.
     *
     * The secret is never put in argv or a URL. It reaches Git through the fixed
     * askpass bridge this module installs, because Git does not read an arbitrary
     * environment variable for HTTP authentication.
     */
    readonly credential?: (replica: Replica) => ReplicaHttpCredential | undefined;
    /**
     * Additional non-secret environment for the Git child.
     *
     * A name that could redirect Git is refused at construction; a secret must not
     * be passed here (use `credential`), because only the bridge is wired to be
     * consumed by Git.
     */
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
}

interface GitResult { code: number | null; stdout: string; stderr: string }

const MAIN = "refs/ensemble/main";
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Constructor-time configuration fault: a deployment bug, not a transfer outcome. */
function configError(message: string): Error {
    // Configuration errors are raised before any transfer, contain no credential or
    // URL, and are read by an operator at boot rather than persisted in a receipt.
    return new Error(message);
}

/** One fixed Git invocation: no shell, no caller argv, no ambient GIT_ variables. */
function git(args: readonly string[], options: { cwd?: string; env?: Readonly<Record<string, string>>; timeoutMs: number }): GitResult {
    const env: Record<string, string> = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: options.cwd ?? "/",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        // The bridge sets the credential mechanism, prompt policy, config scope and
        // locale for every child; this base map only fixes the protocol set so an
        // ambient configuration cannot re-enable a scheme this release refuses.
        GIT_ALLOW_PROTOCOL: "https:http:git",
    };
    for (const [name, value] of Object.entries(options.env ?? {})) env[name] = value;
    const result = spawnSync("git", [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "protocol.ext.allow=never",
        // Never let a redirect carry an authenticated request to another origin.
        "-c", "http.followRedirects=false",
        // No ambient credential helper can supply a stored identity.
        "-c", "credential.helper=",
        ...args,
    ], {
        cwd: options.cwd ?? "/", env, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024,
    });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Turn a failed Git invocation into a classified failure.
 *
 * The child's stderr is deliberately **not** forwarded: it can quote a remote URL,
 * an argv line, an askpass helper path or a provider message, and this text ends up
 * in an archive refusal (and therefore in a receipt). Only the exit status and the
 * closed reason token survive.
 */
function requireOk(result: GitResult, description: string, reason: ReplicaTransportFailure = "remote_unreachable"): string {
    if (result.code !== 0) throw new ReplicaTransportError(reason, `${description} failed with exit status ${result.code ?? "signal"}`);
    return result.stdout;
}

/**
 * Build the transport a deployment mounts for real remote replication.
 * @param options - allowlist, endpoint resolution, identity, quarantine and primary root.
 * @returns the transport the replica engine consumes.
 */
export function createAllowlistedReplicaTransport(options: AllowlistedTransportOptions): NativeReplicaTransport {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw configError("invalid network transport timeout");
    if (!options.identity.trim()) throw configError("network transport requires a stated remote identity");
    if (options.allowlist.length === 0) throw configError("network transport requires a non-empty deployment endpoint allowlist");
    // Validate the deployment's environment at construction: a name that could
    // redirect Git must fail where an operator sees it, not at the first push.
    for (const name of Object.keys(options.environment ?? {})) {
        if (!ENV_NAME.test(name)) throw configError(`deployment environment name ${JSON.stringify(name)} is not a plain variable`);
        if (name.startsWith("GIT_")) throw configError(`deployment must not set ${name}; the transport fixes Git's environment`);
    }
    const quarantine = resolve(options.quarantineRoot);
    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    if ((lstatSync(quarantine).mode & 0o077) !== 0 || realpathSync(quarantine) !== quarantine) throw configError("quarantine root must be a canonical private directory");
    if (!isAbsolute(options.primaryRoot) || resolve(options.primaryRoot) !== options.primaryRoot) throw configError("primary repository must be a canonical absolute path");

    /**
     * The repository a push may read: the per-call lease value when present, else
     * the deployment default. Re-validated every time so a caller cannot point a
     * push at an arbitrary directory, and no value is stored between calls.
     */
    function repositoryFor(context?: ReplicaTransferContext): string {
        const candidate = context?.primaryRoot ?? options.primaryRoot;
        if (!isAbsolute(candidate) || resolve(candidate) !== candidate) throw new ReplicaTransportError("invalid_destination", "push requires a canonical absolute primary repository");
        return candidate;
    }
    /**
     * Resolve the endpoint for one transfer.
     *
     * The key is the **deployment-declared name** the engine took from the owner's
     * location capability. The replica record's `destinationHandle` is a runtime
     * capability id and is deliberately never used here: accepting both forms would let
     * a stale or forged handle reach a deployment entry by accident.
     */
    function endpoint(context?: ReplicaTransferContext): AllowlistedEndpoint {
        const key = context?.destinationKey;
        if (!key) throw new ReplicaTransportError("not_authorized", "this transfer carries no deployment destination");
        let raw: string;
        try { raw = options.resolve(key); }
        catch { throw new ReplicaTransportError("invalid_destination", "this deployment does not declare that replica destination"); }
        const checked = allowlistedEndpoint(raw, options.allowlist);
        if (!checked.ok) throw new ReplicaTransportError("invalid_destination", checked.reason);
        return checked.value;
    }
    /**
     * Run one Git invocation that may authenticate, with the bridge applied.
     *
     * The bridge exists only for the duration of this call: it is created from the
     * current credential, merged into the child environment, and disposed in a
     * `finally`, so a failure cannot leave a helper (or a secret-bearing variable)
     * behind for the next transfer.
     */
    function withCredential<T>(replica: Replica, run: (env: Readonly<Record<string, string>>) => T): T {
        let bridge: BridgedCredential;
        try {
            // The bridge is installed for every transfer, credential or not, so the
            // empty-config/redirect/no-prompt hardening is never conditional.
            bridge = createCredentialBridge(options.credential?.(replica));
        }
        catch (error) {
            // A credential this release cannot carry safely is a classified refusal,
            // never a transfer attempt with a half-applied environment.
            throw new ReplicaTransportError("credential_unavailable", error instanceof Error ? error.message : "the resolved credential is unusable");
        }
        try {
            // The bridge's entries are applied last so a deployment cannot override
            // GIT_ASKPASS, the prompt policy or the empty config scope.
            const env = { ...(options.environment ?? {}), ...bridge.environment };
            return run(env);
        }
        finally { bridge.dispose(); }
    }
    function remoteHead(url: string, replica: Replica): string | null {
        const stdout = withCredential(replica, env => requireOk(git(["ls-remote", "--refs", url, MAIN], { timeoutMs, env }), "read remote ref"));
        if (!stdout.trim()) return null;
        const match = /^([0-9a-f]{40})\trefs\/ensemble\/main\n?$/.exec(stdout);
        if (!match) throw new ReplicaTransportError("quarantine_failed", "the remote returned an invalid ref");
        return match[1]!;
    }
    return {
        /**
         * Authorize one deployment transfer and return its capability.
         *
         * The capability carries the destination key this specific call resolved, not a
         * constructor value: two archives on different declared destinations cannot observe
         * each other's identity, and a capability cannot outlive the call that produced it.
         */
        async authorize(actor, replica, _signal, context?: ReplicaTransferContext) {
            if (actor.kind !== "owner" || actor.channel !== "authenticated-remote") return undefined;
            if (!replica.credentialHandle || replica.credentialHandle.length > 512) return undefined;
            // Defence in depth: a destination the deployment does not declare, or a transfer
            // carrying no key, is not authorized - so the refusal is `not_authorized` before
            // any child process exists.
            try { endpoint(context); } catch { return undefined; }
            if (!options.authorize(actor, replica)) return undefined;
            return { identity: options.identity, destinationKey: context!.destinationKey };
        },
        async head(replica, _signal, context?: ReplicaTransferContext) { return remoteHead(endpoint(context).url, replica); },
        async push(replica, revision, expected, _signal, context?: ReplicaTransferContext) {
            const repository = repositoryFor(context);
            const { url } = endpoint(context);
            const observed = remoteHead(url, replica);
            if (observed !== expected) throw new ReplicaTransportError("remote_conflict", "remote head changed before push");
            const pushed = withCredential(replica, env => git(["-C", repository, "push", "--porcelain", url, `${revision}:${MAIN}`], { timeoutMs, env }));
            if (pushed.code !== 0) {
                // Never infer failure from a non-zero exit after the transfer began:
                // the remote may have accepted the update.
                if (remoteHead(url, replica) === revision) return;
                throw new ReplicaTransportError("remote_unreachable", "the remote refused the push");
            }
            if (remoteHead(url, replica) !== revision) throw new ReplicaTransportError("quarantine_failed", "push acknowledgement could not be verified");
        },
        async fetch(replica, expected, _signal, context?: ReplicaTransferContext) {
            const { url } = endpoint(context);
            const id = `candidate_${randomUUID()}`;
            const root = join(quarantine, id);
            mkdirSync(root, { mode: 0o700 });
            const baseEnv = options.environment ?? {};
            requireOk(git(["init", "--bare", "--quiet", "--template=", "--object-format=sha1", "."], { cwd: root, timeoutMs, env: baseEnv }), "initialize quarantine", "quarantine_failed");
            requireOk(withCredential(replica, env => git(["fetch", "--no-tags", "--no-write-fetch-head", url, `${MAIN}:${MAIN}`], { cwd: root, timeoutMs, env })), "fetch into quarantine");
            const head = requireOk(git(["for-each-ref", "--format=%(objectname)", MAIN], { cwd: root, timeoutMs, env: baseEnv }), "read quarantine ref", "quarantine_failed").trim();
            if (head !== expected) throw new ReplicaTransportError("remote_conflict", "remote changed during fetch; quarantine is not activated");
            requireOk(git(["fsck", "--full", "--no-reflogs"], { cwd: root, timeoutMs, env: baseEnv }), "verify quarantine", "quarantine_failed");
            return { candidateId: id, head, readOnly: true as const };
        },
    };
}
