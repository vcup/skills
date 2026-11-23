/**
 * Loopback network replica transport — **acceptance evidence only**.
 *
 * The archive kernel never talks to a network: its Git child is confined to
 * `file` transport so an archive commit cannot be redirected by a remote. Remote
 * replication is therefore a *separate native capability*: `replication.ts`
 * accepts an injected NativeReplicaTransport and refuses a non-Host destination
 * when none is mounted, instead of adding a remote argument to any archive
 * command.
 *
 * This module proves that branch against a **real** `git daemon` on the loopback
 * interface, with fixed argv, no shell, a scrubbed environment, and an endpoint
 * that must be a loopback `git://`/`http://`/`https://` URL. It deliberately
 * cannot reach a non-loopback host, and it is **never** the transport a deployment
 * runs: `./network-deployment` owns the deployment allowlist and the supported
 * protocol set (`https`, `http`, `git`).
 *
 * Production remotes need a native credential handle resolved by the credential
 * owner; this module keeps credential values out of the archive entirely — only a
 * boolean authorization and an opaque handle are visible, and the handle is never
 * persisted here.
 *
 * Failures after construction are classified ({@link ReplicaTransportError}) so no
 * URL, argv or provider text can reach a receipt.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Actor } from "../../../modules/ensemble/contracts.ts";
import { ReplicaTransportError, type NativeReplicaTransport, type Replica, type ReplicaTransferContext, type ReplicaTransportFailure } from "./replication.ts";

/** Endpoint shapes this acceptance transport is willing to talk to. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Parse and restrict a remote URL. */
export function loopbackEndpoint(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return { ok: false, reason: "remote endpoint is not an absolute URL" }; }
    if (!["git:", "http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "remote endpoint must use git, http or https" };
    if (!LOOPBACK.has(parsed.hostname)) return { ok: false, reason: "acceptance transport only reaches a loopback endpoint" };
    if (parsed.username || parsed.password) return { ok: false, reason: "remote endpoint must not embed credentials" };
    if (!parsed.pathname || parsed.pathname === "/") return { ok: false, reason: "remote endpoint must name a repository path" };
    return { ok: true, url: parsed.toString() };
}

export interface LoopbackTransportOptions {
    /** Native-side resolution of an opaque destination handle to a remote URL. */
    resolve(destinationHandle: string): string;
    /** Deployment-stated remote identity, compared with the owner's expected identity. */
    readonly identity: string;
    /** Private directory for fetched quarantine candidates. */
    readonly quarantineRoot: string;
    /**
     * Fallback primary repository for a call that carries no transfer context.
     *
     * The engine normally passes the repository per call
     * (ReplicaTransferContext.primaryRoot) from the held lease, because only that
     * lease knows the current location after a relocation. A caller-supplied remote
     * cannot influence it either way.
     */
    readonly primaryRoot: string;
    /** Native authorization for this transport. Never derived from the request. */
    authorize(actor: Actor, replica: Replica): boolean;
    /** Optional fixed environment supplied by the native credential owner. */
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
}

interface GitResult { code: number | null; stdout: string; stderr: string }

/** One fixed Git invocation. No shell, no caller argv, no ambient GIT_ variables. */
function git(args: readonly string[], options: { cwd?: string; env?: Readonly<Record<string, string>>; timeoutMs: number }): GitResult {
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: options.cwd ?? "/", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_SSH_COMMAND: "", GIT_ALLOW_PROTOCOL: "git:http:https", LC_ALL: "C" };
    // No filtering here: the constructor has already refused any name that could
    // redirect Git, so silently dropping one would hide a deployment mistake.
    for (const [name, value] of Object.entries(options.env ?? {})) env[name] = value;
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: options.cwd ?? "/", env, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Classified failure; the child's stderr is dropped on purpose so a URL or argv
 * line cannot reach an archive refusal or receipt.
 */
function requireOk(result: GitResult, description: string, reason: ReplicaTransportFailure = "remote_unreachable"): string {
    if (result.code !== 0) throw new ReplicaTransportError(reason, `${description} failed with exit status ${result.code ?? "signal"}`);
    return result.stdout;
}

const MAIN = "refs/ensemble/main";

export function createLoopbackReplicaTransport(options: LoopbackTransportOptions): NativeReplicaTransport {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error("invalid network transport timeout");
    if (!options.identity.trim()) throw new Error("network transport requires a stated remote identity");
    // A deployment-supplied environment is validated once, exactly as the deployment
    // transport does: a name that could redirect Git is a configuration error, not
    // something to quietly discard.
    for (const name of Object.keys(options.environment ?? {})) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new Error(`deployment environment name ${JSON.stringify(name)} is not a plain variable`);
        if (name.startsWith("GIT_")) throw new Error(`deployment must not set ${name}; the transport fixes Git's environment`);
    }
    const quarantine = resolve(options.quarantineRoot);
    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    if ((lstatSync(quarantine).mode & 0o077) !== 0 || realpathSync(quarantine) !== quarantine) throw new Error("quarantine root must be a canonical private directory");
    /** Per-call lease repository when present, else the fixture default; re-validated. */
    function repositoryFor(context?: ReplicaTransferContext): string {
        const candidate = context?.primaryRoot ?? options.primaryRoot;
        if (!isAbsolute(candidate) || resolve(candidate) !== candidate) throw new ReplicaTransportError("invalid_destination", "push requires a canonical absolute primary repository");
        return candidate;
    }
    /**
     * Resolve the loopback endpoint for one transfer.
     *
     * The key is the deployment-declared name the engine took from the owner's location
     * capability; the replica record's `destinationHandle` is a runtime id and is never used
     * here, so an acceptance run cannot depend on the very confusion the interface forbids.
     */
    function endpoint(context?: ReplicaTransferContext): string {
        const key = context?.destinationKey;
        if (!key) throw new ReplicaTransportError("not_authorized", "this transfer carries no deployment destination");
        let raw: string;
        try { raw = options.resolve(key); }
        catch { throw new ReplicaTransportError("invalid_destination", "the deployment cannot resolve this replica destination"); }
        const resolved = loopbackEndpoint(raw);
        if (!resolved.ok) throw new ReplicaTransportError("invalid_destination", resolved.reason);
        return resolved.url;
    }
    function remoteHead(url: string): string | null {
        const stdout = requireOk(git(["ls-remote", "--refs", url, MAIN], { timeoutMs }), "read remote ref");
        if (!stdout.trim()) return null;
        const match = /^([0-9a-f]{40})\trefs\/ensemble\/main\n?$/.exec(stdout);
        if (!match) throw new ReplicaTransportError("quarantine_failed", "the remote returned an invalid ref");
        return match[1]!;
    }
    return {
        /**
         * Authorize one acceptance transfer.
         *
         * The loopback transport is evidence-only: it reaches exactly one local daemon, so
         * its capability names that identity and a synthetic destination key. It still
         * returns a per-call value, because the interface must not let any implementation
         * answer identity from shared state.
         */
        async authorize(actor, replica, _signal, context?: ReplicaTransferContext) {
            if (actor.kind !== "owner" || actor.channel !== "authenticated-remote") return undefined;
            if (!replica.credentialHandle || replica.credentialHandle.length > 512) return undefined;
            try { endpoint(context); } catch { return undefined; }
            if (!options.authorize(actor, replica)) return undefined;
            return { identity: options.identity, destinationKey: context!.destinationKey };
        },
        async head(replica, _signal, context?: ReplicaTransferContext) { return remoteHead(endpoint(context)); },
        async push(replica, revision, expected, _signal, context?: ReplicaTransferContext) {
            const repository = repositoryFor(context);
            const url = endpoint(context);
            const observed = remoteHead(url);
            if (observed !== expected) throw new ReplicaTransportError("remote_conflict", "remote head changed before push");
            const pushed = git(["-C", repository, "push", "--porcelain", url, revision + ":" + MAIN], { timeoutMs, ...(options.environment ? { env: options.environment } : {}) });
            if (pushed.code !== 0) {
                // Never infer failure from a non-zero exit after the transfer began.
                if (remoteHead(url) === revision) return;
                throw new ReplicaTransportError("remote_unreachable", "the remote refused the push");
            }
            if (remoteHead(url) !== revision) throw new ReplicaTransportError("quarantine_failed", "push acknowledgement could not be verified");
        },
        async fetch(replica, expected, _signal?, context?: ReplicaTransferContext) {
            const url = endpoint(context);
            const id = "candidate_" + randomUUID();
            const root = join(quarantine, id);
            mkdirSync(root, { mode: 0o700 });
            const env = { ...(options.environment ?? {}) };
            requireOk(git(["init", "--bare", "--quiet", "--template=", "--object-format=sha1", "."], { cwd: root, timeoutMs, env }), "initialize quarantine", "quarantine_failed");
            requireOk(git(["fetch", "--no-tags", "--no-write-fetch-head", url, MAIN + ":" + MAIN], { cwd: root, timeoutMs, env }), "fetch into quarantine");
            const head = requireOk(git(["for-each-ref", "--format=%(objectname)", MAIN], { cwd: root, timeoutMs, env }), "read quarantine ref", "quarantine_failed").trim();
            if (head !== expected) throw new ReplicaTransportError("remote_conflict", "remote changed during fetch; quarantine is not activated");
            requireOk(git(["fsck", "--full", "--no-reflogs"], { cwd: root, timeoutMs, env }), "verify quarantine", "quarantine_failed");
            return { candidateId: id, head, readOnly: true };
        },
    };
}

/** Assert a path is a canonical private directory. */
export function assertPrivateDirectory(path: string): void {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("directory must be canonical and absolute");
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("directory must be private 0700");
}
