import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build, check, TARGETS, write, type Target } from "./build-ensemble";

const repoRoot = resolve(import.meta.dir, "..");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-build-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Copy the maintained sources into a throwaway repository root. */
async function fixtureRoot(): Promise<string> {
  const root = await temporaryRoot();
  await cp(join(repoRoot, "content"), join(root, "content"), { recursive: true });
  return root;
}

async function readText(root: string, relPath: string): Promise<string> {
  return await readFile(join(root, relPath), "utf8");
}

async function sourcePath(root: string, target: Target, name: string): Promise<string> {
  return join(root, "content/ensemble", target, name);
}

describe("build", () => {
  test("assembles exactly the allowlisted files for each target", async () => {
    for (const target of TARGETS) {
      const result = await build(target);
      expect(result.target).toBe(target);
      expect(result.files.map((file) => file.path)).toEqual([
        "EVOLUTION-TEMPLATE.md",
        "GLOSSARY.md",
        "PATTERNS.md",
        "README.md",
        "SKILL.md",
        "STATE-TEMPLATE.md",
      ]);
    }
  });

  test("is deterministic: same sources produce identical bytes and manifest", async () => {
    for (const target of TARGETS) {
      const first = await build(target);
      const second = await build(target);
      expect(second.manifest).toBe(first.manifest);
      expect(second.files.map((file) => [file.path, file.sha256])).toEqual(
        first.files.map((file) => [file.path, file.sha256]),
      );
    }
  });

  test("exposes assembled bytes on BuildFile.content with a matching sha256 and length", async () => {
    const result = await build("skill");
    for (const file of result.files) {
      expect(file.content).toBeInstanceOf(Uint8Array);
      expect(file.bytes).toBe(file.content.byteLength);
      const digest = new Bun.CryptoHasher("sha256").update(file.content).digest("hex");
      expect(file.sha256).toBe(digest);
    }
  });

  test("keeps the manifest free of file contents and stable in shape", async () => {
    const result = await build("dsh");
    const manifest = JSON.parse(result.manifest);
    expect(manifest.target).toBe("dsh");
    expect(manifest.files).toHaveLength(6);
    for (const entry of manifest.files) {
      expect(Object.keys(entry).sort()).toEqual(["bytes", "path", "sha256"]);
    }
  });

  test("every artifact opens with an H1 title after frontmatter", async () => {
    // Regression: `check` only proves source->artifact consistency, so a source
    // edit can silently drop a structural element like the title. Assert the
    // shape directly rather than relying on the source being right.
    //
    // Only the *opening* line is asserted: PATTERNS.md legitimately uses `#`
    // for its section structure, and STATE-TEMPLATE.md shows a `# Ensemble: ...`
    // line inside a fenced sample, so counting H1s across the file would be wrong.
    for (const target of TARGETS) {
      const result = await build(target);
      for (const file of result.files) {
        const text = new TextDecoder().decode(file.content);
        const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\n+/, "");
        const firstLine = body.split("\n")[0];
        expect({ file: file.path, opensWithH1: /^# \S/.test(firstLine) }).toEqual({
          file: file.path,
          opensWithH1: true,
        });
      }
    }
  });

  test("the SKILL.md title is the skill name", async () => {
    for (const target of TARGETS) {
      const result = await build(target);
      const skill = new TextDecoder().decode(result.files.find((file) => file.path === "SKILL.md")!.content);
      expect(skill).toMatch(/^---\n[\s\S]*?\n---\n\n# Ensemble\n/);
    }
  });

  test("preserves the method's numbered steps and their headings", async () => {
    const result = await build("skill");
    const skill = result.files.find((file) => file.path === "SKILL.md");
    expect(skill).toBeDefined();
    const text = new TextDecoder().decode(skill!.content);
    for (const heading of [
      "## 1. Frame and prepare",
      "## 2. Compose result-changing attempts",
      "## 3. Produce and coach",
      "## 4. Decide by observation",
      "## 5. Evolve and verify",
      "## 6. Close and leave recoverable work",
      "## Records on this path",
    ]) {
      expect(text).toContain(heading);
    }
    // Independent attempts, evidence discipline, and the teaching boundary survive.
    expect(text).toContain("at least two independent attempts");
    expect(text).toContain("Separate observations, inferences, and decisions");
    expect(text).toContain("an acknowledged lesson is not demonstrated learning");
  });

  test("rejects unknown targets instead of guessing", async () => {
    for (const value of ["all", "dsh ", "", "Skill", "docs"]) {
      await expect(build(value as Target)).rejects.toThrow(/unknown target/);
    }
  });

  test("keeps outDir inside the repository so packers use the in-memory result", async () => {
    // Packers need an independent staging root. The builder does not write
    // outside the repository: they consume `files[].content` and write it
    // themselves. This is the contract, so it is asserted rather than implied.
    const outside = await temporaryRoot();
    for (const target of TARGETS) {
      await expect(build(target, { outDir: join(outside, "skills/ensemble") })).rejects.toThrow(
        /output directory escapes the repository root/,
      );
      await expect(write(target, { outDir: join(outside, "skills/ensemble") })).rejects.toThrow(
        /output directory escapes the repository root/,
      );
    }
    expect(await readdir(outside)).toEqual([]);
  });

  test("accepts an outDir inside the repository", async () => {
    const root = await fixtureRoot();
    const result = await build("dsh", { root, outDir: "custom/staging/skills/ensemble" });
    expect(result.outDir).toBe(join(root, "custom/staging/skills/ensemble"));
    expect(result.files).toHaveLength(6);
  });
});

describe("path isolation", () => {
  test("the pure skill artifact carries its own install command and no other path", async () => {
    const result = await build("skill");
    const all = result.files.map((file) => new TextDecoder().decode(file.content)).join("\n");
    expect(all).toContain("npx skills@latest add vcup/skills");
    expect(all).not.toMatch(/\bOMP\b/);
    expect(all).not.toMatch(/\bDSH\b/);
    expect(all).not.toContain("ensemble_state");
    expect(all).not.toContain(".ensemble/");
  });

  test("the OMP artifact documents its real state tool and no other path", async () => {
    const result = await build("omp");
    const all = result.files.map((file) => new TextDecoder().decode(file.content)).join("\n");
    expect(all).toContain("ensemble_state");
    expect(all).toContain(".ensemble/<NNN>-<invocation-slug>/STATE.md");
    expect(all).toContain("001");
    expect(all).not.toMatch(/\bDSH\b/);
    expect(all).not.toContain("npx skills");
    expect(all).not.toContain("vcup/skills");
  });

  test("the DSH artifact uses scoped domain tools and offers no file fallback", async () => {
    const result = await build("dsh");
    const all = result.files.map((file) => new TextDecoder().decode(file.content)).join("\n");
    expect(all).toContain("ensemble_work");
    expect(all).toContain("ensemble_learn");
    expect(all).toContain("ensemble_upload");
    expect(all).toContain("operation_id");
    expect(all).not.toContain("not implemented or accepted");
    expect(all).not.toMatch(/\bOMP\b/);
    expect(all).not.toContain("ensemble_state");
    expect(all).not.toContain(".ensemble/");
    expect(all).not.toContain("npx skills");
    expect(all).not.toContain("vcup/skills");
  });

  test("no artifact links into the maintainer repository's multi-path design docs", async () => {
    for (const target of TARGETS) {
      const result = await build(target);
      for (const file of result.files) {
        const text = new TextDecoder().decode(file.content);
        expect(text).not.toContain("github.com/vcup");
        expect(text).not.toContain("docs/ensemble");
      }
    }
  });

  test("the shared method states one records action instead of branching on the path", async () => {
    const result = await build("skill");
    const skill = new TextDecoder().decode(result.files.find((file) => file.path === "SKILL.md")!.content);
    // Neutral pointer to the path-specific section, not a conditional sentence.
    expect(skill).toContain("[Records on this path](#records-on-this-path)");
    for (const phrase of [
      /Where this path supplies/i,
      /Where it does not/i,
      /otherwise,? maintain/i,
      /with managed (?:archive|plugin|support)/i,
      /skill-only/i,
      /plugin-managed/i,
    ]) {
      expect(skill).not.toMatch(phrase);
    }
  });
});

describe("source validation", () => {
  test("fails when the shared method names a path-specific token", async () => {
    const root = await fixtureRoot();
    const path = join(root, "content/ensemble/common/GLOSSARY.md");
    await writeFile(path, `${await readFile(path, "utf8")}\nThe DSH adapter writes records.\n`);
    await expect(build("skill", { root })).rejects.toThrow(/path-specific or cross-path marker/);
  });

  test("fails when shared content branches on which path is running", async () => {
    const root = await fixtureRoot();
    const path = join(root, "content/ensemble/common/README.md");
    await writeFile(
      path,
      `${await readFile(path, "utf8")}\nWhere this path supplies managed publication, submit it. Otherwise maintain the file yourself.\n`,
    );
    await expect(build("skill", { root })).rejects.toThrow(/path-specific or cross-path marker/);
  });

  test("fails when a declared source is missing", async () => {
    const root = await fixtureRoot();
    await rm(join(root, "content/ensemble/omp/entry.operations.md"));
    await expect(build("omp", { root })).rejects.toThrow(/declared source is missing/);
  });

  test("fails when a source file is not on any allowlist", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "content/ensemble/omp/stray.md"), "unused\n");
    await expect(build("omp", { root })).rejects.toThrow(/not used by the omp allowlist/);
  });

  test("fails on a symbolic link anywhere in the source tree", async () => {
    const root = await fixtureRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "real.md"), "outside\n");
    await symlink(join(outside, "real.md"), join(root, "content/ensemble/common/intro.md.bak"));
    await expect(build("skill", { root })).rejects.toThrow(/symbolic link/);
  });

  test("fails when a link escapes the artifact", async () => {
    const root = await fixtureRoot();
    const path = join(root, "content/ensemble/skill/entry.operations.md");
    await writeFile(
      path,
      `${await readFile(path, "utf8")}\nSee [the design](../../../docs/ensemble/DISTRIBUTION.md).\n`,
    );
    await expect(build("skill", { root })).rejects.toThrow(/link escapes the artifact/);
  });

  test("fails when a link points at a file outside this artifact", async () => {
    const root = await fixtureRoot();
    const path = join(root, "content/ensemble/skill/entry.operations.md");
    await writeFile(path, `${await readFile(path, "utf8")}\nSee [missing](MISSING.md).\n`);
    await expect(build("skill", { root })).rejects.toThrow(/not part of this artifact/);
  });

  test("fails when a heading fragment does not exist in the target file", async () => {
    const root = await fixtureRoot();
    const path = join(root, "content/ensemble/skill/entry.operations.md");
    await writeFile(
      path,
      `${await readFile(path, "utf8")}\nSee [a missing heading](README.md#no-such-heading).\n`,
    );
    await expect(build("skill", { root })).rejects.toThrow(/does not match a heading/);
  });
});

describe("check", () => {
  test("reports the committed pure-skill artifact as up to date", async () => {
    const result = await check("skill");
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("detects a single-byte drift in a generated file", async () => {
    const root = await fixtureRoot();
    await write("skill", { root });
    const target = join(root, "skills/ensemble/SKILL.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original.replace("## 1. Frame and prepare", "## 1. Frame and prepare "));

    const result = await check("skill", { root });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/SKILL\.md: content drifted/);
  });

  test("reports a file that the artifact does not own", async () => {
    const root = await fixtureRoot();
    await write("skill", { root });
    await writeFile(join(root, "skills/ensemble/NOTES.md"), "hand-written\n");

    const result = await check("skill", { root });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/NOTES\.md: unexpected file/);
  });

  test("reports a missing file", async () => {
    const root = await fixtureRoot();
    await write("skill", { root });
    await rm(join(root, "skills/ensemble/GLOSSARY.md"));

    const result = await check("skill", { root });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/GLOSSARY\.md: missing/);
  });
});

describe("write", () => {
  test("creates the artifact and is idempotent", async () => {
    const root = await fixtureRoot();
    const first = await write("omp", { root });
    expect(first.written).toHaveLength(6);
    expect(first.removed).toEqual([]);

    const second = await write("omp", { root });
    expect(second.written).toHaveLength(6);
    expect((await check("omp", { root })).ok).toBe(true);
  });

  test("refuses to overwrite a file it does not own instead of deleting it", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "build/ensemble/dsh/skills/ensemble"), { recursive: true });
    const userFile = join(root, "build/ensemble/dsh/skills/ensemble/private-notes.md");
    await writeFile(userFile, "user data that must survive\n");

    await expect(write("dsh", { root })).rejects.toThrow(/not owned by this artifact/);
    // The user file is still there, byte for byte.
    expect(await readFile(userFile, "utf8")).toBe("user data that must survive\n");
    expect(await readdir(dirname(userFile))).not.toContain("SKILL.md");
  });

  test("refuses to write through a symlinked output directory", async () => {
    const root = await fixtureRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, "build/ensemble/dsh/skills"), { recursive: true });
    await symlink(outside, join(root, "build/ensemble/dsh/skills/ensemble"));

    await expect(write("dsh", { root })).rejects.toThrow(/symbolic link/);
  });
});
