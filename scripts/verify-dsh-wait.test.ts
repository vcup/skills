import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArguments, redact, runtimeVersion } from "./verify-dsh-wait.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("native gate requires explicit runtimes and rejects ambiguous CLI input", () => {
  for (const args of [[], ["--runtime"], ["--runtim", "/tmp/runtime"], ["--runtime", "--package"], ["--runtime", "/x", "--runtime", "/x"], ["--runtime", "/x", "--package", "/a", "--package", "/b"]]) {
    expect(() => parseArguments(args)).toThrow();
  }
  expect(parseArguments(["--runtime", "runtime with spaces", "--package", "a.tgz"])).toEqual({ runtimes: [resolve("runtime with spaces")], tarball: resolve("a.tgz") });
});

test("actual runtime version must belong to wait's exact supported set", async () => {
  const root = await mkdtemp(join(tmpdir(), "wait-gate-input-")); roots.push(root);
  const path = join(root, "node_modules/@deepseek-ai/dsh");
  await mkdir(path, { recursive: true });
  for (const version of ["0.2.2-rc.4", "0.2.2-rc.5"]) {
    await writeFile(join(path, "package.json"), JSON.stringify({ version }));
    expect(await runtimeVersion(root)).toBe(version);
  }
  for (const version of ["0.2.2-rc.6", "0.2.2", "latest", null]) {
    await writeFile(join(path, "package.json"), JSON.stringify({ version }));
    await expect(runtimeVersion(root)).rejects.toThrow(/unsupported/);
  }
});

test("CLI log redaction removes URL credentials and cookie headers", () => {
  const output = redact("http://localhost:1/?token=private-value&next=x\nCookie: session=private-value\nAuthorization: Bearer private-value\nPASS native");
  expect(output).not.toContain("private-value");
  expect(output).toContain("<REDACTED>");
  expect(output).toContain("PASS native");
});
