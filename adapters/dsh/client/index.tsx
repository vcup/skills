import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import { WorkspaceController } from "./controller.ts";
import { archiveRemote } from "./remote.ts";
import type { ArchiveRemote } from "./protocol.ts";
import { Workspace, EnsembleIcon, type WorkspaceInjected } from "./workspace.tsx";
import { en, zh, NS, type LocaleKey } from "./locales.ts";
import { workspaceChoices, type WorkspaceRegistry } from "./workspaces.ts";
import { observeWorkspaces, type RegistryContext } from "./registry-seam.ts";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap { "ensemble.workspace": LocaleKey; }
}
/** Only these two exports belong to the lazy Client factory. Runtime dependencies come from the official composition. */
export const inject = ["slots", "locale", "layout", "remote", "connection"];
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const connection = ctx.get("connection") as ConnectionHandle;
  const unmountRemote = await ctx.remote.$mount(archiveRemote);
  // A mounted Remote namespace is its own Cordis service, and this runtime refuses
  // to hand one out to a plugin that did not inject it: reading
  // `ctx.remote.ensembleArchive` directly throws "cannot get property without
  // inject" and the whole Client entry fails to activate (the page then paints
  // nothing at all). So the UI is composed inside `ctx.inject` for the namespace
  // the contribution just created — the same shape the shipped action-cards and
  // plugin-recommendation plugins use.
  let disposeUi: (() => Promise<void>) | undefined;
  try {
    const ui = ctx.inject(["remote.ensembleArchive"], (inner) => {
      const remote = (inner.remote as typeof inner.remote & { readonly ensembleArchive: ArchiveRemote }).ensembleArchive;
      disposeUi = compose(inner, remote);
    });
    try {
      await ui;
    } catch (error) {
      await ui.dispose();
      throw error;
    }
  } catch (error) {
    await unmountRemote();
    throw error;
  }
  return async () => {
    if (disposeUi !== undefined) await disposeUi();
    await unmountRemote();
  };
}

/**
 * The Client's own composition: dictionaries, the keyed main page, the sidebar
 * entry, connection-driven state and unload cleanup.
 * @param ctx - context that has `remote.ensembleArchive` injected.
 * @param remote - the mounted owner Remote.
 * @returns the disposer that releases everything this composition registered.
 */
function compose(ctx: Context, remote: ArchiveRemote): () => Promise<void> {
  const connection = ctx.get("connection") as ConnectionHandle | undefined;
  const controller = new WorkspaceController(remote);
  const disposers: (() => void)[] = [];
  // The native Workspace registry arrives on the framework's schedule, not ours.
  //
  // `dsh-api-workspace-controller` publishes the `workspaces` service only after it has
  // mounted `remote.workspace` (`src/client/service.ts:126`, inject
  // `['remote','remote.workspace']`), so on a fresh Host it can apply *after* this plugin.
  // A single `ctx.get("workspaces")` therefore captures `undefined` forever and the picker
  // reports "registry not available" even though the Host has one. The shipped
  // `dsh-client-ui-sidebar-browser` solves exactly this with the deferred
  // `ctx.inject(['workspaces'], scope => …)` form, which runs when the service *arrives*,
  // re-runs when it is replaced, and disposes when it is unloaded. This stays an *optional*
  // child scope rather than a module-level `inject` entry, so a Host that composes no
  // registry still activates the plugin and shows its explicit "registry not available"
  // notice. The `refreshProjects` link matters: the arrival has to reach the controller so
  // the panel re-renders and re-evaluates the slot's `inject()` thunk.
  const registryState: { current?: WorkspaceRegistry } = {};
  const registryScope = ctx.inject(["workspaces"], (scope) => {
    registryState.current = (scope as unknown as { workspaces?: WorkspaceRegistry }).workspaces;
    const registry = registryState.current;
    const subscribed = registry !== undefined && typeof registry.list?.subscribe === "function"
      ? registry.list.subscribe(() => { void controller.refreshProjects(); })
      : undefined;
    void controller.refreshProjects();
    return () => { registryState.current = undefined; subscribed?.(); };
  });
  // Publish the choices into the controller's observable state so the panel re-renders when
  // the registry arrives or its list changes, instead of freezing the value computed at
  // registration time.
  disposers.push(observeWorkspaces(ctx as unknown as RegistryContext, value => controller.setWorkspaces(value)));
  // `ctx.inject` returns a Fiber (awaitable, and disposable), not a plain disposer.
  disposers.push(() => { void registryScope.dispose(); });
  const choices = (): ReturnType<typeof workspaceChoices> => workspaceChoices(registryState.current);
  const t = ctx.locale.register(NS, { en, zh });
  disposers.push(t);
  const translate = ctx.locale.bind(NS);
  disposers.push(ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "ensemble", locale: NS,
    inject: (): WorkspaceInjected => ({ hooks: { workspace: controller }, workspaces: choices(), controller: {
      readEnvironment: request => controller.readEnvironment(request), prepareEnvironment: request => controller.prepareEnvironment(request), cancelEnvironment: () => controller.cancelEnvironment(), submitEnvironment: () => controller.submitEnvironment(), approve: request => controller.approve(request), choose: (kind, selection) => controller.choose(kind, selection), select: id => controller.select(id), navigate: view => controller.navigate(view), refreshProjects: () => controller.refreshProjects(), refreshView: () => controller.refreshView(),
      read: (query, next) => controller.read(query, next), canManage: action => controller.canManage(action), prepare: (action, payload) => controller.prepare(action, payload),
      cancelPreview: () => controller.cancelPreview(), submit: () => controller.submit(), receipt: () => controller.receipt(), grants: () => controller.grants_(), readDestinations: () => controller.readDestinations(),
    } }),
  }, Workspace)));
  disposers.push(ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist", id: "ensemble", order: 30, locale: NS, label: () => translate("title"),
  }, EnsembleIcon)));
  let activeGeneration: number | undefined;
  const syncConnection = (): void => {
    if (connection === undefined) return;
    const generation = connection.generation.getSnapshot()?.id;
    const connected = connection.state.getSnapshot() === "connected" && generation !== undefined;
    if (connected && generation === activeGeneration) return;
    activeGeneration = connected ? generation : undefined;
    void controller.connection(connected);
  };
  if (connection !== undefined) {
    disposers.push(connection.state.subscribe(syncConnection), connection.generation.subscribe(syncConnection));
    syncConnection();
  }
  // Owner access is revalidated on focus, not cached across an unattended tab.
  if (typeof window !== "undefined") {
    const revalidate = (): void => { controller.invalidate(); void controller.refreshProjects(); };
    window.addEventListener("focus", revalidate);
    disposers.push(() => window.removeEventListener("focus", revalidate));
  }
  return async () => {
    controller.dispose();
    for (const dispose of disposers.reverse()) dispose();
  };
}
