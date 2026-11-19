/**
 * Tests for `scripts/profile-check.ts`.
 *
 * Two groups, deliberately separated:
 *
 * - **Decision rules and plumbing** run everywhere, with no DSH install: they
 *   inject the process runner and the filesystem inspector, so they assert the
 *   verdict logic — including "a profile that exits when it should keep running
 *   is a new finding, not a pass" — without pretending to boot anything.
 * - **The real matrix** runs only when `DSH_PROFILE_CHECK_INSTALL` names an
 *   isolated install; otherwise those cases are skipped with an explicit
 *   message, so a green run never implies the matrix was measured.
 *
 * Nothing here spawns a DSH process unless that variable is set, and nothing
 * installs, edits a profile, or reaches the network.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_DSH,
  OBSERVE_BANNER,
  cliPath,
  formatReport,
  installedVersion,
  judge,
  resolveNode,
  runProfileCheck,
  writeProfile,
  type Inspector,
  type ProfileProbe,
  type RunResult,
} from "./profile-check.ts";

const roots: string[] = [];


async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "profile-check-test-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** The three probe shapes the script ships, reused so the tests measure the real matrix. */
const HELP_PROBE: ProfileProbe = {
  profile: "with-app",
  bundles: ["@deepseek-ai/dsh-base"],
  intent: "test fixture that must print help",
  expect: "help",
};
const WAIT_PROBE: ProfileProbe = {
  profile: "without-app",
  bundles: ["@deepseek-ai/dsh-base"],
  intent: "test fixture that must stay running",
  expect: "keeps-running",
};

/** A runner that replays fixed outcomes in order and records the invocations. */
function scriptedRunner(
  outcomes: readonly RunResult[],
): { runner: (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => RunResult; calls: { args: string[]; env: Record<string, string>; timeoutMs: number }[] } {
  const calls: { args: string[]; env: Record<string, string>; timeoutMs: number }[] = [];
  let index = 0;
  return {
    calls,
    runner: (_command, args, env, timeoutMs) => {
      calls.push({ args: [...args], env, timeoutMs });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome === undefined) throw new Error("scriptedRunner ran out of outcomes");
      return outcome;
    },
  };
}

/** An inspector over a fabricated install tree, so no real install is needed. */
function fakeInstall(root: string, options: { version?: string; cli?: boolean } = {}): Inspector {
  const modules = join(root, "node_modules/@deepseek-ai/dsh");
  return {
    exists: (path) => (path === cliPath(root) ? options.cli !== false : false),
    readFile: (path) =>
      path === join(modules, "package.json")
        ? JSON.stringify({ version: options.version ?? EXPECTED_DSH })
        : undefined,
    temporaryDirectory: () => join(root, "home"),
    removeDirectory: () => undefined,
    // Writes stay in memory; the fabricated install has no real profile tree.
    makeDirectory: () => undefined,
    writeFile: () => undefined,
  };
}

describe("judge: the verdict rule", () => {
  test("a help probe passes only on exit 0 with output", () => {
    expect(judge(HELP_PROBE, { exitCode: 0, timedOut: false, stdout: "Usage: dsh\n", stderr: "" }).ok).toBe(true);
    expect(judge(HELP_PROBE, { exitCode: 0, timedOut: false, stdout: "", stderr: "" }).ok).toBe(false);
    expect(judge(HELP_PROBE, { exitCode: 1, timedOut: false, stdout: "", stderr: "boom" }).ok).toBe(false);
    expect(judge(HELP_PROBE, { exitCode: null, timedOut: true, stdout: "", stderr: "" }).ok).toBe(false);
  });

  test("a keep-running probe passes only when it is still running and printed no help", () => {
    expect(judge(WAIT_PROBE, { exitCode: null, timedOut: true, stdout: "", stderr: "" }).ok).toBe(true);
    // Exiting is a different finding, never a pass.
    expect(judge(WAIT_PROBE, { exitCode: 0, timedOut: false, stdout: "", stderr: "" }).ok).toBe(false);
    // Running *and* printing help contradicts the prediction.
    expect(judge(WAIT_PROBE, { exitCode: null, timedOut: true, stdout: "Usage: x\n", stderr: "" }).ok).toBe(false);
  });

  test("a failure carries the real first line, not a paraphrase", () => {
    const verdict = judge(HELP_PROBE, {
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "Error: dsh: profile \"web\" does not exist",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('profile "web" does not exist');
  });
});

describe("install inspection", () => {
  test("reads the release from the install manifest", async () => {
    const root = await temporaryRoot();
    expect(installedVersion(root, fakeInstall(root))).toBe(EXPECTED_DSH);
    expect(installedVersion(root, fakeInstall(root, { version: "0.2.2-rc.5" }))).toBe("0.2.2-rc.5");
  });

  test("reports undefined for an unreadable or malformed manifest", async () => {
    const root = await temporaryRoot();
    expect(installedVersion(root, { readFile: () => undefined })).toBeUndefined();
    expect(installedVersion(root, { readFile: () => "not json" })).toBeUndefined();
  });

  test("finds node on PATH and ignores empty segments", () => {
    const found = resolveNode(`:/nonexistent-${Date.now()}:/usr/bin`);
    expect(found === undefined || found.endsWith("/node")).toBe(true);
    expect(resolveNode("")).toBeUndefined();
    expect(resolveNode("/nonexistent-a:/nonexistent-b")).toBeUndefined();
  });
});

describe("runProfileCheck: verdicts without a real install", () => {
  test("no install directory is unverified, not a pass", () => {
    const report = runProfileCheck({});
    expect(report.verdict).toBe("unverified");
    expect(report.outcomes).toHaveLength(0);
    expect(report.blockedBecause).toContain("INSTALL_DIR");
    expect(report.guidance.join("\n")).toContain("npm install --ignore-scripts");
  });

  test("a directory without the published CLI is unverified", async () => {
    const root = await temporaryRoot();
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root, { cli: false }),
      path: "/usr/bin",
    });
    expect(report.verdict).toBe("unverified");
    expect(report.blockedBecause).toContain("no published DSH CLI");
  });

  test("a different release is refused instead of measured as this one", async () => {
    const root = await temporaryRoot();
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root, { version: "0.2.2-rc.5" }),
      path: "/usr/bin",
    });
    expect(report.verdict).toBe("unverified");
    expect(report.blockedBecause).toContain("0.2.2-rc.5");
    expect(report.blockedBecause).toContain(EXPECTED_DSH);
    expect(report.outcomes).toHaveLength(0);
  });

  test("no node on PATH is unverified with the reason, not a profile failure", async () => {
    const root = await temporaryRoot();
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root),
      path: `/nonexistent-${Date.now()}`,
    });
    expect(report.verdict).toBe("unverified");
    expect(report.blockedBecause).toContain("node");
    expect(report.outcomes).toHaveLength(0);
  });
});

describe("runProfileCheck: the matrix, with a scripted process", () => {
  test("both predictions holding is a pass", async () => {
    const root = await temporaryRoot();
    const { runner, calls } = scriptedRunner([
      { status: 0, stdout: "Usage: dsh --profile with-app\n", stderr: "", timedOut: false },
      { status: null, stdout: "", stderr: "", timedOut: true },
    ]);
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root),
      node: "/usr/bin/node",
      runner,
      probes: [HELP_PROBE, WAIT_PROBE],
      helpTimeoutMs: 100,
      waitTimeoutMs: 50,
    });

    expect(report.verdict).toBe("pass");
    expect(report.outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    // The wait probe gets the shorter budget, the help probe the longer one.
    expect(calls.map((call) => call.timeoutMs)).toEqual([100, 50]);
    // The CLI runs under the given node, against the install's own bin.js.
    expect(calls[0]?.args[0]).toBe(cliPath(root));
    // DSH_HOME points at a temporary home, never at the caller's.
    expect(calls[0]?.env.DSH_HOME).toBe(join(root, "home"));
    expect(calls[0]?.env.DSH_HOME).not.toBe(process.env.DSH_HOME);
  });

  test("a help probe that hangs is a failure that reports the timeout", async () => {
    const root = await temporaryRoot();
    const { runner } = scriptedRunner([
      { status: null, stdout: "", stderr: "[profile-check] killed after 100ms", timedOut: true },
      { status: null, stdout: "", stderr: "", timedOut: true },
    ]);
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root),
      node: "/usr/bin/node",
      runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });

    expect(report.verdict).toBe("fail");
    expect(report.outcomes[0]?.ok).toBe(false);
    expect(formatReport(report).join("\n")).toContain("timed out without printing help");
  });

  test("the wait probe exiting is reported as a new finding, not hidden", async () => {
    const root = await temporaryRoot();
    const { runner } = scriptedRunner([
      { status: 0, stdout: "Usage: dsh\n", stderr: "", timedOut: false },
      { status: 0, stdout: "", stderr: "", timedOut: false },
    ]);
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root),
      node: "/usr/bin/node",
      runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });

    expect(report.verdict).toBe("fail");
    const text = formatReport(report).join("\n");
    expect(text).toContain("treat this as a new finding");
  });

  test("a real CLI error is surfaced verbatim", async () => {
    const root = await temporaryRoot();
    const message = 'Error: dsh: profile "x" does not exist; create it with';
    const { runner } = scriptedRunner([
      { status: 1, stdout: "", stderr: message, timedOut: false },
      { status: null, stdout: "", stderr: "", timedOut: true },
    ]);
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root),
      node: "/usr/bin/node",
      runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });
    expect(formatReport(report).join("\n")).toContain("does not exist");
  });
});

describe("gate semantics: contradictions exit non-zero, expectations do not", () => {
  /** Run the whole matrix with a scripted process and report only the verdict. */
  function verdictFor(outcomes: readonly RunResult[]): { verdict: string; lines: string[] } {
    const report = runProfileCheck({
      installDir: "/install",
      inspector: fakeInstall("/install"),
      node: "/usr/bin/node",
      runner: scriptedRunner(outcomes).runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });
    return { verdict: report.verdict, lines: formatReport(report) };
  }

  test("an expected wait being killed by the timeout is NOT a failure", () => {
    const { verdict, lines } = verdictFor([
      { status: 0, stdout: "Usage: x\n", stderr: "", timedOut: false },
      { status: null, stdout: "", stderr: "", timedOut: true },
    ]);
    expect(verdict).toBe("pass");
    expect(lines.join("\n")).not.toContain("CONTRADICTION");
    expect(lines.join("\n")).toContain("exit code 0 (pass)");
  });

  test("an expected help that times out contradicts the prediction", () => {
    const { verdict, lines } = verdictFor([
      { status: null, stdout: "", stderr: "", timedOut: true },
      { status: null, stdout: "", stderr: "", timedOut: true },
    ]);
    expect(verdict).toBe("fail");
    expect(lines.join("\n")).toContain("timed out without printing help");
  });

  test("an expected help that exits non-zero contradicts the prediction", () => {
    const { verdict } = verdictFor([
      { status: 1, stdout: "", stderr: "boom", timedOut: false },
      { status: null, stdout: "", stderr: "", timedOut: true },
    ]);
    expect(verdict).toBe("fail");
  });

  test("a profile that should keep running but exits contradicts the prediction", () => {
    const { verdict } = verdictFor([
      { status: 0, stdout: "Usage: x\n", stderr: "", timedOut: false },
      { status: 0, stdout: "", stderr: "", timedOut: false },
    ]);
    expect(verdict).toBe("fail");
  });
});

describe("config error vs contradiction", () => {
  test("an unusable requested install reads as a configuration error, not a boot failure", async () => {
    const root = await temporaryRoot();
    const report = runProfileCheck({ installDir: root, inspector: fakeInstall(root, { cli: false }), path: "/usr/bin" });
    const text = formatReport(report).join("\n");
    expect(report.verdict).toBe("unverified");
    expect(text).toContain("CONFIG ERROR: INSTALL_DIR=");
    expect(text).toContain("was requested but is unusable");
    expect(text).toContain("exit code 2");
    expect(text).not.toContain("CONTRADICTION");
  });

  test("an unsatisfied prediction reads as a contradiction, not a config error", async () => {
    const report = runProfileCheck({
      installDir: "/install",
      inspector: fakeInstall("/install"),
      node: "/usr/bin/node",
      runner: scriptedRunner([
        { status: null, stdout: "", stderr: "", timedOut: true },
        { status: null, stdout: "", stderr: "", timedOut: true },
      ]).runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });
    const text = formatReport(report).join("\n");
    expect(report.verdict).toBe("fail");
    expect(text).toContain("CONTRADICTION");
    expect(text).toContain("exit code 1");
    expect(text).not.toContain("CONFIG ERROR");
  });
});

describe("coverage lines", () => {
  test("a measured run names what was covered and what was not", () => {
    const report = runProfileCheck({
      installDir: "/install",
      inspector: fakeInstall("/install"),
      node: "/usr/bin/node",
      runner: scriptedRunner([
        { status: 0, stdout: "Usage: x\n", stderr: "", timedOut: false },
        { status: null, stdout: "", stderr: "", timedOut: true },
      ]).runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });
    const text = formatReport(report).join("\n");
    expect(text).toContain("coverage: 2/2 profile shapes measured against 0.2.2-rc.4");
    expect(text).toContain("not covered: live profile, Host/execution-world isolation, Client/GUI, rc.5 type gate");
  });

  test("an unverified run reports 0 measured and still lists the gaps", () => {
    const lines = formatReport(runProfileCheck({})).join("\n");
    expect(lines).toContain("coverage: 0/3 profile shapes measured");
    expect(lines).toContain("not covered:");
  });

  test("the observe banner is a fixed first line", () => {
    expect(OBSERVE_BANNER.startsWith("OBSERVATION ONLY — not a check")).toBe(true);
  });
});

describe("writeProfile", () => {
  test("writes a manifest with the declared bundles and an empty user layer", async () => {
    const home = await temporaryRoot();
    const dir = writeProfile(home, { ...HELP_PROBE, bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] });
    const manifest = JSON.parse(await Bun.file(join(dir, "package.json")).text()) as {
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifest.dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]);
    expect(await Bun.file(join(dir, "cordis.patch.yml")).text()).toBe("[]\n");
    expect(await Bun.file(join(dir, "cordis.yml")).text()).toBe("[]\n");
  });
});

describe("formatReport", () => {
  test("an unverified report always explains what to do next", () => {
    // Built from a real report so the literal cannot drift from the shape.
    const real = runProfileCheck({});
    const lines = formatReport({ ...real, guidance: ["do this"] }).join("\n");
    expect(lines).toContain("UNVERIFIED: no INSTALL_DIR was given");
    expect(lines).toContain("Nothing was run");
    expect(lines).toContain("do this");
  });

  test("a pass names every probe and its intent", () => {
    const root = "/install";
    const report = runProfileCheck({
      installDir: root,
      inspector: fakeInstall(root),
      node: "/usr/bin/node",
      runner: scriptedRunner([
        { status: 0, stdout: "Usage: a\n", stderr: "", timedOut: false },
        { status: null, stdout: "", stderr: "", timedOut: true },
      ]).runner,
      probes: [HELP_PROBE, WAIT_PROBE],
    });
    const text = formatReport(report).join("\n");
    expect(text).toContain("ok   with-app");
    expect(text).toContain("ok   without-app");
    expect(text).toContain(HELP_PROBE.intent);
    expect(text).toContain("PASS:");
  });
});

// ── the real matrix ────────────────────────────────────────────────────────

const INSTALL = process.env.DSH_PROFILE_CHECK_INSTALL;

describe("real matrix", () => {
  test.skipIf(INSTALL === undefined || INSTALL === "")(
    `the shipped matrix passes against ${EXPECTED_DSH} (DSH_PROFILE_CHECK_INSTALL)`,
    () => {
      const report = runProfileCheck({ installDir: INSTALL });
      const text = formatReport(report).join("\n");
      // Whatever the verdict, it must be one of the three, never "silently ok".
      expect(["pass", "fail", "unverified"]).toContain(report.verdict);
      if (report.verdict === "unverified") {
        throw new Error(`matrix could not run against ${INSTALL}:\n${text}`);
      }
      expect(report.verdict).toBe("pass");
      expect(report.outcomes).toHaveLength(3);
    },
    { timeout: 180_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "the same matrix refuses a different release instead of measuring it",
    async () => {
      const root = await temporaryRoot();
      const pkgDir = join(root, "node_modules/@deepseek-ai/dsh");
      await mkdir(join(pkgDir, "lib"), { recursive: true });
      await writeFile(join(pkgDir, "package.json"), JSON.stringify({ version: "0.0.0-other" }));
      await writeFile(join(pkgDir, "lib/bin.js"), "");
      const report = runProfileCheck({ installDir: root, path: process.env.PATH });
      expect(report.verdict).toBe("unverified");
      expect(report.blockedBecause).toContain("0.0.0-other");
    },
  );
});

test("the pinned release is recorded in one place", () => {
  expect(EXPECTED_DSH).toBe("0.2.2-rc.4");
});
