/**
 * Verify the packaged CLI against **both** supported DSH releases, in fresh
 * profiles.
 *
 * The claim being tested is narrow and specific: a package installed by the
 * ordinary `dsh plugin add` into an rc.4 profile and into an rc.5 profile runs
 * its CLI under plain Node and reaches the Host's RPC surface. Nothing here
 * claims a Host process was booted or that an authenticated session existed —
 * those need a running server and a browser handshake, and this script reports
 * exactly what it did.
 *
 * What makes it a real test rather than a smoke test:
 *
 * - **A fresh profile per release.** `DSH_HOME` is a new temporary directory, so
 *   nothing from a previous run can satisfy a dependency. A profile that was
 *   prepared by hand is not evidence.
 * - **The Host's own pnpm settings.** `dsh plugin` initialises the profile from
 *   the shipped `web` template, which writes `nodeLinker: hoisted` and
 *   `autoInstallPeers: false`; the install goes through that same path.
 * - **No symlink and no ancestor `node_modules`.** The package's bare imports
 *   must resolve from what the install put there, or not at all.
 * - **Real Node.** The CLI ships as a Node program; Bun resolves modules
 *   differently, including through directories Node would not consult.
 * - **The wire, not just the process.** The CLI is pointed at a loopback origin
 *   with a well-formed but invalid session cookie, and must reach the transport
 *   and report the Host as unreachable (exit 5). That exercises the connection
 *   object, the `/api` channel and the RPC call — an exit 3 (no credential) or a
 *   module error would not.
 *
 * Usage:
 *
 * ```bash
 * bun scripts/verify-dsh-cli.ts --rc4 <install> --rc5 <install>
 * ```
 *
 * @module scripts/verify-dsh-cli
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** One release's verification result. */
export interface ReleaseCheck {
  readonly release: string;
  readonly install: string;
  readonly added: boolean;
  readonly registered: boolean;
  readonly noPrivateCopies: boolean;
  readonly cliExit: number;
  readonly cliStderr: string;
  readonly profilePnpmSettings: string;
  readonly problems: readonly string[];
}

/** The overall verdict. */
export interface VerifyVerdict {
  readonly ok: boolean;
  readonly checks: readonly ReleaseCheck[];
  readonly problems: readonly string[];
}

/** The tarball the verification installs. */
export const PROBE_TARBALL = "build/pack/dsh/dsh-ensemble-probe-0.3.0.tgz";

/**
 * The packages that must not appear as private copies inside the installed
 * probe.
 *
 * A nested copy is the concrete shape of a mixed install: the plugin's own
 * import would resolve to that copy, so it would run against a different release
 * than the Host. `@deepseek-ai/cordis` is deliberately absent: the CLI's bundle
 * carries its own Cordis by design, and that is not a mixed DSH install.
 */
const SHARED_DSH_PACKAGES = ["dsh-skill", "dsh-tools", "dsh-subprocess-local", "dsh-sandbox-local"] as const;

/** Run one command, returning its exit code and streams. */
function run(argv: readonly string[], options: { cwd: string; env: Record<string, string> }) {
  const result = Bun.spawnSync(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root", ...options.env },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** The real Node binary; the CLI must not be measured with Bun. */
function resolveNode(): string {
  const found = Bun.which("node");
  if (found === null) throw new Error("verification needs a real `node` on PATH");
  return found;
}

/**
 * Install the tarball into a fresh profile for one release and exercise the CLI.
 * @param options.release - the release label, for the report.
 * @param options.install - an isolated install of that release (provides `dsh`).
 * @param options.tarball - absolute path of the probe tarball.
 * @param options.workRoot - a fresh directory this check may own.
 * @param options.node - the Node binary.
 * @returns what was observed, including every problem found.
 */
export function checkRelease(options: {
  readonly release: string;
  readonly install: string;
  readonly tarball: string;
  readonly workRoot: string;
  readonly node: string;
}): ReleaseCheck {
  const problems: string[] = [];
  const home = join(options.workRoot, "home");
  const env = {
    DSH_HOME: home,
    npm_config_cache: join(options.workRoot, "npm-cache"),
    PNPM_HOME: join(options.workRoot, "pnpm"),
    PATH: `${join(options.install, "node_modules", ".bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };

  const added = run(["dsh", "plugin", "--profile", "web", "add", options.tarball], {
    cwd: options.workRoot,
    env,
  });
  if (added.code !== 0) {
    problems.push(`dsh plugin add exited ${added.code}: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  const profile = join(home, "profiles", "web");
  const packageDir = join(profile, "node_modules", "dsh-ensemble-probe");

  // Registered as a bundle row, which is what makes the Host load it.
  let registered = false;
  const profileManifest = join(profile, "package.json");
  if (existsSync(profileManifest)) {
    const parsed = JSON.parse(readFileSync(profileManifest, "utf8")) as {
      dsh?: { profile?: { bundles?: string[] } };
    };
    registered = (parsed.dsh?.profile?.bundles ?? []).includes("dsh-ensemble-probe");
  }
  if (!registered) problems.push("the profile did not register dsh-ensemble-probe as a bundle row");

  // No private copies of the shared DSH instances.
  let noPrivateCopies = true;
  for (const shared of SHARED_DSH_PACKAGES) {
    if (existsSync(join(packageDir, "node_modules", "@deepseek-ai", shared))) {
      noPrivateCopies = false;
      problems.push(`the installed package has a private @deepseek-ai/${shared} copy`);
    }
  }

  // The profile's own pnpm settings: this is what the Host wrote, not what the
  // test assumed.
  const workspaceConfig = join(profile, "pnpm-workspace.yaml");
  const profilePnpmSettings = existsSync(workspaceConfig) ? readFileSync(workspaceConfig, "utf8").trim() : "";
  for (const setting of ["nodeLinker: hoisted", "autoInstallPeers: false"]) {
    if (!profilePnpmSettings.includes(setting)) {
      problems.push(`the profile is missing the Host's own pnpm setting ${JSON.stringify(setting)}`);
    }
  }

  // The wire check: a well-formed but invalid cookie, so the CLI builds the
  // connection, calls `/api`, and the Host (absent) cannot be reached.
  const cookie = join(options.workRoot, "cookie.txt");
  writeFileSync(cookie, "dsh-auth-verify=0123456789abcdef\n");
  const cli = run(
    [
      options.node,
      join(packageDir, "bin", "ensemble-archive.js"),
      "status",
      "--cookie-file",
      cookie,
      "--url",
      "http://127.0.0.1:3999",
    ],
    { cwd: packageDir, env: { ENSEMBLE_ARCHIVE_COOKIE: "" } },
  );
  if (cli.stderr.includes("ERR_MODULE_NOT_FOUND") || cli.stderr.includes("Cannot find module")) {
    problems.push(`the packaged CLI could not load its own modules: ${cli.stderr.split("\n")[0]}`);
  }
  if (cli.code !== 5) {
    problems.push(
      `the CLI exited ${cli.code} for an unreachable Host, expected 5: ${cli.stderr.trim().split("\n")[0] ?? ""}`,
    );
  }
  if (!cli.stderr.includes("could not reach the Host")) {
    problems.push("the CLI did not report the Host as unreachable, so the transport was not exercised");
  }

  return {
    release: options.release,
    install: options.install,
    added: added.code === 0,
    registered,
    noPrivateCopies,
    cliExit: cli.code,
    cliStderr: cli.stderr.trim().split("\n").slice(0, 3).join(" | "),
    profilePnpmSettings,
    problems,
  };
}

/**
 * Verify both releases and combine the results.
 * @param options - the two installs, the tarball and the Node binary.
 * @returns the verdict, with per-release detail.
 */
export function verifyBoth(options: {
  readonly rc4: string;
  readonly rc5: string;
  readonly tarball: string;
  readonly node: string;
  readonly workRoot: string;
}): VerifyVerdict {
  const checks = (["rc4", "rc5"] as const).map((key) =>
    checkRelease({
      release: key === "rc4" ? "0.2.2-rc.4" : "0.2.2-rc.5",
      install: resolve(key === "rc4" ? options.rc4 : options.rc5),
      tarball: options.tarball,
      // A separate tree per release: one install must not be able to satisfy the
      // other's imports through a shared ancestor.
      workRoot: mkdtempSync(join(options.workRoot, `${key}-`)),
      node: options.node,
    }),
  );
  const problems = checks.flatMap((check) => check.problems.map((problem) => `${check.release}: ${problem}`));
  return { ok: problems.length === 0, checks, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const rc4 = flag("--rc4");
  const rc5 = flag("--rc5");
  if (rc4 === undefined || rc5 === undefined) {
    process.stderr.write("usage: bun scripts/verify-dsh-cli.ts --rc4 <install> --rc5 <install>\n");
    process.exit(2);
  }
  const repoRoot = resolve(import.meta.dir, "..");
  const tarball = join(repoRoot, PROBE_TARBALL);
  if (!existsSync(tarball)) {
    process.stderr.write(`error: ${PROBE_TARBALL} is missing; run \`make pack-dsh\` first\n`);
    process.exit(2);
  }
  const workRoot = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verify-dsh-cli-"));
  try {
    const verdict = verifyBoth({ rc4, rc5, tarball, node: resolveNode(), workRoot });
    for (const check of verdict.checks) {
      process.stdout.write(
        `== ${check.release}: add=${check.added ? "ok" : "FAIL"} registered=${check.registered ? "ok" : "FAIL"} ` +
          `no-private-copies=${check.noPrivateCopies ? "ok" : "FAIL"} cli-exit=${check.cliExit}\n`,
      );
      for (const problem of check.problems) process.stderr.write(`   FAIL ${problem}\n`);
    }
    if (!verdict.ok) {
      process.stderr.write("== verify-dsh-cli: FAIL\n");
      process.exit(1);
    }
    process.stdout.write("== verify-dsh-cli: PASS (both releases, fresh profiles, real Node)\n");
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}
