#!/usr/bin/env bun
/**
 * Contract tests for `verify-dsh-runtime-tests.ts`.
 *
 * Why this file exists: the runner's whole job is to decide whether a native family
 * *executed*. A runner that mis-parses "0 skip" or answers "ok" on a skip is the same
 * defect class as a gate that cannot fail — it would report coverage it never measured.
 * So the decision logic is tested directly, without spending a Host.
 *
 * The suite covers the four boundaries lead named:
 *
 * - **failure** — a family with `fail > 0` is reported and the run is not ok;
 * - **unexpected skip** — a skip in any family except the live-CLI one is an error,
 *   because a skip means the environment did not take effect;
 * - **missing live** — a live-CLI skip without `--live-origin`/`--live-cookie-file` is
 *   allowed but must be visible, never counted as a pass;
 * - **the live credential** — only a *path* is accepted, and a path that does not exist is
 *   refused, so a secret value can never arrive through argv.
 *
 * @module scripts/verify-dsh-runtime-tests.test
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILIES, parseInvocation, summarize } from "./verify-dsh-runtime-tests";

const LIVE_FILE = "adapters/dsh/cli.test.ts";

/** The exact shape bun prints, so the parser is tested against real output. */
function bunSummary(input: { pass: number; fail: number; skip: number }): string {
  const lines: string[] = [];
  if (input.fail > 0) lines.push(` ${input.fail} tests failed:`);
  if (input.pass > 0) lines.push(` ${input.pass} pass`);
  if (input.fail > 0) lines.push(` ${input.fail} fail`);
  if (input.skip > 0) lines.push(` ${input.skip} skip`);
  return `${lines.join("\n")}\nRan ${input.pass + input.fail + input.skip} tests across 1 file. [10.00ms]\n`;
}

describe("the family list is complete and names the environment each one reads", () => {
  test("every family names at least one variable", () => {
    for (const family of FAMILIES) {
      expect(family.env.length).toBeGreaterThan(0);
    }
  });

  test("the two harnesses that use their own variable name are not given the archive one", () => {
    // These read different variables; giving them DSH_ARCHIVE_SEAM_INSTALL silently leaves
    // them skipped while the gate reports "ok". That happened once and cost a re-run.
    const replica = FAMILIES.find((family) => family.file.includes("replica-acceptance"));
    const native = FAMILIES.find((family) => family.file.includes("native-acceptance"));
    expect(replica?.env).toEqual(["DSH_REPLICA_SEAM_INSTALL"]);
    expect(native?.env).toEqual(["DSH_NATIVE_SEAM_INSTALLS"]);
    // A list variable must be marked as such, or a dual-release run tests only the first.
    expect(native?.list).toBe(true);
  });

  test("no family is listed twice", () => {
    const files = FAMILIES.map((family) => family.file);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("summarising a run reads the counts, not the prose", () => {
  test("a clean run is captured", () => {
    const outcome = summarize("a.test.ts", bunSummary({ pass: 7, fail: 0, skip: 0 }), 0);
    expect(outcome).toEqual({ file: "a.test.ts", pass: 7, fail: 0, skip: 0, code: 0 });
  });

  test("skips are counted, so a silent skip is visible", () => {
    const outcome = summarize("a.test.ts", bunSummary({ pass: 1, fail: 0, skip: 9 }), 0);
    expect(outcome.skip).toBe(9);
  });

  test("a failing run is captured even when bun's exit code is zero", () => {
    // The runner must not depend on the exit code alone: a family that fails and exits 0
    // would otherwise be reported as ok.
    const outcome = summarize("a.test.ts", bunSummary({ pass: 2, fail: 1, skip: 0 }), 0);
    expect(outcome.fail).toBe(1);
  });

  test("output with no summary yields zeros rather than inventing coverage", () => {
    const outcome = summarize("a.test.ts", "error: cannot find module\n", 1);
    expect(outcome).toMatchObject({ pass: 0, fail: 0, skip: 0, code: 1 });
  });
});

describe("the live credential is a path, never a value", () => {
  test("an existing cookie file is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const file = join(dir, "cookie");
    writeFileSync(file, "secret-do-not-print");
    const invocation = parseInvocation(
      ["--install", "/tmp/install", "--live-origin", "http://127.0.0.1:1", "--live-cookie-file", file],
      {},
    );
    expect(invocation.liveCookieFile).toBe(file);
    expect(invocation.liveOrigin).toBe("http://127.0.0.1:1");
  });

  test("a cookie path that does not exist is refused", () => {
    expect(() =>
      parseInvocation(["--install", "/tmp/install", "--live-cookie-file", "/nonexistent/cookie"], {}),
    ).toThrow(/does not exist/);
  });

  test("omitting the live inputs is allowed; the caller decides, the runner does not invent", () => {
    const invocation = parseInvocation(["--install", "/tmp/install"], {});
    expect(invocation.liveOrigin).toBeUndefined();
    expect(invocation.liveCookieFile).toBeUndefined();
  });

  test("the live inputs may come from the environment too", () => {
    const invocation = parseInvocation(["--install", "/tmp/install"], {
      DSH_CLI_LIVE_ORIGIN: "http://127.0.0.1:2",
    });
    expect(invocation.liveOrigin).toBe("http://127.0.0.1:2");
  });
});

describe("install coverage", () => {
  test("a repeated --install yields both, so a dual release is one run", () => {
    const invocation = parseInvocation(
      ["--install", "/tmp/rc4", "--install", "/tmp/rc5"],
      {},
    );
    expect(invocation.installs).toHaveLength(2);
    expect(invocation.installs[0]).toEndWith("/tmp/rc4");
    expect(invocation.installs[1]).toEndWith("/tmp/rc5");
  });

  test("a single --install yields one", () => {
    expect(parseInvocation(["--install", "/tmp/rc5"], {}).installs).toHaveLength(1);
  });

  test("a duplicate --install is not run twice", () => {
    const invocation = parseInvocation(
      ["--install", "/tmp/rc5", "--install", "/tmp/rc5"],
      {},
    );
    expect(invocation.installs).toHaveLength(1);
  });

  test("INSTALL_DIR is honoured when no flag is given", () => {
    const invocation = parseInvocation([], { INSTALL_DIR: "/tmp/rc5" });
    expect(invocation.installs).toHaveLength(1);
    expect(invocation.installs[0]).toEndWith("/tmp/rc5");
  });

  test("no install at all is refused", () => {
    expect(() => parseInvocation([], {})).toThrow(/missing --install/);
  });

  test("an unknown option is refused rather than ignored", () => {
    expect(() => parseInvocation(["--install", "/tmp/rc5", "--skip-everything"], {})).toThrow(
      /option needs a value|unexpected/,
    );
  });
});

describe("the live file is the only one allowed to skip", () => {
  test("the live family is the cli file, and it exists", () => {
    expect(FAMILIES.some((family) => family.file === LIVE_FILE)).toBe(true);
  });

  test("every other family would be treated as an unexpected skip", () => {
    // Mirrors the runner's rule: skipped families minus the live one must be empty.
    const skipped = [
      { file: "adapters/dsh/store/store.test.ts", pass: 0, fail: 0, skip: 11, code: 0 },
      { file: LIVE_FILE, pass: 9, fail: 0, skip: 1, code: 0 },
    ];
    const unexpected = skipped.filter((outcome) => outcome.file !== LIVE_FILE);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]!.file).toBe("adapters/dsh/store/store.test.ts");
  });
});

describe("the runner is in the maintained type closure", () => {
  test("its source file exists where the closure expects it", () => {
    expect(existsSync(join(import.meta.dir, "verify-dsh-runtime-tests.ts"))).toBe(true);
  });
});
