#!/usr/bin/env bun
/**
 * The guards that make a per-run gate root safe.
 *
 * These exist because the first version of both browser gates cleared
 * `join(output, "serve")` with `rmSync` before starting, to avoid reading a stale
 * handoff. That was right about the problem and wrong about the method: `--output`
 * is whatever the caller typed, so `--output /` would have deleted a directory the
 * gate never created.
 *
 * The tests below pin the two halves of the fix:
 *
 * - **refusals** — root, the repository root, a `..` segment and a symlink are all
 *   refused before anything is written;
 * - **containment** — a run root is unique per call, lives under the caller's
 *   output, and cleanup can only remove the directory this process created.
 *
 * A test that only asserted "the happy path works" would have passed against the
 * unsafe version too.
 *
 * @module scripts/gate-root.test
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRunRoot, outputProblem } from "./gate-root";

const projectRoot = resolve(import.meta.dir, "..");

/** A scratch parent that is never the repository and never a filesystem root. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "gate-root-test-"));
}

describe("an output directory the gate must not write into is refused", () => {
  test("the filesystem root is refused", () => {
    const problem = outputProblem("/", projectRoot);
    expect(problem).toContain("filesystem root");
  });

  test("the repository root is refused", () => {
    const problem = outputProblem(projectRoot, projectRoot);
    expect(problem).toContain("repository root");
  });

  test("a '..' segment is refused", () => {
    // Not because '..' is always dangerous, but because the resolved path and the
    // typed path can differ, and cleanup must act on exactly one meaning.
    // Built by concatenation, not `join`: `join` normalises `..` away, so the test
    // would hand the guard an already-clean path and prove nothing.
    const problem = outputProblem(`${projectRoot}/build/../..`, projectRoot);
    expect(problem).toContain("'..'");
  });

  test("a symlinked output is refused", () => {
    const parent = scratch();
    const real = join(parent, "real");
    mkdirSync(real);
    const link = join(parent, "link");
    symlinkSync(real, link);
    const problem = outputProblem(link, projectRoot);
    // A symlink is refused before anything is created; the message names why.
    expect(problem).toBeDefined();
    expect(String(problem)).toContain("symlink");
  });

  test("the make default output path is accepted", () => {
    // The regression this pins: an over-broad guard refused *every* in-repo path, which
    // would break `CLIENT_OUT ?= build/production/client` — every browser and live gate's
    // documented default. `build/` is git-ignored, so output there is correct.
    expect(outputProblem(join(projectRoot, "build/production/client/auth"), projectRoot)).toBeUndefined();
    expect(outputProblem(join(projectRoot, "build/production/client/live-cli"), projectRoot)).toBeUndefined();
  });

  test("a path inside the repository that Git does not ignore is refused", () => {
    // Regression: an ad-hoc probe ran with `--output x`, and because a gate writes a
    // profile, an archive, cookies and a serve log, the checkout grew 1682 untracked
    // files under `x/`. The verdict comes from git, not from the folder's name.
    const problem = outputProblem(join(projectRoot, "x"), projectRoot);
    expect(problem).toContain("does not ignore");
  });

  test("the ignored .scratch tree is allowed", () => {
    // It is git-ignored and it is where this repository keeps gate evidence, so a run
    // there leaves the checkout clean.
    expect(outputProblem(join(projectRoot, ".scratch/production-cycle/run"), projectRoot)).toBeUndefined();
  });

  test("a path outside the repository is allowed", () => {
    expect(outputProblem(join(scratch(), "outside-run"), projectRoot)).toBeUndefined();
  });

  test("an ordinary directory is accepted", () => {
    const parent = scratch();
    const output = join(parent, "gate");
    mkdirSync(output);
    expect(outputProblem(output, projectRoot)).toBeUndefined();
  });

  test("a directory that does not exist yet is accepted", () => {
    // The gate creates its own output; requiring it to pre-exist would be a
    // gratuitous prerequisite.
    expect(outputProblem(join(scratch(), "not-yet"), projectRoot)).toBeUndefined();
  });
});

describe("a run root is unique, contained, and only this run can remove it", () => {
  test("each call gets a different directory under the output", () => {
    const output = join(scratch(), "gate");
    const first = createRunRoot(output, "serve");
    const second = createRunRoot(output, "serve");
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.path.startsWith(output)).toBe(true);
      expect(existsSync(first.path)).toBe(true);
      expect(existsSync(second.path)).toBe(true);
    } finally {
      first.remove();
      second.remove();
    }
  });

  test("a fresh run root carries no handoff from an earlier run", () => {
    // This is the property the old `rmSync` was reaching for. It holds by
    // construction now: the directory did not exist before this call.
    const output = join(scratch(), "gate");
    const earlier = createRunRoot(output, "serve");
    writeFileSync(join(earlier.path, "connection.json"), '{"origin":"http://127.0.0.1:1"}');
    const later = createRunRoot(output, "serve");
    try {
      expect(existsSync(join(later.path, "connection.json"))).toBe(false);
    } finally {
      earlier.remove();
      later.remove();
    }
  });

  test("removing a run root leaves the caller's own output and siblings intact", () => {
    const output = join(scratch(), "gate");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "keep.txt"), "caller's file");
    expect(existsSync(join(output, "keep.txt"))).toBe(true);
    const root = createRunRoot(output, "serve");
    writeFileSync(join(root.path, "connection.json"), "{}");
    root.remove();
    expect(existsSync(root.path)).toBe(false);
    expect(readdirSync(output)).toContain("keep.txt");
  });

  test("removal never removes the output directory itself", () => {
    const output = join(scratch(), "gate");
    const root = createRunRoot(output, "serve");
    root.remove();
    expect(existsSync(output)).toBe(true);
  });
});
