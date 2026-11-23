/**
 * Standalone git smart-HTTP fixture that requires HTTP basic auth.
 *
 * It is a **separate process** on purpose. The transport under test runs Git with
 * a blocking spawn, so a server living in the same event loop could never answer a
 * request: an in-process fixture would silently prove nothing and then time out.
 *
 * Usage: node auth-server-fixture.mjs <bareRepoDir> <user> <secret>
 * Prints exactly two lines, then serves until killed:
 *   PORT <n>
 *   COMMIT <sha>
 * Every request's authorization outcome is appended to `<bareRepoDir>/../observed.log`
 * as `ok` or `denied`, which is how the caller proves what Git actually sent.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [, , repo, user, secret] = process.argv;
if (!repo || !user || !secret) {
    console.error("usage: node auth-server-fixture.mjs <bareRepoDir> <user> <secret>");
    process.exit(2);
}
const observed = join(repo, "..", "observed.log");
appendFileSync(observed, "");

const git = (args, options = {}) => spawnSync("git", args, { encoding: "utf8", ...options });
const tree = git(["mktree"], { cwd: repo }).stdout.trim();
const commit = git(["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit-tree", tree, "-m", "fixture"], { cwd: repo }).stdout.trim();
git(["update-ref", "refs/ensemble/main", commit], { cwd: repo });

const expected = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const server = createServer((request, response) => {
    request.resume();
    const header = request.headers["authorization"];
    const authorized = header === expected;
    appendFileSync(observed, authorized ? "ok\n" : "denied\n");
    if (!authorized) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="replica"', connection: "close" });
        response.end("authentication required");
        return;
    }
    // Authorized: let the real server implementation answer, so the framing is
    // Git's own and this fixture cannot invent a protocol bug.
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // The CGI environment is passed as the child's environment (that is the CGI
    // contract), not on stdin.
    const backend = spawnSync("git", ["http-backend"], {
        env: {
            ...process.env,
            GIT_PROJECT_ROOT: join(repo, ".."),
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.replace(/^\?/, ""),
            REQUEST_METHOD: request.method ?? "GET",
            CONTENT_TYPE: "",
            REMOTE_USER: user,
            REMOTE_ADDR: "127.0.0.1",
            GATEWAY_INTERFACE: "CGI/1.1",
            SERVER_PROTOCOL: "HTTP/1.1",
        },
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
    });
    if (backend.status !== 0) {
        response.writeHead(500, { connection: "close" });
        response.end();
        return;
    }
    const separator = backend.stdout.indexOf("\r\n\r\n");
    const head = backend.stdout.subarray(0, separator).toString("utf8");
    const body = backend.stdout.subarray(separator + 4);
    const headers = {};
    let status = 200;
    for (const line of head.split("\r\n")) {
        const index = line.indexOf(":");
        if (index === -1) continue;
        const name = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (name === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
    }
    response.writeHead(status, { ...headers, connection: "close" });
    response.end(body);
});

server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`PORT ${typeof address === "object" && address ? address.port : 0}\n`);
    process.stdout.write(`COMMIT ${commit}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
