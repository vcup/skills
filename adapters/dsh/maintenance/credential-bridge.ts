/**
 * Fixed credential bridge for the deployment replica transport.
 *
 * ## Why this exists
 *
 * Git does not read an arbitrary environment variable for HTTP authentication. It
 * obtains credentials from an `http.*` config entry, a credential helper, or
 * `GIT_ASKPASS` (falling back to a terminal prompt, which this transport disables).
 * Dropping a token into a variable such as `ENSEMBLE_MIRROR_TOKEN` therefore does
 * nothing at all: the request goes out anonymously and fails against any
 * authenticated remote. "The variable was present" is not evidence of
 * authentication, so this module builds the bridge Git actually consumes.
 *
 * ## Shape of the bridge
 *
 * 1. A **fixed POSIX shell script** with constant text is used as `GIT_ASKPASS`.
 *    It interpolates nothing but two variables the child environment carries; no
 *    secret, URL or caller-supplied string is ever written into it. The script is
 *    installed from this module (one private file per transfer) so a deployment
 *    cannot replace it, and it is removed in `dispose()`.
 * 2. The secret exists only in the child's environment
 *    ({@link BRIDGE_SECRET_ENV}); the username is a separate, non-secret value
 *    ({@link BRIDGE_USER_ENV}). The helper answers a `Username` prompt with the
 *    username and a `Password` prompt with the secret - never the same value to
 *    both, which is how a token gets logged as a "username" by a server that echoes
 *    it.
 * 3. Any other prompt exits non-zero. Git prompts for things this release does not
 *    answer (a `passphrase`, a `PIN`, a rewritten-host confirmation), and answering
 *    them with the HTTP token would send the secret to a field that was never an
 *    HTTP password.
 * 4. Git's credential environment is set **by this module**, never by deployment
 *    configuration: `GIT_ASKPASS` (this helper), `GIT_TERMINAL_PROMPT=0`,
 *    `GIT_ASKPASS_REQUIRE=force`, `GIT_CONFIG_GLOBAL=/dev/null`,
 *    `GIT_CONFIG_NOSYSTEM=1`, and `LC_ALL=C` so prompt text the helper matches on is
 *    not localised.
 * 5. Ambient credential helpers are disabled by running with an empty config scope:
 *    no `credential.helper` can be inherited from a user's stored credentials, so a
 *    transfer cannot silently authenticate as the machine's user.
 *
 * ## What it refuses
 *
 * - An empty secret is "no credential" rather than an empty password.
 * - A secret containing NUL, CR or LF is refused: the helper answers on one line.
 * - A username containing NUL, CR, LF or a colon is refused; a colon would let the
 *   value change the meaning of the credential pair Git assembles.
 * - SSH is not a supported scheme in this release, so key material is out of scope.
 *
 * ## Redirects
 *
 * The transport passes `http.followRedirects=false` so a redirect cannot move an
 * authenticated request to a different origin and hand that origin the secret. See
 * `network-deployment.ts`.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Environment names the generated helper reads. Fixed, not deployment-chosen. */
export const BRIDGE_USER_ENV = "ENSEMBLE_REPLICA_USER";
export const BRIDGE_SECRET_ENV = "ENSEMBLE_REPLICA_SECRET";

/**
 * The helper script: constant text, no interpolation, no secret, no path.
 *
 * Git passes the prompt as `$1`. The two `case` arms answer the username and
 * password prompts; everything else fails closed.
 */
const ASKPASS_SCRIPT = `#!/bin/sh
# Fixed ensemble replica credential bridge (installed by the transport).
# Answers the HTTP username/password prompts from the child environment only.
# It reads no file, no config and no network, and holds no secret itself.
case "$1" in
  *sername*) printf '%s\\n' "\${${BRIDGE_USER_ENV}}" ;;
  *assword*) printf '%s\\n' "\${${BRIDGE_SECRET_ENV}}" ;;
  *) exit 1 ;;
esac
`;

/** A resolved HTTP credential for exactly one transfer. */
export interface ReplicaHttpCredential {
    /** Non-secret username. Required: this release never guesses a token's username. */
    readonly username: string;
    /** Secret value. Never in argv, a URL, a result, a receipt or a log. */
    readonly secret: string;
}

export interface BridgedCredential {
    /** Environment fragments the transport merges for this one Git child. */
    readonly environment: Readonly<Record<string, string>>;
    /** Remove the temporary helper. Safe to call more than once. */
    dispose(): void;
}

function unsafe(value: string, what: string): void {
    if (/[\u0000\n\r]/.test(value)) throw new Error(`resolved replica ${what} contains a character the bridge cannot carry safely`);
}

/**
 * Validate a resolved credential before any child process exists.
 * @param credential - the resolved credential.
 */
export function assertUsableCredential(credential: ReplicaHttpCredential): void {
    if (!credential.username || credential.username.length > 512) throw new Error("replica HTTP credential requires a username of at most 512 characters");
    // A colon would change the meaning of the `user:password` pair Git assembles.
    if (credential.username.includes(":")) throw new Error("replica HTTP credential username must not contain a colon");
    if (!credential.secret || credential.secret.length > 8192) throw new Error("replica HTTP credential requires a secret of at most 8192 characters");
    unsafe(credential.username, "username");
    unsafe(credential.secret, "secret");
}

/**
 * Install the fixed helper for one transfer and return the environment that makes
 * Git use it.
 * @param credential - a resolved credential, or undefined for an unauthenticated transfer.
 * @returns the bridge; created even without a credential so the hardening applies everywhere.
 */
export function createCredentialBridge(credential: ReplicaHttpCredential | undefined): BridgedCredential {
    if (credential) assertUsableCredential(credential);
    const directory = mkdtempSync("/tmp/ensemble-replica-askpass-");
    const script = join(directory, "askpass.sh");
    writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 });
    chmodSync(script, 0o700);
    let disposed = false;
    return {
        environment: {
            // Private 0700 directory and file: another user cannot replace the helper
            // between writing it and Git executing it.
            GIT_ASKPASS: script,
            // Without this, an askpass path is ignored when no terminal is attached.
            GIT_ASKPASS_REQUIRE: "force",
            // Never fall back to asking a human.
            GIT_TERMINAL_PROMPT: "0",
            // Empty config scope: no inherited user config, so no ambient
            // credential.helper can supply the machine's stored identity.
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            // Prompt text the helper matches on must not be localised.
            LC_ALL: "C",
            ...(credential ? { [BRIDGE_USER_ENV]: credential.username, [BRIDGE_SECRET_ENV]: credential.secret } : {}),
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort: the script holds no secret */ }
        },
    };
}

/** Diagnostic identifier; never contains a secret. */
export function bridgeId(): string { return randomUUID(); }
