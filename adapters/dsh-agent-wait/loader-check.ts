#!/usr/bin/env bun
/**
 * Real-Loader verification for the packed DSH subagent-wait plugin.
 *
 * This is **not** a unit test and not part of `bun test`: it boots the
 * published `@deepseek-ai/dsh-app-boot` Loader against a real `cordis.yml` and
 * exercises the installed package through the public services.
 *
 * Resolution is explicit and unmixed, mirroring the reviewer's native
 * scaffold:
 *
 *   DSH_WAIT_RUNTIME   directory of a full isolated DSH install (rc.4 or rc.5
 *                      with the @deepseek-ai/* runtime, typescript, @types/node)
 *   DSH_WAIT_PACKAGE   the installed package to mount — a bare package name that
 *                      resolves from DSH_WAIT_RUNTIME's node_modules (the
 *                      maintained Make gate installs the tgz there first), or an
 *                      absolute path to the packed `index.js`.
 *   DSH_WAIT_TMP       scratch directory for temporary artifacts
 *
 * The composition is the real minimal native stack the plugin's `inject`
 * requires — `tools`, `subagents`, `agents`, plus the agent loop, sessions,
 * persistence, session query, the local filesystem, and the working directory.
 *
 * What this proves is limited and stated honestly: the published Loader loads
 * this package and the `wait_subagents` tool is registered and reachable, and a
 * call without a live calling agent is refused with the plugin's own
 * `WAIT_UNAVAILABLE` guard. It does **not** run a real subagent start/end pair
 * (that needs a deterministic LLM adapter and a subagent provider, which the
 * independent runtime reviewer exercises against the packed tgz); this file is
 * the scoped gate, not the whole acceptance.
 *
 * Every check prints `PASS <name>` or `FAIL <name>: <detail>`; the process exits
 * 1 if any check failed.
 *
 * @module adapters/dsh-agent-wait/loader-check
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { boot } from "@deepseek-ai/dsh-app-boot";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";

const runtime = resolve(process.env.DSH_WAIT_RUNTIME ?? "");
if (runtime === "" || process.env.DSH_WAIT_RUNTIME === undefined) {
  console.error("DSH_WAIT_RUNTIME must name a full isolated DSH install directory");
  process.exit(2);
}
const packageSpec = process.env.DSH_WAIT_PACKAGE ?? "dsh-agent-wait";
const requireBase = createRequire(join(runtime, "package.json"));

const failures: string[] = [];

function check(condition: boolean, name: string, detail = ""): void {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`FAIL ${name}${detail === "" ? "" : `: ${detail}`}`);
}

/** Resolve one runtime package from the full install; a file path is used as-is. */
function resolvePackage(name: string): string {
  if (name.startsWith("/") || name.startsWith("file:")) return name;
  return requireBase.resolve(name);
}

/** The real minimal native stack the plugin needs, in Loader order. */
function baseRows(root: string): Record<string, unknown>[] {
  const modules: readonly string[] = [
    "llm",
    "session",
    "agent",
    "system-prompt",
    "tools",
    "tool-executor-native",
    "session-projection",
    "agent-loop",
    "fs-local",
    "working-directory",
    "session-query-sqlite",
    "session-persistence-jsonl",
    "subagent",
    "subagent-spawn-in-process",
  ];
  const configs: Record<string, Record<string, unknown>> = {
    "session-persistence-jsonl": { root: join(root, "sessions") },
    "agent-loop": { agents: [] },
    "fs-local": { cwd: root },
    "working-directory": { defaultDirectory: root },
    "session-query-sqlite": { path: ":memory:", openAt: "never" },
    "subagent-spawn-in-process": { providerName: "spawn" },
  };
  return modules.map((name) => ({
    id: name,
    name: resolvePackage(`@deepseek-ai/dsh-${name}`),
    ...(configs[name] === undefined ? {} : { config: configs[name] }),
  }));
}

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

async function callTool(ctx: Context, id: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await ctx.tools.execute({
    calls: [{ type: "tool-call", id: id as never, name: "wait_subagents", arguments: JSON.stringify(args) }],
    signal: AbortSignal.timeout(15000),
  });
  const settled = result.results[0];
  if (settled === undefined) return { text: "", isError: true };
  const text = settled.result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return { text, isError: settled.result.isError };
}

async function main(): Promise<void> {
  const scratch = resolve(process.env.DSH_WAIT_TMP ?? join(runtime, ".wait-check"));
  await mkdir(scratch, { recursive: true });
  await mkdir(join(scratch, "sessions"), { recursive: true });

  const pluginRow = packageSpec.startsWith("/")
    ? pathToFileURL(packageSpec).href
    : resolvePackage(packageSpec);
  const rows = [...baseRows(scratch), { id: "agent-wait", name: pluginRow }];
  const configPath = join(scratch, "cordis.yml");
  await writeFile(configPath, `${rows.map((row) => `- ${JSON.stringify(row)}`).join("\n")}\n`);
  const ctx = await boot("wait-loader-check", configPath);

  const definition = ctx.tools.get("wait_subagents");
  check(definition !== undefined, "tool wait_subagents is registered");
  const parameters = definition?.parameters as
    | { properties?: Record<string, unknown> }
    | undefined;
  check(parameters?.properties?.agents !== undefined, "tool declares an `agents` parameter");
  check(parameters?.properties?.timeout_ms !== undefined, "tool declares a `timeout_ms` parameter");

  // Without a live calling agent the tool must refuse, not silently proceed.
  const noAgent = await callTool(ctx, "no-agent", {});
  check(noAgent.isError, "a call without a calling agent is refused");
  check(noAgent.text.includes("requires a calling agent"), "the refusal names the missing calling agent", noAgent.text);

  await ctx.fiber.dispose();
  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
