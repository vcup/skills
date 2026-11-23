import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-config-editor";
import { createEnvironmentService } from "../environment/service.ts";
import { createNativePreferences } from "../environment/native.ts";
import { createNativeCatalogReader, createNativeSelectionSource } from "../environment/host.ts";
import type { SelectionRequest } from "../environment/selection.ts";
/** One production composition for native tools, authenticated Client and headless management. */
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { SessionId } from "@deepseek-ai/dsh-session";
import { readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WORK_ACTIONS, failure, success, type Actor, type ActorIdentity, type Result, type LearnCommand, type WorkCommand, type OwnerContext, type ProjectSummary } from "../../../modules/ensemble/contracts.ts";
import { ADMIN_PAYLOAD_SCHEMAS } from "../../../modules/ensemble/codec.ts";
import { applyCoordination } from "../../../modules/ensemble/coordination.ts";
import { applyLearning } from "../../../modules/ensemble/learning.ts";
import { projection } from "../../../modules/ensemble/projection.ts";
import { querySnapshot } from "../../../modules/ensemble/query.ts";
import type { ProviderFactories } from "../archive.ts";
import { createArchiveRegistry, ArchiveKernel } from "../store/index.ts";
import { createUploadManager } from "../uploads/index.ts";
import { createArchiveMaintenance, createLocationHandles } from "../maintenance/index.ts";
import type { LocationSelection } from "../maintenance/handles.ts";
import { registerEnsembleTools } from "../tools/index.ts";
import { createNativeBridge } from "./dsh.ts";
import { locationAuthorizer, type LocationWorld } from "./locations.ts";
import { createProductOwner } from "./owner.ts";
import { createOwnerApprovals } from "./approvals.ts";
import { createProductReplicaTransport, parseReplicaDestinations, REPLICA_DESTINATIONS_ENV } from "./replication.ts";
import { selectOwnRows, type ConfigRowLike, type MountFiberLike } from "./mount.ts";

export interface ProductOptions {
  readonly root: string;
  readonly mountFiber?: Context["fiber"];
  readonly hostAuthorityId: string;
  readonly hostWorld: string;
  readonly sourceWorld: string;
  readonly factories: ProviderFactories;
  /** Optional provider-specific capability: the public FileSystem does not expose readlink. */
  readonly sourceReadLink?: (path: string, signal: AbortSignal) => Promise<string>;
}
export function createProduct(ctx: Context, options: ProductOptions) {
  if (![options.root, options.hostAuthorityId, options.hostWorld, options.sourceWorld].every(value => value.trim() !== "")) throw new Error("archive root, Host authority and execution worlds must be explicitly configured");
  const bridge = createNativeBridge(ctx, options.sourceWorld);
  const sourceFs = ctx.fs;
  const sourceScope = ctx[Context.isolate].fs;
  const hostContext = ctx.isolate("fs");
  const hostFs = new LocalFileSystem(hostContext, { cwd: options.root, diffBasisMaxBytes: 10 * 1024 * 1024 });
  /**
   * Is the source world still the one this product was built against?
   *
   * Only the **isolation scope label** is a stable identity: Cordis hands out a
   * fresh service proxy on every `ctx.fs` / `ctx.get("fs")` access, so comparing
   * proxies by identity is always false — measured, not assumed. That comparison
   * made every `choose(kind: "source")` fail with "requires the registered
   * Host-local execution world" while destinations worked, because only the host
   * world's check avoided it. Reading the label and requiring the service to
   * still be present is both stable and sufficient: swapping the provider changes
   * the label, and withdrawing it makes the service absent.
   */
  const source: LocationWorld = { identity: options.sourceWorld, fs: sourceFs, hostLocal: false, current: () => ctx[Context.isolate].fs === sourceScope && ctx.get("fs") !== undefined, ...(options.sourceReadLink ? { readLink: options.sourceReadLink } : {}) };
  const host: LocationWorld = { identity: options.hostWorld, fs: hostFs, hostLocal: true, source: false, current: () => hostContext.get("fs") !== undefined, readLink: async (path, signal) => { signal.throwIfAborted(); return readlink(path); } };
  // When both configured identities are equal, require the native provider to map
  // the Host root before selecting the single Host-local capability.
  if (source.identity === host.identity) {
    if (sourceFs.processPathFromHostPath(options.root) !== options.root) throw new Error("same-world declaration lacks a native Host path mapping");
  }
  // Network replication is a deployment capability, not a code path: without a
  // declared destination map the engine gets no transport, so it reports that a
  // separately approved native network capability is required. Parsed once here
  // so a malformed value fails at boot, where an operator sees it.
  const replicaConfiguration = parseReplicaDestinations(process.env[REPLICA_DESTINATIONS_ENV]);
  if (!replicaConfiguration.ok) throw new Error(`ensemble: ${replicaConfiguration.reason}`);
  const worlds = [source, host];
  // A network replica has no Host-local path: it is selected by the deployment's
  // own destination name, and only a declared name may be issued a capability.
  // Passing the map here is what lets `choose {kind:"replica"}` work at all —
  // without it there is nothing for the authorizer to resolve a remote against.
  const handles = createLocationHandles({
    authorizeSelection: locationAuthorizer(worlds, key => replicaConfiguration.value?.destinations[key]),
  });
  const approvals = createOwnerApprovals();
  let uploads: ReturnType<typeof createUploadManager>;
  const registry = createArchiveRegistry({
    root: options.root, hostAuthorityId: options.hostAuthorityId, worldIdentity: options.hostWorld,
    context: ctx as never, factories: options.factories,
    reducer: (snapshot, command, facts) => (WORK_ACTIONS as readonly string[]).includes(command.action) ? applyCoordination(snapshot, command as WorkCommand, facts) : applyLearning(snapshot, command as LearnCommand, facts),
    projection, query: querySnapshot,
    prepareFacts: async (actor, _snapshot, _command, signal) => {
      if (actor.kind !== "session") return {};
      const caller = ctx.agents.get(SessionId(actor.sessionId));
      const identity = bridge.identity(caller);
      if (identity.rootSessionId !== actor.rootSessionId || identity.workspaceId !== actor.workspaceRef) throw new Error("native session ownership changed");
      return bridge.facts(caller!, signal);
    },
    nativeIdentity: sessionId => {
      try { const value = bridge.identity(ctx.agents.get(SessionId(sessionId))); return { kind: "session", sessionId: value.sessionId, rootSessionId: value.rootSessionId }; }
      catch { return undefined; }
    },
    resolveSealed: (actor, archiveId, invocationId, uploadId, digest) => uploads.resolveSealed(actor, archiveId, invocationId, uploadId, digest),
    validateSource: async (descriptor, signal) => {
      if (descriptor.worldIdentity !== options.sourceWorld || !ctx.workspaceRegistry.list().some(workspace => workspace.id === descriptor.nativeWorkspaceRef)) return failure("not_authorized", "source must name the registered native Workspace and execution world");
      try {
        const target = await sourceFs.resolve(descriptor.canonicalAddress, { signal });
        if (sourceFs.processPath(target) !== descriptor.canonicalAddress || (await sourceFs.stat(target, signal))?.type !== "directory") return failure("invalid_input", "source must name its native canonical directory");
        if (descriptor.nativeSessionRef) {
          const identity = bridge.identity(ctx.agents.get(SessionId(descriptor.nativeSessionRef)));
          if (identity.workspaceId !== descriptor.nativeWorkspaceRef) return failure("not_authorized", "source Session belongs to another Workspace");
        }
        return success(descriptor);
      } catch { return failure("not_authorized", "native source filesystem did not authorize the binding"); }
    },
  });
  uploads = createUploadManager({ root: `${options.root}.uploads`, withAccess: (actor, id, access, signal, run) => registry.withAccess(actor, id, access, signal, run) });
  const kernel = new ArchiveKernel({ context: ctx as never, factories: options.factories });
  const replicaTransport = replicaConfiguration.value === undefined ? undefined : createProductReplicaTransport(ctx, replicaConfiguration.value, { quarantineRoot: `${options.root}.quarantine.replicas` });
  const maintenance = createArchiveMaintenance({ registry, kernel, handles, hostWorld: options.hostWorld, quarantineRoot: `${options.root}.quarantine`, ...(replicaTransport === undefined ? {} : { network: replicaTransport }), verifyApproval: approvals.verify, proveStopped: async (actor, id, head, evidence, signal) => {
    const digest = createHash("sha256").update(JSON.stringify({ archiveId: id, head })).digest("hex");
    if (!await approvals.verify(actor, id, evidence, "stopped-primary", digest, signal)) return false;
    const statement = approvals.evidence(evidence)?.source_stop;
    if (!statement || statement.archive_id !== id || statement.final_head !== head) return false;
    const stopped = await registry.withOwner(actor, id, signal, async lease => success(lease.snapshot.policy.paused && lease.snapshot.revision === head));
    return stopped.ok ? stopped.value : stopped.error.code === "not_found" && statement.mode === "external-owner-handoff";
  } });
  // Which native Settings rows this plugin owns is decided in `./mount`, where it
  // is tested without a Host: a Loader row's `fiber` is a PromiseLike wrapper
  // around the real fiber, so identity has to come from the Loader entry. A
  // duplicate row is refused rather than merged, because two targets claiming one
  // preference namespace have no correct resolution.
  const ownRows = selectOwnRows(
    (ctx.get("configEditor")?.entries() ?? []) as unknown as readonly ConfigRowLike[],
    options.mountFiber as unknown as MountFiberLike | undefined,
  );
  if (!ownRows.ok) throw new Error(`ensemble: ${ownRows.reason}`);
  const nativeTargets = ownRows.ids;
  const settings = ctx.get("settings");
  /**
   * The Host owner actor for reads this plugin performs on its own behalf.
   *
   * It is not a way to gain authority: every call still passes the registry's own
   * owner admission and per-archive lease, and it is used only where the caller is
   * already the authenticated owner (the environment Remote path). Nothing here is
   * reachable from a model tool argument.
   */
  const hostOwner: Actor = { kind: "owner", ownerId: "authenticated-host-owner", hostAuthorityId: options.hostAuthorityId, channel: "authenticated-remote" };

  /**
   * Resolve one attempt's recorded selection from the archive.
   *
   * The owner names only the attempt id; the requested route and the bound member
   * Session are archive facts, so a tool argument cannot claim a route or point
   * the collector at another Session. Only two fields leave this function — the
   * requested selection and the member id — never a record body or a prompt.
   *
   * The member is the **last** `binding_history` entry, not the planned
   * `member_id`: after a `replace` the planned value is stale, and using it would
   * attribute the replaced Session's log to this attempt.
   */
  const resolveAttemptSelection = async (attemptId: string, signal: AbortSignal): Promise<Result<Omit<SelectionRequest, "evidence_id">>> => {
    if (typeof attemptId !== "string" || attemptId.trim() === "") return failure("invalid_input", "an attempt id is required");
    const catalog = await registry.projects(hostOwner, { kind: "projects" }, signal);
    if (!catalog.ok) return catalog;
    for (const project of catalog.value.items as readonly { readonly project_id?: unknown }[]) {
      if (typeof project.project_id !== "string") continue;
      signal.throwIfAborted();
      const target = await registry.readTarget(hostOwner, project.project_id, signal);
      if (!target.ok) continue;
      type AttemptSelection =
        | { readonly kind: "absent" }
        | { readonly kind: "unbound" }
        | { readonly kind: "bound"; readonly value: Omit<SelectionRequest, "evidence_id"> };
      const leased = await registry.withOwner<AttemptSelection>(hostOwner, target.value.archiveId, signal, async lease => {
        const attempt = lease.snapshot.objects.find(object => object.id === attemptId && object.kind === "attempt");
        if (attempt === undefined || attempt.kind !== "attempt") return success({ kind: "absent" });
        const last = attempt.body.binding_history.at(-1);
        if (last === undefined) return success({ kind: "unbound" });
        return success({ kind: "bound", value: { attempt_id: attemptId, member_session_id: last.member_id, requested: { ...(attempt.body.requested_selection ?? {}) } } });
      });
      if (!leased.ok) return leased;
      if (leased.value.kind === "absent") continue;
      if (leased.value.kind === "unbound") return failure("not_found", "this attempt has no bound member Session yet; bind it before recording selection evidence");
      return success(leased.value.value);
    }
    return failure("not_found", "no readable archive holds that attempt");
  };

  const environment = settings && nativeTargets.length ? createEnvironmentService({
    root: `${options.root}.environment`, hostAuthorityId: options.hostAuthorityId, context: ctx as never, factories: options.factories,
    native: createNativePreferences(settings as never, nativeTargets),
    locations: { handles, hostWorld: options.hostWorld, protectedRoots: [options.root] },
    // Trusted selection evidence: the log source is the published Session query,
    // and the request facts come from the archive record, never from an argument.
    selection: { source: createNativeSelectionSource(ctx), resolve: resolveAttemptSelection },
  }) : undefined;
  const catalog = createNativeCatalogReader(ctx);
  const capabilities = ["read", ...Object.keys(ADMIN_PAYLOAD_SCHEMAS)];
  const owner = createProductOwner({
    environment: (actor, request, signal) => environment?.execute(actor, request, signal) ?? Promise.resolve(failure("storage_unavailable", "native Settings target is not available")),
    hostAuthorityId: options.hostAuthorityId, ownerId: "authenticated-host-owner", authorizationRefreshMs: 1000,
    // Only the deployment's own declared names, and only the non-secret fields a
    // picker needs. The URL and the credential reference stay on this side: they
    // are deployment facts, and a browser has no use for either.
    //
    // With no declared destinations this refuses rather than answering `[]`. An
    // empty list is indistinguishable from "the read is not wired", and a picker
    // showing an empty dropdown sends the user back to guessing a key — which is
    // the problem this method exists to remove.
    destinations: async () => replicaConfiguration.value === undefined
      ? failure("storage_unavailable", "this Host declares no network replica destinations")
      : success(Object.entries(replicaConfiguration.value.destinations).map(([key, destination]) => ({ key, identity: destination.identity }))),
    projects: async (actor, signal) => {
      const context = await registry.context(actor, signal); if (!context.ok) return context;
      const locations = await handles.list(actor, signal);
      // The owner this response is for, taken from the actor the guard already
      // admitted — never from the request. Narrowed on `kind` and rebuilt from its
      // three owner fields rather than asserted, so a session actor reaching here is
      // a type error instead of a cast away.
      if (actor.kind !== "owner") return failure("not_authorized", "owner context requires an authenticated owner");
      const current_owner: Extract<ActorIdentity, { kind: "owner" }> = { kind: "owner", ownerId: actor.ownerId, hostAuthorityId: actor.hostAuthorityId };
      return success({ ...context.value, capabilities, current_owner, projects: context.value.projects.map(project => ({ ...project, capabilities })), source_handles: locations.filter(item => item.kind === "source").map(item => item.handle), destination_handles: locations.filter(item => item.kind === "destination").map(item => item.handle) } satisfies OwnerContext);
    },
    query: async (actor, query, signal) => {
      if (query.kind === "projects") return registry.projects(actor, query, signal);
      if (!query.project_id) return failure("invalid_input", "owner query requires project_id");
      const target = await registry.readTarget(actor, query.project_id, signal); if (!target.ok) return target;
      const answer = await registry.query(actor, target.value, query, signal);
      if (!answer.ok || query.kind !== "context") return answer;
      return success({ ...answer.value, items: answer.value.items.map(item => ({ ...item, capabilities } as ProjectSummary)) });
    },
    manage: (actor, request, signal) => maintenance.execute(actor, request, signal),
    choose: (actor, request, signal) => handles.choose(actor, request as LocationSelection, signal),
    approve: async (actor, request, signal) => {
      if (request.candidate_id) {
        const candidate = maintenance.history.candidateInfo(request.candidate_id);
        if (!candidate || candidate.candidate.backupDigest !== request.target_digest) return failure("not_authorized", "approval does not name this Host's exact verified recovery candidate");
        return approvals.issue(actor, candidate.candidate.identity.archiveId, request);
      }
      if (request.source_stop) {
        const stop = request.source_stop;
        const digest = createHash("sha256").update(JSON.stringify({ archiveId: stop.archive_id, head: stop.final_head })).digest("hex");
        if (request.target_digest !== digest) return failure("invalid_input", "source stop digest differs from the exact final-head statement");
        return approvals.issue(actor, stop.archive_id, request);
      }
      const target = await registry.resolveProject(actor, request.project_id, signal); if (!target.ok) return target;
      return approvals.issue(actor, target.value.archiveId, request);
    },
    subscribe: listener => registry.subscribe(listener),
  });
  registerEnsembleTools(ctx, {
    authority: exec => bridge.actor(exec.agent, exec.callId),
    assertCurrent: (exec, call) => bridge.assertCurrent(exec.agent, call.identity),
    resolve: async (call, projectId, signal) => projectId ? registry.readTarget(call.actor, projectId, signal) : registry.resolve(call.actor, { worldIdentity: call.identity.worldIdentity, nativeWorkspaceRef: call.identity.workspaceId, sessionId: call.actor.sessionId, rootSessionId: call.actor.rootSessionId }, signal),
    archive: registry,
    environment: async (call, query, exec) => {
      if (!environment || nativeTargets.length !== 1) return failure("storage_unavailable", "environment requires one active native Settings target");
      const found = await (await catalog)(exec.agent!, exec.signal); if (!found.ok) return found;
      bridge.assertCurrent(exec.agent, call.identity);
      return environment.recommend(call.actor, query.role, query.task_context, found.value, nativeTargets[0]!, exec.signal);
    },
    projects: (call, query, signal) => registry.projects(call.actor, query, signal),
    upload: (actor, id, command, signal) => uploads.execute(actor, id, command, signal),
  });
  ctx.effect(() => () => { environment?.dispose(); handles.dispose(); approvals.dispose(); registry.dispose(); kernel.dispose(); });
  return { owner, registry, maintenance, handles, bridge, approvals };
}
