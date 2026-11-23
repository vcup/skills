/**
 * Install the actual distribution with the **standard launcher**, then drive the
 * real installed product: official profile boot, authenticated owner transport,
 * packaged headless CLI, native model tools, selection evidence and native
 * Settings application.
 *
 * Two modes:
 *
 * - **gate** (default): install, prove the official `dsh --profile web` launch
 *   and its token→cookie fence, then run `adapters/dsh/native/verify-product.mjs`
 *   under the official profile *composition* and exit with its status. This is
 *   what `make product-check` calls; the exit code is the evidence.
 * - **serve** (`ENSEMBLE_PRODUCT_SERVE=1`): the same install and the same gate,
 *   then a Host is left running on a real port with a real session cookie so a
 *   **browser** can attach to it. `connection.json` and `evidence.json` land in
 *   the gate root, and the process waits for SIGTERM/SIGINT.
 *
 * Why two hosts and not one: the gate's deep journey needs a deterministic LLM
 * adapter mounted in-process, while the browser needs the untouched shipped
 * entry points. They share one `DSH_HOME`, so they run **strictly sequentially** —
 * a profile directory and its archive ledger are single-writer, and two live
 * Hosts would race on the same feature lock. The serve Host therefore starts only
 * after the fixture Host has disposed, and the driver re-proves the handshake on
 * the serving process itself before writing `connection.json`.
 *
 * Nothing here packs a tarball. The artifact is pinned by bytes: pass
 * `--sha256 <hex>` (or `ENSEMBLE_PRODUCT_SHA256`) and the driver refuses to
 * install a different file. Installed bytes are then compared with the tarball
 * entries, so a rewritten install cannot pass as "the released distribution".
 *
 * Arguments: `<runtime install> [tarball] [--sha256 <hex>] [--phases a,b] [--serve] [--timeout ms]`.
 * Environment:
 * - `ENSEMBLE_PRODUCT_ROOT` — gate root (DSH_HOME, archive, evidence). Defaults to
 *   a fresh temporary directory that this process removes on exit; pass a
 *   persistent one when serving, because the browser and the operator outlive it.
 * - `ENSEMBLE_PRODUCT_SERVE=1` — leave a Host running and write connection.json.
 * - `ENSEMBLE_PRODUCT_KEEP=1` — keep a temporary gate root for inspection.
 * - `ENSEMBLE_PRODUCT_FIXTURE` — override the fixture path (debugging only).
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

/** One pinned entry's measured hash, as recorded in `artifact.json`. */
export interface PinnedFile {
  readonly entry: string;
  readonly sha256: string;
}

/** What the artifact check measured: the whole-file pin plus each entry. */
export interface ArtifactCheck {
  readonly tarballSha256: string;
  readonly files: readonly PinnedFile[];
  readonly pinned: boolean;
}

/** One resolved invocation: where to install from, what to pin, which phases run. */
export interface Invocation {
  readonly runtime: string;
  readonly tarball: string;
  readonly sha256?: string;
  readonly phases: readonly string[];
  readonly serve: boolean;
  readonly timeoutMs: number;
}

/** The gate's accumulated evidence. A journey may add keys; the driver persists it. */
export interface Evidence {
  projectId?: string;
  head?: string;
  authorizationEpoch?: number;
  rootSessionId?: string;
  source?: string;
  workspaceId?: string;
  [key: string]: unknown;
}

/** The environment the driver reads and extends for every child. */
export type ChildEnvironment = Record<string, string | undefined>;

/** Narrow an unknown thrown value to a printable message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A child process result as `bounded` reports it. */
export interface BoundedResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}


/**
 * The world name this gate makes the Host adopt for its own filesystem.
 *
 * The Host environment and the handoff must agree on this string: a probe that fills
 * an execution-world field has to name the world the Host actually serves, and guessing
 * from a container name would be wrong. Publishing it in the handoff is what lets a
 * consumer read it instead of reconstructing it.
 */
export const SOURCE_WORLD = "acceptance-host-world";

/** The archive's own world. Deliberately different from the source world. */
export const ARCHIVE_WORLD = "acceptance-host-world";

/** The trusted authority id the Host runs as. */
export const AUTHORITY_ID = "acceptance-host";

/** Files the gate pins inside the tarball and re-checks after installation. */
export const PINNED_ENTRIES = ["index.js", "client.js", "bin/ensemble-archive.js", "package.json"];

/** sha256 of a buffer, hex. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read one pinned entry out of a `.tgz` without unpacking it to disk.
 *
 * `tar -xOzf` streams a single member, so the check never writes a second copy of
 * the package and does not depend on the installer's layout.
 * @param {string} tarball - absolute path of the candidate.
 * @param {string} entry - package-relative path, e.g. `index.js`.
 * @returns {Buffer | undefined} the entry bytes, or undefined when absent.
 */
export function readTarballEntry(tarball: string, entry: string): Buffer | undefined {
  const result = spawnSync("tar", ["-xOzf", tarball, `package/${entry}`], { maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * Compare the candidate's pinned bytes with the installed bytes.
 *
 * Three separate claims, because they fail differently: the tarball must match
 * the caller's pin (else the gate measured the wrong artifact), every pinned
 * entry must exist in it, and the installed copy must be byte-identical (else a
 * link, a rewrite step or a stale profile answered instead of the distribution).
 * @param {string} tarball - the candidate artifact.
 * @param {string} packageRoot - the installed package directory.
 * @param {string | undefined} expected - pinned whole-tarball sha256, or undefined to only record it.
 * @returns {{tarballSha256: string, files: Array<{entry: string, sha256: string}>, pinned: boolean}} measured facts.
 * @throws when the pin, an entry, or an installed byte differs.
 */
export function verifyArtifact(tarball: string, packageRoot: string, expected: string | undefined): ArtifactCheck {
  const bytes = readFileSync(tarball);
  const tarballSha256 = sha256(bytes);
  if (expected !== undefined && expected !== tarballSha256) {
    throw new Error(`candidate bytes are not the pinned artifact: expected ${expected}, got ${tarballSha256}`);
  }
  const files = [];
  for (const entry of PINNED_ENTRIES) {
    const fromTarball = readTarballEntry(tarball, entry);
    if (fromTarball === undefined) throw new Error(`the tarball is missing ${entry}`);
    const installed = join(packageRoot, entry);
    if (!existsSync(installed)) throw new Error(`the installation is missing ${entry}`);
    const tarballHash = sha256(fromTarball);
    const installHash = sha256(readFileSync(installed));
    if (installHash !== tarballHash) {
      throw new Error(`${entry}: installed bytes differ from the tarball (${installHash} vs ${tarballHash})`);
    }
    files.push({ entry, sha256: tarballHash });
  }
  return { tarballSha256, files, pinned: expected !== undefined };
}

/**
 * Parse the driver's arguments and environment into one invocation.
 *
 * Kept pure and exported so the contract (defaults, flag errors, phase list) is
 * testable without installing anything.
 * @param {readonly string[]} argv - arguments after the script path.
 * @param {Record<string, string | undefined>} env - process environment.
 * @returns {{runtime: string, tarball: string, sha256?: string, phases: string[], serve: boolean, timeoutMs: number}} the invocation.
 * @throws on an unknown flag, a missing value, or a non-numeric timeout.
 */
export function parseInvocation(argv: readonly string[], env: ChildEnvironment): Invocation {
  const positional: string[] = [];
  let sha256: string | undefined;
  let phases = "launch,identity,core,environment,selection,currentauth,legacy,network,coldrestart,team,learning";
  let serve = env.ENSEMBLE_PRODUCT_SERVE === "1";
  let timeoutMs = 240_000;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--sha256") sha256 = argv[++index];
    else if (token === "--phases") phases = argv[++index];
    else if (token === "--timeout") timeoutMs = Number(argv[++index]);
    else if (token === "--serve") serve = true;
    else if (token.startsWith("--")) throw new Error(`unknown flag ${token}`);
    else positional.push(token);
  }
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`--sha256 wants 64 lowercase hex characters, got ${JSON.stringify(sha256)}`);
  }
  if (env.ENSEMBLE_PRODUCT_SHA256 !== undefined) {
    if (sha256 !== undefined && sha256 !== env.ENSEMBLE_PRODUCT_SHA256) throw new Error("--sha256 and ENSEMBLE_PRODUCT_SHA256 disagree");
    sha256 = env.ENSEMBLE_PRODUCT_SHA256;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout wants a positive millisecond count, got ${JSON.stringify(timeoutMs)}`);
  }
  const list = phases.split(",").map((phase) => phase.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("--phases wants at least one phase name");
  return {
    runtime: resolve(positional[0] ?? ".scratch/rc5-cycle/rc5"),
    tarball: resolve(positional[1] ?? "build/pack/dsh/dsh-ensemble-1.0.0.tgz"),
    ...(sha256 === undefined ? {} : { sha256 }),
    phases: list,
    serve,
    timeoutMs,
  };
}

/**
 * Run one child under a hard bound, killing it if the bound expires.
 *
 * A gate that can hang teaches people to ignore it, so every child here is
 * bounded and a timeout is a failure that names its phase and leaves no orphan.
 * @param {import("node:child_process").ChildProcess} child - an already spawned child.
 * @param {number} timeoutMs - bound in milliseconds.
 * @param {string} label - phase name for the failure message.
 * @returns {Promise<{code: number | null, signal: string | null, stdout: string, stderr: string}>} captured result.
 */
export function bounded(child: import("node:child_process").ChildProcess, timeoutMs: number, label: string): Promise<BoundedResult> {
  return new Promise((done, fail) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Wait for the kill to land before failing: a gate that reports a timeout
      // while the child is still alive has left exactly the orphan it promised
      // not to leave. The second timer is only an escalation bound.
      const escalate = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(escalate);
        fail(new Error(`${label} exceeded its ${timeoutMs}ms bound and was killed`));
      });
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (data) => (stdout += data));
    child.stderr?.on("data", (data) => (stderr += data));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, signal, stdout, stderr });
    });
  });
}

/** Stop a child this driver started: SIGTERM, then SIGKILL if it lingers. */
export async function stop(child: import("node:child_process").ChildProcess | undefined, graceMs = 10_000): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.signalCode === null && child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

const launcher = (runtime: string): string => join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");

/**
 * The Node binary the installed Host must run under.
 *
 * The launcher and the packages it loads are Node programs; `process.execPath` is
 * bun when this gate is invoked through `bun` (which `make product-check` does),
 * and bun cannot load the Host's native module-loader addon. So the child is
 * always a real `node`, resolved explicitly rather than inherited.
 * @param {Record<string, string | undefined>} env - process environment.
 * @returns {string} the Node executable to spawn.
 * @throws when the resolved executable is not Node, so the failure names the cause.
 */
export function nodeBin(env: ChildEnvironment): string {
  const candidate = env.ENSEMBLE_PRODUCT_NODE ?? "node";
  const probe = spawnSync(candidate, ["-p", "process.release.name"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== "node") {
    throw new Error(`the installed Host needs a real Node executable; ${JSON.stringify(candidate)} is not one (set ENSEMBLE_PRODUCT_NODE)`);
  }
  return candidate;
}

/**
 * Gate one install end to end. Exported so the regression test can drive the
 * pin/verify/cleanup contract against a throwaway artifact and fake install.
 * @param {ReturnType<typeof parseInvocation>} invocation - parsed arguments.
 * @param {Record<string, string | undefined>} env - process environment.
 * @returns {Promise<number>} process exit status.
 */
export async function runGate(invocation: Invocation, env: ChildEnvironment): Promise<number> {
  const { runtime, tarball } = invocation;
  if (!existsSync(join(runtime, "node_modules/@deepseek-ai/dsh/package.json"))) {
    console.error(`no supported DSH install at ${runtime}. Pass the isolated install directory explicitly.`);
    return 2;
  }
  if (!existsSync(tarball)) {
    console.error(`no tarball at ${tarball}\nPass a pinned artifact explicitly; this driver never packs one itself.`);
    return 2;
  }
  const persistent = env.ENSEMBLE_PRODUCT_ROOT;
  const root = persistent === undefined ? mkdtempSync(join(tmpdir(), "ensemble-product-")) : resolve(persistent);
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  mkdirSync(scratch, { recursive: true });
  const childEnv: ChildEnvironment = {
    ...env,
    DSH_HOME: home,
    PNPM_HOME: join(root, "pnpm"),
    TMPDIR: scratch,
    npm_config_cache: join(root, "npm-cache"),
    ENSEMBLE_PRODUCT_RUNTIME: runtime,
    ENSEMBLE_PRODUCT_ROOT: root,
    DSH_ENSEMBLE_ARCHIVE_ROOT: join(root, "archive"),
    DSH_ENSEMBLE_AUTHORITY_ID: AUTHORITY_ID,
    DSH_ENSEMBLE_ARCHIVE_WORLD: ARCHIVE_WORLD,
    DSH_ENSEMBLE_SOURCE_WORLD: SOURCE_WORLD,
    ...(invocation.sha256 === undefined ? {} : { ENSEMBLE_PRODUCT_SHA256: invocation.sha256 }),
    ENSEMBLE_PRODUCT_PHASES: invocation.phases.filter((phase) => phase !== "launch").join(","),
  };
  const removeRoot = persistent === undefined && env.ENSEMBLE_PRODUCT_KEEP !== "1";
  let node;
  try {
    node = nodeBin(env);
  } catch (error) {
    console.error(`product-gate: ${messageOf(error)}`);
    if (removeRoot) rmSync(root, { recursive: true, force: true });
    return 2;
  }
  let serving: import("node:child_process").ChildProcess | undefined;
  // Declared beside `serving`: the `finally` below stops it, and a binding declared
  // inside the `try` is not in scope there — that ReferenceError made a fully green
  // run exit 1.
  let networkServer: import("node:child_process").ChildProcess | undefined;
  try {
    console.log(`== product-gate: ${tarball} → ${root}`);
    const installed = spawnSync(
      node,
      [launcher(runtime), "plugin", "--profile", "web", "add", tarball, "--offline"],
      { cwd: root, env: childEnv, encoding: "utf8", timeout: invocation.timeoutMs },
    );
    writeFileSync(join(root, "installation.log"), (installed.stdout ?? "") + (installed.stderr ?? ""));
    if (installed.status !== 0) {
      console.error(`standard installation failed (${installed.status}):\n${installed.stderr || installed.stdout}`);
      return 2;
    }
    const packageRoot = join(home, "profiles/web/node_modules/dsh-ensemble");
    const artifact = verifyArtifact(tarball, packageRoot, invocation.sha256);
    writeFileSync(join(root, "artifact.json"), JSON.stringify(artifact, null, 2));
    console.log(`artifact ${artifact.tarballSha256}${artifact.pinned ? " (pinned)" : " (unpinned)"}`);
    for (const file of artifact.files) console.log(`  ${file.entry} ${file.sha256}`);

    if (invocation.phases.includes("launch")) {
      const code = await proveLauncher(runtime, childEnv, root, invocation.timeoutMs);
      if (code !== 0) return code;
    }
    // ── the authenticated replica fixture, when the network phase is selected ──
    // The server is a separate process on purpose: the transport spawns Git
    // synchronously, so an in-process server could never answer and the symptom would
    // look like a credential bug. The token comes from the server's own banner and is
    // written only to the credential store; it never enters argv or a URL.
    const network: { credentialFile?: string; askpassFile?: string } = {};
    if (invocation.phases.includes("network")) {
      // The server treats argv[2] as GIT_PROJECT_ROOT and serves the request path
      // under it, so the bare repo is a child named `repo.git` and the URL is
      // `<origin>/repo.git` — matching how `git http-backend` resolves PATH_INFO.
      const projectRoot = join(root, "network", "remote");
      const remoteDir = join(projectRoot, "repo.git");
      mkdirSync(remoteDir, { recursive: true });
      spawnSync("git", ["init", "--bare", "--quiet", "--template=", remoteDir], { encoding: "utf8" });
      networkServer = spawn(node, [resolve("scripts/fixtures/git-auth-server.mjs"), projectRoot], {
        cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"], env: { ...childEnv, PATH: process.env.PATH ?? "" },
      });
      let banner = "";
      networkServer.stdout?.on("data", (data: Buffer) => (banner += data.toString()));
      networkServer.stderr?.on("data", (data: Buffer) => process.stderr.write(`[git-auth-server] ${data.toString()}`));
      const server = await new Promise<{ origin: string; username: string; token: string; port: number }>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`the git auth fixture printed no banner within ${invocation.timeoutMs}ms: ${banner}`)), invocation.timeoutMs);
        const poll = setInterval(() => {
          const line = banner.split("\n").find((entry) => entry.trim().startsWith("{"));
          if (line === undefined) return;
          clearInterval(poll);
          clearTimeout(timer);
          try { done(JSON.parse(line)); } catch (error) { fail(error); }
        }, 50);
        networkServer?.once("exit", (code: number | null) => { clearInterval(poll); clearTimeout(timer); fail(new Error(`the git auth fixture exited ${String(code)}: ${banner}`)); });
      });
      // The destination is deployment configuration: URL, stated identity and a
      // credential *reference* (never the secret). Only http/https/git schemes are
      // accepted, and userinfo in a URL is refused by the parser.
      childEnv.DSH_ENSEMBLE_REPLICA_DESTINATIONS = JSON.stringify({
        mirror: {
          url: `${server.origin}/repo.git`,
          identity: new URL(server.origin).host,
          credential_ref: "ENSEMBLE_REPLICA_TOKEN",
          credential_username: server.username,
        },
      });
      // The provider's version-1 document: the secret lives under `refs`, keyed by the
      // credential reference the destination names. `records` stays empty because an
      // api-key record is a different, model-visible thing.
      // The provider reads `$DSH_HOME/.credentials.yaml` by default (the bundle mounts
      // it with no explicit path), so the store goes exactly there — a path the
      // provider does not read would make the revocation check test nothing.
      network.credentialFile = join(childEnv.DSH_HOME ?? join(root, "home"), ".credentials.yaml");
      writeFileSync(network.credentialFile, `version: 1\nrefs:\n  ENSEMBLE_REPLICA_TOKEN: ${JSON.stringify(server.token)}\nrecords: {}\n`, { mode: 0o600 });
      chmodSync(network.credentialFile, 0o600);
      // A fixed askpass helper for the fixture's own concurrent-writer step. The
      // product installs its own trusted helper; this one exists so the test can
      // write to the remote as "the other writer" without inventing a credential path.
      network.askpassFile = join(root, "network", "askpass.sh");
      writeFileSync(network.askpassFile, `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$ENSEMBLE_REPLICA_USER" ;;
  *assword*) printf '%s\\n' "$ENSEMBLE_REPLICA_SECRET" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
      chmodSync(network.askpassFile, 0o700);
      childEnv.ENSEMBLE_NETWORK_CREDENTIAL_FILE = network.credentialFile;
      childEnv.ENSEMBLE_NETWORK_FIXTURE = JSON.stringify({
        origin: server.origin,
        repo: remoteDir,
        destinationKey: "mirror",
        credentialHandle: "fixture-replica",
        credentialUsername: server.username,
        // The secret reaches the fixture's concurrent-writer step through the
        // environment only; it is never in argv, a URL or a log.
        credentialSecret: server.token,
        askpass: network.askpassFile,
        // Not the archive's own world: that would mean "this Host's filesystem".
        world: "acceptance-network-world",
      });
      console.log(`network fixture: authenticated git server on ${server.origin}, bare repo ${remoteDir}`);
    }
    const fixture = spawn(
      node,
      [resolve(env.ENSEMBLE_PRODUCT_FIXTURE ?? "adapters/dsh/native/verify-product.mjs")],
      { cwd: resolve("."), env: childEnv, stdio: "inherit" },
    );
    const fixtureResult = await bounded(fixture, invocation.timeoutMs, "fixture");
    if (fixtureResult.code !== 0) {
      console.error(`fixture failed (${fixtureResult.code}${fixtureResult.signal === null ? "" : `, ${fixtureResult.signal}`})`);
      return fixtureResult.code ?? 1;
    }
    // A cold restart is a *second process* on the same DSH_HOME, started only after
    // the first has fully exited: that is the only way "the state survived" means
    // anything. The expectation file carries the first process's own committed
    // facts, so this cannot pass by comparing the state with itself.
    if (invocation.phases.includes("coldrestart") && !invocation.serve) {
      const expectationPath = join(root, "restart-expectation.json");
      if (!existsSync(expectationPath)) {
        console.error("cold restart: the write pass left no restart-expectation.json; the restart was NOT verified");
        return 1;
      }
      // Keep the write pass's evidence before the second process overwrites it.
      writeFileSync(join(root, "evidence.write.json"), readFileSync(join(root, "evidence.json")));
      const restart = spawn(node, [resolve(env.ENSEMBLE_PRODUCT_FIXTURE ?? "adapters/dsh/native/verify-product.mjs")], {
        cwd: resolve("."),
        env: {
          ...childEnv,
          ENSEMBLE_PRODUCT_VERIFY_ONLY: "1",
          ENSEMBLE_PRODUCT_EXPECTED: readFileSync(expectationPath, "utf8"),
          ENSEMBLE_PRODUCT_PHASES: "identity,coldrestart-verify",
        },
        stdio: "inherit",
      });
      const restartResult = await bounded(restart, invocation.timeoutMs, "coldrestart");
      if (restartResult.code !== 0) {
        console.error(`cold restart FAILED (${restartResult.code}): a fresh Host did not serve the committed state`);
        return restartResult.code ?? 1;
      }
      const restarted = JSON.parse(readFileSync(join(root, "evidence.json"), "utf8"));
      const write = JSON.parse(readFileSync(join(root, "evidence.write.json"), "utf8"));
      writeFileSync(join(root, "evidence.json"), JSON.stringify({
        ...restarted,
        phases: { ...write.phases, "coldrestart-verify": restarted.phases["coldrestart-verify"] },
      }, null, 2));
      console.log("COLD RESTART PASS: a fresh Host process served the committed project, head and epoch after the first exited");
    }
    if (!invocation.serve) {
      console.log(`Product evidence: ${join(root, "evidence.json")}`);
      return 0;
    }
    return await serveHost(runtime, childEnv, root, invocation.timeoutMs, (child) => {
      serving = child;
    }, artifact, invocation.phases);
  } finally {
    await stop(networkServer);
    await stop(serving);
    if (removeRoot) rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Prove the official launcher boots the installed profile and enforces auth.
 *
 * The shipped binary and the shipped flags, then a full stop: the same `DSH_HOME`
 * is reused by the in-process fixture afterwards, so the profile directory has
 * exactly one writer at a time.
 * @param {string} runtime - supported install.
 * @param {Record<string, string>} env - child environment.
 * @param {string} root - gate root for the captured log.
 * @param {number} timeoutMs - bound for the whole phase.
 * @returns {Promise<number>} 0 when the launch and both fences pass.
 */
async function proveLauncher(runtime: string, env: ChildEnvironment, root: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  const child = spawn(nodeBin(env), [launcher(runtime), "--profile", "web", "--port", "0", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  try {
    const url = await urlLine(child, () => log, timeoutMs, "the official launcher");
    writeFileSync(join(root, "launcher.log"), log);
    const origin = new URL(url).origin;
    // The printed URL *is* the browser entry: `GET /?token=…` answers 303 plus the
    // session cookie, and the page it redirects to is the real UI. `/connect` is a
    // different exchange (an API credential) whose cookie the index route refuses,
    // so using it here would prove the wrong fence for a browser.
    const bad = await fetch(`${origin}/?token=invalid`, { redirect: "manual" });
    if (bad.status !== 401) throw new Error(`an invalid token must be refused with 401, got ${bad.status}`);
    const good = await fetch(new URL(`/${new URL(url).search}`, origin), { redirect: "manual" });
    if (good.status !== 303) throw new Error(`the launch token must be exchanged with 303, got ${good.status}`);
    const cookie = good.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("the launch exchange issued no session cookie");
    const page = await fetch(`${origin}/`, { headers: { cookie }, redirect: "manual" });
    if (page.status !== 200) throw new Error(`the UI page must be served to the session cookie, got ${page.status}`);
    const html = await page.text();
    if (!html.includes("__DSH_BOOT__")) throw new Error("the served page carries no __DSH_BOOT__ manifest");
    if (!html.includes("dsh-ensemble")) throw new Error("the boot manifest does not include the dsh-ensemble Client module");
    const anonymous = await fetch(`${origin}/`, { redirect: "manual" });
    if (anonymous.status !== 401) throw new Error(`an anonymous page request must be refused, got ${anonymous.status}`);
    console.log(`PHASE launch PASS ${Date.now() - started}ms (official launcher, token→cookie fence)`);
    return 0;
  } catch (error) {
    console.error(`PHASE launch FAIL: ${messageOf(error)}`);
    writeFileSync(join(root, "launcher.log"), log);
    return 1;
  } finally {
    await stop(child);
  }
}

/**
 * Wait for the shipped launcher's URL line, or fail with its log.
 * @param {import("node:child_process").ChildProcess} child - running launcher.
 * @param {() => string} log - reads what the child has printed so far.
 * @param {number} timeoutMs - bound.
 * @param {string} label - who was expected to print it.
 * @returns {Promise<string>} the printed URL (it carries the one-time token).
 */
function urlLine(child: import("node:child_process").ChildProcess, log: () => string, timeoutMs: number, label: string): Promise<string> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      fail(new Error(`${label} printed no URL within ${timeoutMs}ms:\n${log().slice(-4000)}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      const match = log().match(/dsh web: (\S+)/);
      if (match === null) return;
      clearInterval(poll);
      clearTimeout(timer);
      done(match[1]);
    }, 100);
    child.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      fail(new Error(`${label} exited ${code} before it served:\n${log().slice(-4000)}`));
    });
  });
}

/**
 * Leave the real Host serving for a browser and publish what a client needs.
 *
 * The browser gets the shipped entry points at the shipped origin; the driver
 * proves the fence again on this process, because a serve Host that skipped the
 * gate's path would prove nothing about the gate.
 * @param {string} runtime - supported install.
 * @param {Record<string, string>} env - child environment.
 * @param {string} root - gate root; `connection.json` is written here.
 * @param {number} timeoutMs - bound for the handshake.
 * @param {(child: import("node:child_process").ChildProcess) => void} register - lets the caller stop it.
 * @returns {Promise<number>} 0 after SIGTERM/SIGINT.
 */
async function serveHost(runtime: string, env: ChildEnvironment, root: string, timeoutMs: number, register: (child: import("node:child_process").ChildProcess) => void, artifact: ArtifactCheck, requestedPhases: readonly string[]): Promise<number> {
  const child = spawn(nodeBin(env), [launcher(runtime), "--profile", "web", "--port", "0", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  register(child);
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  try {
    const url = await urlLine(child, () => log, timeoutMs, "the serving Host");
    const origin = new URL(url).origin;
    // Browser entry, as above: `/?token=…` → 303 + cookie, then the page answers 200.
    const exchange = await fetch(url, { redirect: "manual" });
    if (exchange.status !== 303) throw new Error(`the serving Host refused its own launch token: ${exchange.status}`);
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("the serving Host issued no session cookie");
    const page = await fetch(`${origin}/`, { headers: { cookie }, redirect: "manual" });
    if (page.status !== 200) throw new Error(`the serving Host refused the session cookie on its page: ${page.status}`);
    if (!(await page.text()).includes("dsh-ensemble")) throw new Error("the serving Host's boot manifest lacks the dsh-ensemble module");
    // Two different credentials, and a UI gate must use the right one. The browser
    // cookie above (`v1.…`, from `/?token=`) is what the **index route** accepts; the
    // API cookie (`v2.…`, from `/connect?token=`) is what the Remote accepts and what
    // the page route *rejects*. Measured, not assumed.
    const browserCookieFile = join(root, "browser-cookie");
    writeFileSync(browserCookieFile, cookie, { mode: 0o600 });
    let remoteCookieFile;
    let live: Partial<Evidence> = {};
    try {
      const api = await fetch(new URL(`/connect${new URL(url).search}`, origin), { redirect: "manual" });
      const apiCookie = api.headers.get("set-cookie")?.split(";")[0];
      if (!apiCookie) throw new Error(`the API exchange returned ${api.status} with no cookie`);
      remoteCookieFile = join(root, "remote-cookie");
      writeFileSync(remoteCookieFile, apiCookie, { mode: 0o600 });
      // Preflight each credential against the surface it is *for*, so a mixed-up
      // handoff cannot be published: the API cookie must not load the page, and the
      // browser cookie must.
      const apiOnPage = await fetch(`${origin}/`, { headers: { cookie: apiCookie }, redirect: "manual" });
      if (apiOnPage.status === 200) throw new Error("the API cookie unexpectedly loads the page; the handoff polarity is wrong");
      const browserOnPage = await fetch(`${origin}/`, { headers: { cookie }, redirect: "manual" });
      if (browserOnPage.status !== 200) throw new Error(`the browser cookie must load the page, got ${browserOnPage.status}`);
      const packageRoot = join(root, "home", "profiles/web/node_modules/dsh-ensemble");
      const { connect } = await import(pathToFileURL(join(packageRoot, "lib/transport.bundle.mjs")).href);
      const connection = await connect({ url: origin, cookie: apiCookie });
      const projects = await connection.call("ensembleArchive/projects", { request: {} });
      await connection.close?.().catch?.(() => {});
      const project = projects?.value?.projects?.[0];
      if (projects?.ok && project) {
        live = { projectId: project.project_id, head: project.read_revision, authorizationEpoch: project.authorization_epoch };
      }
    } catch (error) {
      console.error(`handoff: Remote credential unavailable (${String(error).slice(0, 200)})`);
      throw error;
    }
    writeFileSync(join(root, "serve.log"), log.slice(-4000));
    const evidencePath = join(root, "evidence.json");
    const evidence: Evidence = existsSync(evidencePath) ? (JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence) : {};
    const connection = {
      origin,
      // The one-time token is the browser's entry; it is not repeated here so the
      // handoff file does not become a standing credential.
      uiPath: `/?${new URL(url).searchParams.toString()}`,
      // `browserCookieFile` loads the page (index route). `apiCookieFile` speaks the
      // Remote and is REJECTED by the page. `cookieFile` is kept as the API
      // credential for existing consumers and says so.
      browserCookieFile,
      apiCookieFile: remoteCookieFile,
      cookieFile: remoteCookieFile,
      cookieFileMeaning: "api",
      packageRoot: join(root, "home", "profiles/web/node_modules/dsh-ensemble"),
      // The installed entry hashes this gate already measured (verified equal to the
      // tarball members), so a client can assert tar == installed == served in one pass
      // instead of three.
      installedEntrySha256: Object.fromEntries(artifact.files.map((file) => [file.entry, file.sha256])),
      artifactSha256: artifact.tarballSha256,
      projectId: live.projectId ?? evidence.projectId,
      rootSessionId: evidence.rootSessionId,
      source: evidence.source,
      workspaceId: evidence.workspaceId,
      head: live.head ?? evidence.head,
      headSource: live.head === undefined ? "fixture" : "live",
      ...(live.authorizationEpoch === undefined ? {} : { authorizationEpoch: live.authorizationEpoch }),
      pid: child.pid,
      log: join(root, "serve.log"),
      evidence: evidencePath,
      startedAt: new Date().toISOString(),
      // A Host that ran without the journey phases has no archive, so this handoff
      // must never be read as a gate pass. The flag travels in the file itself: a
      // consumer cannot mistake an empty-registry fixture for an accepted release.
      //
      // `phases` is the list THIS PROCESS was asked to run. It must come from the
      // parsed invocation: the child environment deliberately drops `launch` (that
      // phase already ran here), so reading it back would publish a different list
      // than the caller passed and a consumer checking its own request would fail.
      diagnosticOnly: env.ENSEMBLE_PRODUCT_DIAGNOSTIC_ONLY === "1",
      phases: requestedPhases.join(","),
      // The world this Host actually serves, so a probe can fill an execution-world
      // field from the handoff instead of guessing at it. These are the same values
      // the child environment above was given — one constant, one source of truth.
      sourceWorld: SOURCE_WORLD,
      archiveWorld: ARCHIVE_WORLD,
      authorityId: AUTHORITY_ID,
    };
    writeFileSync(join(root, "connection.json"), JSON.stringify(connection, null, 2), { mode: 0o600 });
    console.log(`READY ${join(root, "connection.json")}`);
    console.log(`Host pid ${child.pid}; SIGTERM this process to stop it.`);
    await new Promise((done) => {
      process.once("SIGTERM", done);
      process.once("SIGINT", done);
    });
    return 0;
  } finally {
    await stop(child);
  }
}

if (import.meta.main) {
  let invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`product-gate: ${messageOf(error)}`);
    process.exit(2);
  }
  try {
    process.exitCode = await runGate(invocation, process.env);
  } catch (error) {
    console.error(`product-gate: ${messageOf(error)}`);
    process.exitCode = 1;
  }
}
