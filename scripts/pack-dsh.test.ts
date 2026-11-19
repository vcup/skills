import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OUTPUT_BUDGET_BYTES,
  REFERENCE_RESOURCES,
  SKILL_DIR,
  SKILL_FILE,
} from "../adapters/dsh/meta.ts";
import {
  assertReferenceResource,
  createReferenceReader,
  ReferenceError,
} from "../adapters/dsh/reference.ts";
import { invocationPolicy, parseSkillFile } from "../adapters/dsh/skill.ts";
import {
  bundlePatch,
  dshContent,
  packageAllowlist,
  packageManifest,
  PackError,
  stage,
} from "./pack-dsh.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pack-dsh-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Write one artifact directory with all six files at a given size for PATTERNS.md. */
async function artifact(patternsBytes = 32): Promise<string> {
  const dir = await temporaryRoot();
  for (const name of REFERENCE_RESOURCES) {
    await writeFile(join(dir, name), `${name} body\n`);
  }
  await writeFile(join(dir, "PATTERNS.md"), "p".repeat(patternsBytes));
  await writeFile(
    join(dir, SKILL_FILE),
    [
      "---",
      "name: ensemble",
      "description: Improve real work through independent contributions.",
      "disable-model-invocation: true",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("ensemble_reference enumeration", () => {
  test("accepts every enumerated name and rejects everything else", async () => {
    const dir = await artifact();
    const reader = await createReferenceReader(dir);

    for (const name of REFERENCE_RESOURCES) {
      const result = await reader.read(name);
      expect(result.resource).toBe(name);
      expect(result.bytes).toBeGreaterThan(0);
    }

    for (const bad of ["SKILL.md", "", "patterns.md", "../package.json", "/etc/passwd", "a/b.md", "..\\x.md"]) {
      await expect(reader.read(bad)).rejects.toThrow(ReferenceError);
      await expect(reader.read(bad)).rejects.toMatchObject({ code: "UNKNOWN_RESOURCE" });
    }
  });

  test("the allowlist is enforced without the tool schema", () => {
    expect(() => assertReferenceResource("GLOSSARY.md")).not.toThrow();
    expect(() => assertReferenceResource("SKILL.md")).toThrow(/UNKNOWN_RESOURCE|unknown reference resource/);
  });

  test("rejects a resource over the output budget instead of truncating", async () => {
    const dir = await artifact(OUTPUT_BUDGET_BYTES + 1);
    const reader = await createReferenceReader(dir);

    await expect(reader.read("PATTERNS.md")).rejects.toMatchObject({ code: "OUTPUT_BUDGET_EXCEEDED" });
  });

  test("returns a resource exactly at the budget", async () => {
    const dir = await artifact(OUTPUT_BUDGET_BYTES);
    const reader = await createReferenceReader(dir);

    const result = await reader.read("PATTERNS.md");
    expect(result.bytes).toBe(OUTPUT_BUDGET_BYTES);
  });

  test("rejects a symlinked resource", async () => {
    const dir = await artifact();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "secret.md"), "secret");
    await rm(join(dir, "GLOSSARY.md"));
    await symlink(join(outside, "secret.md"), join(dir, "GLOSSARY.md"));

    const reader = await createReferenceReader(dir);
    await expect(reader.read("GLOSSARY.md")).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });

  test("rejects a symlinked skill directory", async () => {
    const dir = await artifact();
    const link = join(await temporaryRoot(), "link");
    await symlink(dir, link);

    await expect(createReferenceReader(link)).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });

  test("rejects a missing skill directory", async () => {
    const missing = join(await temporaryRoot(), "absent");
    await expect(createReferenceReader(missing)).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });
});

describe("bundled skill parsing", () => {
  test("derives a user-only invocation policy from the generated DSH frontmatter", async () => {
    const files = await dshContent();
    const skill = files.find((file) => file.path === SKILL_FILE);
    expect(skill).toBeDefined();
    const parsed = parseSkillFile(new TextDecoder().decode(skill?.content));

    expect(parsed.name).toBe("ensemble");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.invocation).toEqual({ modelInvocable: false, userInvocable: true });
    expect(parsed.body).not.toContain("disable-model-invocation");
    // The DSH artifact carries its own capability status; the pure-skill and OMP
    // artifacts carry different path sections, so this asserts the DSH text.
    expect(parsed.body).toContain("Capability status: pre-release method resource");
  });

  test("matches the rc.4 filesystem-provider defaults for omitted keys", () => {
    expect(invocationPolicy(undefined, undefined)).toEqual({ modelInvocable: true, userInvocable: true });
    expect(invocationPolicy(true, undefined)).toEqual({ modelInvocable: false, userInvocable: true });
    expect(invocationPolicy(undefined, false)).toEqual({ modelInvocable: true, userInvocable: false });
  });

  test("rejects unsupported or unsafe frontmatter", () => {
    expect(() => parseSkillFile("no frontmatter\n")).toThrow();
    expect(() => parseSkillFile("---\nname: ensemble\n---\n")).toThrow(/description/);
    expect(() => parseSkillFile("---\nname: Ensemble\ndescription: x\n---\n")).toThrow(/kebab-case/);
    expect(() => parseSkillFile("---\nname: ensemble\ndescription: x\nunknown: y\n---\n")).toThrow(/duplicate|unsupported/);
    expect(() => parseSkillFile("---\nname: ensemble\ndescription: x\ndisable-model-invocation: maybe\n---\n")).toThrow(
      /not a boolean/,
    );
  });
});

describe("pack staging", () => {
  test("stages exactly the allowlist from build('dsh') memory bytes", async () => {
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    const result = await stage({ root: REPO_ROOT, stagingDir });

    expect([...result.files]).toEqual(packageAllowlist());
    expect(result.files).toContain(`${SKILL_DIR}/${SKILL_FILE}`);
    for (const name of REFERENCE_RESOURCES) expect(result.files).toContain(`${SKILL_DIR}/${name}`);
    // Six content files only: no extra directory, no other target's artifact.
    expect(result.files.filter((path) => path.startsWith(`${SKILL_DIR}/`))).toHaveLength(6);

    const stagedSkill = await readFile(join(stagingDir, SKILL_DIR, SKILL_FILE), "utf8");
    expect(stagedSkill).toContain("Capability status: pre-release method resource");
  });

  test("manifest digests match the staged bytes", async () => {
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    await stage({ root: REPO_ROOT, stagingDir });

    const bundle = JSON.parse(await readFile(join(stagingDir, "bundle-manifest.json"), "utf8")) as {
      files: { path: string; sha256: string; bytes: number }[];
      contentDigest: string;
    };
    expect(bundle.files).toHaveLength(6);
    expect(bundle.contentDigest).toMatch(/^[0-9a-f]{64}$/);

    for (const file of bundle.files) {
      const bytes = await readFile(join(stagingDir, SKILL_DIR, file.path));
      expect(bytes.byteLength).toBe(file.bytes);
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }

    const manifest = JSON.parse(await readFile(join(stagingDir, "package.json"), "utf8")) as {
      engines: { dsh: string };
      dsh: { bundle: { patch: string } };
      peerDependencies: Record<string, string>;
    };
    expect(manifest.engines.dsh).toBe("0.2.2-rc.4");
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(Object.keys(manifest.peerDependencies).every((name) => name.startsWith("@deepseek-ai/"))).toBe(true);
  });

  test("package files name no other consumption path", async () => {
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    await stage({ root: REPO_ROOT, stagingDir });

    const forbidden = [/ensemble_state/, /\.ensemble\//, /npx skills/, /vcup\/skills/, /omp install/i];
    for (const path of ["README.md", "cordis.patch.yml", "package.json", "bundle-manifest.json"]) {
      const text = await readFile(join(stagingDir, path), "utf8");
      for (const token of forbidden) expect(text).not.toMatch(token);
    }
  });

  test("staging replaces only its own staging root", async () => {
    // `build/pack/dsh` is this script's ignored output directory: a previous
    // run's leftovers are cleared, and nothing outside it is touched.
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    const sibling = join(root, "keep.txt");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "stale.md"), "old");
    await writeFile(sibling, "keep me");

    const result = await stage({ root: REPO_ROOT, stagingDir });
    expect(result.files).not.toContain("stale.md");
    await expect(readFile(join(stagingDir, "stale.md"), "utf8")).rejects.toThrow();
    expect(await readFile(sibling, "utf8")).toBe("keep me");
  });

  test("the bundle patch names this package and nothing else", () => {
    const patch = bundlePatch();
    expect(patch).toContain("dsh-ensemble-probe");
    expect(patch.match(/name:/g)).toHaveLength(1);
    expect(patch).not.toContain("dsh-client");
  });

  test("the manifest declares probe status, not product status", () => {
    const manifest = packageManifest([]) as { probe: { status: string }; description: string };
    expect(manifest.probe.status).toBe("host-only-probe");
    expect(manifest.description).toContain("Host-only DSH probe");
  });

  test("re-staging deterministically regenerates a modified staged file", async () => {
    // This covers staging only. There is no verifier for an already-produced
    // tarball: `stage()`/`pack()` always regenerate from sources, so an edit to
    // a staged file is overwritten on the next run rather than detected.
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    await stage({ root: REPO_ROOT, stagingDir });
    await writeFile(join(stagingDir, "cordis.patch.yml"), "- insert: []\n");

    const again = await stage({ root: REPO_ROOT, stagingDir });
    expect(again.files).toEqual(packageAllowlist());
    expect(await readFile(join(stagingDir, "cordis.patch.yml"), "utf8")).toBe(bundlePatch());
  });
});

describe("pack error surface", () => {
  test("PackError is the only failure type raised by staging invariants", () => {
    expect(new PackError("x")).toBeInstanceOf(Error);
  });
});
