import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_REPLICA_PROTOCOLS, allowlistedEndpoint, createAllowlistedReplicaTransport } from "./network-deployment.ts";
import type { Replica } from "./replication.ts";
import type { Actor } from "../../../modules/ensemble/contracts.ts";

const owner: Actor = { kind: "owner", ownerId: "deployment-owner", hostAuthorityId: "deployment-host", channel: "authenticated-remote" };
const signal = new AbortController().signal;
/**
 * Transfer context: the deployment key is trusted metadata, never the runtime handle,
 * and the repository comes from the held lease rather than the transport constructor.
 */
const ctx = (key: string, primaryRoot = "/tmp") => ({ primaryRoot, destinationKey: key });
const capability = (key: string) => ({ identity: "deployment-remote", destinationKey: key });
const replica = (destinationHandle: string): Replica => ({ id: "replica_one", archiveId: "archive_one", destinationHandle, expectedIdentity: "deployment-remote", credentialHandle: "native:replica-token", expectedRevision: null, state: "configured" });
const env = (cwd: string) => ({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const git = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8", env: env(cwd) });

describe("deployment replica allowlist", () => {
    test("only declared hosts are reachable, and credentials may not appear in a URL", () => {
        const allowlist = ["git.internal.example", "backup.example:8443"];
        expect(allowlistedEndpoint("https://git.internal.example/team/archive.git", allowlist).ok).toBe(true);
        expect(allowlistedEndpoint("git://backup.example:8443/srv/archive.git", allowlist).ok).toBe(true);
        // The supported set is exactly https/http/git — the same set the native
        // adapter and the docs state. SSH is refused by name rather than accepted
        // and then failing at transfer time.
        const ssh = allowlistedEndpoint("ssh://backup.example:8443/srv/archive.git", allowlist);
        expect(ssh.ok).toBe(false);
        if (!ssh.ok) expect(ssh.reason).toContain("ssh:");
        expect(SUPPORTED_REPLICA_PROTOCOLS).toBe("https, http, git");
        // A host that is not declared is refused even though the URL is well formed.
        expect(allowlistedEndpoint("https://attacker.example/archive.git", allowlist).ok).toBe(false);
        // A declared host on an undeclared port is a different authority.
        expect(allowlistedEndpoint("https://backup.example/srv/archive.git", allowlist).ok).toBe(false);
        // A password in the URL would reach argv and logs.
        expect(allowlistedEndpoint("https://user:secret@git.internal.example/archive.git", allowlist).ok).toBe(false);
        expect(allowlistedEndpoint("file:///srv/archive.git", allowlist).ok).toBe(false);
        expect(allowlistedEndpoint("ext::sh -c touch% /tmp/x", allowlist).ok).toBe(false);
        expect(allowlistedEndpoint("https://git.internal.example/", allowlist).ok).toBe(false);
        // An empty allowlist means no network capability at all.
        expect(allowlistedEndpoint("https://git.internal.example/a.git", []).ok).toBe(false);
        // The transport refuses to be constructed without an allowlist.
        expect(() => createAllowlistedReplicaTransport({ allowlist: [], resolve: () => "https://x/a.git", identity: "id", quarantineRoot: "/tmp/q-x", primaryRoot: "/tmp", authorize: () => true })).toThrow();
    });

    test("an undeclared endpoint never reaches a child process", async () => {
        const base = mkdtempSync(join(tmpdir(), "ensemble-deploy-"));
        const primary = join(base, "primary");
        git(["init", "--bare", "--quiet", primary], base);
        try {
            // The deployment map is the only source of endpoints: a handle it does
            // not declare cannot resolve to a URL at all.
            const declared = new Map([["declared", "https://git.internal.example/a.git"], ["elsewhere", "https://not-listed.example/a.git"]]);
            const transport = createAllowlistedReplicaTransport({
                allowlist: ["git.internal.example"],
                resolve: handle => { const url = declared.get(handle); if (url === undefined) throw new Error("undeclared handle"); return url; },
                identity: "id", quarantineRoot: join(base, "q2"), primaryRoot: primary, authorize: () => true,
            });
            expect(await transport.authorize(owner, replica("undeclared"), signal)).toBeUndefined();
            // A handle that resolves outside the allowlist is refused too.
            expect(await transport.authorize(owner, replica("elsewhere"), signal)).toBeUndefined();
            // A transfer with no deployment key never reaches a child process, and a key
            // the deployment does not declare is refused rather than falling back.
            await expect(transport.head(replica("declared"), signal, ctx(""), capability("declared"))).rejects.toThrow();
            await expect(transport.head(replica("declared"), signal, ctx("elsewhere"), capability("declared"))).rejects.toThrow();
            expect(await transport.authorize({ kind: "session", sessionId: "s", rootSessionId: "s", workspaceRef: "w", callId: "c" }, replica("declared"), signal)).toBeUndefined();
            // A deployment cannot smuggle a Git-redirecting variable in.
            expect(() => createAllowlistedReplicaTransport({
                allowlist: ["git.internal.example"], resolve: () => "https://git.internal.example/a.git",
                identity: "id", quarantineRoot: join(base, "q3"), primaryRoot: primary, authorize: () => true,
                environment: { GIT_DIR: "/somewhere/else" },
            })).toThrow("must not set GIT_DIR");
            expect(() => createAllowlistedReplicaTransport({
                allowlist: ["git.internal.example"], resolve: () => "https://git.internal.example/a.git",
                identity: "id", quarantineRoot: join(base, "q4"), primaryRoot: primary, authorize: () => true,
                environment: { "bad name": "x" },
            })).toThrow();
        } finally { rmSync(base, { recursive: true, force: true }); }
    });

    test("a declared endpoint runs the real push/conflict/fetch cycle", async () => {
        // A loopback host may be *declared* by a test deployment, which is how this
        // exercises the same code path a real endpoint uses.
        const base = mkdtempSync(join(tmpdir(), "ensemble-deploy-live-"));
        const served = join(base, "srv.git");
        git(["init", "--bare", "--quiet", served], base);
        git(["config", "--file", join(served, "config"), "daemon.receivepack", "true"], base);
        const primary = join(base, "primary");
        git(["init", "--bare", "--quiet", primary], base);
        const port = 19900 + Math.floor(Math.random() * 80);
        const daemon = spawn("git", ["daemon", "--reuseaddr", "--base-path=" + base, "--export-all", "--enable=receive-pack", "--listen=127.0.0.1", "--port=" + String(port), "--log-destination=stderr"], { stdio: ["ignore", "ignore", "pipe"] });
        try {
            const url = `git://127.0.0.1:${port}/srv.git`;
            const transport = createAllowlistedReplicaTransport({
                allowlist: [`127.0.0.1:${port}`], resolve: (key: string) => { if (key !== "declared") throw new Error("undeclared"); return url; }, identity: "deployment-remote",
                quarantineRoot: join(base, "q"), primaryRoot: primary, authorize: () => true,
            });
            const target = replica("declared");
            expect(await transport.authorize(owner, target, signal, ctx("declared", primary))).toBeDefined();
            // The declared-key check is real: a keyless or undeclared transfer is not authorized.
            expect(await transport.authorize(owner, target, signal, ctx("", primary))).toBeUndefined();
            expect(await transport.authorize(owner, target, signal, ctx("elsewhere", primary))).toBeUndefined();
            const tree = git(["mktree"], primary).stdout.trim();
            const first = git(["-c", "user.name=a", "-c", "user.email=a@b", "commit-tree", tree, "-m", "first"], primary).stdout.trim();
            git(["update-ref", "refs/ensemble/main", first], primary);
            await transport.push(target, first, null, signal, ctx("declared", primary), capability("declared"));
            expect(await transport.head(target, signal, ctx("declared", primary), capability("declared"))).toBe(first);
            const fetched = await transport.fetch(target, first, signal, ctx("declared", primary), capability("declared"));
            expect(fetched.readOnly).toBe(true);
            expect(fetched.head).toBe(first);
            expect(existsSync(join(base, "q", fetched.candidateId, "HEAD"))).toBe(true);
            expect(realpathSync(join(base, "q"))).toBe(join(base, "q"));
            // A divergent remote must be refused, never forced or merged.
            const second = git(["-c", "user.name=a", "-c", "user.email=a@b", "commit-tree", tree, "-p", first, "-m", "second"], primary).stdout.trim();
            git(["update-ref", "refs/ensemble/main", second], primary);
            await expect(transport.push(target, first, null, signal, ctx("declared", primary), capability("declared"))).rejects.toThrow("remote head changed before push");
            // And a fast-forward push after re-reading the remote is allowed.
            await transport.push(target, second, first, signal, ctx("declared", primary), capability("declared"));
            expect(await transport.head(target, signal, ctx("declared", primary), capability("declared"))).toBe(second);
        } finally {
            daemon.kill("SIGTERM");
            rmSync(base, { recursive: true, force: true });
        }
    }, 60_000);
});
