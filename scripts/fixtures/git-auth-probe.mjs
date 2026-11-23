/**
 * Counterexample: does a plain injected env var authenticate Git over HTTP?
 *
 * The claim under test came from review, and it is the right question to ask
 * rather than assume: `native/replication.ts` resolves a credential and passes it
 * as a deployment-named environment variable (e.g. `ENSEMBLE_MIRROR_TOKEN`).
 * Which mechanism inside Git is supposed to *consume* that variable for HTTP auth?
 *
 * This script answers it with a real HTTP remote that requires Basic auth:
 *
 *   1. `anonymous`   — no credential at all: must fail (proves the server is not
 *                      silently allowing anonymous access, so a later pass means
 *                      something).
 *   2. `plain env`   — the token exported under a plain variable name, exactly as
 *                      the transport does today: expected to FAIL, because Git has
 *                      no consumer for an arbitrary variable. This is the RED.
 *   3. `askpass`     — the same token delivered through `GIT_ASKPASS`, a helper
 *                      script Git genuinely consults: expected to PASS. This is
 *                      the mechanism a fix would use.
 *
 * All three use the same fixed argv (`ls-remote`), the same scrubbed environment,
 * and never put the token in argv or a URL.
 *
 * Usage: node scripts/fixtures/git-auth-probe.mjs <bare-repo-dir>
 * Exit 0 when the observed pattern matches (anonymous fail, plain env fail,
 * askpass pass); exit 1 otherwise.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/fixtures/git-auth-probe.mjs <bare-repo-dir>");
  process.exit(2);
}

/** Start the auth server and read its banner. */
async function startServer() {
  const child = spawn(process.execPath, [new URL("./git-auth-server.mjs", import.meta.url).pathname, repo], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const banner = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve(JSON.parse(out.trim()));
    });
    child.once("exit", (code) => reject(new Error(`auth server exited ${code}`)));
  });
  return { child, banner };
}

const SCRUBBED = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_SSH_COMMAND: "",
  LC_ALL: "C",
};

/** One fixed-argv Git read, with whatever extra environment the case needs. */
function lsRemote(origin, home, extra) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-remote", "--refs", origin], {
    cwd: home,
    env: { ...SCRUBBED, HOME: home, ...extra },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ok: result.status === 0, status: result.status, stderr: (result.stderr ?? "").trim().slice(0, 200) };
}

const { child, banner } = await startServer();
const home = await mkdtemp(join(tmpdir(), "git-auth-probe-"));
try {
  const remote = `${banner.origin}/repo.git`;
  const observed = {};

  // 1. No credential: the server must refuse. If this passed, the fixture would
  //    be allowing anonymous access and every later result would be meaningless.
  observed.anonymous = lsRemote(remote, home, {});

  // 2. A plain variable, exactly the shape the transport injects today.
  observed.plainEnv = lsRemote(remote, home, { ENSEMBLE_MIRROR_TOKEN: banner.token, ENSEMBLE_MIRROR_USER: banner.username });

  // 3. GIT_ASKPASS: a real helper Git consults. The token is read from the helper
  //    file, so it never appears in argv.
  const helper = join(home, "askpass.sh");
  await writeFile(helper, `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s\\n' "$ENSEMBLE_MIRROR_USER" ;;\n  *) printf '%s\\n' "$ENSEMBLE_MIRROR_TOKEN" ;;\nesac\n`);
  await chmod(helper, 0o700);
  observed.askpass = lsRemote(remote, home, {
    GIT_ASKPASS: helper,
    ENSEMBLE_MIRROR_TOKEN: banner.token,
    ENSEMBLE_MIRROR_USER: banner.username,
  });

  const pattern = observed.anonymous.ok === false && observed.plainEnv.ok === false && observed.askpass.ok === true;
  console.log(JSON.stringify({
    ok: pattern,
    conclusion: pattern
      ? "a plain injected variable does NOT authenticate Git; GIT_ASKPASS does"
      : "the observed pattern differs from the claim under test",
    observed,
  }, null, 2));
  process.exitCode = pattern ? 0 : 1;
} finally {
  await rm(home, { recursive: true, force: true });
  child.kill("SIGTERM");
}
