import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyClean,
  cleanPlan,
  doctor,
  inspectArtifacts,
  stagingStatus,
  validateInstallDir,
  type Probe,
} from "./project-tasks";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "project-tasks-"));
}

/** A probe that reports exactly the tools named, and nothing else. */
function fakeProbe(present: readonly string[], output = "1.0.0"): Probe {
  return (command) => {
    const name = command.split("/").pop() ?? command;
    return present.includes(name) ? { ok: true, output } : { ok: false, output: "" };
  };
}

describe("doctor", () => {
  test("passes when the default offline path can run", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "node_modules/typescript/bin"), { recursive: true });
    await writeFile(join(root, "node_modules/typescript/bin/tsc"), "");

    const report = doctor(root, fakeProbe(["bun", "python3"]));
    expect(report.ok).toBe(true);
    expect(report.missingRequired).toEqual([]);
    // Optional tools are reported, not fatal.
    expect(report.missingOptional).toContain("omp");
    expect(report.lines.join("\n")).toContain("default path: ok");

    await rm(root, { recursive: true, force: true });
  });

  test("fails and names what is blocked when bun is absent", async () => {
    const root = await temporaryRoot();
    const report = doctor(root, fakeProbe(["python3"]));

    expect(report.ok).toBe(false);
    expect(report.missingRequired).toContain("bun");
    const text = report.lines.join("\n");
    expect(text).toContain("MISSING bun");
    expect(text).toContain("blocks: check, test");
    expect(text).toContain("default path: BLOCKED by bun");

    await rm(root, { recursive: true, force: true });
  });

  test("treats missing dependencies as blocking, not as a pass", async () => {
    const root = await temporaryRoot();
    const report = doctor(root, fakeProbe(["bun", "python3"]));

    expect(report.ok).toBe(false);
    const text = report.lines.join("\n");
    expect(text).toContain("MISSING node_modules/");
    expect(text).toContain("make setup");
    // The fix is named, and it is the only target that installs anything.
    expect(text).not.toContain("bun install");

    await rm(root, { recursive: true, force: true });
  });

  test("reports absent artifacts as normal, never as drift", async () => {
    const root = await temporaryRoot();
    const report = doctor(root, fakeProbe(["bun", "python3"]));
    const text = report.lines.join("\n");

    expect(text).toContain("absent");
    expect(text).toContain("make content-build TARGET=omp");
    expect(text).toContain("make pack-omp");
    expect(text).not.toContain("drift");

    await rm(root, { recursive: true, force: true });
  });
});

describe("stagingStatus", () => {
  test("the committed skill path needs no staging", () => {
    const status = stagingStatus("skill", "/nonexistent");
    expect(status.ok).toBe(true);
    expect(status.message).toContain("committed artifact");
  });

  test("reports an unbuilt generated path as unbuilt, not as drift", async () => {
    const root = await temporaryRoot();
    const status = stagingStatus("omp", root);

    expect(status.ok).toBe(false);
    expect(status.message).toContain("has not been built");
    expect(status.message).toContain("not drift");
    expect(status.message).toContain("make content-build TARGET=omp");

    await rm(root, { recursive: true, force: true });
  });

  test("accepts an existing staging directory", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "build/ensemble/dsh"), { recursive: true });

    expect(stagingStatus("dsh", root).ok).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("rejects an unknown path instead of guessing", () => {
    expect(stagingStatus("dsh2", "/nonexistent").ok).toBe(false);
    expect(stagingStatus("dsh2", "/nonexistent").message).toContain("unknown content path");
  });
});

describe("inspectArtifacts", () => {
  test("says nothing has been packed when there is no build tree", async () => {
    const root = await temporaryRoot();
    const result = inspectArtifacts(root, fakeProbe(["tar"]));

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("make pack");
    await rm(root, { recursive: true, force: true });
  });

  test("lists each tarball through tar and reports a tar failure", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "build/pack/omp"), { recursive: true });
    await writeFile(join(root, "build/pack/omp/pkg-0.1.0.tgz"), "not really a tarball");

    const ok = inspectArtifacts(root, fakeProbe(["tar"]));
    expect(ok.ok).toBe(true);
    expect(ok.lines[0]).toContain("pkg-0.1.0.tgz");

    const broken = inspectArtifacts(root, () => ({ ok: false, output: "" }));
    expect(broken.ok).toBe(false);
    expect(broken.lines.join("\n")).toContain("is tar installed?");

    await rm(root, { recursive: true, force: true });
  });
});

describe("validateInstallDir", () => {
  test("rejects a missing directory with the path it looked at", async () => {
    const missing = join(tmpdir(), "definitely-not-here-1f2e3d");
    const report = validateInstallDir(missing);

    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("does not exist");
    expect(report.problems[0]).toContain(missing);
  });

  test("rejects a directory that is not an isolated DSH install", async () => {
    const root = await temporaryRoot();
    const report = validateInstallDir(root);

    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("no @deepseek-ai/dsh-skill");
    // The message names the tested set and the default, so the maintainer knows
    // what to install instead of guessing a version.
    expect(report.problems.join("\n")).toContain("0.2.2-rc.4");
    expect(report.problems.join("\n")).toContain("0.2.2-rc.5");
    await rm(root, { recursive: true, force: true });
  });

  test("accepts both tested releases, not only the default one", async () => {
    for (const version of ["0.2.2-rc.4", "0.2.2-rc.5"]) {
      const root = await temporaryRoot();
      await mkdir(join(root, "node_modules/@deepseek-ai/dsh-skill"), { recursive: true });
      await writeFile(join(root, "node_modules/@deepseek-ai/dsh-skill/package.json"), `{"version":"${version}"}`);

      const report = validateInstallDir(root);
      expect(report.ok).toBe(true);
      expect(report.release).toBe(version);

      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an untested DSH version rather than silently accepting it", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "node_modules/@deepseek-ai/dsh-skill"), { recursive: true });
    await writeFile(join(root, "node_modules/@deepseek-ai/dsh-skill/package.json"), '{"version":"0.2.2-rc.6"}');

    const report = validateInstallDir(root);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("outside the tested DSH set");
    expect(report.problems.join("\n")).toContain("0.2.2-rc.6");

    await rm(root, { recursive: true, force: true });
  });

  test("rejects a mixed install: two DSH packages at different releases", async () => {
    const root = await temporaryRoot();
    for (const [name, version] of [
      ["@deepseek-ai/dsh-skill", "0.2.2-rc.4"],
      ["@deepseek-ai/dsh-tools", "0.2.2-rc.5"],
    ] as const) {
      await mkdir(join(root, "node_modules", name), { recursive: true });
      await writeFile(join(root, "node_modules", name, "package.json"), `{"version":"${version}"}`);
    }

    const report = validateInstallDir(root);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("mixed DSH releases");
    // A mixed install has no single release, so nothing may be reported as one.
    expect(report.release).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  test("needs types only when asked: the Loader gate does not require tsc", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "node_modules/@deepseek-ai/dsh-skill"), { recursive: true });
    await writeFile(join(root, "node_modules/@deepseek-ai/dsh-skill/package.json"), '{"version":"0.2.2-rc.4"}');

    expect(validateInstallDir(root).ok).toBe(true);
    expect(validateInstallDir(root, { requireTypes: true }).ok).toBe(false);
    expect(validateInstallDir(root, { requireTypes: true }).problems.join("\n")).toContain("no typescript");

    await rm(root, { recursive: true, force: true });
  });

  test("accepts a complete pinned install", async () => {
    const root = await temporaryRoot();
    for (const path of ["@deepseek-ai/dsh-skill/package.json", "typescript/bin/tsc", "@types/node/package.json"]) {
      await mkdir(join(root, "node_modules", path, ".."), { recursive: true });
      await writeFile(join(root, "node_modules", path), path.endsWith("package.json") ? '{"version":"0.2.2-rc.4"}' : "");
    }

    expect(validateInstallDir(root, { requireTypes: true }).ok).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});

describe("cleanPlan", () => {
  test("plans only build/ by default, and never node_modules", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "build/ensemble"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });

    const plan = cleanPlan({ root });
    expect(plan.remove).toEqual([join(root, "build")]);
    expect(plan.refused).toEqual([]);

    await rm(root, { recursive: true, force: true });
  });

  test("includes node_modules only with all", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "build"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });

    const plan = cleanPlan({ root, all: true });
    expect(plan.remove).toEqual([join(root, "build"), join(root, "node_modules")]);

    await rm(root, { recursive: true, force: true });
  });

  test("refuses a symlinked build directory instead of following it", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "precious.txt"), "keep me");
    await symlink(outside, join(root, "build"));

    const plan = cleanPlan({ root });
    expect(plan.remove).toEqual([]);
    expect(plan.refused.join("\n")).toContain("symbolic link");
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("refuses build/ when it holds Git-tracked files", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build/tracked.txt"), "source");

    const plan = cleanPlan({ root, trackedFiles: () => ["build/tracked.txt"] });
    expect(plan.remove).toEqual([]);
    expect(plan.refused.join("\n")).toContain("Git-tracked");
    expect(plan.refused.join("\n")).toContain("build/tracked.txt");

    await rm(root, { recursive: true, force: true });
  });

  test("refuses a build path that is a file, not a directory", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "build"), "not a directory");

    const plan = cleanPlan({ root });
    expect(plan.remove).toEqual([]);
    expect(plan.refused.join("\n")).toContain("not a directory");

    await rm(root, { recursive: true, force: true });
  });

  test("does nothing when there is nothing to remove", async () => {
    const root = await temporaryRoot();
    const plan = cleanPlan({ root, all: true });

    expect(plan.remove).toEqual([]);
    expect(plan.refused).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("applyClean removes exactly the planned paths and nothing else", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "build/deep/nested"), { recursive: true });
    await writeFile(join(root, "keep.txt"), "keep");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const removed = await applyClean(cleanPlan({ root }));
    expect(removed).toEqual([join(root, "build")]);
    expect(existsSync(join(root, "build"))).toBe(false);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});
