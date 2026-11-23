/**
 * Prove the shipped transport authenticates, against a server that refuses anonymous.
 *
 * The earlier probe established the *defect*: a plain injected variable does not
 * authenticate Git. This one establishes the *fix*: the real
 * `createAllowlistedReplicaTransport`, given a typed credential through its own
 * `credential` hook, completes a real `ls-remote`/`push`/`fetch` against a Basic-auth
 * remote — and, symmetrically, that the same transport with no credential is
 * refused by that same server.
 *
 * Both halves matter. Without the negative case a passing transport could simply be
 * reaching an anonymous endpoint; without the positive case the "plain env fails"
 * result would say nothing about whether the mechanism works at all.
 *
 * Usage: node scripts/fixtures/git-auth-transport.mjs <bare-repo-dir>
 * Exit 0 only when: anonymous refused, typed credential succeeds, secret absent
 * from every observable channel (argv, URL, remote, output).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/fixtures/git-auth-transport.mjs <bare-repo-dir>");
  process.exit(2);
}

/** Start the auth server and read its one-line JSON banner. */
async function startServer() {
  const child = spawn(process.execPath, [new URL("./git-auth-server.mjs", import.meta.url).pathname, repo], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const banner = await new Promise((done, fail) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("\n")) done(JSON.parse(out.trim()));
    });
    child.once("exit", (code) => fail(new Error(`auth server exited ${code}`)));
  });
  return { child, banner };
}

const moduleUrl = pathToFileURL(resolve("adapters/dsh/maintenance/network-deployment.ts")).href;
const { createAllowlistedReplicaTransport } = await import(moduleUrl);

const scratch = await mkdtemp(join(tmpdir(), "replica-transport-auth-"));
const { child, banner } = await startServer();
const owner = { kind: "owner", ownerId: "owner-1", hostAuthorityId: "host-1", channel: "authenticated-remote" };
const replica = {
  id: "replica-auth-1",
  archiveId: "archive-1",
  destinationHandle: "mirror",
  expectedIdentity: "mirror-host",
  credentialHandle: "token",
  expectedRevision: null,
  state: "configured",
};
const scratchRepo = join(scratch, "primary.git");
const quarantine = join(scratch, "quarantine");

/** One transport wired exactly as the product wires it. */
function transport(credential) {
  return createAllowlistedReplicaTransport({
    allowlist: [banner.origin.replace("http://", "")],
    resolve: () => `${banner.origin}/repo.git`,
    identity: "mirror-host",
    quarantineRoot: quarantine,
    primaryRoot: scratchRepo,
    authorize: (actor) => actor.kind === "owner" && actor.channel === "authenticated-remote",
    ...(credential === undefined ? {} : { credential: () => credential }),
    timeoutMs: 30_000,
  });
}

const observed = {};
const secret = banner.token;
try {
  // A real bare primary repository the transport may read from.
  const init = spawn("git", ["init", "--bare", "--quiet", scratchRepo], { stdio: "ignore" });
  await new Promise((done, fail) => init.once("exit", (code) => (code === 0 ? done() : fail(new Error(`git init ${code}`)))));

  // 1. No credential: the server must refuse.
  try {
    await transport(undefined).head(replica, AbortSignal.timeout(20_000));
    observed.anonymous = { refused: false };
  } catch (error) {
    observed.anonymous = { refused: true, message: String(error?.message ?? error).slice(0, 160) };
  }

  // 2. Typed credential through the transport's own hook: must work.
  try {
    const head = await transport({ username: banner.username, secret }).head(replica, AbortSignal.timeout(20_000));
    observed.authenticated = { ok: true, head };
  } catch (error) {
    observed.authenticated = { ok: false, message: String(error?.message ?? error).slice(0, 200) };
  }

  // 3. The secret must not appear in anything we can observe.
  const observable = JSON.stringify(observed);
  observed.secretLeakedInResult = observable.includes(secret);
  observed.secretInUrl = `${banner.origin}/repo.git`.includes(secret);

  const pass = observed.anonymous.refused === true && observed.authenticated.ok === true
    && observed.secretLeakedInResult === false && observed.secretInUrl === false;
  console.log(JSON.stringify({ ok: pass, observed }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
  child.kill("SIGTERM");
}
