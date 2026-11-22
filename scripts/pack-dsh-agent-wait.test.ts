import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SUPPORTED_DSH_VERSIONS } from "../adapters/dsh-agent-wait/meta.ts";
import { PACKAGE_NAME, PACKAGE_VERSION, TOOL_NAME } from "../adapters/dsh-agent-wait/meta.ts";
import {
  assertNoCrossPathTokens,
  assertStagingDirectory,
  bundlePatch,
  packageAllowlist,
  packageManifest,
  stage,
} from "./pack-dsh-agent-wait.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pack-dsh-agent-wait-"));
  roots.push(root);
  return root;
}

describe("package allowlist", () => {
  test("stages exactly the declared files, nothing discovered", async () => {
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    const result = await stage({ root: REPO_ROOT, stagingDir });

    expect([...result.files]).toEqual(packageAllowlist());
    expect(result.files).toContain("index.js");
    expect(result.files).toContain("README.md");
    expect(result.files).toContain("package.json");
    expect(result.files).toContain("cordis.patch.yml");
    expect(result.files).toContain("bundle-manifest.json");
  });
});

describe("manifest", () => {
  test("derives engines.dsh from the one supported set", () => {
    const manifest = packageManifest() as {
      engines: { dsh: string };
      peerDependencies: Record<string, string>;
      name: string;
      version: string;
      dsh: { bundle: { patch: string } };
    };
    expect(manifest.name).toBe(PACKAGE_NAME);
    expect(manifest.version).toBe(PACKAGE_VERSION);
    expect(manifest.version).toBe("1.0.0");
    expect(packageManifest()).not.toHaveProperty("probe");
    expect(packageManifest()).not.toHaveProperty("private");
    expect(packageManifest()).toHaveProperty("engines.node", ">=24.9.0");
    expect(packageManifest()).toHaveProperty("repository.url", "git+https://github.com/vcup/skills.git");
    expect(manifest.engines.dsh).toBe(SUPPORTED_DSH_VERSIONS.join(" || "));
    expect(manifest.engines.dsh).not.toMatch(/[><^~]|\*|latest/);
    expect(manifest.peerDependencies["@deepseek-ai/dsh-tools"]).toBe(manifest.engines.dsh);
    expect(manifest.peerDependencies["@deepseek-ai/dsh-subagent"]).toBe(manifest.engines.dsh);
    expect(manifest.peerDependencies["@deepseek-ai/dsh-agent"]).toBe(manifest.engines.dsh);
    expect(manifest.peerDependencies["@deepseek-ai/cordis"]).toBe("~4.1.0");
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(Object.keys(manifest.peerDependencies).every((n) => n.startsWith("@deepseek-ai/"))).toBe(true);
  });
});

describe("bundle patch", () => {
  test("names this package and registers the wait tool", () => {
    const patch = bundlePatch();
    expect(patch).toContain(PACKAGE_NAME);
    expect(patch).toContain("agent-wait");
    expect(patch.match(/name:/g)).toHaveLength(1);
    expect(patch).not.toContain("dsh-ensemble-probe");
    expect(patch).not.toContain("dsh-client");
  });
});

describe("cross-path tokens", () => {
  test("refuses another consumption path's tokens", () => {
    expect(() => assertNoCrossPathTokens("README.md", "install with omp install")).toThrow(/omp install/);
    expect(() => assertNoCrossPathTokens("package.json", "dsh-ensemble-probe")).toThrow(/dsh-ensemble-probe/);
  });

  test("accepts a clean package readme", () => {
    const clean = `# ${PACKAGE_NAME}\n\nUses ${TOOL_NAME}.`;
    expect(() => assertNoCrossPathTokens("README.md", clean)).not.toThrow();
  });
});

describe("staging", () => {
  test("replaces only its own staging root", async () => {
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    const sibling = join(root, "keep.txt");
    await stage({ root: REPO_ROOT, stagingDir });
    await writeFile(join(stagingDir, "stale.md"), "old");
    await writeFile(sibling, "keep me");

    const result = await stage({ root: REPO_ROOT, stagingDir });
    expect(result.files).not.toContain("stale.md");
    await expect(readFile(join(stagingDir, "stale.md"), "utf8")).rejects.toThrow();
    expect(await readFile(sibling, "utf8")).toBe("keep me");
  });

  test("the staged README is self-contained (no repository path)", async () => {
    const root = await temporaryRoot();
    const stagingDir = join(root, "stage");
    await stage({ root: REPO_ROOT, stagingDir });
    const readme = await readFile(join(stagingDir, "README.md"), "utf8");
    expect(readme).toContain(TOOL_NAME);
    expect(readme).not.toMatch(/vcup\/skills|adapters\/|scripts\//);
  });
});


describe("staging refusal", () => {
  test("refuses a nonempty directory without the package marker without deleting data", async () => {
    const stagingDir = await temporaryRoot();
    await writeFile(join(stagingDir, "keep.txt"), "irreplaceable");
    await expect(stage({ root: REPO_ROOT, stagingDir })).rejects.toThrow(/nonempty/);
    expect(await readFile(join(stagingDir, "keep.txt"), "utf8")).toBe("irreplaceable");
  });

  test("refuses the repository, its ancestor, and its source directories", async () => {
    const root = join(await temporaryRoot(), "repo");
    await mkdir(join(root, "adapters/dsh-agent-wait"), { recursive: true });
    for (const stagingDir of [root, resolve(root, ".."), join(root, "adapters/dsh-agent-wait")]) {
      await expect(assertStagingDirectory(root, stagingDir)).rejects.toThrow(/staging/);
    }
  });

  test("refuses a parent symlink before creating or removing output", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "keep.txt"), "keep");
    await symlink(join(root, "real"), join(root, "alias"));
    await expect(stage({ root: REPO_ROOT, stagingDir: join(root, "alias", "out") })).rejects.toThrow(/symlink/);
    expect(await readFile(join(root, "real", "keep.txt"), "utf8")).toBe("keep");
  });
});


test("repeated staging produces identical installed source and manifests", async () => {
  const root = await temporaryRoot();
  const first = await stage({ stagingDir: join(root, "first") });
  const second = await stage({ stagingDir: join(root, "second") });
  for (const file of packageAllowlist()) {
    expect(await readFile(join(first.stagingDir, file), "utf8")).toBe(await readFile(join(second.stagingDir, file), "utf8"));
  }
});


test("external checkout beside the emit directory still packs deterministically", async () => {
  const checkout = await temporaryRoot();
  await mkdir(join(checkout, "scripts"));
  await mkdir(join(checkout, "adapters/dsh-agent-wait"), { recursive: true });
  for (const file of ["scripts/pack-dsh-agent-wait.ts", ...["index.ts", "meta.ts", "wait.ts", "package-readme.md"].map(name => `adapters/dsh-agent-wait/${name}`)]) {
    await copyFile(join(REPO_ROOT, file), join(checkout, file));
  }
  await symlink(join(REPO_ROOT, "node_modules"), join(checkout, "node_modules"));
  const script = `import { stage } from "./scripts/pack-dsh-agent-wait.ts";
    import { readFile } from "node:fs/promises";
    const first = await stage();
    const before = await readFile(first.stagingDir + "/index.js", "utf8");
    const second = await stage();
    const after = await readFile(second.stagingDir + "/index.js", "utf8");
    if (before !== after || before.includes("pack-dsh-agent-wait-emit-")) throw new Error("nondeterministic emit path leaked");`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: checkout, env: { ...process.env, TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
