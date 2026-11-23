/** Independent native-boundary acceptance. No profile install, network, Git or implementation edits.
 * Run: bun scripts/verify-dsh-native-acceptance.ts --runtime .scratch/rc5-cycle/rc5
 * Published Cordis/FileSystem/subprocess/sandbox providers are real; Agent-shaped callers below
 * exercise internal seams only and are never a Remote/authenticated-UI or AgentLoop E2E claim:
 * component-level green here cannot substitute the actual current-owner Remote gate, which the
 * parent native/client verifier owns.
 */
import { mkdtemp, mkdir, symlink, writeFile, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeSourceReader } from "../adapters/dsh/native/locations.ts";
import { nativeIdentity, NativeIdentityError, type NativeAgent } from "../adapters/dsh/native/identity.ts";
import { createProductOwner } from "../adapters/dsh/native/owner.ts";
import { failure, success, type Actor, type ActorIdentity, type OwnerContext } from "../modules/ensemble/contracts.ts";

export interface BoundaryEvidence { check: string; passed: boolean; detail: unknown }
interface TinyAgent extends NativeAgent { ctx: unknown }

export async function verifyNativeBoundaries(runtimePath: string): Promise<{ runtime: string; fixture: string; coverage: string; checks: BoundaryEvidence[] }> {
  const runtime = resolve(runtimePath);
  const require = createRequire(join(runtime, "package.json"));
  const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href);
  const { Context } = await load("@deepseek-ai/cordis");
  const { LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
  const { LocalSubprocessRuntime } = await load("@deepseek-ai/dsh-subprocess-local");
  const { LocalSandboxProvider } = await load("@deepseek-ai/dsh-sandbox-local");
  const fixture = await mkdtemp("/var/tmp/ensemble-native-review-");
  const source = join(fixture, "source"), outside = join(fixture, "outside");
  await mkdir(source); await mkdir(outside);
  await writeFile(join(source, "normal.txt"), "inside selected source\n");
  // All outside material is synthetic and belongs to this private fixture.
  const sentinel = "private-outside-link-metadata";
  await symlink(sentinel, join(outside, "private-link"));
  await symlink(outside, join(source, "escape"));
  await symlink("normal.txt", join(source, "safe-link"));
  const ctx = new Context();
  const foreign = new Context();
  const checks: BoundaryEvidence[] = [];
  const add = (check: string, passed: boolean, detail: unknown) => checks.push({ check, passed, detail });
  try {
    const fs = new LocalFileSystem(ctx, { cwd: source, diffBasisMaxBytes: 1024 });
    new LocalFileSystem(foreign, { cwd: outside, diffBasisMaxBytes: 1024 });
    const root = await fs.resolve(source);
    const world = { identity: "selected-source", fs, hostLocal: false, current: () => true, readLink: async (path: string, signal: AbortSignal) => { signal.throwIfAborted(); return readlink(path); } };
    const reader = nativeSourceReader(world, root);
    const signal = AbortSignal.timeout(15000);
    const normal = await reader.scan(["normal.txt", "safe-link"], 4096, signal);
    add("selected regular file and final symlink bytes", Boolean(normal.ok && normal.value.completeness === "complete" && Buffer.from(normal.value.contents.get("safe-link") ?? []).toString() === "normal.txt"), normal.ok ? normal.value.entries : normal);

    const escaped = await reader.scan(["escape/private-link"], 4096, signal);
    const leaked = escaped.ok && Buffer.from(escaped.value.contents.get("escape/private-link") ?? []).toString() === sentinel;
    add("ancestor symlink cannot reveal an outside symlink target", !leaked, escaped.ok ? { completeness: escaped.value.completeness, entries: escaped.value.entries, leakedSyntheticOutsideBytes: leaked } : escaped);

    // Dynamic revocation: a source world that stops being current loses read rights mid-session,
    // independent of any archive grant the caller may hold.
    const revokedWorld = { ...world, current: () => false };
    const revoked = await nativeSourceReader(revokedWorld, root).scan(["normal.txt"], 4096, signal);
    add("revoked source world refuses reads", !revoked.ok && !revoked.ok && revoked.error.code === "not_authorized", revoked);

    // Compile only the production bridge against the selected released runtime.
    // Resolving external imports to absolute public package exports avoids changing its install.
    const built = await Bun.build({ entrypoints: [resolve("adapters/dsh/native/dsh.ts")], target: "node", format: "esm", plugins: [{ name: "read-only-release-exports", setup(build) { build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: require.resolve(args.path), external: true })); } }] });
    if (!built.success) throw new AggregateError(built.logs, "bridge compilation failed");
    const bridgePath = join(fixture, "bridge.mjs");
    await writeFile(bridgePath, await built.outputs[0]!.text());
    const { sourceWorld } = await import(pathToFileURL(bridgePath).href);
    const worldOf = sourceWorld(ctx, "selected-source");
    const same = worldOf({ ctx } as TinyAgent);
    const differentRoot = worldOf({ ctx: foreign } as TinyAgent);
    add("same Cordis origin and scope is admitted", same === "selected-source", { resolved: same });
    add("matching default isolation labels do not join foreign Cordis origins", differentRoot === undefined, { resolved: differentRoot ?? null, sameIsolationLabels: ["fs", "subprocess", "sandbox"].every(name => ctx[Context.isolate][name] === foreign[Context.isolate][name]), sameFilesystem: ctx.get("fs") === foreign.get("fs") });

    // Late registration: a peer service frequently arrives after this plugin activates.
    // Labels are read live, so the same origin must keep resolving after subprocess/sandbox appear,
    // and a foreign origin that still lacks them must stay refused at every point in time.
    const beforeLate = { same: worldOf({ ctx } as TinyAgent), foreign: worldOf({ ctx: foreign } as TinyAgent) };
    new LocalSubprocessRuntime(ctx, {});
    new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 });
    const afterLate = { same: worldOf({ ctx } as TinyAgent), foreign: worldOf({ ctx: foreign } as TinyAgent) };
    add("late-registered peer services keep the same origin admitted (live labels, not a snapshot)", beforeLate.same === "selected-source" && afterLate.same === "selected-source", { beforeLate, afterLate });
    add("foreign origin is refused both before and after late registration", beforeLate.foreign === undefined && afterLate.foreign === undefined, { beforeLate, afterLate });

    // Same-scope replacement: released Cordis refuses a second registration of the same service
    // key in one scope, so isolation labels cannot be silently swapped; a different isolation
    // scope is still refused.
    let duplicateRegistration = "";
    try { new LocalFileSystem(ctx, { cwd: source, diffBasisMaxBytes: 1024 }); } catch (error) { duplicateRegistration = error instanceof Error ? error.message : String(error); }
    add("released Cordis rejects same-scope re-registration (labels cannot be silently replaced)", duplicateRegistration.includes("has been registered"), { duplicateRegistration });
    const isolated = ctx.isolate("fs");
    new LocalFileSystem(isolated, { cwd: outside, diffBasisMaxBytes: 1024 });
    add("different isolation scope is refused", worldOf({ ctx: isolated } as TinyAgent) === undefined, { resolved: worldOf({ ctx: isolated } as TinyAgent) ?? null });

    // Revocation by disposal: once the origin's services are gone, no caller resolves.
    await ctx.fiber.dispose();
    const afterDispose = worldOf({ ctx } as TinyAgent);
    add("disposed execution origin no longer resolves", afterDispose === undefined, { resolved: afterDispose ?? null, fsAfterDispose: ctx.get("fs") ?? null });

    // Identity is derived from live native objects only: forged, cloned or stale callers fail.
    const rootAgent: TinyAgent = { id: "root", session: { id: "root" }, ctx };
    const childAgent: TinyAgent = { id: "child", session: { id: "child" }, ctx };
    const workspace = { id: "w1", sessionIds: ["root"], path: source };
    const runtimeStub = {
      agents: { get: (id: string) => id === "root" ? rootAgent : id === "child" ? childAgent : undefined },
      subagents: { rootOf: () => rootAgent },
      workspaces: { list: () => [workspace] },
      workingDirectory: { get: () => source },
      worldOf: (): string | undefined => "selected-source",
    };
    const resolvedIdentity = nativeIdentity(runtimeStub, childAgent);
    add("live child agent resolves under its live root and workspace", resolvedIdentity.sessionId === "child" && resolvedIdentity.rootSessionId === "root" && resolvedIdentity.workspaceId === "w1", resolvedIdentity);
    const forge = (caller: unknown, list: readonly unknown[] = [workspace]) => { try { nativeIdentity({ ...runtimeStub, workspaces: { list: () => list } } as typeof runtimeStub, caller as TinyAgent); return null; } catch (error) { return error instanceof NativeIdentityError ? error.message : String(error); } };
    add("a cloned Agent-shaped object is not a live agent", forge({ ...childAgent, ctx }) !== null, { refusal: forge({ ...childAgent, ctx }) });
    add("undefined caller is refused", forge(undefined) !== null, { refusal: forge(undefined) });
    add("a caller id without a live registry entry is refused", forge({ id: "ghost", session: { id: "ghost" }, ctx }) !== null, { refusal: forge({ id: "ghost", session: { id: "ghost" }, ctx }) });
    add("a caller whose session id disagrees with its object identity is refused", forge({ id: "child", session: { id: "other" }, ctx }) !== null, { refusal: forge({ id: "child", session: { id: "other" }, ctx }) });
    add("zero or ambiguous workspace membership is refused", forge(childAgent, []) !== null && forge(childAgent, [workspace, { ...workspace, id: "w2" }]) !== null, { zero: forge(childAgent, []), ambiguous: forge(childAgent, [workspace, { ...workspace, id: "w2" }]) });
    add("a caller without a deployment world mapping is refused", (() => { try { nativeIdentity({ ...runtimeStub, worldOf: () => undefined } as typeof runtimeStub, childAgent); return false; } catch (error) { return error instanceof NativeIdentityError; } })(), { refusal: "NativeIdentityError" });
    add("a detached root (registry entry removed) is refused", (() => { try { nativeIdentity({ ...runtimeStub, agents: { get: (id: string) => id === "child" ? childAgent : undefined } } as typeof runtimeStub, childAgent); return false; } catch (error) { return error instanceof NativeIdentityError; } })(), { refusal: "NativeIdentityError" });

    // Owner entry: authorization is derived only from the fixed Remote peer principal.
    // These are internal-seam guards with stub deps; the authenticated-Remote/browser E2E is not claimed here.
    const project: OwnerContext["projects"][number] = { project_id: "p1", title: "review", read_revision: "r1", authorization_epoch: 1, capabilities: ["read", "write"], binding_id: "b1" };
    let ownerCalls = 0;
    const product = createProductOwner({
      hostAuthorityId: "review-host", ownerId: "review-owner", authorizationRefreshMs: 1000,
      environment: async () => { ownerCalls++; return success({ preferences: [] }); },
      // `current_owner` is required on every OwnerContext response: a fresh Client
      // needs it to build a legal `initial_grants` subject. Derived from the `actor`
      // this stub is handed — which the owner guard already verified — rather than
      // hardcoded, so the fixture cannot state an identity that disagrees with the
      // caller it is serving. Same rule as production: narrow, never assert.
      projects: async (actor) => {
        ownerCalls++;
        if (actor.kind !== "owner") return failure("not_authorized", "owner context requires an authenticated owner");
        const current_owner: Extract<ActorIdentity, { kind: "owner" }> = { kind: "owner", ownerId: actor.ownerId, hostAuthorityId: actor.hostAuthorityId };
        return success({ capabilities: ["archive"], root_handles: [], source_handles: [], destination_handles: [], current_owner, projects: [project] } satisfies OwnerContext);
      },
      query: async () => success({ items: [] }),
      manage: async () => success({ status: "managed" }),
      choose: async () => success({ chosen: "p1" }),
      approve: async () => success({ approved: true }),
      subscribe: () => () => {},
    });
    const ownerInvocation = { peer: { principal: { kind: "owner" } } };
    const userInvocation = { peer: { principal: { kind: "user" } } };
    const principalLess = { peer: {} };
    const refusal = async (call: Promise<unknown>): Promise<string | null> => {
      const result = await call as { ok?: boolean; error?: { code?: string } };
      if (result && typeof result === "object" && result.ok === false) return result.error?.code ?? "not_authorized";
      return null;
    };
    const refusals: Record<string, string | null> = {};
    for (const [label, invocation] of [["no-invocation", undefined], ["user-principal", userInvocation], ["missing-principal", principalLess]] as const) {
      refusals[`${label}/environment`] = await refusal(product.environment({}, invocation as never, signal));
      refusals[`${label}/projects`] = await refusal(product.projects({}, invocation as never, signal));
      refusals[`${label}/query`] = await refusal(product.query({ kind: "context" }, invocation as never, signal));
      refusals[`${label}/manage`] = await refusal(product.manage({ action: "pause", payload: { reason: "x" }, project_id: "p1", expected_revision: "r1", operation_id: "op" }, invocation as never, signal));
      refusals[`${label}/choose`] = await refusal(product.choose({ kind: "file", path: source, world: "selected-source" }, invocation as never, signal));
      refusals[`${label}/approve`] = await refusal(product.approve({ approval_id: "a1" }, invocation as never, signal));
    }
    add("every owner-entry method refuses without an owner peer principal", Object.values(refusals).every(code => code === "not_authorized"), refusals);
    const beforeOwnerCalls = ownerCalls;
    const ownerProjects = await product.projects({}, ownerInvocation, signal) as { ok: boolean };
    add("only the owner peer principal reaches the executor", Boolean(ownerProjects.ok) && ownerCalls > beforeOwnerCalls, { ownerCalls });
    const claims = await product.projects({ owner: true, principal: { kind: "owner" } } as never, userInvocation, signal) as { ok: boolean; error?: { code?: string } };
    add("identity fields in the request cannot mint owner authority", !claims.ok, claims);
    const badShape = await product.choose({ kind: "file", path: source }, ownerInvocation, signal) as { ok: boolean; error?: { code?: string } };
    add("owner entry still enforces closed request shapes", !badShape.ok && badShape.error?.code === "invalid_input", badShape);
    const watched: unknown[] = [];
    const watchSignal = AbortSignal.timeout(3000);
    for await (const frame of product.watch({ project_id: "p1" }, userInvocation, watchSignal)) { watched.push(frame); break; }
    add("watch yields refusal before any frame for a non-owner", (watched[0] as { ok?: boolean })?.ok === false, watched[0]);
  } finally { await foreign.fiber.dispose(); await ctx.fiber.dispose().catch(() => {}); }
  const result = { runtime, fixture, coverage: "real released Cordis + LocalFileSystem/subprocess/sandbox; internal bridge/identity/owner-seam callers; no Remote auth E2E", checks };
  await writeFile(join(fixture, "evidence.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
if (import.meta.main) {
  if (process.argv.length !== 4 || process.argv[2] !== "--runtime") { console.error("usage: bun scripts/verify-dsh-native-acceptance.ts --runtime <read-only released runtime>"); process.exitCode = 2; }
  else { const result = await verifyNativeBoundaries(process.argv[3]!); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.checks.every(check => check.passed) ? 0 : 1; }
}
