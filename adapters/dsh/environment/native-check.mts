#!/usr/bin/env bun
/** Required native environment gate. Explicit install argument; no missing-install success or skip. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNativePreferences, discoverEnvironmentCatalog, type LlmCatalogFace, type NativePreferences, type SettingsFace } from "./native.ts";
import { createEnvironmentService } from "./service.ts";
import { failure, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import type { Preferences } from "../../../modules/ensemble/environment.ts";
import { ArchiveKernel } from "../store/kernel.ts";
import type { IsolatedContext } from "../archive.ts";
import { createLocationHandles } from "../maintenance/handles.ts";

/**
 * The booted Host, described structurally.
 *
 * `boot()` is resolved from the measured install, so its type is only available
 * inside a real install program; this declares the surface these checks use
 * instead of leaving it `any`. The Host type gate compiles the modules that do
 * import the published packages, so a changed provider signature still fails
 * there rather than being absorbed here.
 */
type BootedHost = IsolatedContext & {
  readonly settings: SettingsFace;
  readonly llm: LlmCatalogFace & { registerAdapter(names: readonly string[], adapter: unknown): void };
  readonly fiber: { dispose(): Promise<void> };
};
/** The contributor context `boot()` hands to a composition callback. */
interface BootContributor { provide(name: string, value: unknown): unknown }
/**
 * The committed answer a mutating environment action returns.
 *
 * `EnvironmentService.execute` deliberately answers `Result<unknown>` (the result
 * shape belongs to the action), so the fields these checks assert on are named
 * once here instead of being reached through `any` at every call site.
 */
interface CommittedAnswer {
  readonly status: string;
  readonly committed_revision: string;
  readonly head_revision: string;
  readonly replayed?: boolean;
  readonly targets: readonly { readonly expected_native_revision: number }[];
  readonly application: { readonly targets: readonly { readonly status: string; readonly detail: string }[] };
}
/** A redacted native Settings descriptor row, as `describe()` publishes it. */
interface SettingsRow { readonly ns: string; readonly revision: number; readonly value: Record<string, unknown> }

const install = process.argv[2];
if (!install) { console.error("Usage: bun adapters/dsh/environment/native-check.mts <isolated supported DSH install>"); process.exit(2); }
const installed = resolve(install);
const require = createRequire(join(installed, "package.json"));
const runtimeVersion = JSON.parse(readFileSync(require.resolve("@deepseek-ai/dsh/package.json"), "utf8")).version;
assert.ok(["0.2.2-rc.4", "0.2.2-rc.5"].includes(runtimeVersion), "unsupported native gate version");
const base = resolve(".scratch/production-cycle"); mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, "environment-native-"));
symlinkSync(join(installed, "node_modules"), join(fixture, "node_modules"), "dir");
const rows = [
  { id: "config-editor", name: "@deepseek-ai/dsh-config-editor" },
  { id: "settings", name: "@deepseek-ai/dsh-settings" },
  { id: "llm", name: "@deepseek-ai/dsh-llm" },
  { id: "ensemble-environment", name: pathToFileURL(join(fixture, "settings-plugin.mjs")).href, config: { unrelated: "unchanged", secret: "fixture-only-do-not-export" } },
];
writeFileSync(join(fixture, "package.json"), JSON.stringify({ private: true, type: "module", dsh: { profile: { bundles: [] } } }));
writeFileSync(join(fixture, "boot.yml"), rows.map(r => `- ${JSON.stringify(r)}`).join("\n"));
writeFileSync(join(fixture, "cordis.patch.yml"), `- ${JSON.stringify({ insert: rows })}\n`);
const built = await Bun.build({ entrypoints: [resolve("adapters/dsh/environment/config.ts")], outdir: fixture, target: "node", external: ["@deepseek-ai/schemastery"] });
assert.ok(built.success, "native Config build");
writeFileSync(join(fixture, "settings-plugin.mjs"), `import z from '@deepseek-ai/schemastery';\nimport { rolePreferencesConfig } from './config.js';\nexport const name='environment-test-settings';\nexport const Config=z.object({rolePreferences:rolePreferencesConfig,unrelated:z.string().volatile(),secret:z.string().role('secret').volatile()});\nexport function apply(ctx,config){ctx.provide('environmentTestConfig',config);}\n`);
const { boot } = await import(require.resolve("@deepseek-ai/dsh-app-boot"));
const { LocalSubprocessRuntime } = await import(require.resolve("@deepseek-ai/dsh-subprocess-local"));
const { LocalSandboxProvider } = await import(require.resolve("@deepseek-ai/dsh-sandbox-local"));
const settingsContext: BootedHost = await boot("environment-check", join(fixture, "boot.yml"), [], (ctx: BootContributor) => {
  ctx.provide("profileContext", { name: "environment-check", dir: fixture, patchPath: join(fixture, "cordis.patch.yml"),
    installAnchor: require.resolve("@deepseek-ai/dsh/package.json"), cwd: fixture, home: join(fixture, "home"), startedBundles: [], overlays: [], telemetryDisabledEnv: "1" });
}, pathToFileURL(join(installed, "package.json")).href);
const kernel = new ArchiveKernel({ context: settingsContext, factories: { subprocess: scope => new LocalSubprocessRuntime(scope),
  sandbox: scope => new LocalSandboxProvider(scope, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }) } });
const owner: Actor = { kind: "owner", ownerId: "owner", hostAuthorityId: "host", channel: "authenticated-remote" };
const member: Actor = { kind: "session", sessionId: "member", rootSessionId: "root", workspaceRef: "source", callId: "call" };
const signal = AbortSignal.timeout(120000);
const preferences: Preferences = { roles: [{ role: "worker", candidates: [{ provider: "fixture", model: "model", effort: { mode: "explicit", value: "careful" },
  applicability: { task_types: ["code"], interface_versions: [], required_capabilities: ["tools"] }, reason: "Locally reviewed preference, not a global quality order." }] }] };
const native = createNativePreferences(settingsContext.settings, ["ensemble-environment"]);
let writes = 0, loseResponse = false, readUnavailable = false, conflictBeforeApply = false;
const hooked: NativePreferences = { targets: native.targets, read: (id, s) => readUnavailable ? Promise.resolve(failure("storage_unavailable", "injected read loss")) : native.read(id, s),
  async apply(id, prefs, expected, s) {
    writes++;
    if (conflictBeforeApply) { conflictBeforeApply = false; await settingsContext.settings.update(id, { unrelated: "concurrent change" }, expected); }
    const result = await native.apply(id, prefs, expected, s);
    if (loseResponse) assert.equal(result.ok, true, "fault injection requires an actual successful native update");
    if (loseResponse) { loseResponse = false; readUnavailable = true; return failure("outcome_unknown", "injected lost native response after actual write"); }
    return result;
  } };
const root = join(fixture, "environment.git");
const handles = createLocationHandles({ async authorizeSelection(_actor, request) { return { ok: true as const, value: { path: request.path, world: "host-world", check: async () => true } }; } });
const locations = { handles, hostWorld: "host-world", protectedRoots: [] };
let service = createEnvironmentService({ root, hostAuthorityId: "host", kernel, native: hooked, locations });
let passes = 0;
function ok<T>(result: Result<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); return (result as { ok: true; value: T }).value; }
/**
 * Narrow one committed answer.
 *
 * `execute` answers `Result<unknown>` on purpose: the result shape belongs to the
 * action, not to the executor. This is the single place these checks turn that
 * `unknown` into the answer fields they assert on, so no call site needs `any`.
 */
function committed(result: Result<unknown>): CommittedAnswer {
  const value = ok(result);
  assert.ok(value !== null && typeof value === "object", "a committed environment answer must be an object");
  return value as CommittedAnswer;
}
async function command(input: unknown): Promise<CommittedAnswer> {
  const result = await service.execute(owner, input, signal);
  if (!result.ok) console.error("COMMAND FAILED", JSON.stringify((input as { action?: string }).action), JSON.stringify(result));
  return committed(result);
}
function passed(label: string) { passes++; console.log(`PASS ${label}`); }
try {
  settingsContext.settings.describe({ redactSecrets: true }); // Exercise the native descriptor before archive IO.
  const initialNative = ok(await native.read("ensemble-environment", signal));
  assert.deepEqual(initialNative.preferences, { roles: [] });
  const saved = await command({ action: "environment_set", expected_revision: "absent", operation_id: "save", preferences });
  const summary = ok(await service.read(owner, undefined, signal));
  assert.equal(summary.desired_revision, saved.committed_revision);
  assert.equal(summary.applications.length, 0);
  assert.deepEqual(ok(await native.read("ensemble-environment", signal)).preferences, { roles: [] });
  passed("real Git desired commit does not mutate native Settings");
  const unauthorized = await service.execute(member, { action: "environment_set", expected_revision: saved.committed_revision, operation_id: "forged", preferences }, signal);
  assert.equal(unauthorized.ok, false); assert.equal(ok(await service.read(owner, undefined, signal)).read_revision, saved.committed_revision);
  assert.equal((await service.read(member, undefined, signal)).ok, false);
  const grant = await command({ action: "environment_grant_read", expected_revision: saved.committed_revision, operation_id: "grant", grants: [{ subject: { kind: "session", sessionId: "member", rootSessionId: "root" } }] });
  const { LlmAdapter } = await import(require.resolve("@deepseek-ai/dsh-llm"));
  const resolvedModels: string[] = [];
  class MetadataAdapter extends LlmAdapter {
    async resolveModel(provider: string, model: string) {
      resolvedModels.push(model);
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: "careful", name: "Careful" }], defaultEffort: "careful" } };
    }
    async *stream() { throw new Error("This acceptance gate must never send a live model request."); }
  }
  settingsContext.llm.registerAdapter(["fixture"], new MetadataAdapter());
  const access = { sessionId: "member", parent: { provider: "fixture", model: "model" }, policy: [{ provider: "fixture", model: "model" }], selectionEnabled: true, allowedPresets: [], validate: () => true, llm: settingsContext.llm };
  const catalog = ok(await discoverEnvironmentCatalog(access, signal));
  assert.deepEqual(catalog.routes[0]?.efforts, ["careful"]);
  assert.ok(resolvedModels.length > 0 && resolvedModels.every(m => m === "model"));
  assert.equal(ok(await service.recommend(member, "worker", preferences.roles[0]!.candidates[0]!.applicability, catalog, "ensemble-environment", signal)).candidates.length, 0);
  passed("separate environment grant and recommendations consume native applied preferences only");
  const preview = await command({ action: "environment_preview", desired_revision: saved.committed_revision, target_ids: ["ensemble-environment"] });
  assert.equal(preview.targets[0].expected_native_revision, initialNative.revision);
  loseResponse = true;
  const applyRequest = { action: "environment_apply", expected_revision: grant.committed_revision, operation_id: "apply", desired_revision: saved.committed_revision,
    targets: [{ target_id: "ensemble-environment", expected_native_revision: initialNative.revision }] };
  const appliedUnknown = await command(applyRequest);
  assert.equal(appliedUnknown.application.targets[0].status, "unknown"); assert.equal(writes, 1);
  readUnavailable = false;
  service.dispose(); service = createEnvironmentService({ root, hostAuthorityId: "host", kernel, native: hooked, locations });
  const retried = await command(applyRequest);
  assert.equal(retried.application.targets[0].status, "applied"); assert.equal(writes, 1);
  const recommendation = ok(await service.recommend(member, "worker", preferences.roles[0]!.candidates[0]!.applicability, catalog, "ensemble-environment", signal));
  assert.deepEqual(recommendation.candidates[0]?.request, { provider: "fixture", model: "model", reasoning_effort: "careful" });
  passed("actual native Settings write with lost response reconciles after restart without resend");
  const descriptor = settingsContext.settings.describe({ redactSecrets: true }).find(row => row.ns === "ensemble-environment");
  assert.ok(descriptor, "the native Settings instance must be uniquely described");
  // `describe()` publishes the live value as `unknown`; a redacted descriptor must
  // still be an object, and the unrelated field must survive our field-only merge.
  const nativeValue = descriptor.value;
  assert.ok(nativeValue !== null && typeof nativeValue === "object" && !Array.isArray(nativeValue), "native Settings value must be an object");
  const settingsValue = nativeValue as Record<string, unknown>;
  assert.equal(settingsValue.unrelated, "unchanged"); assert.ok(!("secret" in settingsValue));
  const allEntries = await kernel.entries(root, ok(await service.read(owner, undefined, signal)).read_revision, signal);
  for (const entry of allEntries) assert.ok(!new TextDecoder().decode(await kernel.blob(root, entry.oid, signal)).includes("fixture-only-do-not-export"));
  passed("native merge preserves unrelated fields and no credential value enters archive objects");
  const oldHead = ok(await service.read(owner, undefined, signal)).read_revision;
  const changed: Preferences = { roles: [{ ...preferences.roles[0]!, candidates: [{ ...preferences.roles[0]!.candidates[0]!, reason: "New reviewed reason." }] }] };
  const saved2 = await command({ action: "environment_set", expected_revision: oldHead, operation_id: "save2", preferences: changed });
  const beforeConflict = ok(await native.read("ensemble-environment", signal)); conflictBeforeApply = true;
  const conflicted = await command({ action: "environment_apply", expected_revision: saved2.committed_revision, operation_id: "conflicting-apply", desired_revision: saved2.committed_revision,
    targets: [{ target_id: "ensemble-environment", expected_native_revision: beforeConflict.revision }] });
  assert.equal(conflicted.application.targets[0].status, "failed");
  assert.deepEqual(ok(await native.read("ensemble-environment", signal)).preferences, preferences);
  passed("real native Settings CAS refuses concurrent edits without overwriting preferences");
  const restored = await command({ action: "environment_restore", expected_revision: conflicted.committed_revision, operation_id: "restore", historical_revision: saved.committed_revision });
  assert.notEqual(restored.committed_revision, saved.committed_revision);
  assert.deepEqual(ok(await service.read(owner, undefined, signal)).preferences, preferences);
  assert.equal(ok(await service.read(owner, saved2.committed_revision, signal)).preferences.roles[0]?.candidates[0]?.reason, "New reviewed reason.");
  const retry = await command({ action: "environment_set", expected_revision: "absent", operation_id: "save", preferences });
  assert.equal(retry.committed_revision, saved.committed_revision);
  const badRetry = await service.execute(owner, { action: "environment_set", expected_revision: restored.committed_revision, operation_id: "save", preferences: changed }, signal);
  assert.equal(badRetry.ok, false); if (!badRetry.ok) assert.equal(badRetry.error.code, "operation_key_conflict");
  passed("desired restore appends history; same-key retry returns original commit and conflicting content refuses");
  const backup = ok(await service.backup(owner, signal)); assert.equal(backup.revision, restored.committed_revision);
  const quarantine = join(fixture, "quarantine.git"); await kernel.restoreBundle(backup.bytes, quarantine, signal);
  assert.equal(await kernel.head(quarantine, signal), backup.revision);
  assert.deepEqual(await kernel.history(quarantine, backup.revision, signal), await kernel.history(root, backup.revision, signal));
  passed("complete independent environment backup restores all commits and original head");
  const backupPath = join(fixture, "owner-backup");
  const destination = ok(await handles.choose(owner, { kind: "destination", path: backupPath, world: "host-world" }, signal));
  const backupRequest = { action: "environment_backup", expected_revision: restored.committed_revision, operation_id: "backup-output", destination_handle: destination.handle };
  assert.equal((await command(backupRequest)).status, "backed_up");
  assert.equal((await command(backupRequest)).replayed, true);
  const backupHandle = ok(await handles.choose(owner, { kind: "backup", path: backupPath, world: "host-world" }, signal));
  const recovered = createEnvironmentService({ root: join(fixture, "recovered.git"), hostAuthorityId: "host", kernel, native: hooked, locations });
  try {
    const recoveryRequest = { action: "environment_recover", expected_revision: "absent", operation_id: "recover", backup_handle: backupHandle.handle };
    const result = committed(await recovered.execute(owner, recoveryRequest, signal));
    const recoveredState = ok(await recovered.read(owner, undefined, signal));
    assert.notEqual(recoveredState.environment_id, backup.environment_id);
    assert.equal(recoveredState.desired_revision, result.committed_revision);
    assert.deepEqual(recoveredState.preferences, preferences);
    assert.deepEqual(recoveredState.applications, []);
    assert.equal((await recovered.read(member, saved.committed_revision, signal)).ok, false);
    const replayed = committed(await recovered.execute(owner, recoveryRequest, signal));
    assert.equal(replayed.committed_revision, result.committed_revision);
    assert.equal(ok(await recovered.read(owner, saved2.committed_revision, signal)).preferences.roles[0]?.candidates[0]?.reason, "New reviewed reason.");
    assert.equal(writes, 2, "recovery never replays native actions");
  } finally { recovered.dispose(); }
  passed("owner handle backup recovery retains history with new identity, no old grants and no native replay");
  const revoked = await command({ action: "environment_grant_read", expected_revision: restored.committed_revision, operation_id: "revoke", grants: [] });
  assert.equal((await service.read(member, saved.committed_revision, signal)).ok, false);
  assert.equal((await service.recommend(member, "worker", preferences.roles[0]!.candidates[0]!.applicability, catalog, "ensemble-environment", signal)).ok, false);
  assert.equal(ok(await service.read(owner, undefined, signal)).read_revision, revoked.committed_revision);
  passed("current environment revoke also denies historical reads and native advice");
  // Failure after native response but before its environment observation publishes must retain the intent.
  let failSettlement = false, crashWrites = 0;
  const crashed = createEnvironmentService({ root: join(fixture, "crashed.git"), hostAuthorityId: "host", kernel,
    native: { targets: native.targets, read: native.read, async apply(id, prefs, expected, s) {
      crashWrites++; const result = await native.apply(id, prefs, expected, s); failSettlement = true; return result;
    } }, fault(stage) { if (stage === "before_publish" && failSettlement) throw new Error("injected observation commit failure"); } });
  try {
    const savedCrash = committed(await crashed.execute(owner, { action: "environment_set", expected_revision: "absent", operation_id: "save-crash", preferences: changed }, signal));
    const actualBefore = ok(await native.read("ensemble-environment", signal));
    const crashRequest = { action: "environment_apply", operation_id: "crash-apply", expected_revision: savedCrash.committed_revision, desired_revision: savedCrash.committed_revision,
      targets: [{ target_id: "ensemble-environment", expected_native_revision: actualBefore.revision }] };
    const lost = await crashed.execute(owner, crashRequest, signal);
    assert.equal(lost.ok, false); if (!lost.ok) assert.equal(lost.error.code, "outcome_unknown");
    assert.equal(ok(await crashed.read(owner, undefined, signal)).applications[0]?.targets[0]?.status, "pending");
    failSettlement = false;
    const reconciled = committed(await crashed.execute(owner, crashRequest, signal));
    assert.equal(reconciled.application.targets[0].status, "applied"); assert.equal(crashWrites, 1);
  } finally { crashed.dispose(); }
  passed("native-success observation-commit failure retains pending and retries reconcile without side-effect replay");
  // A lost readback after a real native write must hold the intent open for a
  // competing operation until one explicit readback establishes the effect.
  let applyWrites = 0, loseReadback = false;
  const gated = createEnvironmentService({ root: join(fixture, "gated.git"), hostAuthorityId: "host", kernel,
    native: { targets: native.targets, read: (id: string, s: AbortSignal) => {
      if (!loseReadback) return native.read(id, s);
      loseReadback = false; return Promise.resolve(failure("storage_unavailable", "injected post-write readback loss"));
    }, async apply(id, prefs, expected, s) { applyWrites++; loseReadback = true; return native.apply(id, prefs, expected, s); } } });
  try {
    const gatedPreferences: Preferences = { roles: [{ ...preferences.roles[0]!, candidates: [{ ...preferences.roles[0]!.candidates[0]!, reason: "Gated readback variant." }] }] };
    const savedGated = committed(await gated.execute(owner, { action: "environment_set", expected_revision: "absent", operation_id: "save-gated", preferences: gatedPreferences }, signal));
    const beforeGated = ok(await native.read("ensemble-environment", signal));
    const unknownReadback = committed(await gated.execute(owner, { action: "environment_apply", expected_revision: savedGated.committed_revision, operation_id: "gated-apply",
      desired_revision: savedGated.committed_revision, targets: [{ target_id: "ensemble-environment", expected_native_revision: beforeGated.revision }] }, signal));
    assert.equal(unknownReadback.application.targets[0].status, "unknown"); assert.equal(applyWrites, 1);
    const competing = await gated.execute(owner, { action: "environment_apply", expected_revision: unknownReadback.committed_revision, operation_id: "competing-apply",
      desired_revision: savedGated.committed_revision, targets: [{ target_id: "ensemble-environment", expected_native_revision: beforeGated.revision }] }, signal);
    assert.equal(competing.ok, false);
    assert.equal(ok(await gated.read(owner, undefined, signal)).applications[0]?.targets[0]?.status, "unknown");
    const reconciledUnknown = committed(await gated.execute(owner, { action: "environment_reconcile", expected_revision: unknownReadback.committed_revision,
      operation_id: "gated-reconcile", application_id: "gated-apply" }, signal));
    assert.equal(reconciledUnknown.application.targets[0].status, "applied"); assert.equal(applyWrites, 1);
  } finally { gated.dispose(); }
  passed("lost native readback holds a competing apply until one explicit reconcile confirms the applied effect");
  // An explicit reconcile that reads a genuinely different native value settles
  // the intent as failed, so a later operation is not blocked forever.
  let driftWrites = 0;
  const drifting = createEnvironmentService({ root: join(fixture, "drifting.git"), hostAuthorityId: "host", kernel,
    native: { targets: native.targets, read: (id: string, s: AbortSignal) => native.read(id, s),
      async apply(id, prefs, expected, s) { driftWrites++; const result = await native.apply(id, prefs, expected, s);
        await settingsContext.settings.update(id, { rolePreferences: { roles: [] } }, expected + 1); return result; } } });
  try {
    const savedDrift = committed(await drifting.execute(owner, { action: "environment_set", expected_revision: "absent", operation_id: "save-drift", preferences: changed }, signal));
    const beforeDrift = ok(await native.read("ensemble-environment", signal));
    const drifted = committed(await drifting.execute(owner, { action: "environment_apply", expected_revision: savedDrift.committed_revision, operation_id: "drift-apply",
      desired_revision: savedDrift.committed_revision, targets: [{ target_id: "ensemble-environment", expected_native_revision: beforeDrift.revision }] }, signal));
    assert.equal(drifted.application.targets[0].status, "unknown");
    const reconciledDrift = committed(await drifting.execute(owner, { action: "environment_reconcile", expected_revision: drifted.committed_revision,
      operation_id: "drift-reconcile", application_id: "drift-apply" }, signal));
    assert.equal(reconciledDrift.application.targets[0].status, "failed"); assert.equal(driftWrites, 1);
    const nextOperation = committed(await drifting.execute(owner, { action: "environment_set", expected_revision: reconciledDrift.committed_revision,
      operation_id: "after-drift", preferences: changed }, signal));
    assert.equal(nextOperation.status, "committed");
  } finally { drifting.dispose(); }
  passed("explicit reconcile of a genuinely different native value settles failed and releases the effect lock");
  // The selection-evidence command exists on the closed owner surface and fails
  // closed when no trusted native collector is mounted: it never records a
  // guessed route, and a model-shaped request cannot submit its own member.
  const noCollector = await service.execute(owner, { action: "environment_record_selection", expected_revision: revoked.committed_revision,
    operation_id: "selection-without-collector", attempt_id: "attempt-1" }, signal);
  assert.equal(noCollector.ok, false); if (!noCollector.ok) assert.equal(noCollector.error.code, "storage_unavailable");
  const forgedSelection = await service.execute(owner, { action: "environment_record_selection", expected_revision: revoked.committed_revision,
    operation_id: "selection-forged", attempt_id: "attempt-1", requested: { provider: "fixture", model: "model" } }, signal);
  assert.equal(forgedSelection.ok, false); if (!forgedSelection.ok) assert.equal(forgedSelection.error.code, "invalid_input");
  assert.equal(ok(await service.read(owner, undefined, signal)).applications.length > 0, true);
  const summaryBefore = ok(await service.read(owner, undefined, signal));
  assert.deepEqual(summaryBefore.evidence, []); assert.equal(summaryBefore.evidence_total, 0);
  passed("selection evidence command is closed and fails closed without a trusted native collector");
  console.log(`ENVIRONMENT ${runtimeVersion}: ${passes} checks PASS; fixture=${fixture}`);
} finally { service.dispose(); kernel.dispose(); await settingsContext.fiber.dispose(); }
