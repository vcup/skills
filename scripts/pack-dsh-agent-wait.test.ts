import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SUPPORTED_DSH_VERSIONS } from "../adapters/dsh-agent-wait/meta.ts";
import { PACKAGE_NAME, PACKAGE_VERSION, TOOL_NAME } from "../adapters/dsh-agent-wait/meta.ts";
import {
  assertNoCrossPathTokens,
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
    await mkdir(stagingDir, { recursive: true });
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
