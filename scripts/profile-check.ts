#!/usr/bin/env bun
/**
 * Diagnose whether a DSH profile actually boots, and say why when it does not.
 *
 * This script exists because an earlier report claimed "`dsh --profile` hangs
 * (exit 124)". The observation was real; the conclusion was wrong. A profile
 * whose composition has no app/startup row boots successfully and then keeps
 * running, because `dsh --profile <name> --help` is the *app's* help: only an
 * app plugin consumes it, and only the mounted plugins end the process. This
 * script measures that distinction instead of assuming it.
 *
 * Three verdicts, and no fourth:
 *
 *   pass        every profile in the matrix behaved as predicted
 *   fail        a profile that should print help did not; the real error or the
 *               timeout is reported verbatim and the exit code is non-zero
 *   unverified  the environment cannot answer the question (no isolated install,
 *               no published CLI, wrong release); nothing is claimed either way
 *
 *   bun scripts/profile-check.ts <isolated-install-dir>
 *
 * Without an install directory it prints how to create one and exits 2. It
 * never writes into the repository, never touches a live profile, and needs no
 * credentials and no network.
 *
 * `--observe` turns the same measurements into an observation: it prints
 * everything measured, says so in its first line, and exits 0 without asserting
 * anything. The default is the gate.
 *
 * Exit codes: 0 pass, 1 measured behaviour contradicts a prediction,
 * 2 unverified or misconfigured (nothing claimed).
 *
 * @module scripts/profile-check
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The DSH release this gate is pinned to. */
export const EXPECTED_DSH = "0.2.2-rc.4";

/** Wall-clock limit for a profile that must print help and exit. */
export const HELP_TIMEOUT_MS = 60_000;

/**
 * Wall-clock limit for the profile expected to keep running.
 *
 * It only has to outlive the moment the app would have printed help, so this is
 * much shorter than the help limit. A longer wait proves nothing extra.
 */
export const WAIT_TIMEOUT_MS = 12_000;

/** One profile shape the matrix measures. */
export interface ProfileProbe {
  /** Profile name inside the temporary DSH_HOME. */
  readonly profile: string;
  /**
   * Bundles the profile composes. An empty list means "use the shipped
   * template of that name", which the CLI creates on first use.
   */
  readonly bundles: readonly string[];
  /** What this probe is for, in one phrase. */
  readonly intent: string;
  /** The outcome this probe predicts. */
  readonly expect: "help" | "keeps-running";
}

/**
 * The matrix. It encodes the diagnosis directly, so the old misreading cannot
 * return unnoticed:
 *
 * - `web` is a shipped template with an app/startup row: it must print that
 *   app's help and exit 0.
 * - `composed-app` is hand-written and adds the app bundle explicitly: same
 *   prediction, so the result does not depend on the shipped templates.
 * - `no-app-waits` is hand-written with only `dsh-base`: no app row, so nothing
 *   consumes `--help` and nothing ends the process. It must stay running.
 */
export const PROBES: readonly ProfileProbe[] = [
  {
    profile: "web",
    bundles: [],
    intent: "shipped template with an app row prints its app help",
    expect: "help",
  },
  {
    profile: "composed-app",
    bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
    intent: "hand-composed profile with an app bundle prints its app help",
    expect: "help",
  },
  {
    profile: "no-app-waits",
    bundles: ["@deepseek-ai/dsh-base"],
    intent: "a profile with no app row boots, then keeps running instead of printing help",
    expect: "keeps-running",
  },
];

/** One process observation. */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether the wall-clock limit killed the process. */
  readonly timedOut: boolean;
}

/** Runs one command; injected so the decision rules are testable without spawning. */
export type Runner = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
) => RunResult;

/** Filesystem lookups and writes, injected so nothing touches the real disk in tests. */
export interface Inspector {
  readonly readFile?: (path: string) => string | undefined;
  readonly exists?: (path: string) => boolean;
  readonly temporaryDirectory?: () => string;
  readonly removeDirectory?: (path: string) => void;
  readonly makeDirectory?: (path: string) => void;
  readonly writeFile?: (path: string, content: string) => void;
}

/** One probe's measured outcome. */
export interface ProbeOutcome {
  readonly probe: ProfileProbe;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
  /** One line explaining the verdict. */
  readonly detail: string;
}

/** The whole run's verdict. */
export type Verdict = "pass" | "fail" | "unverified";

/** What a run concluded, and why it could not conclude anything. */
export interface ProfileReport {
  readonly verdict: Verdict;
  readonly installDir?: string;
  readonly dshVersion?: string;
  readonly outcomes: readonly ProbeOutcome[];
  /** How many profile shapes the matrix planned to measure. */
  readonly planned: number;
  /** Set only for `unverified`. */
  readonly blockedBecause?: string;
  /** Executable next steps, always present so the message is actionable. */
  readonly guidance: readonly string[];
}

const GUIDANCE: readonly string[] = [
  "Create an isolated install of the published release (never this working tree):",
  '  dsh_install="${TMPDIR:-/tmp}/dsh-rc4"',
  '  mkdir -p "$dsh_install" && cd "$dsh_install" && npm init -y',
  `  npm install --ignore-scripts @deepseek-ai/dsh@${EXPECTED_DSH} typescript@5.9 @types/node@24`,
  'Then: make profile-check INSTALL_DIR="$dsh_install"',
  "",
  "The install is disposable. The check creates its profiles under a temporary",
  "DSH_HOME and removes it afterwards; it never reads or writes a live profile.",
];

function defaultRun(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): RunResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env,
    // A CLI needs no stdin; `/dev/null` keeps a stray prompt from blocking.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = code === "ETIMEDOUT";
  return {
    status: timedOut ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: timedOut ? `${result.stderr ?? ""}\n[profile-check] killed after ${timeoutMs}ms` : result.stderr ?? "",
    timedOut,
  };
}

const defaultInspector: Inspector = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  exists: (path) => existsSync(path),
  temporaryDirectory: () => mkdtempSync(join(tmpdir(), "dsh-profile-check-")),
  removeDirectory: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  makeDirectory: (path) => {
    mkdirSync(path, { recursive: true });
  },
  writeFile: (path, content) => {
    writeFileSync(path, content);
  },
};

/** Path of the published CLI inside an isolated install. */
export function cliPath(installDir: string): string {
  return join(installDir, "node_modules/@deepseek-ai/dsh/lib/bin.js");
}

/**
 * Read the installed release from an isolated install.
 * @param installDir - absolute install directory.
 * @param inspector - filesystem lookups.
 * @returns the manifest version, or undefined when absent or unreadable.
 */
export function installedVersion(installDir: string, inspector: Inspector = defaultInspector): string | undefined {
  const text = inspector.readFile?.(join(installDir, "node_modules/@deepseek-ai/dsh/package.json"));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write one hand-composed profile into a temporary home: manifest, empty user
 * patch layer, and the empty root config a profile boots over.
 * @param home - temporary DSH home.
 * @param probe - the profile shape to write.
 * @param io - filesystem writers; defaults to the real filesystem.
 * @returns the profile directory.
 */
export function writeProfile(home: string, probe: ProfileProbe, io: Inspector = defaultInspector): string {
  const dir = join(home, "profiles", probe.profile);
  const makeDirectory = io.makeDirectory ?? ((path: string) => mkdirSync(path, { recursive: true }));
  const writeFile = io.writeFile ?? ((path: string, content: string) => writeFileSync(path, content));
  makeDirectory(dir);
  writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: `dsh-profile-${probe.profile}`, private: true, dsh: { profile: { bundles: [...probe.bundles] } } },
      null,
      2,
    )}\n`,
  );
  writeFile(join(dir, "cordis.patch.yml"), "[]\n");
  writeFile(join(dir, "cordis.yml"), "[]\n");
  return dir;
}

/**
 * Decide one probe's verdict from what the process did.
 *
 * Pure, so the rule is testable without booting anything. A predicted help must
 * exit 0 *and* print something; a predicted wait must still be running at the
 * deadline and must not have printed help — exiting would be a different
 * finding, not a pass.
 * @param probe - the prediction under test.
 * @param observed - exit status, timeout flag, and captured output.
 * @returns whether the prediction held, plus one explanatory line.
 */
export function judge(
  probe: ProfileProbe,
  observed: { readonly exitCode: number | null; readonly timedOut: boolean; readonly stdout: string; readonly stderr: string },
): { ok: boolean; detail: string } {
  const printedHelp = observed.stdout.trim().length > 0;
  if (probe.expect === "help") {
    if (observed.timedOut) {
      return { ok: false, detail: "timed out without printing help; expected the app's help and exit 0" };
    }
    if (observed.exitCode !== 0) {
      const first = firstLine(observed.stderr) || firstLine(observed.stdout) || "(no output)";
      return { ok: false, detail: `exited ${observed.exitCode ?? "?"} instead of printing help: ${first}` };
    }
    if (!printedHelp) return { ok: false, detail: "exited 0 but printed no help text" };
    return { ok: true, detail: `printed help and exited 0: ${firstLine(observed.stdout)}` };
  }
  if (!observed.timedOut) {
    return {
      ok: false,
      detail: `exited ${observed.exitCode ?? "?"} but a composition without an app row is expected to keep running; treat this as a new finding`,
    };
  }
  if (printedHelp) {
    return { ok: false, detail: "kept running but printed help text; this expectation no longer matches the release" };
  }
  return { ok: true, detail: "still running at the deadline, with no help output and no error (booted, then waited)" };
}

function firstLine(text: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

/**
 * Resolve the `node` binary the published CLI must run under.
 *
 * Not `process.execPath`: `make profile-check` invokes this script with bun,
 * and the DSH CLI's native addon refuses a non-Node runtime
 * (`node-addon-require-builtin unsupported`). Running the CLI under the wrong
 * interpreter would report that as a profile failure, which it is not.
 * @param pathValue - PATH to search.
 * @returns the `node` command to use, or undefined when none is on PATH.
 */
export function resolveNode(pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Run the matrix against one isolated install.
 * @param options - install directory, timing, and injected process/filesystem hooks.
 * @returns the report; expected failures are reported, never thrown.
 */
export function runProfileCheck(
  options: {
    installDir?: string;
    node?: string;
    helpTimeoutMs?: number;
    waitTimeoutMs?: number;
    runner?: Runner;
    inspector?: Inspector;
    probes?: readonly ProfileProbe[];
    path?: string;
  } = {},
): ProfileReport {
  const inspector = options.inspector ?? defaultInspector;
  const runner = options.runner ?? defaultRun;
  const pathValue = options.path ?? process.env.PATH ?? "";
  const helpTimeoutMs = options.helpTimeoutMs ?? HELP_TIMEOUT_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const probes = options.probes ?? PROBES;
  const guidance = [...GUIDANCE];

  const raw = options.installDir;
  if (raw === undefined || raw.trim() === "") {
    return { verdict: "unverified", outcomes: [], planned: probes.length, blockedBecause: "no INSTALL_DIR was given", guidance };
  }
  const installDir = resolve(raw);

  const cli = cliPath(installDir);
  if (inspector.exists?.(cli) !== true) {
    return {
      verdict: "unverified",
      installDir,
      outcomes: [],
      planned: probes.length,
      blockedBecause: `no published DSH CLI at ${cli}`,
      guidance,
    };
  }
  const node = options.node ?? resolveNode(pathValue);
  if (node === undefined) {
    return {
      verdict: "unverified",
      installDir,
      outcomes: [],
      planned: probes.length,
      blockedBecause: "no `node` on PATH; the published DSH CLI cannot run under bun",
      guidance: [
        ...guidance,
        "",
        "The CLI's native addon needs a Node runtime: invoking it with bun fails with",
        "`node-addon-require-builtin unsupported`. Put node on PATH (the development",
        "container ships node 26) and re-run.",
      ],
    };
  }

  const dshVersion = installedVersion(installDir, inspector);
  if (dshVersion !== EXPECTED_DSH) {
    return {
      verdict: "unverified",
      installDir,
      ...dshVersion === undefined ? {} : { dshVersion },
      outcomes: [],
      planned: probes.length,
      blockedBecause:
        dshVersion === undefined
          ? "the install's DSH manifest has no readable version"
          : `the install holds ${dshVersion}, but this gate measures ${EXPECTED_DSH}`,
      guidance,
    };
  }

  const home = inspector.temporaryDirectory?.();
  if (home === undefined) {
    return { verdict: "unverified", installDir, dshVersion, outcomes: [], planned: probes.length, blockedBecause: "no temporary directory available", guidance };
  }

  const env: Record<string, string> = {
    PATH: pathValue,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
  };

  const outcomes: ProbeOutcome[] = [];
  try {
    for (const probe of probes) {
      const timeoutMs = probe.expect === "help" ? helpTimeoutMs : waitTimeoutMs;
      // A shipped template is created by the CLI on first use, so only
      // hand-composed profiles are written here.
      if (probe.bundles.length > 0) writeProfile(home, probe, inspector);
      const started = Date.now();
      const result = runner(node, [cli, "--profile", probe.profile, "--help"], env, timeoutMs);
      const measured = { exitCode: result.timedOut ? null : result.status, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
      const verdict = judge(probe, measured);
      outcomes.push({
        probe,
        exitCode: measured.exitCode,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
        stdout: result.stdout,
        stderr: result.stderr,
        ok: verdict.ok,
        detail: verdict.detail,
      });
    }
  } finally {
    inspector.removeDirectory?.(home);
  }

  return {
    verdict: outcomes.every((outcome) => outcome.ok) ? "pass" : "fail",
    installDir,
    dshVersion,
    outcomes,
    planned: probes.length,
    guidance,
  };
}

/**
 * Render a report as the lines a maintainer reads.
 * @param report - the run's report.
 * @returns one line per fact; failures include an excerpt of the real output.
 */
export function formatReport(report: ProfileReport): string[] {
  const lines: string[] = [];
  const coverage = [
    `coverage: ${report.outcomes.length}/${report.planned} profile shapes measured` +
      (report.dshVersion === undefined ? "" : ` against ${report.dshVersion}`) +
      ` in this container`,
    "not covered: live profile, Host/execution-world isolation, Client/GUI, rc.5 type gate (pinned to rc.4)",
  ];
  if (report.installDir !== undefined) {
    lines.push(`install: ${report.installDir}${report.dshVersion === undefined ? "" : ` (${report.dshVersion})`}`);
  }
  if (report.verdict === "unverified") {
    // A requested-but-unusable install is a configuration problem; no request
    // at all is an unsupplied input. They read differently on purpose, so a
    // reader never confuses "your path is wrong" with "profile boot failed".
    const reason = report.blockedBecause ?? "the environment cannot answer this question";
    if (report.installDir !== undefined) {
      lines.push(
        `CONFIG ERROR: INSTALL_DIR=${report.installDir} was requested but is unusable, so nothing was verified: ${reason}`,
      );
    } else {
      lines.push(`UNVERIFIED: ${reason}`);
    }
    lines.push("Nothing was run, so nothing is claimed about profile boot.");
    lines.push(...coverage);
    lines.push("== exit code 2 (unverified: nothing was verified)");
    lines.push("");
    for (const line of report.guidance) lines.push(line);
    return lines;
  }
  for (const outcome of report.outcomes) {
    lines.push(
      `${outcome.ok ? "ok  " : "FAIL"} ${outcome.probe.profile.padEnd(14)} ${String(outcome.durationMs).padStart(6)}ms  ${outcome.detail}`,
    );
    lines.push(`     ${outcome.probe.intent}`);
    if (outcome.ok) continue;
    for (const stream of [outcome.stderr, outcome.stdout]) {
      const excerpt = stream.split("\n").filter((line) => line.trim().length > 0).slice(0, 6);
      for (const line of excerpt) lines.push(`     | ${line.length > 160 ? `${line.slice(0, 157)}...` : line}`);
    }
  }
  if (report.verdict === "pass") {
    lines.push("PASS: app rows print their help and exit; a composition without one boots and keeps running.");
    lines.push("== exit code 0 (pass)");
  } else {
    lines.push(
      "CONTRADICTION: at least one profile behaved differently from its prediction; the real error or timeout is shown above.",
    );
    lines.push("== exit code 1 (observation contradicts the prediction)");
  }
  lines.push(...coverage);
  return lines;
}

/** The first line of every `--observe` run. */
export const OBSERVE_BANNER = "OBSERVATION ONLY — not a check; this run does not assert profile boot works";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const observe = args.includes("--observe");
  const installDir = args.find((arg) => arg !== "--observe");
  const report = runProfileCheck({ installDir });
  const lines = formatReport(report);
  if (observe) {
    // Observation mode reports what happened and asserts nothing: an
    // unverified environment is still a successful observation.
    const status = report.verdict === "unverified" ? "not attempted" : report.verdict === "pass" ? "as predicted" : "contradicted predictions";
    console.log(OBSERVE_BANNER);
    console.log(`observed: ${status} (exit code ignored in observation mode)`);
    for (const line of lines) console.log(line);
    process.exitCode = 0;
  } else {
    for (const line of lines) console.log(line);
    process.exitCode = report.verdict === "pass" ? 0 : report.verdict === "fail" ? 1 : 2;
  }
}
