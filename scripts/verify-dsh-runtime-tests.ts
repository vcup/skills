#!/usr/bin/env bun
/**
 * `runtime-test-check` — run the native test families that offline `bun test` skips.
 *
 * ## Why this gate exists
 *
 * Offline `make test` reports 92 skips, and that is legitimate: a unit suite on a machine
 * with no install has nothing to install into. What is not legitimate is letting those 92
 * skips stand in for the release claim. The product gates boot real Hosts, but "a gate
 * boots a Host" is not the same statement as "these named tests executed", and a report
 * that swaps one for the other is claiming coverage it never measured.
 *
 * So this gate names the files, supplies each one's own environment, and **fails when a
 * family still skips** — because a skip here means the environment did not take effect and
 * the tests did not run.
 *
 * ## The one family that is allowed to skip
 *
 * The live CLI case needs a running Host's origin and credential file. This gate passes an
 * origin and a cookie **file path** when the caller supplies one, and refuses to invent a
 * token value: a cookie printed into a command line or a log is a leak, and a fabricated
 * one would test nothing. So that single test may skip, is counted separately, and is
 * reported as skipped rather than green.
 *
 *   bun scripts/verify-dsh-runtime-tests.ts --install DIR [--native-runtime DIR]
 *       [--live-origin URL --live-cookie-file PATH]
 *
 * Exit: 0 every named family ran with no failure and no unexpected skip; 1 a test failed;
 * 2 a prerequisite is missing (nothing concluded).
 *
 * @module scripts/verify-dsh-runtime-tests
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface Family {
  readonly file: string;
  readonly env: readonly string[];
  readonly gate: string;
  /** True when the variable takes a colon-separated list of installs. */
  readonly list?: boolean;
}

/**
 * The families, each with the environment it reads and the release gate that exercises the
 * same capability. `gate` is recorded so a reader can see the overlap, not so it can be
 * substituted for running the test.
 */
export const FAMILIES: readonly Family[] = [
  { file: "adapters/dsh/store/store.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check / replica-acceptance-check" },
  { file: "adapters/dsh/store/kernel.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check / native-acceptance-check" },
  { file: "adapters/dsh/store/ledger.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check / maintenance-live-check" },
  { file: "adapters/dsh/store/kernel-descriptor.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check" },
  { file: "scripts/verify-dsh-store-acceptance.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "store-acceptance-check" },
  { file: "scripts/verify-dsh-replica-acceptance.test.ts", env: ["DSH_REPLICA_SEAM_INSTALL"], gate: "replica-acceptance-check" },
  { file: "scripts/verify-dsh-native-acceptance.test.ts", env: ["DSH_NATIVE_SEAM_INSTALLS"], gate: "native-acceptance-check", list: true },
  { file: "adapters/dsh/archive.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check / replica-acceptance-check" },
  { file: "adapters/dsh/owner-entry.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check" },
  { file: "adapters/dsh/owner-world.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check" },
  { file: "adapters/dsh/owner-service.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check" },
  { file: "adapters/dsh/owner-remote.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check" },
  { file: "adapters/dsh/owner-preserve.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "production-check" },
  { file: "adapters/dsh/cli-invocation.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "maintenance-live-check" },
  { file: "adapters/dsh/cli.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "maintenance-live-check / production-check" },
  { file: "scripts/profile-check.test.ts", env: ["DSH_PROFILE_CHECK_INSTALL"], gate: "production-check" },
  { file: "adapters/dsh/native/locations.test.ts", env: ["DSH_ARCHIVE_SEAM_INSTALL"], gate: "host-check / product-check" },
];

/** The only family member allowed to skip, and only for want of a live credential. */
const LIVE_FILE = "adapters/dsh/cli.test.ts";

interface Invocation {
  /** One or more installs. Several means a dual-release run; list variables get all. */
  readonly installs: readonly string[];
  readonly liveOrigin: string | undefined;
  readonly liveCookieFile: string | undefined;
}

function fail(message: string): never {
  console.error(`runtime-test-check: ${message}`);
  process.exit(2);
}

export function parseInvocation(argv: readonly string[], env: Record<string, string | undefined>): Invocation {
  const values = new Map<string, string>();
  const installFlags: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`option needs a value: ${token}`);
    if (token === "--install") installFlags.push(value);
    values.set(token, value);
    index += 1;
  }
  const install = values.get("--install") ?? env.INSTALL_DIR;
  if (install === undefined || install === "") throw new Error("missing --install (or INSTALL_DIR)");
  const liveOrigin = values.get("--live-origin") ?? env.DSH_CLI_LIVE_ORIGIN;
  const liveCookieFile = values.get("--live-cookie-file") ?? env.DSH_CLI_LIVE_COOKIE_FILE;
  // A credential *value* is never accepted on the command line: only a path to a file the
  // caller controls. That keeps the secret out of argv, out of logs and out of this gate.
  if (liveCookieFile !== undefined && liveCookieFile !== "" && !existsSync(liveCookieFile)) {
    throw new Error(`--live-cookie-file does not exist: ${liveCookieFile}`);
  }
  // Repeating --install covers both releases in one run; one value is the common case.
  const all = installFlags.length > 0 ? installFlags : [install];
  return {
    installs: [...new Set(all.map((one) => resolve(one)))],
    liveOrigin,
    liveCookieFile,
  };
}

interface Outcome {
  readonly file: string;
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly code: number;
}

/** Read bun's summary lines. Numbers only: the tests' own names are the authority. */
export function summarize(file: string, output: string, code: number): Outcome {
  const pick = (label: string): number => {
    const match = output.match(new RegExp(`^\\s*(\\d+)\\s+${label}\\s*$`, "m"));
    return match === null ? 0 : Number(match[1]);
  };
  return { file, pass: pick("pass"), fail: pick("fail"), skip: pick("skip"), code };
}

function main(): void {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2), process.env);
  } catch (error) {
    fail((error as Error).message);
  }
  const { liveOrigin, liveCookieFile } = invocation;
  const installs = invocation.installs;
  for (const one of installs) {
    if (!existsSync(one)) fail(`install directory does not exist: ${one}`);
    if (!existsSync(join(one, "node_modules/@deepseek-ai/dsh/package.json"))) {
      fail(`no @deepseek-ai/dsh in ${one}; this gate needs a real isolated install`);
    }
  }
  const repo = resolve(import.meta.dir, "..");

  const outcomes: Outcome[] = [];
  for (const family of FAMILIES) {
    if (!existsSync(join(repo, family.file))) {
      fail(`${family.file} is missing; the family list is stale and this gate refuses to run a partial set`);
    }
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const name of family.env) {
      // A list variable must receive *every* install this run covers, so a dual-release
      // invocation exercises both rather than silently testing only the first.
      env[name] = family.list === true ? installs.join(":") : installs[0]!;
    }
    if (family.file === LIVE_FILE) {
      // Only pass what the caller actually gave. An invented value would make the live
      // test assert against a fixture this gate imagined.
      if (liveOrigin !== undefined && liveOrigin !== "") env.DSH_CLI_LIVE_ORIGIN = liveOrigin;
      else delete env.DSH_CLI_LIVE_ORIGIN;
      if (liveCookieFile !== undefined && liveCookieFile !== "") env.DSH_CLI_LIVE_COOKIE_FILE = liveCookieFile;
      else delete env.DSH_CLI_LIVE_COOKIE_FILE;
    }
    const run = spawnSync(process.execPath, ["test", family.file], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 900_000,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const outcome = summarize(family.file, output, run.status ?? 1);
    outcomes.push(outcome);
    const tail = output.split("\n").filter((line) => /^\s*\d+\s+(pass|fail|skip)\s*$/.test(line)).join(" ").trim();
    console.log(
      `${outcome.code === 0 && outcome.fail === 0 ? "ok  " : "FAIL"}  ${family.file}  ` +
        `pass=${outcome.pass} fail=${outcome.fail} skip=${outcome.skip}` +
        (tail === "" ? "" : `   (${tail})`),
    );
    if (outcome.code !== 0 || outcome.fail > 0) {
      console.error(`\n-- ${family.file} failed; its output follows --`);
      console.error(output.slice(-4000));
    }
  }

  const failed = outcomes.filter((outcome) => outcome.code !== 0 || outcome.fail > 0);
  const skipped = outcomes.filter((outcome) => outcome.skip > 0);

  console.log("");
  console.log(
    `== runtime-test-check: ${outcomes.length} families, ` +
      `${outcomes.reduce((sum, outcome) => sum + outcome.pass, 0)} pass, ` +
      `${outcomes.reduce((sum, outcome) => sum + outcome.fail, 0)} fail, ` +
      `${outcomes.reduce((sum, outcome) => sum + outcome.skip, 0)} skip`,
  );

  if (failed.length > 0) {
    console.error(`runtime-test-check: FAILED in ${failed.map((outcome) => outcome.file).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  // A skip in any family other than the live-CLI one means the environment did not take
  // effect: the tests did not run, and this gate must not report them as covered.
  const unexpected = skipped.filter((outcome) => outcome.file !== LIVE_FILE);
  if (unexpected.length > 0) {
    console.error(
      `runtime-test-check: ${unexpected.length} family(ies) still skipped with an install named: ` +
        `${unexpected.map((outcome) => `${outcome.file} (${outcome.skip})`).join(", ")}`,
    );
    console.error("  The environment did not take effect, so those tests did not run.");
    process.exitCode = 1;
    return;
  }
  if (skipped.length > 0) {
    console.log(
      `runtime-test-check: live CLI skipped (${skipped.map((outcome) => outcome.skip).join(",")} test) — ` +
        "no --live-origin/--live-cookie-file supplied; reported as skipped, never as passed",
    );
  }
  console.log("== runtime-test-check: ok");
}

// Guarded, so importing this module for its parsers does not execute the gate. Without
// the guard, `import { parseInvocation } from …` runs `main()`, prints a prerequisite
// error and exits the test process — which is exactly what happened when the first version
// of this file had a bare `main()`.
if (import.meta.main) main();
