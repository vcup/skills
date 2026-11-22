#!/usr/bin/env bun
/** Reproducible, offline native acceptance. Never writes into a supplied runtime. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION, SUPPORTED_DSH_VERSIONS } from "../adapters/dsh-agent-wait/meta.ts";
import { pack } from "./pack-dsh-agent-wait.ts";

export interface VerifyOptions { runtimes: string[]; tarball?: string }
export function parseArguments(args: readonly string[]): VerifyOptions {
  const options: VerifyOptions = { runtimes: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== "--runtime" && flag !== "--package") throw new Error(`unknown argument: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a path`);
    if (flag === "--runtime") options.runtimes.push(resolve(value));
    else {
      if (options.tarball !== undefined) throw new Error("--package may only be supplied once");
      options.tarball = resolve(value);
    }
  }
  if (!options.runtimes.length) throw new Error("at least one --runtime <isolated-install-dir> is required");
  if (new Set(options.runtimes).size !== options.runtimes.length) throw new Error("duplicate runtime path");
  return options;
}

export async function runtimeVersion(runtime: string): Promise<string> {
  const path = join(runtime, "node_modules/@deepseek-ai/dsh/package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !(SUPPORTED_DSH_VERSIONS as readonly string[]).includes(manifest.version)) {
    throw new Error(`unsupported DSH runtime ${String(manifest.version)}; expected ${SUPPORTED_DSH_VERSIONS.join(" or ")}`);
  }
  return manifest.version;
}

/** Capture output without exposing any URL tokens a future runtime might print. */
export function redact(text: string): string {
  return text.replace(/([?&](?:token|key|secret)=)[^\s&#]+/gi, "$1<REDACTED>")
    .replace(/(authorization|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi, "$1$2<REDACTED>");
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function run(label: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  // Child timeouts are guards, not success: an exit 124/nonzero always fails the gate.
  const child = Bun.spawn(["timeout", "90s", ...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const log = redact(stdout + stderr);
  await writeFile(join(cwd, `${label}.log`), log);
  console.log(`${label}: exit ${exit}`);
  if (exit !== 0) throw new Error(`${label} failed\n${log}`);
}

export async function verify(options: VerifyOptions): Promise<string> {
  // Validate every input before creating profiles, invoking pnpm, or packing.
  const versions = await Promise.all(options.runtimes.map(runtimeVersion));
  if (options.tarball !== undefined && !existsSync(options.tarball)) throw new Error("--package does not exist");
  const root = await mkdtemp(join(tmpdir(), "dsh-wait-native-"));
  console.log(`evidence: ${root}`);
  const tarball = options.tarball ?? (await pack({ stagingDir: join(root, "package") })).tarball;
  const hash = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const results: { runtime: string; version: string; status: string }[] = [];
  for (const [index, runtime] of options.runtimes.entries()) {
    const lane = join(root, `runtime-${index}`);
    const home = join(lane, "home");
    await mkdir(home, { recursive: true });
    await mkdir(join(lane, "tmp"));
    const env = {
      ...process.env, DSH_HOME: home, PNPM_HOME: join(lane, "pnpm"), TMPDIR: join(lane, "tmp"),
      DSH_TELEMETRY_DISABLED: "1", WAIT_RUNTIME: await realpath(runtime), WAIT_PROFILE_HOME: home,
      WAIT_PACKAGE: join(home, "profiles/web/node_modules", PACKAGE_NAME, "index.js"),
      WAIT_EXPECT_VERSION: PACKAGE_VERSION, WAIT_FIXTURE: join(lane, "native"),
    };
    const cli = join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");
    // Standard DSH CLI is load-bearing: it projects shared-instance dependencies
    // and installs the bundle layer. Plain pnpm/npm add is NOT an equivalent.
    await run("install", ["node", cli, "plugin", "--profile", "web", "add", tarball, "--offline"], env, lane);
    await run("list", ["node", cli, "plugin", "--profile", "web", "list"], env, lane);
    await run("native", ["node", join(ROOT, "adapters/dsh-agent-wait/native/check.mjs")], env, lane);
    const patch = join(lane, "cli.patch.yml");
    await writeFile(patch, `- insert:\n    - ${JSON.stringify({ id: "wait-native-scenario", name: join(ROOT, "adapters/dsh-agent-wait/native/cli.mjs") })}\n`);
    await run("cli", ["node", cli, "--profile", "web", "--patch", patch, "--no-open", "--port", "0"], { ...env, WAIT_FIXTURE: join(lane, "cli") }, lane);
    await run("remove", ["node", cli, "plugin", "--profile", "web", "remove", PACKAGE_NAME, "--offline"], env, lane);
    if (existsSync(env.WAIT_PACKAGE)) throw new Error("remove left the wait package installed");
    results.push({ runtime, version: versions[index]!, status: "PASS" });
  }
  await writeFile(join(root, "result.json"), JSON.stringify({ package: PACKAGE_NAME, version: PACKAGE_VERSION, tarball, sha256: hash, results }, null, 2) + "\n");
  console.log(`PASS native matrix (${results.length} runtime(s)); sha256 ${hash}`);
  return root;
}

if (import.meta.main) {
  let options: VerifyOptions;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) { console.error(String(error)); console.error("usage: bun scripts/verify-dsh-wait.ts --runtime <install> [--runtime <install>] [--package <tgz>]"); process.exit(2); }
  try { await verify(options); }
  catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
}
