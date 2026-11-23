/**
 * Contract tests for the test-only source world server, driven over its real
 * HTTP surface.
 *
 * The server exists so the acceptance run can read source bytes from a second
 * container with no shared filesystem. These tests therefore start the actual
 * script as a child process and speak only its wire protocol — no imports, no
 * monkeypatched internals — because the property under test is what the process
 * does to a caller that has nothing but the socket.
 *
 * Covered here:
 *   - authentication is required for every route, and a missing or wrong token
 *     never reaches a handler;
 *   - path handling refuses NUL, backslash, `..`, and anything outside
 *     `/source`, and refuses to traverse an intermediate symlink;
 *   - targets are opaque handles: an unknown or fabricated key is refused;
 *   - byte budgets are enforced by the server, not merely requested by the
 *     caller, and unknown routes/verbs are refused;
 *   - the read ACL is dynamic: after `readable: false` every read fails, and
 *     restoring it makes them succeed again;
 *   - the fixture root is fresh per process and all of its content is synthetic.
 *
 * Not proven here: that a real product Host is confined to this world. That
 * needs the cross-container run (`adapters/dsh/native/verify-source.mjs` against
 * a server in another container) and is reported separately; this file
 * deliberately does not claim it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "source-world-server.mjs");
const TOKEN = "fixture-contract-test-token-0123456789";

/** Pick a free loopback port so the tests never collide with a live acceptance server. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Started {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly world: string;
}

async function start(): Promise<Started> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: HERE,
    env: { ...process.env, ENSEMBLE_SOURCE_TEST_TOKEN: TOKEN, ENSEMBLE_SOURCE_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const origin = `http://127.0.0.1:${port}`;
  const banner = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`fixture did not start: ${stdout}${stderr}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) {
        clearTimeout(timer);
        resolve(stdout);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited with ${code}: ${stdout}${stderr}`));
    });
  });
  const parsed = JSON.parse(banner.trim()) as { world: string; port: number; root: string };
  expect(parsed.port).toBe(port);
  expect(parsed.world).toMatch(/^[0-9a-f-]{36}$/);
  return { child, origin, world: parsed.world };
}

interface Answer { readonly status: number; readonly body: any }

/** POST one RPC body. `null` means "send no credential"; omitting it means the fixture token. */
async function post(origin: string, body: unknown, token: string | null = TOKEN, path = "/fs"): Promise<Answer> {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function health(origin: string): Promise<Answer> {
  const response = await fetch(origin + "/health", { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: response.status, body: await response.json() };
}

describe("source-world fixture server", () => {
  let started: Started;
  beforeAll(async () => { started = await start(); });
  afterAll(() => { started?.child.kill("SIGTERM"); });

  test("the fixture starts with a fresh synthetic world and records its reads", async () => {
    const answer = await health(started.origin);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, world: started.world, readable: true, reads: 0 });
  });

  test("no token, a wrong token, or an unauthenticated GET is refused", async () => {
    expect((await post(started.origin, { method: "resolve", path: "/source" }, null)).status).toBe(403);
    expect((await post(started.origin, { method: "resolve", path: "/source" }, "not-the-token")).status).toBe(403);
    const plain = await fetch(started.origin + "/fs");
    expect(plain.status).toBe(403);
    const healthNoToken = await fetch(started.origin + "/health");
    expect(healthNoToken.status).toBe(403);
  });

  test("paths are confined to /source and an intermediate symlink is never traversed", async () => {
    const root = await post(started.origin, { method: "resolve", path: "/source" });
    expect(root.status).toBe(200);
    expect(root.body.value.displayPath).toBe("/source");

    // Explicit refusals, each one a distinct escape shape.
    expect((await post(started.origin, { method: "resolve", path: "/etc/passwd" })).body.code).toBe("FS_SANDBOX_DENIED");
    expect((await post(started.origin, { method: "resolve", path: "/source/../../etc/passwd" })).body.code).toBe("FS_SANDBOX_DENIED");
    expect((await post(started.origin, { method: "resolve", path: "/source\\..\\etc" })).body.code).toBe("FS_SANDBOX_DENIED");
    expect((await post(started.origin, { method: "resolve", path: "/source/a\u0000b" })).body.code).toBe("FS_SANDBOX_DENIED");

    // The fixture ships a symlink to /etc/passwd. Resolving through it must
    // fail, which is what stops a reader turning a recorded link into foreign
    // bytes, while the link text itself stays readable.
    const link = await post(started.origin, { method: "resolve", path: "/source/untrusted-link" });
    expect(link.body.code).toBe("FS_SANDBOX_DENIED");
    const viaLink = await post(started.origin, { method: "resolve", path: "/source/untrusted-link/../passwd" });
    expect(viaLink.body.code).toBe("FS_SANDBOX_DENIED");
    expect((await post(started.origin, { method: "readLink", path: "/source/untrusted-link" })).body.value).toBe("/etc/passwd");
  });

  test("targets are opaque: an unknown or fabricated key is refused", async () => {
    expect((await post(started.origin, { method: "stat", target: { targetKey: "00000000-0000-4000-8000-000000000000" } })).body.code).toBe("FS_SANDBOX_DENIED");
    expect((await post(started.origin, { method: "processPath", target: {} })).body.code).toBe("FS_SANDBOX_DENIED");
    const root = await post(started.origin, { method: "resolve", path: "/source" });
    const key = root.body.value.targetKey;
    expect((await post(started.origin, { method: "processPath", target: { targetKey: key } })).body.value).toBe("/source");
    expect((await post(started.origin, { method: "contains", root: { targetKey: key }, target: { targetKey: key } })).body.value).toBe(true);
  });

  test("binary bytes are exact, and the server enforces the byte budget itself", async () => {
    const resolved = (await post(started.origin, { method: "resolve", path: "/source" })).body.value;
    const listing = await post(started.origin, { method: "listDir", target: resolved });
    const binary = listing.body.value.find((entry: { name: string }) => entry.name === "binary.dat");
    expect(binary).toBeDefined();
    const read = await post(started.origin, { method: "readBytes", target: binary.target, maxBytes: 8 });
    expect(read.status).toBe(200);
    expect([...Buffer.from(read.body.value.base64, "base64")]).toEqual([0, 255, 254, 128, 13, 10, 65, 0]);
    expect(read.body.value.sha256).toMatch(/^[0-9a-f]{64}$/);

    // One byte short is a refusal, not a truncated success.
    expect((await post(started.origin, { method: "readBytes", target: binary.target, maxBytes: 7 })).body.code).toBe("FS_TOO_LARGE");
    // And the caller cannot ask for more than the hard ceiling.
    expect((await post(started.origin, { method: "readBytes", target: binary.target, maxBytes: 2 * 1024 * 1024 })).body.code).toBe("FS_TOO_LARGE");

    const directory = (await post(started.origin, { method: "resolve", path: "/source/directory" })).body.value;
    expect((await post(started.origin, { method: "readBytes", target: directory })).body.code).toBe("FS_NOT_REGULAR_FILE");
  });

  test("a symlink is recorded as its target text and never as its target's bytes", async () => {
    const resolved = (await post(started.origin, { method: "resolve", path: "/source" })).body.value;
    const listing = await post(started.origin, { method: "listDir", target: resolved });
    const link = listing.body.value.find((entry: { name: string }) => entry.name === "untrusted-link");
    expect(link).toMatchObject({ name: "untrusted-link", type: "other" });
  });

  test("only read operations exist: a write method and an unknown route are refused", async () => {
    expect((await post(started.origin, { method: "writeText", target: {}, text: "x" })).body.code).toBe("FS_SANDBOX_DENIED");
    expect((await post(started.origin, { method: "resolve", path: "/source" }, TOKEN, "/fixture/unknown")).body.code).toBe("FS_SANDBOX_DENIED");
    const oversized = await fetch(started.origin + "/fs", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "resolve", path: "/source", padding: "x".repeat(20_000) }),
    });
    expect(oversized.status).toBe(400);
    expect((await oversized.json()).code).toBe("FS_TOO_LARGE");
  });

  test("the read ACL is dynamic: revocation denies every read and restoration allows them again", async () => {
    const resolved = (await post(started.origin, { method: "resolve", path: "/source" })).body.value;
    const before = (await health(started.origin)).body.reads;

    expect((await post(started.origin, { readable: false }, TOKEN, "/fixture/access")).body).toMatchObject({ ok: true, readable: false });
    expect((await post(started.origin, { method: "readBytes", target: resolved })).body.code).toBe("FS_PERMISSION_DENIED");
    expect((await post(started.origin, { method: "resolve", path: "/source" })).body.code).toBe("FS_PERMISSION_DENIED");
    // Health answers even while revoked, so an observer can tell a denial from
    // a dead server.
    expect((await health(started.origin)).status).toBe(200);

    expect((await post(started.origin, { readable: true }, TOKEN, "/fixture/access")).body).toMatchObject({ ok: true, readable: true });
    expect((await post(started.origin, { method: "listDir", target: resolved })).status).toBe(200);
    const listing = await post(started.origin, { method: "listDir", target: resolved });
    const binary = listing.body.value.find((entry: { name: string }) => entry.name === "binary.dat");
    expect((await post(started.origin, { method: "readBytes", target: binary.target, maxBytes: 8 })).status).toBe(200);
    expect((await health(started.origin)).body.reads).toBeGreaterThanOrEqual(before);
  });

  test("the identity route is authenticated and agrees with the banner and health", async () => {
    const started = await start();
    try {
      // Authenticated callers get the served root, which is what lets a runner
      // prove the bytes are not on its own filesystem. Without this route the gate
      // could only assert on the virtual `/source` prefix, which exists nowhere and
      // therefore proves nothing.
      const identityResponse = await fetch(started.origin + "/fixture/identity", { headers: { authorization: `Bearer ${TOKEN}` } });
      const identity = { status: identityResponse.status, body: await identityResponse.json() as Record<string, any> };
      expect(identity.status).toBe(200);
      expect(identity.body.ok).toBe(true);
      expect(identity.body.fixture).toBe("source-world");
      expect(identity.body.world).toBe(started.world);
      // The reported root is a real absolute fixture directory, generated by the
      // fixture rather than read from the environment.
      expect(typeof identity.body.root).toBe("string");
      expect(identity.body.root.startsWith("/")).toBe(true);
      expect(identity.body.root).toContain("ensemble-source-world-");

      // It describes the same world health reports, so a served root cannot be
      // attributed to a different world than the one whose bytes were read.
      expect(identity.body.world).toBe((await health(started.origin)).body.world);

      // An unauthenticated caller learns nothing — not even the root path.
      const anonymous = await fetch(started.origin + "/fixture/identity");
      expect(anonymous.status).toBe(403);
      const leaked = await anonymous.json() as { root?: unknown; world?: unknown };
      expect(leaked.root).toBeUndefined();
      expect(leaked.world).toBeUndefined();
    } finally {
      started.child.kill("SIGTERM");
    }
  }, 20_000);

  test("a server started without a token refuses to start at all", async () => {
    const port = await freePort();
    const scratch = mkdtempSync(join(tmpdir(), "source-world-notoken-"));
    try {
      const child = spawn(process.execPath, [SERVER], {
        cwd: scratch,
        env: { ...process.env, ENSEMBLE_SOURCE_TEST_TOKEN: "", ENSEMBLE_SOURCE_TEST_PORT: String(port), TMPDIR: scratch },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const code = await new Promise<number | null>((resolve) => child.once("exit", (value) => resolve(value)));
      expect(code).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
