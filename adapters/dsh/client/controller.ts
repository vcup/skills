import { ClientFailure, decodeDestinations, decodePage, decodeOwner, failureOf, json, record, unwrap, type ArchiveRemote, type WatchHandle, type Failure, type Fields, type Page, type ProjectCard, type Query, type OwnerContext } from "./protocol.ts";

export type View = "work" | "materials" | "reading" | "lessons" | "history" | "projects" | "maintenance";
/**
 * Where the operation-recovery state machine is.
 *
 * `awaiting` — the outcome is unknown and the key is held; nothing may be written.
 * `revalidating` — re-establishing the current owner/session/project before reading.
 * `denied` — the Host refuses current access; the key is *kept* so a later revalidation
 *   (after refreshing or selecting a project) can still settle the operation.
 * `settled` — the Host's receipt was read under current authority and is authoritative.
 */
export type RecoveryPhase = "awaiting" | "revalidating" | "denied" | "settled";
export interface Preview {
  readonly request: Fields;
  readonly project_id: string;
  readonly authorization_epoch: number;
  readonly revision: string;
}
export interface Snapshot {
  readonly connected: boolean;
  readonly watching: boolean;
  readonly status: "disconnected" | "loading" | "ready" | "denied" | "error";
  readonly projects: readonly ProjectCard[];
  readonly owner?: OwnerContext;
  readonly location?: Fields;
  readonly approval?: Fields;
  readonly environment?: Fields;
  readonly environmentPreview?: Fields;
  readonly environmentPending?: Fields;
  readonly environmentResult?: Fields;
  readonly environmentBusy?: boolean;
  readonly environmentUncertain?: string;
  readonly selected?: ProjectCard;
  readonly view: View;
  readonly query?: Query;
  readonly page?: Page;
  readonly loading: boolean;
  readonly error?: Failure;
  readonly preview?: Preview;
  readonly submitting: boolean;
  readonly result?: Fields;
  readonly newer_revision?: string;
  readonly uncertain_operation?: string;
  readonly uncertain_project?: string;
  /**
   * Where the operation-recovery state machine is, when a write's outcome is unconfirmed.
   *
   * Kept separate from `uncertain_operation` on purpose: the operation key is the
   * non-sensitive handle that survives a revocation, while `recovery` describes what the
   * Client is currently able to say about it. A denied status must not strand the key.
   */
  readonly recovery?: RecoveryPhase;
  readonly recoveryError?: Failure;
  /** Owner-visible grant identities from a real `diagnose`, so `revoke` can name one. */
  readonly grants?: readonly Fields[];
  /** Restore candidates the Host actually quarantined, so activation can name one. */
  readonly candidates?: readonly Fields[];
  /**
   * Declared network replica destinations, or `undefined` before the read.
   *
   * `destinationsState` distinguishes three things a plain array cannot: the read
   * has not happened, the Host declares none (`unconfigured` — network replication
   * is not set up), or the list is usable. An empty array alone would be
   * indistinguishable from an unwired read, which is how a picker ends up silently
   * offering nothing and a user starts guessing keys.
   */
  readonly destinations?: readonly { readonly key: string; readonly identity: string }[];
  readonly destinationsState?: "available" | "unconfigured";
  /**
   * Native Workspace choices for the source picker.
   *
   * This lives in the controller rather than being computed inside the slot's `inject()`
   * thunk because that thunk is evaluated **once** per registration: a registry that
   * arrives later would update the underlying value but never re-render the panel, so a
   * user would see "no native Workspace" on a Host that has one. Publishing it as state
   * puts it on the same observable path the rest of the panel already uses.
   */
  readonly workspaces?: { readonly available: boolean; readonly choices: readonly { readonly workspace_id: string; readonly title: string; readonly path: string }[] };
}
const initial = (): Snapshot => ({ connected: false, watching: false, status: "disconnected", projects: [], view: "work", loading: false, submitting: false });
const unauthorized = (code: string): boolean => ["not_authorized", "owner_required", "authorization_changed", "permission_denied"].includes(code);

/** One lifetime owns snapshots, authorization, navigation, pagination and pending writes.
 * Transport cancellation is deliberately not called rollback: uncertain writes keep a receipt id.
 */
export class WorkspaceController {
  private state: Snapshot = initial();
  private listeners = new Set<() => void>();
  private lifetime = 0;
  private request = 0;
  private catalogRequest = 0;
  private disposed = false;
  private watchHandle?: WatchHandle;
  private watchGeneration = 0;
  private environmentGeneration = 0;
  /**
   * The write this controller has in flight, and — once the Host has answered — the
   * revision it committed.
   *
   * An owner write that changes the authorization epoch makes the archive's own watch
   * report a new epoch, and that must not erase the confirmation of the write that caused
   * it. Attribution is by *proven* causality, not by "a write was pending":
   *
   * - an epoch notification that arrives **before** the Host's answer cannot be our
   *   write's effect (we have no confirmation yet), so it is foreign and clears
   *   everything;
   * - one that arrives **after** the answer is ours only when its `read_revision` equals
   *   the revision the Host said it committed.
   *
   * That is why `committedRevision` is recorded here rather than a boolean flag: a flag
   * would excuse a real revocation that happened to land during a write.
   *
   * `authorityChanged` is deliberately **phase-independent**: it records that authority
   * moved on the other channel while this exact write was registered — the watch and the
   * management RPC are independent, so it may arrive before the answer, after it, or
   * during the refresh that follows it. It never means "our write was authorised": it
   * means current access has not been re-established yet, and protected content must not
   * be shown until the Host is asked again.
   */
  private pendingWrite?: { readonly operationId: string; readonly projectId: string; committedRevision?: string; readonly authorityChanged?: boolean };
  constructor(private readonly remote: ArchiveRemote, private readonly operationId: () => string = () => crypto.randomUUID()) {}
  readonly getSnapshot = (): Snapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<Snapshot>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private clear(status: Snapshot["status"], error?: Failure): void {
    ++this.lifetime; ++this.request; ++this.environmentGeneration;
    // A catalogue read is authority state, so disconnect/denial/unload must supersede it:
    // a late answer may not republish an owner it is no longer allowed to speak for.
    ++this.catalogRequest;
    // Every caller of `clear` is a foreign supersession (disconnect, denial, another
    // project, unload), so an in-flight write can no longer be reported against it.
    this.pendingWrite = undefined;
    this.stopWatch();
    this.publish({ status, projects: [], owner: undefined, location: undefined, approval: undefined, environment: undefined, environmentPreview: undefined, environmentPending: undefined, environmentResult: undefined, environmentBusy: false, selected: undefined, page: undefined, preview: undefined, result: undefined, query: undefined,
      loading: false, watching: false, submitting: false, newer_revision: undefined, grants: undefined, candidates: undefined, error });
  }
  async connection(connected: boolean): Promise<void> {
    if (this.disposed) return;
    this.clear(connected ? "loading" : "disconnected");
    this.publish({ connected });
    if (connected) await this.refreshProjects();
  }
  /**
   * Read the owner catalogue, which is *authority* state: who may read, and which projects
   * exist. It is deliberately fenced by `catalogRequest`, not by the selection lifetime.
   *
   * Selection and authority move for different reasons. A user picking a project from the
   * still-usable cached options bumps the selection lifetime (rightly — an in-flight page
   * read belongs to the old selection), but that must not cancel the archive's authority
   * read: doing so stranded `status` in "loading" with no owner, and silently dropped a
   * refusal that arrived afterwards. So only a newer catalogue request, or a genuine
   * authority boundary (`clear`, `invalidate`, `dispose`), supersedes this read.
   *
   * The selection is re-derived from `state.selected` *after* the await, so whatever the user
   * has chosen by then is what gets adopted.
   */
  async refreshProjects(options: { ownWrite?: boolean } = {}): Promise<void> {
    if (!this.state.connected || this.disposed) return;
    const request = ++this.catalogRequest;
    this.publish({ status: "loading", error: undefined });
    try {
      const owner = decodeOwner(await this.remote.projects({}));
      const projects = owner.projects;
      if (request !== this.catalogRequest || this.disposed) return;
      const prior = this.state.selected;
      const selected = projects.find(item => item.project_id === prior?.project_id);
      if (prior && (!selected || selected.authorization_epoch !== prior.authorization_epoch)) {
        ++this.lifetime; ++this.request;
        this.stopWatch();
        // An epoch change caused by this controller's own committed write is not a
        // revocation: the confirmation of that write is still true, so it survives the
        // revalidation. A foreign epoch change still clears it.
        this.publish({ page: undefined, query: undefined, preview: undefined, ...(options.ownWrite === true ? {} : { result: undefined }), loading: false, newer_revision: undefined });
      }
      this.publish({ owner, projects, selected, status: "ready",
        ...(selected && prior && selected.read_revision !== prior.read_revision ? { newer_revision: selected.read_revision } : {}) });
      if (selected && !this.watchHandle) this.startWatch(selected);
    } catch (error) {
      if (request !== this.catalogRequest || this.disposed) return;
      const failure = failureOf(error);
      this.clear(unauthorized(failure.code) ? "denied" : "error", failure);
    }
  }
  /**
   * Select a project. Re-selecting the project already selected is a no-op.
   *
   * Idempotence is judged on the *whole* selection, not the id: when the catalogue now reports
   * a different `authorization_epoch` or `read_revision` for the same id, that is a new
   * authority context and must be adopted exactly as before. Only a candidate identical to the
   * current selection takes the early return — reopening the same project must not churn the
   * lifetime or tear down a live watch.
   */
  select(projectId: string): void {
    const selected = this.state.projects.find(item => item.project_id === projectId);
    if (!selected || !this.state.connected) return;
    const prior = this.state.selected;
    if (prior !== undefined && prior.project_id === selected.project_id
      && prior.authorization_epoch === selected.authorization_epoch && prior.read_revision === selected.read_revision) return;
    ++this.lifetime; ++this.request;
    // Selecting another project is a foreign supersession: an in-flight write's answer
    // must not be reported against a different project.
    if (this.pendingWrite !== undefined && this.pendingWrite.projectId !== selected.project_id) this.pendingWrite = undefined;
    this.stopWatch();
    this.publish({ selected, approval: undefined, page: undefined, query: undefined, preview: undefined, result: undefined, error: undefined, loading: false, newer_revision: undefined });
    this.startWatch(selected);
  }
  private stopWatch(): void { ++this.watchGeneration; this.watchHandle?.dispose(); this.watchHandle = undefined; this.publish({ watching: false }); }
  private startWatch(project: ProjectCard): void {
    const token = ++this.watchGeneration;
    void (async () => {
      try {
        const handle = this.remote.watch({ project_id: project.project_id });
        this.watchHandle = handle;
        for await (const frame of handle) {
          if (token !== this.watchGeneration || this.disposed) return;
          const event = unwrap(frame);
          if (event.project_id !== project.project_id || event.authorization_epoch !== project.authorization_epoch) { this.invalidate(typeof event.read_revision === "string" ? event.read_revision : undefined); return; }
          if (typeof event.read_revision !== "string") throw new ClientFailure({ code: "invalid_response", message: "Invalid archive notification." });
          this.publish({ watching: true, ...(event.read_revision !== project.read_revision ? { newer_revision: event.read_revision } : {}) });
        }
        if (token === this.watchGeneration && !this.disposed) this.clear("error", { code: "watch_ended", message: "Archive access monitoring stopped. Refresh access before continuing." });
      } catch (error) { if (token === this.watchGeneration && !this.disposed) this.clear("error", failureOf(error)); }
    })();
  }
  /**
   * Change the visible view. Repeating the view that is already shown is a no-op.
   *
   * The tab bar calls this for every click, including the current tab. The read that fills a
   * view is triggered by a change of `view`/`project_id`, so bumping the request token and
   * clearing `page`/`query` here would blank an already-rendered view with nothing scheduled
   * to re-fill it — and would discard an answer still in flight. Navigating to a *different*
   * view keeps its existing meaning: cached content is cleared and in-flight reads are
   * cancelled. An explicit refresh is `refreshView()`, a deliberately separate intent.
   */
  navigate(view: View): void {
    if (view === this.state.view) return;
    ++this.request;
    this.publish({ view, query: undefined, page: undefined, preview: undefined, result: undefined, loading: false, error: undefined });
  }
  async read(query: Query, next = false): Promise<void> {
    const project = this.state.selected;
    if (!project || !this.state.connected || this.disposed || (next && (this.state.loading || !this.state.page?.next_cursor))) return;
    const generation = this.lifetime, request = ++this.request;
    const previous = this.state.page;
    // Only a caller's explicit refresh can advance a snapshot. Continuations reuse its exact query.
    const base = next ? this.state.query! : query;
    const revision = next ? previous!.read_revision : "revision" in query && typeof query.revision === "string" ? query.revision : project.read_revision;
    const pinned = !["receipt", "context", "projects", "environment_preferences"].includes(String(base.kind));
    const input = { ...base, project_id: project.project_id, ...(pinned ? { revision } : {}), ...(next ? { cursor: previous!.next_cursor! } : {}) };
    this.publish({ loading: true, error: undefined, ...(!next ? { page: undefined, query: base } : {}) });
    try {
      const page = decodePage(await this.remote.query(json(input) as Fields));
      if (generation !== this.lifetime || request !== this.request || this.disposed) return;
      if (page.authorization_epoch !== project.authorization_epoch) {
        this.clear("denied", { code: "authorization_changed", message: "Permissions changed. Refresh projects before reading again." }); return;
      }
      if (pinned && page.read_revision !== revision) throw new ClientFailure({ code: "snapshot_mismatch", message: "The archive returned a different snapshot. Open the view again." });
      // Bound the rendered page collection; a continuation replaces a content byte page (never concatenates partial UTF-8).
      const bytePage = base.kind === "artifact" || base.kind === "object";
      const items = next && !bytePage ? [...previous!.items, ...page.items] : page.items;
      if (items.length > 1000) throw new ClientFailure({ code: "budget_exceeded", message: "Refine the query to show fewer than 1,000 records." });
      this.publish({ loading: false, page: { ...page, items } });
    } catch (error) {
      if (generation !== this.lifetime || request !== this.request || this.disposed) return;
      const failure = failureOf(error);
      if (unauthorized(failure.code)) this.clear("denied", failure);
      else this.publish({ loading: false, error: failure });
    }
  }
  async refreshView(): Promise<void> {
    const selected = this.state.selected, query = this.state.query;
    await this.refreshProjects();
    if (selected && query && this.state.selected?.project_id === selected.project_id) {
      const fresh = { ...query };
      if ("revision" in fresh) delete fresh.revision;
      if ("cursor" in fresh) delete fresh.cursor;
      this.publish({ newer_revision: undefined });
      await this.read(fresh);
    }
  }
  /**
   * Push notifications never grant permission; they only invalidate cached authority.
   *
   * The watch and the management RPC are **independent async channels**, so arrival order
   * proves nothing: the Host can commit, the watch can deliver the new epoch, and the RPC
   * answer can still arrive afterwards. Therefore a notification is never classified as
   * "foreign" by timing:
   *
   * - protected content is cleared in every case, because it was read under the previous
   *   authority and must not be shown after authority moved;
   * - the *pending write is kept*, because only the RPC answer can say whether our
   *   operation committed. Discarding it here is what would lose a legitimate write;
   * - the notification is attributed to our write only when the Host has already confirmed
   *   a commit and the notification names that exact immutable revision, and even then it
   *   proves the *commit fact* only — current access is re-established separately by
   *   revalidating the archive/project/subject with the Host.
   */
  invalidate(readRevision?: string): void {
    const own = this.pendingWrite;
    const attributed = own?.committedRevision !== undefined && readRevision === own.committedRevision;
    ++this.lifetime; ++this.request;
    // Authority moved: an in-flight catalogue read must not restore the catalogue afterwards.
    ++this.catalogRequest;
    this.stopWatch();
    this.publish({ status: "denied", projects: [], owner: undefined, selected: undefined, page: undefined, query: undefined, preview: undefined,
      loading: false, watching: false, newer_revision: undefined, grants: undefined, candidates: undefined,
      ...(attributed ? {} : { result: undefined }),
      error: { code: "authorization_changed", message: "Archive access changed. Refresh projects to revalidate access." } });
    // Keep the registration and record that current authority still has to be
    // re-established. This is not conditional on the notification arriving *before* the
    // RPC answer: either channel may win, and the answer itself may already be in hand when
    // the watch frame lands. Dropping this on the attributed path is what stranded a
    // genuinely committed write in `denied`.
    if (own !== undefined) this.pendingWrite = { ...own, authorityChanged: true };
  }
  canManage(action: string): boolean {
    const state = this.state;
    return state.connected && state.status === "ready" && !state.submitting && !state.uncertain_operation
      && (action === "initialize" ? state.owner?.capabilities.includes(action) === true : state.watching && !!state.selected && state.selected.capabilities.includes(action));
  }
  /**
   * Choose an owner location.
   *
   * Two shapes, and they are not interchangeable: a filesystem location names an
   * absolute `path`, while a network replica names a deployment-declared
   * `destinationKey` and **must not carry a path** (the Host refuses a replica
   * selection that has one, and refuses an undeclared key). Building the request
   * here — rather than letting a caller pass a loose object — is what keeps the UI
   * from sending a shape that can only be rejected.
   */
  async choose(kind: string, selection: { path?: string; world: string; destinationKey?: string }): Promise<void> {
    if (!this.state.connected || !this.state.owner || this.state.submitting) return;
    const generation = this.lifetime;
    const request: Record<string, string> = { kind, world: selection.world };
    if (kind === "replica") {
      if (typeof selection.destinationKey !== "string" || selection.destinationKey === "") {
        this.publish({ error: { code: "invalid_input", message: "A network replica needs a declared destination name; an absolute path cannot identify a remote archive." } });
        return;
      }
      request.destinationKey = selection.destinationKey;
    } else {
      if (typeof selection.path !== "string" || selection.path.trim() === "") {
        this.publish({ error: { code: "invalid_input", message: "This location kind needs an absolute path in the selected execution world." } });
        return;
      }
      request.path = selection.path;
    }
    try {
      const location = json(unwrap(await this.remote.choose(request))) as Fields;
      if (generation !== this.lifetime || this.disposed) return;
      this.publish({ location }); await this.refreshProjects();
    } catch (error) { if (generation === this.lifetime) this.publish({ error: failureOf(error) }); }
  }
  async readEnvironment(request: Fields = { action: "environment_read" }): Promise<void> {
    if (!this.state.owner || !this.state.connected || this.state.environmentBusy) return;
    const generation = this.environmentGeneration;
    this.publish({ environmentBusy: true, error: undefined });
    try {
      const value = json(unwrap(await this.remote.environment(request))) as Fields;
      if (generation !== this.environmentGeneration || this.disposed) return;
      this.publish({ environmentBusy: false, ...(request.action === "environment_read" ? { environment: value } : { environmentPreview: value }) });
    } catch (error) { if (generation === this.environmentGeneration) { const failure = failureOf(error); this.publish({ environmentBusy: false, error: failure, ...(!["outcome_unknown", "connection_lost"].includes(failure.code) ? { environmentUncertain: undefined } : {}) }); if (unauthorized(failure.code)) this.clear("denied", failure); } }
  }
  prepareEnvironment(input: Fields): void {
    if (!this.state.owner || !this.state.connected || this.state.environmentBusy) return;
    if (this.state.environmentUncertain && input.action !== "environment_reconcile") { this.publish({ error: { code: "outcome_unknown", message: "Reconcile the previous environment application before another write." } }); return; }
    const expected = this.state.environment?.read_revision;
    if (typeof expected !== "string" && input.action !== "environment_set") return;
    this.publish({ environmentPending: { ...json(input) as Fields, expected_revision: typeof expected === "string" ? expected : "absent", operation_id: this.operationId() }, error: undefined });
  }
  cancelEnvironment(): void { this.publish({ environmentPending: undefined }); }
  async submitEnvironment(): Promise<void> {
    const request = this.state.environmentPending;
    if (!request || !this.state.owner || !this.state.connected || this.state.environmentBusy || request.expected_revision !== (this.state.environment?.read_revision ?? "absent")) return;
    const generation = this.environmentGeneration;
    this.publish({ environmentBusy: true, environmentUncertain: String(request.operation_id), error: undefined });
    try {
      const result = json(unwrap(await this.remote.environment(request))) as Fields;
      if (generation !== this.environmentGeneration || this.disposed) return;
      if (result.status !== "committed") throw new ClientFailure({ code: "outcome_unknown", message: "Read environment application state and reconcile before another operation." });
      this.publish({ environmentBusy: false, environmentPending: undefined, environmentPreview: undefined, environmentResult: result, environmentUncertain: undefined });
      await this.readEnvironment();
    } catch (error) { if (generation === this.environmentGeneration) { const failure = failureOf(error); this.publish({ environmentBusy: false, error: failure, ...(!["outcome_unknown", "connection_lost"].includes(failure.code) ? { environmentUncertain: undefined } : {}) }); if (unauthorized(failure.code)) this.clear("denied", failure); } }
  }
  async approve(request: Fields): Promise<void> {
    const selected = this.state.selected;
    if (!this.state.owner || !selected || !this.state.connected || !this.state.watching || this.state.status !== "ready") return;
    const generation = this.lifetime;
    try {
      const approval = json(unwrap(await this.remote.approve({ ...request, project_id: selected.project_id }))) as Fields;
      if (generation === this.lifetime && !this.disposed) this.publish({ approval, error: undefined });
    } catch (error) { if (generation === this.lifetime) this.publish({ error: failureOf(error) }); }
  }
  prepare(action: string, payload: Fields): void {
    if (!this.canManage(action)) { this.publish({ error: { code: "not_authorized", message: "Reconnect and obtain this management capability before submitting." }, preview: undefined }); return; }
    const selected = this.state.selected;
    const initializing = action === "initialize";
    const request: Fields = { ...(!initializing ? { project_id: selected!.project_id } : {}), action, payload: json(payload), expected_revision: initializing ? "absent" : selected!.read_revision, operation_id: this.operationId() };
    this.publish({ preview: { request, project_id: initializing ? "" : selected!.project_id, authorization_epoch: initializing ? 0 : selected!.authorization_epoch, revision: initializing ? "absent" : selected!.read_revision }, error: undefined, result: undefined });
  }
  cancelPreview(): void { this.publish({ preview: undefined }); }
  async submit(): Promise<void> {
    const preview = this.state.preview, project = this.state.selected;
    const initializing = preview?.request.action === "initialize";
    if (!preview || !this.canManage(String(preview.request.action)) || !initializing && (!project || preview.project_id !== project.project_id
      || preview.authorization_epoch !== project.authorization_epoch || preview.revision !== project.read_revision)) {
      this.publish({ preview: undefined, error: { code: "preview_expired", message: "The project or permissions changed. Review a new preview." } }); return;
    }
    const generation = this.lifetime;
    const operation = String(preview.request.operation_id);
    this.publish({ submitting: true, uncertain_operation: operation, uncertain_project: preview.project_id, error: undefined });
    // Register the write *before* awaiting it, so an epoch notification that lands while
    // the call is pending is attributable to this operation and not to a foreign
    // revocation. Keyed by operation id and project: a second submit cannot inherit it.
    this.pendingWrite = { operationId: operation, projectId: preview.project_id };
    try {
      const result = unwrap(await this.remote.manage(preview.request));
      // The write's own effect can land before this call resumes: a pause/resume changes
      // the authorization epoch, the watch reports it, and `invalidate()` bumps `lifetime`
      // by design. That must still not discard the confirmation of the write that caused
      // it. Only a supersession of *this* operation's pending registration, or disposal,
      // may drop the answer.
      const superseded = this.disposed
        || (generation !== this.lifetime && !this.ownsPending(operation, preview.project_id));
      if (superseded) return;
      if (result.status !== "committed") throw new ClientFailure({ code: "outcome_unknown", message: "The archive did not confirm the commit. Read the operation receipt." });
      const committedRevision = typeof result.committed_revision === "string" ? result.committed_revision : undefined;
      // The commit is a fact, so it is recorded and shown. Keep every other field of the
      // registration too: an earlier notification may already have marked that authority
      // moved, and rebuilding this object from scratch would silently forget that.
      if (this.pendingWrite?.operationId === operation) {
        this.pendingWrite = { ...this.pendingWrite, ...(committedRevision === undefined ? {} : { committedRevision }) };
      }
      this.publish({ submitting: false, uncertain_operation: undefined, preview: undefined, page: undefined, result: json(result) as Fields });
      await this.refreshProjects({ ownWrite: true });
      // Read the registration *after* that await, never before it: the notification proving
      // authority moved may have arrived during the refresh, and that is exactly the arrival
      // order that was missed. Ownership is re-checked here too, so a supersession (another
      // project, a clear, disposal) that dropped the registration is never revalidated back
      // to life. The project is the operation's own, not whatever is selected now.
      //
      // `initialize` has no project to revalidate: the refresh above is already the
      // re-establishment, and a catalogue lookup for the empty id could only fail.
      if (preview.project_id !== "" && this.ownsChanged(operation, preview.project_id)) await this.revalidateAfterOwnWrite(preview.project_id, committedRevision);
    } catch (error) {
      if (generation !== this.lifetime || this.disposed) return;
      const failure = failureOf(error);
      if (unauthorized(failure.code)) { this.publish({ uncertain_operation: undefined }); this.clear("denied", failure); }
      else this.publish({ submitting: false, error: failure, ...(failure.code !== "outcome_unknown" && failure.code !== "connection_lost" ? { uncertain_operation: undefined } : {}) });
    } finally {
      // Scoped to this write only: a later epoch change is foreign again.
      if (this.pendingWrite?.operationId === operation) this.pendingWrite = undefined;
    }
  }
  /** Whether the given write is still the one this controller has in flight. */
  private ownsPending(operationId: string, projectId: string): boolean {
    return this.pendingWrite?.operationId === operationId && this.pendingWrite.projectId === projectId;
  }
  /** Whether that same write is registered *and* authority has moved since it started. */
  private ownsChanged(operationId: string, projectId: string): boolean {
    return this.ownsPending(operationId, projectId) && this.pendingWrite?.authorityChanged === true;
  }
  /**
   * Re-establish current authority after authority moved while our own write was registered.
   *
   * The commit is a fact (the Host said so, and the revision is immutable), but that fact
   * does not prove this owner may still read the archive. So the catalogue is read again
   * and, if the project is still listed, the view is re-read under the fresh epoch. If it
   * is gone, the Client says access changed and shows nothing protected — it does not
   * keep a dead selection. No `manage` call is made: recovery never risks a second write.
   */
  private async revalidateAfterOwnWrite(projectId: string, committedRevision: string | undefined): Promise<void> {
    const generation = this.lifetime;
    try {
      const owner = decodeOwner(await this.remote.projects({}));
      if (generation !== this.lifetime || this.disposed) return;
      // The operation's own project, never whatever is selected now: an invalidation clears
      // the selection, and a later selection would make this revalidate — and potentially
      // show — the wrong project. A supersession during the await bumps the lifetime and
      // returns above, so a late answer cannot restore an abandoned project either.
      const current = owner.projects.find(item => item.project_id === projectId);
      if (current === undefined) {
        this.publish({ owner, projects: owner.projects, selected: undefined, status: "denied", watching: false,
          recovery: "denied", recoveryError: { code: "not_authorized", message: "This archive is no longer available to this owner. The committed revision was recorded." } });
        return;
      }
      // `error` is cleared too: the denial banner was raised when authority moved, and it is
      // stale the moment access is re-established. On this path there is no later refresh to
      // clear it, so leaving it set renders "ready" and an `authorization_changed` alert at
      // the same time.
      this.publish({ owner, projects: owner.projects, selected: current, status: "ready", watching: this.state.watching,
        recovery: "settled", recoveryError: undefined, error: undefined,
        ...(committedRevision === undefined ? {} : { newer_revision: committedRevision }) });
      if (!this.watchHandle) this.startWatch(current);
    } catch (error) {
      if (generation !== this.lifetime || this.disposed) return;
      const failure = failureOf(error);
      if (unauthorized(failure.code)) {
        this.publish({ status: "denied", projects: [], owner: undefined, selected: undefined, watching: false,
          recovery: "denied", recoveryError: failure });
        return;
      }
      this.publish({ recoveryError: failure });
    }
  }
  /**
   * Settle an unconfirmed write by reading its receipt **under current authority**.
   *
   * The operation key is non-sensitive and survives a revocation, so it is never dropped
   * just because the archive moved to `denied`. What must not happen is reading the
   * receipt and accepting its payload without first re-establishing that this owner,
   * session and project are currently allowed to see it — that would be a check-then-
   * unprotected-publish, and it would let an external revocation leak protected data.
   *
   * The state machine is: revalidate (fresh owner catalogue + epoch for this exact
   * project) → if current access is refused, keep the key and say so → otherwise read the
   * receipt and accept only `committed` for this operation → then read the view again so
   * content is shown from a snapshot taken under current authority. No `manage` call is
   * ever issued here: recovery must not risk a second write.
   */
  async receipt(): Promise<void> {
    const operation = this.state.uncertain_operation;
    const projectId = this.state.uncertain_project;
    if (operation === undefined || projectId === undefined) return;
    if (!this.state.connected || this.disposed) return;
    const generation = this.lifetime;
    this.publish({ recovery: "revalidating", recoveryError: undefined });
    try {
      const owner = decodeOwner(await this.remote.projects({}));
      if (generation !== this.lifetime || this.disposed) return;
      const current = owner.projects.find(item => item.project_id === projectId);
      if (current === undefined) {
        // Current authority does not include this project at all. The key is kept so that
        // refreshing or selecting the project again can still settle it; nothing is shown.
        this.publish({ owner, projects: owner.projects, selected: undefined, status: "denied", watching: false,
          recovery: "denied", recoveryError: { code: "not_authorized", message: "This project is not currently available to this owner. The operation key is kept." } });
        return;
      }
      // Fresh epoch/authority for the same project, adopted before anything is read.
      const selected = current;
      const page = decodePage(await this.remote.query({ kind: "receipt", project_id: projectId, operation_id: operation }));
      if (generation !== this.lifetime || this.disposed) return;
      // Re-check after the await: the authority may have moved again while reading.
      const committed = page.items.find(item => item.operation_id === operation && item.status === "committed");
      this.publish({ owner, projects: owner.projects, selected, status: "ready", watching: this.state.watching,
        page, recovery: "settled",
        ...(committed === undefined
          ? { recoveryError: { code: "outcome_unknown", message: "The Host has no committed receipt for this operation yet. The key is kept; nothing was re-sent." } }
          : { uncertain_operation: undefined, uncertain_project: undefined, preview: undefined, result: committed, recoveryError: undefined }) });
      if (committed !== undefined && !this.watchHandle) this.startWatch(selected);
    } catch (error) {
      if (generation !== this.lifetime || this.disposed) return;
      const failure = failureOf(error);
      // A refusal is not a licence to show anything: keep the key, report the phase, and
      // let the user refresh or select another project to revalidate.
      if (unauthorized(failure.code)) {
        this.publish({ status: "denied", projects: [], owner: undefined, selected: undefined, watching: false,
          recovery: "denied", recoveryError: failure });
        return;
      }
      this.publish({ recovery: "awaiting", recoveryError: failure });
    }
  }
  /**
   * Read the owner-visible grant identities from the Host.
   *
   * `revoke` needs the exact opaque grant id, and no other owner surface names one;
   * `diagnose` is the Host's own answer, so the Client lists what the archive
   * actually holds instead of asking an operator to guess. This is a read: it
   * commits nothing and needs no preview.
   */
  async grants_(): Promise<void> {
    const project = this.state.selected;
    if (!project || !this.state.connected || !this.canManage("diagnose")) return;
    const generation = this.lifetime;
    try {
      const value = json(unwrap(await this.remote.manage({ project_id: project.project_id, action: "diagnose", payload: { scope: "archive" }, expected_revision: project.read_revision, operation_id: this.operationId() }))) as Fields;
      if (generation !== this.lifetime || this.disposed) return;
      if (!Array.isArray(value.grant_ids)) throw new ClientFailure({ code: "invalid_response", message: "The archive returned no grant inventory." });
      const grants = (value.grant_ids as unknown[]).filter(record).map(item => json(item) as Fields);
      this.publish({ grants, error: undefined });
    } catch (error) {
      if (generation !== this.lifetime || this.disposed) return;
      const failure = failureOf(error);
      if (unauthorized(failure.code)) this.clear("denied", failure); else this.publish({ error: failure });
    }
  }
  /**
   * Read the deployment's declared replica destinations.
   *
   * `storage_unavailable` is a *state*, not an error: this Host declaring no
   * destinations means network replication is not configured, and the UI must say
   * that instead of showing an empty picker a user would try to fill by guessing a
   * key. Any other refusal is a real failure and is surfaced as one.
   */
  async readDestinations(): Promise<void> {
    if (!this.state.connected || !this.state.owner || this.disposed) return;
    const generation = this.lifetime;
    try {
      const destinations = decodeDestinations(await this.remote.destinations({}));
      if (generation !== this.lifetime || this.disposed) return;
      this.publish({ destinations, destinationsState: "available", error: undefined });
    } catch (error) {
      if (generation !== this.lifetime || this.disposed) return;
      const failure = failureOf(error);
      if (failure.code === "storage_unavailable") {
        this.publish({ destinations: [], destinationsState: "unconfigured", error: undefined });
        return;
      }
      if (unauthorized(failure.code)) this.clear("denied", failure);
      else this.publish({ destinationsState: undefined, error: failure });
    }
  }
  /**
   * Publish the native Workspace choices.
   *
   * Called from the registry seam on service arrival, list change, removal and
   * replacement. It has to go through `publish` rather than being computed inside the
   * slot's `inject()` thunk: that thunk is evaluated once per registration, so a registry
   * arriving after the panel mounted would update the value but never re-render, and a
   * user would keep seeing "no native Workspace" on a Host that has one.
   * @param value - the current choices, or undefined when no registry is available.
   */
  setWorkspaces(value: Snapshot["workspaces"]): void { this.publish({ workspaces: value }); }
  dispose(): void { ++this.environmentGeneration; this.pendingWrite = undefined; this.stopWatch(); ++this.lifetime; ++this.request; ++this.catalogRequest; this.state = initial(); this.disposed = true; this.listeners.clear(); }
}
