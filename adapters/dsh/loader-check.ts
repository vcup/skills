#!/usr/bin/env bun
/**
 * Real-Loader verification for the packed DSH ensemble probe.
 *
 * This is **not** a unit test and not part of `bun test`: it boots the
 * published `@deepseek-ai/dsh-app-boot` Loader against a real `cordis.yml` and
 * exercises the installed package through the public services. It must run
 * from an installation that resolves the `@deepseek-ai/*` packages, i.e. the
 * isolated install where the packed tarball was added:
 *
 *   cp adapters/dsh/loader-check.ts "$DSH_PROBE_HOME/loader-check.ts"
 *   cd "$DSH_PROBE_HOME" && node loader-check.ts        # Node ≥ 22.18 strips types
 *
 * Environment:
 *   DSH_PROBE_PACKAGE  package name to mount (default `dsh-ensemble-probe`)
 *   DSH_PROBE_TMP      scratch directory for temporary artifacts (default `.probe-check`)
 *
 * The generated `cordis.yml` files must live under a directory whose
 * `node_modules` resolves the packages, because the Loader resolves each row
 * relative to that file.
 *
 * What this proves is limited to: the published Loader loads this package, the
 * skill provider is merged with the intended invocation policy, the tool reads
 * back the bundled enumeration, and failures are explicit. It proves nothing
 * about Host/execution-world isolation, the Client half, or archive behaviour.
 *
 * Every check prints `PASS <name>` or `FAIL <name>: <detail>`; the process exits
 * 1 if any check failed.
 *
 * @module adapters/dsh/loader-check
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-skill";

const PACKAGE = process.env.DSH_PROBE_PACKAGE ?? "dsh-ensemble-probe";
const failures: string[] = [];

function check(condition: boolean, name: string, detail = ""): void {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`FAIL ${name}${detail === "" ? "" : `: ${detail}`}`);
}

const BASE_ROWS = [
  { id: "system-prompt", name: "@deepseek-ai/dsh-system-prompt" },
  { id: "skill", name: "@deepseek-ai/dsh-skill" },
  { id: "tools", name: "@deepseek-ai/dsh-tools" },
  { id: "tool-executor-native", name: "@deepseek-ai/dsh-tool-executor-native" },
];

async function scenario(name: string, dir: string, rows: readonly Record<string, unknown>[]): Promise<Context> {
  const configPath = join(dir, `${name}.yml`);
  await writeFile(configPath, `${rows.map((row) => `- ${JSON.stringify(row)}`).join("\n")}\n`);
  return boot("probe-check", configPath);
}

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

async function callTool(ctx: Context, id: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await ctx.tools.execute({
    calls: [{ type: "tool-call", id: id as never, name: "ensemble_reference", arguments: JSON.stringify(args) }],
    signal: AbortSignal.timeout(15000),
  });
  const settled = result.results[0];
  if (settled === undefined) return { text: "", isError: true };
  const text = settled.result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return { text, isError: settled.result.isError };
}

/** Locate the installed package directory through Node resolution. */
function installedPackageDir(): string {
  return new URL(".", import.meta.resolve(`${PACKAGE}/package.json`)).pathname;
}

async function main(): Promise<void> {
  const packageDir = installedPackageDir();
  const scratch = process.env.DSH_PROBE_TMP ?? join(process.cwd(), ".probe-check");
  await mkdir(scratch, { recursive: true });
  const skillDir = join(packageDir, "skills/ensemble");

  // ── Scenario 1: the installed package as a Loader row ────────────────────
  const ctx = await scenario("installed", scratch, [...BASE_ROWS, { id: "ensemble-probe", name: PACKAGE }]);
  const skills = ctx.skills;
  const tools = ctx.tools;

  const summaries = await skills.list({});
  const ensemble = summaries.find((skill) => skill.name === "ensemble");
  check(ensemble !== undefined, "skill ensemble is registered");
  check(ensemble?.invocation.userInvocable === true, "skill is user-invocable", JSON.stringify(ensemble?.invocation));
  check(
    ensemble?.invocation.modelInvocable === false,
    "skill is not model-invocable (frontmatter disable-model-invocation: true)",
    JSON.stringify(ensemble?.invocation),
  );
  check(ensemble?.provider === "ensemble-probe", "skill provider name", ensemble?.provider);
  check(
    ensemble?.resourceBase?.kind === "opaque",
    "skill resource base is opaque (no host path)",
    JSON.stringify(ensemble?.resourceBase),
  );
  check(
    !summaries.some((skill) => skill.invocation.modelInvocable && skill.name === "ensemble"),
    "model-facing catalog excludes ensemble",
  );

  const definition = await skills.get("ensemble", {});
  const raw = await readFile(join(skillDir, "SKILL.md"), "utf8");
  const expectedBody = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  check(definition !== undefined, "skill body loads by name");
  check(definition?.content === expectedBody, "skill body equals SKILL.md without frontmatter");
  check(
    (definition?.content ?? "").includes("Capability status: pre-release method resource"),
    "skill body keeps the pre-release capability status section",
  );

  check(tools.get("ensemble_reference") !== undefined, "tool ensemble_reference is registered");

  for (const resource of ["EVOLUTION-TEMPLATE.md", "GLOSSARY.md", "PATTERNS.md", "README.md", "STATE-TEMPLATE.md"]) {
    const result = await callTool(ctx, `call-${resource}`, { resource });
    const expected = await readFile(join(skillDir, resource), "utf8");
    check(!result.isError, `tool reads ${resource}`, result.text.slice(0, 200));
    check(result.text === expected, `tool returns exact bytes for ${resource}`);
  }

  const unknown = await callTool(ctx, "call-unknown", { resource: "SECRETS.md" });
  check(unknown.isError, "tool rejects a name outside the enumeration (schema)");
  check(
    unknown.text.includes("must be one of"),
    "schema rejection lists the enumeration",
    unknown.text.slice(0, 200),
  );

  for (const path of ["../package.json", "/etc/passwd", "skills/ensemble/SKILL.md", "..\\package.json", "SKILL.md"]) {
    const attempt = await callTool(ctx, "call-path", { resource: path });
    check(attempt.isError, `tool rejects path-like input ${JSON.stringify(path)}`, attempt.text.slice(0, 160));
  }

  // The reader's own allowlist, exercised through the exported factory so a
  // future schema relaxation cannot silently widen what the body accepts.
  const reader = await (await import(`${packageDir}index.js`)).createReferenceReader(skillDir);
  for (const path of ["../package.json", "/etc/passwd", "SKILL.md", "..\\package.json", "GLOSSARY.md/../SKILL.md"]) {
    let code = "";
    try {
      await reader.read(path);
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    check(code === "UNKNOWN_RESOURCE", `reader rejects non-enumerated name ${JSON.stringify(path)}`, code);
  }
  check((await reader.read("GLOSSARY.md")).resource === "GLOSSARY.md", "reader accepts an enumerated name");

  const skillViaTool = await callTool(ctx, "call-skill", { resource: "SKILL.md" });
  check(skillViaTool.isError, "tool does not expose SKILL.md through the schema");

  await ctx.fiber.dispose();
  const afterDispose = await skills.list({}).catch(() => []);
  check(
    !afterDispose.some((skill) => skill.provider === "ensemble-probe"),
    "disposing the plugin removes its skill provider",
  );
  check(tools.get("ensemble_reference") === undefined, "disposing the plugin removes its tool");

  // ── Scenario 2: a shim over a temporary artifact directory ───────────────
  // Exercises the output budget through the same public registration path,
  // without touching the installed package.
  const tempArtifact = join(scratch, "artifact");
  await mkdir(tempArtifact, { recursive: true });
  for (const resource of ["EVOLUTION-TEMPLATE.md", "GLOSSARY.md", "README.md", "STATE-TEMPLATE.md", "SKILL.md"]) {
    await writeFile(join(tempArtifact, resource), await readFile(join(skillDir, resource)));
  }
  await writeFile(join(tempArtifact, "PATTERNS.md"), "x".repeat(70 * 1024));

  const shim = join(scratch, "shim.mjs");
  await writeFile(
    shim,
    [
      `import { applyWith } from ${JSON.stringify(join(packageDir, "index.js"))}`,
      "export const name = 'probe-shim'",
      "export const inject = ['skills', 'tools']",
      `export function apply(ctx) { applyWith(ctx, { skillDir: ${JSON.stringify(tempArtifact)} }) }`,
      "",
    ].join("\n"),
  );

  const shimCtx = await scenario("shim", scratch, [...BASE_ROWS, { id: "probe-shim", name: "./shim.mjs" }]);
  const overBudget = await callTool(shimCtx, "call-budget", { resource: "PATTERNS.md" });
  check(overBudget.isError, "oversized resource fails instead of truncating");
  check(
    overBudget.text.includes("OUTPUT_BUDGET_EXCEEDED"),
    "oversized resource reports OUTPUT_BUDGET_EXCEEDED",
    overBudget.text.slice(0, 300),
  );
  await shimCtx.fiber.dispose();

  // ── Scenario 3: duplicate registration in one layer ──────────────────────
  // The Loader reports a failed row as an inactive entry with a warning rather
  // than rejecting the whole boot, so the assertion reads the row's own fiber
  // state and the surviving provider list.
  const duplicateCtx = await scenario("duplicate", scratch, [
    ...BASE_ROWS,
    { id: "ensemble-probe-a", name: PACKAGE },
    { id: "ensemble-probe-b", name: PACKAGE },
  ]);
  const duplicateEntries = [...duplicateCtx.loader.entries()];
  const failedRow = duplicateEntries.find((entry) => entry.id.endsWith("ensemble-probe-b"));
  const failedMessage =
    (failedRow?.fiber as { _error?: { message?: string } } | undefined)?._error?.message ?? "";
  check(
    failedRow !== undefined && failedRow.fiber?.state === 3,
    "a second provider with the same name fails to activate (fiber FAILED)",
    String(failedRow?.fiber?.state),
  );
  check(
    /already registered/.test(failedMessage),
    "the registry rejects the duplicate provider name",
    failedMessage.slice(0, 300),
  );
  const surviving = await duplicateCtx.skills.list({});
  check(
    surviving.filter((skill) => skill.name === "ensemble").length === 1,
    "exactly one ensemble skill survives the duplicate",
    String(surviving.length),
  );
  await duplicateCtx.fiber.dispose();

  // ── Scenario 4: the shipped bundle patch, applied as an overlay ──────────
  // `cordis.patch.yml` is what a profile would apply after installing the
  // package, so this exercises the file the tarball actually ships rather than
  // a hand-written row.
  const baseConfig = join(scratch, "base.yml");
  await writeFile(baseConfig, `${BASE_ROWS.map((row) => `- ${JSON.stringify(row)}`).join("\n")}\n`);
  const overlay = loadOverlayPatches("probe-check", join(packageDir, "cordis.patch.yml"));
  check(overlay.length > 0, "shipped cordis.patch.yml parses as a patch layer");
  const patchedCtx = await boot("probe-check", baseConfig, overlay);
  const patchedSkills = await patchedCtx.skills.list({});
  check(
    patchedSkills.some((skill) => skill.name === "ensemble" && skill.provider === "ensemble-probe"),
    "the shipped bundle patch mounts the package",
    patchedSkills.map((skill) => skill.name).join(","),
  );
  const patchedTool = await callTool(patchedCtx, "call-patched", { resource: "GLOSSARY.md" });
  check(!patchedTool.isError && patchedTool.text.length > 0, "the patched composition serves references");
  await patchedCtx.fiber.dispose();

  console.log(failures.length === 0 ? `\nOK ${PACKAGE} via real Loader` : `\n${failures.length} check(s) failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
