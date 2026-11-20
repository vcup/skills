/**
 * Interface tests for `scripts/check-docs.py`.
 *
 * These drive the real Python checker as a subprocess against throwaway fixture
 * copies of this repository. The checker is the committed one, Python is the
 * real interpreter, and every assertion is about exit status and output — not
 * about a hand-written list of files.
 *
 * The adversarial cases matter more than the happy path: package READMEs must
 * be resolved against the *installed package* tree (not their source folder),
 * both packages must catch broken artifact-relative links, and a broken
 * derivation must fail loudly instead of silently resolving zero links.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED = new Set([".git", "node_modules", "build", ".scratch"]);

let workspace: string;

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) {
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
}

/** Fresh fixture per test: a complete repo copy, so derived trees are real. */
async function fixture(): Promise<string> {
  const dir = join(workspace, `case-${Math.random().toString(36).slice(2)}`);
  await copyTree(REPO_ROOT, dir);
  return dir;
}

function runDocs(root: string): { code: number; out: string } {
  const result = spawnSync("python3", ["scripts/check-docs.py"], {
    cwd: root, encoding: "utf8", env: { ...process.env },
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function appendFile(path: string, text: string): Promise<void> {
  await writeFile(path, `${await readFile(path, "utf8")}\n${text}\n`, "utf8");
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "check-docs-test-"));
  await mkdir(workspace, { recursive: true });
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("coverage and newly covered docs", () => {
  test("a broken relative link in a newly covered doc makes the checker red", async () => {
    const root = await fixture();
    expect(runDocs(root).code).toBe(0);
    await appendFile(join(root, "docs/DEVELOPMENT.md"),
      "[bad link](does-not-exist-red-fixture.md)");
    const after = runDocs(root);
    expect(after.code).toBe(1);
    expect(after.out).toContain("docs/DEVELOPMENT.md: missing does-not-exist-red-fixture.md");
  });

  test("a nonexistent heading anchor makes the checker red", async () => {
    const root = await fixture();
    await appendFile(join(root, "adapters/dsh/README.md"),
      "[bad anchor](#no-such-heading-red-fixture)");
    const after = runDocs(root);
    expect(after.code).toBe(1);
    expect(after.out).toContain("adapters/dsh/README.md: unresolved heading #no-such-heading-red-fixture");
  });
});

describe("package README artifact-relative link seam", () => {
  test("OMP: valid installed-package links pass, broken artifact link fails", async () => {
    const root = await fixture();
    // The real link is already present and must NOT false-positive even though
    // adapters/omp/package/skills/ensemble/STATE-TEMPLATE.md does not exist.
    const green = runDocs(root);
    expect(green.code).toBe(0);
    expect(green.out).toContain("Checked");
    await appendFile(join(root, "adapters/omp/package/README.md"),
      "[broken artifact link](skills/ensemble/NO-SUCH-FILE.md)");
    const red = runDocs(root);
    expect(red.code).toBe(1);
    expect(red.out).toContain("adapters/omp/package/README.md: missing in installed package: skills/ensemble/NO-SUCH-FILE.md");
  });

  test("DSH: a broken link in the packaged README is caught in the installed tree", async () => {
    const root = await fixture();
    expect(runDocs(root).code).toBe(0);
    await appendFile(join(root, "adapters/dsh/package-readme.md"),
      "[broken DSH artifact link](skills/ensemble/NOT-A-RESOURCE.md)");
    const red = runDocs(root);
    expect(red.code).toBe(1);
    expect(red.out).toContain("adapters/dsh/package-readme.md: missing in installed package: skills/ensemble/NOT-A-RESOURCE.md");
  });

  test("DSH: a valid installed-resource link does not false-positive", async () => {
    const root = await fixture();
    await appendFile(join(root, "adapters/dsh/package-readme.md"),
      "[valid reference](skills/ensemble/STATE-TEMPLATE.md)");
    expect(runDocs(root).code).toBe(0);
  });
});

describe("private-path links and fail-closed derivation", () => {
  test("a private absolute path link fails", async () => {
    const root = await fixture();
    await appendFile(join(root, "docs/DEVELOPMENT.md"),
      "[private](/tmp/private-fixture/should-not-be-a-doc.md)");
    const red = runDocs(root);
    expect(red.code).toBe(1);
    expect(red.out).toMatch(/docs\/DEVELOPMENT\.md: (nonportable absolute link|link depends on private files): \/tmp\/private-fixture\/should-not-be-a-doc\.md/);
  });

  test("an unparseable DSH meta.ts fails the checker instead of silently passing", async () => {
    const root = await fixture();
    const metaPath = join(root, "adapters/dsh/meta.ts");
    const meta = await readFile(metaPath, "utf8");
    // Remove the declaration the package-tree derivation reads; a real refactor
    // that changes it must not quietly resolve zero DSH package links.
    await writeFile(metaPath, meta.replace(
      /export const REFERENCE_RESOURCES = \[[\s\S]*?\] as const;/,
      "const REFERENCE_RESOURCES_REMOVED_BY_FIXTURE = [];",
    ), "utf8");
    const red = runDocs(root);
    expect(red.code).toBe(1);
    expect(red.out).toContain("package manifest error");
    expect(red.out).toContain("REFERENCE_RESOURCES");
  });

  test("an empty built-file derivation fails the checker instead of silently passing", async () => {
    const root = await fixture();
    const builderPath = join(root, "scripts/build-ensemble.ts");
    const builder = await readFile(builderPath, "utf8");
    const stripped = builder.replace(/function spec\([\s\S]*?\n\}/,
      "function spec(_target: Target): TargetSpec {\n  return { outDir: \"x\", outputs: [] };\n}");
    expect(stripped).not.toBe(builder);
    await writeFile(builderPath, stripped, "utf8");
    const red = runDocs(root);
    expect(red.code).toBe(1);
    expect(red.out).toContain("package manifest error");
  });
});
