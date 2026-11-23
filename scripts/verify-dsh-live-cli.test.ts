#!/usr/bin/env bun
/**
 * Contract tests for `verify-dsh-live-cli.ts`.
 *
 * The live case is the one native test that can never be allowed to skip, so the gate
 * that runs it must itself be tested on the three ways it could quietly pass:
 *
 * 1. **skip counted as success** — the exact defect that left this case uncovered;
 * 2. **zero tests counted as success** — a pass line that never appeared;
 * 3. **a credential arriving as a value** — only a path may be accepted.
 *
 * The Host lifecycle is not exercised here; that is the gate's job against a real
 * install. These tests pin the decisions.
 *
 * @module scripts/verify-dsh-live-cli.test
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffProblem, parseInvocation, summarize, verdict } from "./verify-dsh-live-cli";

describe("the verdict refuses every way of not running the live case", () => {
  test("a skip is a failure, not an accepted outcome", () => {
    const result = verdict({ pass: 0, fail: 0, skip: 1 }, 0);
    expect(result.code).toBe(1);
    expect(result.reason).toContain("skipped");
  });

  test("a skip is a failure even when other tests passed", () => {
    // The file has 9 always-on tests; 8 pass and the live one skips must still fail.
    const result = verdict({ pass: 8, fail: 0, skip: 1 }, 0);
    expect(result.code).toBe(1);
  });

  test("a failure is reported", () => {
    expect(verdict({ pass: 0, fail: 1, skip: 0 }, 1).code).toBe(1);
  });

  test("a non-zero exit with no parsed counts is a failure", () => {
    expect(verdict({ pass: 0, fail: 0, skip: 0 }, 1).code).toBe(1);
  });

  test("zero tests is not evidence, even with a clean exit", () => {
    const result = verdict({ pass: 0, fail: 0, skip: 0 }, 0);
    expect(result.code).toBe(1);
    expect(result.reason).toContain("zero-count");
  });

  test("a real pass is the only success", () => {
    const result = verdict({ pass: 1, fail: 0, skip: 0 }, 0);
    expect(result.code).toBe(0);
    expect(result.reason).toContain("skip=0");
  });
});

describe("summarising the live run reads counts", () => {
  test("counts are read from bun's summary", () => {
    const counts = summarize(" 9 pass\n 1 skip\nRan 10 tests across 1 file.\n");
    expect(counts).toEqual({ pass: 9, fail: 0, skip: 1 });
  });

  test("output with no summary yields zeros, so verdict refuses it", () => {
    const counts = summarize("error: cannot find module\n");
    expect(counts).toEqual({ pass: 0, fail: 0, skip: 0 });
    expect(verdict(counts, 0).code).toBe(1);
  });
});

describe("the handoff must carry an origin and a credential path", () => {
  const cookieFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "live-cli-test-"));
    const file = join(dir, "api-cookie");
    writeFileSync(file, "secret-never-read-by-the-gate");
    return file;
  };

  test("a complete handoff is accepted", () => {
    expect(handoffProblem({ origin: "http://127.0.0.1:1234", apiCookieFile: cookieFile() })).toBeUndefined();
  });

  test("a missing origin is refused", () => {
    expect(handoffProblem({})).toContain("origin");
  });

  test("an origin that is not http is refused", () => {
    expect(handoffProblem({ origin: "file:///tmp", apiCookieFile: cookieFile() })).toContain("origin");
  });

  test("a missing api cookie file is refused", () => {
    expect(handoffProblem({ origin: "http://127.0.0.1:1" })).toContain("apiCookieFile");
  });

  test("an api cookie path that does not exist is refused", () => {
    expect(handoffProblem({ origin: "http://127.0.0.1:1", apiCookieFile: "/nonexistent/cookie" })).toContain(
      "does not exist",
    );
  });
});

describe("the credential is a path, never a value", () => {
  test("all required options parse", () => {
    const invocation = parseInvocation(
      [
        "--install-dir", "/tmp/install",
        "--package", "/tmp/pkg.tgz",
        "--sha256", "a".repeat(64),
        "--output", "/tmp/out",
      ],
      {},
    );
    expect(invocation.install).toEndWith("/tmp/install");
    expect(invocation.sha256).toBe("a".repeat(64));
  });

  test("a short or non-hex sha256 is refused", () => {
    const base = ["--install-dir", "/tmp/i", "--package", "/tmp/p.tgz", "--output", "/tmp/o"];
    expect(() => parseInvocation([...base, "--sha256", "abc"], {})).toThrow(/64 lowercase hex/);
    expect(() => parseInvocation([...base, "--sha256", "A".repeat(64)], {})).toThrow(/64 lowercase hex/);
  });

  test("a missing sha256 is refused: an unpinned run cannot conclude", () => {
    expect(() =>
      parseInvocation(["--install-dir", "/tmp/i", "--package", "/tmp/p.tgz", "--output", "/tmp/o"], {}),
    ).toThrow(/missing --sha256/);
  });

  test("an unknown option is refused rather than ignored", () => {
    expect(() =>
      parseInvocation(
        [
          "--install-dir", "/tmp/i",
          "--package", "/tmp/p.tgz",
          "--output", "/tmp/o",
          "--sha256", "a".repeat(64),
          "--cookie", "value",
        ],
        {},
      ),
    ).toThrow(/unknown option/);
  });
});
