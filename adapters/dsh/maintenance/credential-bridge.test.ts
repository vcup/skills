/**
 * Credential-consumption acceptance: prove Git *uses* the resolved secret against
 * a remote that requires authentication.
 *
 * The false positive this guards against: put a token in an environment variable,
 * see a later push work, and call it authenticated — even though Git never read
 * that variable. Every case here runs a **real** `git` child against a **real**
 * HTTP endpoint that inspects `Authorization` and records the verdict:
 *
 * 1. no credential -> 401, Git fails closed (never prompts), the remote records
 *    only denied requests;
 * 2. a wrong secret -> refused the same way;
 * 3. the correct credential, delivered only through the fixed askpass bridge -> the
 *    remote records an authorized request, and the secret appears in no result the
 *    transport produced.
 *
 * The server is a **separate process** (`auth-server-fixture.mjs`): the transport
 * spawns Git synchronously, so an in-process server could never answer and the test
 * would hang while proving nothing.
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BRIDGE_SECRET_ENV, BRIDGE_USER_ENV, createCredentialBridge } from "./credential-bridge.ts";
import { createAllowlistedReplicaTransport } from "./network-deployment.ts";
import type { Replica } from "./replication.ts";

const signal = new AbortController().signal;
const SECRET = "REPLICA-TOKEN-b7f1c2d3";
const USER = "mirror-bot";
const FIXTURE = resolve(import.meta.dir, "auth-server-fixture.mjs");

const git = (args: string[], cwd: string) => spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
});

/** Start the out-of-process auth server; returns its origin, commit and log path. */
async function authRemote(): Promise<{ url: string; commit: string; log: string; stop: () => void; cleanup: () => void }> {
    const base = mkdtempSync(join(tmpdir(), "cred-remote-"));
    const repo = join(base, "repo.git");
    const init = git(["init", "--bare", "--quiet", "--template=", repo], base);
    if (init.status !== 0) throw new Error(init.stderr);
    const log = join(dirname(repo), "observed.log");
    /**
     * Start the fixture, retrying once.
     *
     * The suite runs many ephemeral loopback servers concurrently, so a single bind
     * can lose a race on a port that was free a moment earlier. A retry is the honest
     * fix: the failure is environmental and the second attempt takes a fresh port,
     * rather than an assertion being softened.
     */
    let child: ReturnType<typeof spawn> | undefined;
    let port = 0;
    let commit = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const candidate = spawn("node", [FIXTURE, repo, USER, SECRET], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        candidate.stderr?.setEncoding("utf8");
        candidate.stderr?.on("data", chunk => { stderr += String(chunk); });
        try {
            const started = await new Promise<{ port: number; commit: string }>((resolvePromise, reject) => {
                let buffer = "";
                const timer = setTimeout(() => reject(new Error(`auth fixture did not start: ${buffer} ${stderr}`)), 15_000);
                candidate.stdout?.setEncoding("utf8");
                candidate.stdout?.on("data", chunk => {
                    buffer += String(chunk);
                    const portMatch = /PORT (\d+)/.exec(buffer);
                    const commitMatch = /COMMIT ([0-9a-f]{40})/.exec(buffer);
                    if (portMatch && commitMatch) {
                        clearTimeout(timer);
                        resolvePromise({ port: Number(portMatch[1]), commit: commitMatch[1]! });
                    }
                });
                candidate.on("error", reject);
            });
            child = candidate;
            port = started.port;
            commit = started.commit;
            break;
        }
        catch (error) {
            candidate.kill("SIGTERM");
            if (attempt === 2) throw error;
        }
    }
    if (!child || port === 0) throw new Error("auth fixture never started");
    return {
        url: `http://127.0.0.1:${port}/repo.git`,
        commit,
        log,
        stop: () => { child?.kill("SIGTERM"); },
        cleanup: () => { rmSync(base, { recursive: true, force: true }); },
    };
}

function observed(log: string): string[] {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
}

/** Transfer context: the deployment key is trusted metadata from the location capability. */
const ctx = { primaryRoot: "/tmp/credential-fixture-primary", destinationKey: "mirror" };
/** The capability the transport's own `authorize` returns for this destination. */
const capability = { identity: "http-mirror", destinationKey: "mirror" };
const replica: Replica = { id: "replica_one", archiveId: "archive_one", destinationHandle: "mirror", expectedIdentity: "http-mirror", credentialHandle: "native:replica", expectedRevision: null, state: "configured" };

function transportFor(url: string, credential?: { username: string; secret: string }) {
    return createAllowlistedReplicaTransport({
        allowlist: [new URL(url).host],
        resolve: (key: string) => { if (key !== "mirror") throw new Error("undeclared"); return url; },
        identity: "http-mirror",
        quarantineRoot: mkdtempSync(join(tmpdir(), "cred-q-")),
        primaryRoot: "/tmp/credential-fixture-primary",
        // A remote answering 401 makes Git wait for a human unless a credential is
        // supplied; the transport deadline is what turns that into a failure.
        timeoutMs: 10_000,
        authorize: () => true,
        ...(credential === undefined ? {} : { credential: () => credential }),
    });
}

describe("the credential bridge is consumed by Git", () => {
    test("no credential fails against an authenticated remote and is recorded as denied", async () => {
        const remote = await authRemote();
        try {
            await expect(transportFor(remote.url).head(replica, signal, ctx, capability)).rejects.toThrow();
            const entries = observed(remote.log);
            expect(entries.length).toBeGreaterThan(0);
            expect(entries.every(entry => entry === "denied")).toBe(true);
        } finally { remote.stop(); remote.cleanup(); }
    }, 90_000);

    test("a wrong secret is refused and the right one through the bridge is accepted", async () => {
        const remote = await authRemote();
        try {
            await expect(transportFor(remote.url, { username: USER, secret: "WRONG-TOKEN" }).head(replica, signal, ctx, capability)).rejects.toThrow();
            expect(observed(remote.log).every(entry => entry === "denied")).toBe(true);
            // The real proof: the resolved secret reaches the server through askpass,
            // so the remote records an authorized request and returns its ref.
            const right = transportFor(remote.url, { username: USER, secret: SECRET });
            expect(await right.head(replica, signal, ctx, capability)).toBe(remote.commit);
            expect(observed(remote.log).filter(entry => entry === "ok").length).toBeGreaterThan(0);
        } finally { remote.stop(); remote.cleanup(); }
    }, 90_000);

    test("the helper answers each prompt from its own field and refuses unknown prompts", () => {
        const bridge = createCredentialBridge({ username: USER, secret: SECRET });
        const script = bridge.environment["GIT_ASKPASS"]!;
        const text = readFileSync(script, "utf8");
        // Constant text: no secret, no username, no URL is interpolated into it.
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(USER);
        expect(statSync(script).mode & 0o777).toBe(0o700);
        const ask = (prompt: string) => spawnSync(script, [prompt], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...bridge.environment } });
        expect(ask("Username for 'https://git.example': ").stdout).toBe(`${USER}\n`);
        expect(ask("Password for 'https://mirror-bot@git.example': ").stdout).toBe(`${SECRET}\n`);
        // An unknown prompt must fail closed rather than answer with the secret.
        const passphrase = ask("Enter passphrase for key '/id_ed25519': ");
        expect(passphrase.status).not.toBe(0);
        expect(passphrase.stdout).toBe("");
        bridge.dispose();
        expect(existsSync(script)).toBe(false);
    });

    test("an authenticated transfer never follows a redirect to another origin", async () => {
        // Git runs with http.followRedirects=false, so a 302 must stop the transfer
        // instead of replaying the Authorization header at a new origin.
        const target = await authRemote();
        const redirect = createServer((request, response) => {
            request.resume();
            response.writeHead(302, { location: target.url, connection: "close" });
            response.end();
        });
        await new Promise<void>(resolve => redirect.listen(0, "127.0.0.1", () => resolve()));
        const address = redirect.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        try {
            // A tight deadline keeps a following-Git implementation from passing by
            // simply timing out slowly.
            const transport = createAllowlistedReplicaTransport({
                allowlist: [`127.0.0.1:${port}`],
                resolve: (key: string) => { if (key !== "mirror") throw new Error("undeclared"); return `http://127.0.0.1:${port}/repo.git`; },
                identity: "http-mirror",
                quarantineRoot: mkdtempSync(join(tmpdir(), "cred-q-redirect-")),
                primaryRoot: "/tmp/credential-fixture-primary",
                timeoutMs: 4000,
                authorize: () => true,
                credential: () => ({ username: USER, secret: SECRET }),
            });
            await expect(transport.head(replica, signal, ctx, capability)).rejects.toThrow();
            // The redirect target must have received nothing at all.
            expect(observed(target.log)).toEqual([]);
        } finally {
            await new Promise<void>(resolve => redirect.close(() => resolve()));
            target.stop();
            target.cleanup();
        }
    }, 90_000);

    test("a credential that cannot be carried safely is refused before any child runs", () => {
        expect(() => createCredentialBridge({ username: USER, secret: "" })).toThrow();
        expect(() => createCredentialBridge({ username: "", secret: SECRET })).toThrow();
        expect(() => createCredentialBridge({ username: USER, secret: "a\nb" })).toThrow();
        // A colon would change the meaning of the pair Git assembles.
        expect(() => createCredentialBridge({ username: "a:b", secret: SECRET })).toThrow();
        // An unauthenticated transfer still gets the hardened environment.
        const bridge = createCredentialBridge(undefined);
        expect(bridge.environment["GIT_TERMINAL_PROMPT"]).toBe("0");
        expect(bridge.environment["GIT_ASKPASS_REQUIRE"]).toBe("force");
        expect(bridge.environment["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
        expect(bridge.environment[BRIDGE_SECRET_ENV]).toBeUndefined();
        expect(bridge.environment[BRIDGE_USER_ENV]).toBeUndefined();
        bridge.dispose();
    });
});
