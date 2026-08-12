import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEnsembleState } from "./index";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeEnsembleState", () => {
  test("atomically replaces a valid invocation state", async () => {
    const root = await temporaryRoot();
    const path = ".ensemble/001-test/STATE.md";

    await writeEnsembleState(root, path, "first");
    await writeEnsembleState(root, path, "second");

    expect(await readFile(join(root, path), "utf8")).toBe("second");
  });

  test("rejects paths outside the invocation state shape", async () => {
    const root = await temporaryRoot();

    await expect(writeEnsembleState(root, "../STATE.md", "bad")).rejects.toThrow(
      "path must match .ensemble/<NNN>-<slug>/STATE.md",
    );
  });

  test("rejects a symlinked state root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, ".ensemble"));

    await expect(writeEnsembleState(root, ".ensemble/001-test/STATE.md", "bad")).rejects.toThrow(
      ".ensemble must not be a symbolic link",
    );
  });

  test("rejects a symlinked invocation directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, ".ensemble"));
    await symlink(outside, join(root, ".ensemble/001-test"));

    await expect(writeEnsembleState(root, ".ensemble/001-test/STATE.md", "bad")).rejects.toThrow(
      "invocation directory must not be a symbolic link",
    );
  });
});
