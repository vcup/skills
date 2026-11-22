/**
 * Host type gate for the DSH subagent-wait plugin.
 *
 * The plugin entry (`index.ts`) imports `@deepseek-ai/*`, which are not root
 * dependencies, so it is checked against a real isolated DSH install exactly
 * like `adapters/dsh/typecheck-host.ts` does for the ensemble probe. The two
 * programs are deliberately separate: this package's tsconfig and module set
 * are its own, so a change in one plugin cannot loosen the other's gate.
 *
 * Usage:
 *   bun adapters/dsh-agent-wait/typecheck-host.ts <isolated-install-dir>
 *
 * The install directory must contain `node_modules/typescript/bin/tsc`,
 * `@types/node`, and the published `@deepseek-ai/*` packages for one of the
 * supported DSH releases.
 *
 * @module adapters/dsh-agent-wait/typecheck-host
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_DSH_VERSIONS, supportedVersionsText } from "./meta.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const installDir = resolve(process.argv[2] ?? "");
  if (installDir === "" || process.argv[2] === undefined) {
    console.error("usage: bun adapters/dsh-agent-wait/typecheck-host.ts <isolated-install-dir>");
    process.exit(2);
  }
  const host = JSON.parse(await readFile(join(installDir, "node_modules/@deepseek-ai/dsh/package.json"), "utf8")) as { version: string };
  if (!(SUPPORTED_DSH_VERSIONS as readonly string[]).includes(host.version)) {
    throw new Error(`unsupported DSH ${host.version}; expected ${supportedVersionsText()}`);
  }
  const tsc = join(installDir, "node_modules/typescript/bin/tsc");
  if (!existsSync(tsc)) {
    console.error(`no typescript at ${tsc}; install one of ${supportedVersionsText()} plus typescript@5.9 and @types/node@24 first`);
    process.exit(2);
  }

  const scratch = await mkdtemp(join(tmpdir(), "dsh-agent-wait-host-"));
  try {
    // Copy exactly the runtime module closure. No writes to the install.
    await mkdir(join(scratch, "dsh-agent-wait"), { recursive: true });
    for (const name of ["index.ts", "meta.ts", "wait.ts"]) {
      await copyFile(join(HERE, name), join(scratch, "dsh-agent-wait", name));
    }
    await mkdir(join(scratch, "node_modules"), { recursive: true });

    const ln = Bun.spawnSync(
      ["ln", "-s", join(installDir, "node_modules", "@deepseek-ai"), join(scratch, "node_modules", "@deepseek-ai")],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (ln.exitCode !== 0) {
      console.error(`could not link @deepseek-ai from ${installDir}: ${ln.stderr.toString()}`);
      process.exit(2);
    }
    const atTypes = join(installDir, "node_modules", "@types");
    if (existsSync(atTypes)) {
      const lnTypes = Bun.spawnSync(
        ["ln", "-s", atTypes, join(scratch, "node_modules", "@types")],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (lnTypes.exitCode !== 0) {
        console.error(`could not link @types from ${installDir}: ${lnTypes.stderr.toString()}`);
        process.exit(2);
      }
    }

    await copyFile(join(HERE, "tsconfig.host.json"), join(scratch, "dsh-agent-wait/tsconfig.host.json"));

    const tscProc = Bun.spawnSync(
      [process.execPath, tsc, "-p", join(scratch, "dsh-agent-wait/tsconfig.host.json")],
      { cwd: scratch, stdout: "pipe", stderr: "pipe" },
    );
    if (tscProc.exitCode !== 0) {
      console.error(tscProc.stderr.toString() || tscProc.stdout.toString());
      process.exit(1);
    }
    console.log(`dsh-agent-wait typecheck ok (actual DSH ${host.version})`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
