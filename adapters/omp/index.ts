import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STATE_PATH = /^\.ensemble\/\d{3}-[a-z0-9][a-z0-9-]*\/STATE\.md$/;

export async function writeEnsembleState(cwd: string, path: string, content: string): Promise<void> {
  if (!STATE_PATH.test(path)) {
    throw new Error("path must match .ensemble/<NNN>-<slug>/STATE.md");
  }

  const root = resolve(cwd, ".ensemble");
  const target = resolve(cwd, path);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error("path escapes .ensemble");
  }

  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) {
    throw new Error(".ensemble must not be a symbolic link");
  }

  const invocation = dirname(target);
  await mkdir(invocation, { recursive: true });
  if ((await lstat(invocation)).isSymbolicLink()) {
    throw new Error("invocation directory must not be a symbolic link");
  }

  const realRoot = await realpath(root);
  const realInvocation = await realpath(invocation);
  if (!realInvocation.startsWith(`${realRoot}${sep}`)) {
    throw new Error("invocation directory escapes .ensemble");
  }

  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export default function ensembleAdapter(pi: ExtensionAPI): void {
  const { Type } = pi.typebox;

  pi.registerTool({
    name: "ensemble_state",
    label: "Ensemble State",
    description: "Atomically write an ensemble invocation STATE.md inside the current repository.",
    approval: "write",
    parameters: Type.Object({
      path: Type.String({ description: ".ensemble/<NNN>-<slug>/STATE.md" }),
      content: Type.String({ description: "Complete replacement Markdown for STATE.md" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }] };
      }
      await writeEnsembleState(ctx.cwd, params.path, params.content);

      return {
        content: [{ type: "text", text: `Updated ${params.path}` }],
        details: { path: params.path },
      };
    },
  });
}
