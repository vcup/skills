import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopbackReplicaTransport, loopbackEndpoint } from "./network.ts";
import type { Replica } from "./replication.ts";
import type { Actor } from "../../../modules/ensemble/contracts.ts";

const owner: Actor = { kind: "owner", ownerId: "network-owner", hostAuthorityId: "network-host", channel: "authenticated-remote" };
const replica = (destinationHandle: string): Replica => ({ id: "replica_one", archiveId: "archive_one", destinationHandle, expectedIdentity: "loopback-remote", credentialHandle: "native:none", expectedRevision: null, state: "configured" });
const signal = new AbortController().signal;
const env = (cwd: string) => ({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const git = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8", env: env(cwd) });

/** A real bare repository behind a real git daemon on loopback, both in this fixture. */
function loopbackServer() {
    const base = mkdtempSync(join(tmpdir(), "ensemble-network-"));
    const served = join(base, "srv.git");
    expect(git(["init", "--bare", "--quiet", served], base).status).toBe(0);
    expect(git(["config", "daemon.receivepack", "true"], served).status).toBe(0);
    const source = join(base, "primary");
    expect(git(["init", "--bare", "--quiet", source], base).status).toBe(0);
    const port = 19400 + Math.floor(Math.random() * 400);
    const daemon = spawn("git", ["daemon", "--reuseaddr", "--base-path=" + base, "--export-all", "--enable=receive-pack", "--listen=127.0.0.1", "--port=" + String(port), "--log-destination=stderr"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    daemon.stderr.setEncoding("utf8");
    daemon.stderr.on("data", chunk => { log += chunk; });
    const url = "git://127.0.0.1:" + String(port) + "/srv.git";
    const ready = spawnSync("node", ["-e", "const net=require('net');const s=net.connect(" + String(port) + ",'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));"], { encoding: "utf8" });
    return { base, source, url, log: () => log, ready: ready.status === 0, stop: () => { daemon.kill("SIGTERM"); rmSync(base, { recursive: true, force: true }); } };
}

describe("network replica transport", () => {
    test("endpoint parsing refuses non-loopback, credentialed and non-repository URLs", () => {
        expect(loopbackEndpoint("https://example.com/repo.git").ok).toBe(false);
        expect(loopbackEndpoint("https://user:secret@127.0.0.1/repo.git").ok).toBe(false);
        expect(loopbackEndpoint("file:///tmp/repo.git").ok).toBe(false);
        expect(loopbackEndpoint("not a url").ok).toBe(false);
        expect(loopbackEndpoint("http://127.0.0.1:8080/").ok).toBe(false);
        expect(loopbackEndpoint("http://127.0.0.1:8080/repo.git").ok).toBe(true);
        expect(loopbackEndpoint("git://localhost/repo.git").ok).toBe(true);
    });

    test("a real git daemon serves an authenticated push and an isolated fetch", async () => {
        const server = loopbackServer();
        try {
            expect(server.ready, server.log()).toBe(true);
            const quarantine = join(server.base, "quarantines");
            const transport = createLoopbackReplicaTransport({ resolve: () => server.url, identity: "loopback-remote", quarantineRoot: quarantine, primaryRoot: server.source, authorize: () => true });
            const target = replica("destination_one");
            // `authorize` answers with a per-call capability, so identity travels with the
            // authorization instead of being read back from shared state.
            // `authorize` takes the transfer context because the deployment key is what makes a
            // destination resolvable; without it there is no endpoint and no capability.
            const context = { primaryRoot: server.source, destinationKey: "loopback" };
            expect(await transport.authorize(owner, target, signal)).toBeUndefined();
            expect(await transport.authorize(owner, target, signal, { primaryRoot: server.source, destinationKey: "" })).toBeUndefined();
            const capability = await transport.authorize(owner, target, signal, context);
            expect(capability).toEqual({ identity: "loopback-remote", destinationKey: "loopback" });
            // Authorization is the injected native capability, not the owner string:
            // a different owner identity is refused by *that* capability, so this
            // asserts the seam is consulted rather than re-implemented here.
            const denying = createLoopbackReplicaTransport({ resolve: () => server.url, identity: "loopback-remote", quarantineRoot: join(server.base, "q2"), primaryRoot: server.source, authorize: () => false });
            expect(await denying.authorize(owner, target, signal, context)).toBeUndefined();
            expect(await denying.authorize(owner, { ...target, credentialHandle: "" }, signal, context)).toBeUndefined();
            expect(await transport.authorize({ kind: "session", sessionId: "s", rootSessionId: "s", workspaceRef: "w", callId: "c" }, target, signal, context)).toBeUndefined();
            expect(await transport.head(target, signal, context, capability!)).toBeNull();

            const tree = git(["mktree"], server.source);
            expect(tree.status).toBe(0);
            const commit = git(["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit-tree", tree.stdout.trim(), "-m", "fixture"], server.source);
            expect(commit.status).toBe(0);
            const revision = commit.stdout.trim();
            expect(git(["update-ref", "refs/ensemble/main", revision], server.source).status).toBe(0);

            await transport.push(target, revision, null, signal, context, capability!);
            expect(await transport.head(target, signal, context, capability!)).toBe(revision);

            const fetched = await transport.fetch(target, revision, signal, context, capability!);
            expect(fetched.readOnly).toBe(true);
            expect(fetched.head).toBe(revision);
            expect(existsSync(join(quarantine, fetched.candidateId, "HEAD"))).toBe(true);
            expect(realpathSync(quarantine)).toBe(quarantine);

            // A fast-forward push to a *newer* local revision is allowed; a stale
            // revision (remote has moved past it) must be refused without forcing.
            const second = git(["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit-tree", tree.stdout.trim(), "-p", revision, "-m", "second"], server.source);
            expect(second.status).toBe(0);
            const next = second.stdout.trim();
            await transport.push(target, next, revision, signal, context, capability!);
            expect(await transport.head(target, signal, context, capability!)).toBe(next);
            await expect(transport.push(target, revision, null, signal, context, capability!)).rejects.toThrow("remote head changed before push");
            await expect(transport.fetch(target, revision, signal, context, capability!)).rejects.toThrow("remote changed during fetch");
            expect(await transport.head(target, signal, context, capability!)).toBe(next);
        } finally { server.stop(); }
    }, 60_000);
});
