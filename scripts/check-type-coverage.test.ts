#!/usr/bin/env bun
/**
 * Regression for type discovery when Git cannot answer.
 *
 * ## The failure this pins
 *
 * `make check` ran `check-type-coverage.ts` inside a tree with no `.git` (the Makefile
 * tests build their fixture that way, and so does an exported source tree). There,
 * `git ls-files -co --exclude-standard` can exit 0 with **empty output** rather than
 * failing. The gate read that as "this repository maintains no TypeScript files",
 * printed `no maintained TypeScript files found; the discovery rule is wrong.` and exited
 * 2 — which failed `make check`, and with it `package-check`, `all` and `make -j8 all`.
 *
 * The discovery already had a filesystem-walk fallback; the bug was that an empty answer
 * never reached it. So the test is about **which authority produced the list**, not about
 * a copy of the rule: a fixture with no `.git` must still enumerate real files.
 *
 * ## Why the fixture is built as described, and not hand-shaped
 *
 * The fixture is a real directory containing real `.ts` files plus the ignored trees that
 * must be skipped, created under `.scratch/` (ignored, so the test leaves no untracked
 * files in the checkout). Nothing about discovery is re-implemented here: the function is
 * called and its answer is inspected.
 *
 * @module scripts/check-type-coverage.test
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { maintained, maintainedFiles } from "./check-type-coverage";

const repoRoot = resolve(import.meta.dir, "..");

/** A directory with no `.git`, holding source files and the trees that must be skipped. */
function gitlessFixture(): { root: string; cleanup: () => void } {
  // Under `.scratch/` on purpose: it is git-ignored, so a fixture here never appears as an
  // untracked file in the checkout. The fixture itself deliberately has no `.git`.
  //
  // `.scratch/` is created first because it is *not* guaranteed to exist. `makefile.test.ts`
  // builds its fixture skipping `.scratch`, so inside that fixture `join(root, ".scratch", …)`
  // had no parent and `mkdtempSync` threw ENOENT — green in a normal checkout, red in the
  // fixture, which is the whole door. Creating the parent makes the fixture independent of
  // whether anything has ever written there.
  const scratchRoot = join(repoRoot, ".scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "type-coverage-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "adapters/dsh"), { recursive: true });
  mkdirSync(join(root, "node_modules/vendor"), { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(join(root, ".scratch"), { recursive: true });
  writeFileSync(join(root, "src/keep.ts"), "export const keep = 1;\n");
  writeFileSync(join(root, "adapters/dsh/keep-too.mts"), "export const also = 2;\n");
  writeFileSync(join(root, "src/keep.test.ts"), "// a test file is still maintained source\n");
  // These must never be reported: build output, vendor code, scratch, and declarations
  // that published packages ship themselves.
  writeFileSync(join(root, "node_modules/vendor/index.ts"), "export const vendor = 0;\n");
  writeFileSync(join(root, "build/emitted.ts"), "export const emitted = 0;\n");
  writeFileSync(join(root, ".scratch/temp.ts"), "export const temp = 0;\n");
  writeFileSync(join(root, "src/shipped.d.ts"), "declare const shipped: number;\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("maintained file classification", () => {
  test("TypeScript source is maintained, including .mts and tests", () => {
    for (const path of ["src/keep.ts", "adapters/dsh/keep-too.mts", "src/keep.test.ts", "scripts/x.tsx"]) {
      expect(maintained(path)).toBe(true);
    }
  });

  test("build output, vendor code, scratch and shipped declarations are not", () => {
    for (const path of [
      "node_modules/vendor/index.ts",
      "build/emitted.ts",
      ".scratch/temp.ts",
      "src/shipped.d.ts",
      "README.md",
    ]) {
      expect(maintained(path)).toBe(false);
    }
  });
});

describe("discovery when git cannot answer", () => {
  test("this checkout with git reports the maintained files it contains", () => {
    // The normal path: git answers, so the list must include a file that certainly exists.
    const files = maintainedFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("scripts/check-type-coverage.ts");
    // Nothing from the ignored trees may appear, whatever git or the walk produced.
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("build/"))).toBe(false);
    expect(files.some((file) => file.startsWith(".scratch/"))).toBe(false);
  });

  test("a tree with no .git still enumerates source instead of reporting none", () => {
    // The regression proper. A gitless tree is exactly the Makefile-test fixture; before
    // the fix this produced `[]`, the gate said "the discovery rule is wrong", and the
    // whole offline chain failed.
    const fixture = gitlessFixture();
    try {
      const files = maintainedFiles(fixture.root);
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain("src/keep.ts");
      expect(files).toContain("adapters/dsh/keep-too.mts");
      expect(files).toContain("src/keep.test.ts");
    } finally {
      fixture.cleanup();
    }
  });

  test("the gitless walk skips build, node_modules, scratch and shipped declarations", () => {
    const fixture = gitlessFixture();
    try {
      const files = maintainedFiles(fixture.root);
      // The point of a fallback is that it applies the same exclusions, not different ones.
      expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
      expect(files.some((file) => file.startsWith("build/"))).toBe(false);
      expect(files.some((file) => file.startsWith(".scratch/"))).toBe(false);
      expect(files.some((file) => file.endsWith(".d.ts"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
