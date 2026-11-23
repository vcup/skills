/**
 * Minimal local git HTTP server that REQUIRES authentication.
 *
 * Purpose: settle one question with a counterexample instead of an assumption —
 * does a plain injected environment variable (`ENSEMBLE_MIRROR_TOKEN`) cause Git
 * to authenticate to an HTTP remote?
 *
 * It serves a real bare repository over `git http-backend` and refuses any
 * request without `Authorization: Basic …`. Credentials never come from argv or a
 * URL; the test-only user/token are generated here and printed for the harness.
 *
 * Usage: node scripts/fixtures/git-auth-server.mjs <bare-repo-dir>
 * Prints one JSON banner: {origin, username, token, port}. Stops on SIGTERM.
 *
 * This is a test fixture, never a product component.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/fixtures/git-auth-server.mjs <bare-repo-dir>");
  process.exit(2);
}
const username = "fixture";
const token = randomBytes(16).toString("hex");
const expected = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;

const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    // A 401 without a realm prompt keeps this deterministic: Git must not fall
    // back to an interactive prompt in the harness.
    request.resume();
    response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"', "content-type": "text/plain" });
    response.end("authentication required\n");
    return;
  }
  // The request URL is path-only (`/repo.git/info/refs?…`). Parse it directly
  // rather than through a base URL, so `pathname` cannot acquire an extra host
  // prefix and `GIT_PROJECT_ROOT`+`PATH_INFO` keep the shape git http-backend
  // expects.
  const raw = request.url ?? "/";
  const queryAt = raw.indexOf("?");
  const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const search = queryAt < 0 ? "" : raw.slice(queryAt + 1);
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_PROJECT_ROOT: repo,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(pathname),
      QUERY_STRING: search,
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      REMOTE_USER: username,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  child.stdout.on("data", (chunk) => {
    if (headersSent) { response.write(chunk); return; }
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const end = headerBuffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = headerBuffer.subarray(0, end).toString();
    const body = headerBuffer.subarray(end + 4);
    let status = 200;
    const headers = {};
    for (const line of head.split("\r\n")) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name.toLowerCase()] = value;
    }
    response.writeHead(status, headers);
    headersSent = true;
    if (body.length > 0) response.write(body);
  });
  child.on("close", () => {
    if (!headersSent) { response.writeHead(500); response.end(stderr || "git http-backend produced no output"); return; }
    response.end();
  });
  request.pipe(child.stdin);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${port}`, username, token, port }));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
