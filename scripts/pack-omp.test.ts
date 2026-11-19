import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTarball, packOmp } from "./pack-omp";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pack-omp-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/**
 * The repository root, one level above `scripts/`.
 */
const REPO = join(import.meta.dir, "..");

describe("packOmp", () => {
  test("stages the expected package tree", async () => {
    const out = await temporaryRoot();
    const result = await packOmp({ root: REPO, stagingRoot: join(out, "staging"), outputDir: join(out, "out"), pack: false });

    expect(result.name).toBe("@vcup/skills");
    expect(result.files.map(file => file.path).sort()).toEqual([
      "README.md",
      "agents/ensemble-reviewer.md",
      "agents/ensemble-scout.md",
      "agents/ensemble-worker.md",
      "omp-extension/index.ts",
      "package.json",
      "skills/always/SKILL.md",
      "skills/edit-commit-msg/SKILL.md",
      "skills/ensemble/EVOLUTION-TEMPLATE.md",
      "skills/ensemble/GLOSSARY.md",
      "skills/ensemble/PATTERNS.md",
      "skills/ensemble/README.md",
      "skills/ensemble/SKILL.md",
      "skills/ensemble/STATE-TEMPLATE.md",
    ]);
  });

  test("the staged ensemble skill is the OMP artifact, not the pure-skill one", async () => {
    const out = await temporaryRoot();
    const result = await packOmp({ root: REPO, stagingRoot: join(out, "staging"), outputDir: join(out, "out"), pack: false });
    const staged = await readFile(join(result.stagingRoot, "skills/ensemble/SKILL.md"), "utf8");

    // OMP-path markers survive.
    expect(staged).toContain("ensemble_state");
    expect(staged).toContain(".ensemble/<NNN>-<invocation-slug>/STATE.md");
    expect(staged).toContain("001");
    expect(staged).toContain("999");
    expect(staged).toContain("symlink");
    expect(staged).toContain("one state writer at a time");
    // Other paths do not.
    expect(staged).not.toContain("npx skills");
    expect(staged).not.toContain("vcup/skills");
    expect(staged).not.toContain("ensemble_reference");
  });

  test("roles and the extension are copied byte for byte", async () => {
    const out = await temporaryRoot();
    const result = await packOmp({ root: REPO, stagingRoot: join(out, "staging"), outputDir: join(out, "out"), pack: false });

    const pairs: [string, string][] = [
      ["agents/ensemble-scout.md", "agents/ensemble-scout.md"],
      ["agents/ensemble-reviewer.md", "agents/ensemble-reviewer.md"],
      ["agents/ensemble-worker.md", "agents/ensemble-worker.md"],
      ["skills/always/SKILL.md", "skills/always/SKILL.md"],
      ["skills/edit-commit-msg/SKILL.md", "skills/edit-commit-msg/SKILL.md"],
      ["adapters/omp/index.ts", "omp-extension/index.ts"],
    ];
    for (const [source, packaged] of pairs) {
      const original = await readFile(join(REPO, source));
      const staged = await readFile(join(result.stagingRoot, packaged));
      expect(staged.equals(original)).toBe(true);
    }
  });

  test("every staged file matches the reported digest and length", async () => {
    const out = await temporaryRoot();
    const result = await packOmp({ root: REPO, stagingRoot: join(out, "staging"), outputDir: join(out, "out"), pack: false });

    for (const file of result.files) {
      const staged = await readFile(join(result.stagingRoot, file.path));
      expect(staged.byteLength).toBe(file.bytes);
      expect(staged.length).toBe(file.bytes);
    }
  });

  test("the tarball contains the package and nothing from the mother repository", async () => {
    const out = await temporaryRoot();
    const result = await packOmp({ root: REPO, stagingRoot: join(out, "staging"), outputDir: join(out, "out") });

    expect(result.tarball).not.toBeNull();
    const entries = (await listTarball(result.tarball!)).sort();
    expect(entries).toEqual(result.files.map(file => file.path).sort());

    for (const forbidden of ["content/", "scripts/", ".git", "build/", "docs/", "adapters/omp/index.ts"]) {
      expect(entries.some(entry => entry.startsWith(forbidden))).toBe(false);
    }
  });

  /**
   * A writable copy of the maintained sources, so a test can break one of
   * them and observe the packer's refusal.
   */
  async function fixtureRoot(): Promise<string> {
    const root = await temporaryRoot();
    for (const dir of ["content", "skills/always", "skills/edit-commit-msg", "agents", "adapters/omp"]) {
      await cp(join(REPO, dir), join(root, dir), { recursive: true });
    }
    return root;
  }

  test("rejects a source tree whose role mentions another path's installer", async () => {
    const source = await fixtureRoot();
    await writeFile(
      join(source, "agents", "ensemble-scout.md"),
      "---\nname: ensemble-scout\ndescription: d\nautoloadSkills: [ensemble]\n---\n\nUse npx skills to install.\n",
    );

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/pure-skill installer command/);
  });

  test("rejects a README that tells the user to install the tarball", async () => {
    const source = await fixtureRoot();
    await writeFile(
      join(source, "adapters/omp/package/README.md"),
      "# Package\n\n```bash\nomp install ./build/pack/omp/vcup-skills-0.2.0.tgz\n```\n",
    );

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/tarball install command unsupported/);
  });

  test("rejects a README that points at a source-repository-only script", async () => {
    const source = await fixtureRoot();
    await writeFile(
      join(source, "adapters/omp/package/README.md"),
      "# Package\n\nRun `bun scripts/pack-omp.ts` first, then `omp install .`.\n",
    );

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/path that only exists in the source repository/);
  });

  test("rejects a role that names a path-bound tool category", async () => {
    const source = await fixtureRoot();
    await writeFile(
      join(source, "agents", "ensemble-worker.md"),
      "---\nname: ensemble-worker\ndescription: d\n---\n\nUse managed domain tools when available.\n",
    );

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/path-bound tool category/);
  });

  test("rejects a role that autoloads a skill the package does not ship", async () => {
    const source = await fixtureRoot();
    await writeFile(
      join(source, "agents", "ensemble-scout.md"),
      "---\nname: ensemble-scout\ndescription: d\nautoloadSkills: [missing-skill]\n---\n\nbody\n",
    );

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/autoloadSkills names an unknown skill/);
  });

  test("rejects a package manifest whose allowlist omits a packaged path", async () => {
    const source = await fixtureRoot();
    await writeFile(join(source, "adapters/omp/package/package.json"), JSON.stringify({
      name: "@vcup/skills",
      version: "0.0.0",
      files: ["skills/"],
      omp: { extensions: ["./omp-extension/index.ts"] },
    }));

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/files allowlist does not cover/);
  });

  test("rejects a package manifest that renames the package", async () => {
    const source = await fixtureRoot();
    const manifest = JSON.parse(await readFile(join(source, "adapters/omp/package/package.json"), "utf8")) as {
      name: string;
    };
    manifest.name = "@vcup/other";
    await writeFile(join(source, "adapters/omp/package/package.json"), JSON.stringify(manifest));

    await expect(
      packOmp({ root: source, stagingRoot: join(source, "out/staging"), outputDir: join(source, "out"), pack: false }),
    ).rejects.toThrow(/name must be @vcup\/skills/);
  });
});
