/** Proof that the descriptor pin (not the pathname) is what confines a child.
 * The identity guard is deliberately not involved here: this exercises the same sandbox the kernel
 * uses, with rule/cwd pointing at a pinned descriptor, while the pathname is swapped underneath. */
import { describe, expect, test } from "bun:test";
import { constants, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIsolatedGroup } from "../archive.ts";
const install = process.env.DSH_ARCHIVE_SEAM_INSTALL;
const native = install ? describe : describe.skip;
const signal = () => new AbortController().signal;
function fixture() { const dir = resolve(".scratch/production-cycle"); mkdirSync(dir, { recursive: true }); return mkdtempSync(join(dir, "kernel-desc-")); }

async function group() {
  const root = resolve(install!);
  const load = (n: string) => import(join(root, "node_modules/@deepseek-ai", n, "lib/index.js"));
  const [{ Context }, { LocalSubprocessRuntime }, { LocalSandboxProvider }] = await Promise.all([
    load("cordis"), load("dsh-subprocess-local"), load("dsh-sandbox-local")]);
  return buildIsolatedGroup(new Context() as never, {
    subprocess: (c: unknown) => new LocalSubprocessRuntime(c as never),
    sandbox: (c: unknown) => new LocalSandboxProvider(c as never, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }),
  });
}
async function writeThrough(workspaceRoot: string, cwd: string, name: string): Promise<{ code: number | null; stderr: string }> {
  const g = await group();
  // The seam's confine() takes only mode+workspaceRoot: extra writable roots are not part of it.
  const wrap = await g.sandbox.confine(["/bin/sh", "-c", `echo PAYLOAD > ${name}; echo rc=$?`], { mode: "workspace-write", workspaceRoot });
  const handle = g.subprocess.spawn({
    argv: wrap.argv, cwd,
    stdio: { stdin: "ignore", stdout: "collect", stderr: "collect" },
    graceMs: 1000,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workspaceRoot, TMPDIR: workspaceRoot },
  });
  const done = await handle.done;
  // Collect mode returns an offset reader, not a string and not an async iterable.
  const stderr = handle.collected.stderr.readFrom(0).text;
  return { code: done.exitCode, stderr };
}

native("descriptor pin vs path rule, same sandbox", () => {
  test("path rule+cwd lets a swapped symlink redirect the write into the victim", async () => {
    const base = fixture();
    const victim = join(base, "victim"); mkdirSync(victim, { mode: 0o700 }); writeFileSync(join(victim, "keep.txt"), "VICTIM");
    const archive = join(base, "archive"); mkdirSync(archive, { mode: 0o700 });
    renameSync(archive, `${archive}-moved`); symlinkSync(victim, archive, "dir");
    await writeThrough(archive, archive, "payload.txt");
    // Documents the vulnerability this design closes: the victim received the file.
    expect(readdirSync(victim).sort()).toEqual(["keep.txt", "payload.txt"]);
    unlinkSync(archive); renameSync(`${archive}-moved`, archive);
  }, 20000);
  test("descriptor rule+cwd keeps the write in the pinned inode when the path is swapped", async () => {
    const base = fixture();
    const victim = join(base, "victim"); mkdirSync(victim, { mode: 0o700 }); writeFileSync(join(victim, "keep.txt"), "VICTIM");
    const archive = join(base, "archive"); mkdirSync(archive, { mode: 0o700 });
    const fd = openSync(archive, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pin = `/proc/self/fd/${fd}`;
    try {
      renameSync(archive, `${archive}-moved`); symlinkSync(victim, archive, "dir");
      await writeThrough(pin, pin, "payload.txt");
      // The victim is untouched and the pinned (original) inode received the write.
      expect(readdirSync(victim)).toEqual(["keep.txt"]);
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("VICTIM");
      expect(readdirSync(pin).sort()).toEqual(["payload.txt"]);
    } finally { closeSync(fd); unlinkSync(archive); renameSync(`${archive}-moved`, archive); }
  }, 20000);
});
