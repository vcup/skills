/**
 * The native Workspace registry seam.
 *
 * Why this is a module of its own: the registry is an **optional** service that may be
 * absent, arrive late, be replaced, or be unloaded, and the picker must track all four
 * without the caller re-evaluating anything by hand. Two things move together — reading the
 * current choices and (un)subscribing to its changes — so they live behind one interface.
 *
 * The detail it exists to get right: a slot's `inject()` thunk is evaluated once per
 * registration, so a Workspace created *after* this panel mounted (the fresh-Host journey:
 * create a Workspace, then return to initialize) would never re-render the picker if the
 * choices were only computed there. The seam therefore reports into the controller's
 * observable state, which the component already subscribes to via `useWorkspace`.
 *
 * @module adapters/dsh/client/registry-seam
 */
import { workspaceChoices, type WorkspaceChoice, type WorkspaceRegistry } from "./workspaces.ts";

/** What the picker renders: whether a registry is usable at all, and its rows. */
export interface WorkspaceChoices {
  readonly available: boolean;
  readonly choices: readonly WorkspaceChoice[];
}

/** The pieces of a Cordis context this seam needs, kept narrow so it is testable. */
export interface RegistryContext {
  inject(
    services: readonly string[],
    callback: (scope: { readonly workspaces?: WorkspaceRegistry }) => (() => void) | void,
  ): { dispose(): unknown };
}

/**
 * Attach to the native registry and report its choices on every relevant transition.
 *
 * @param ctx - context that can start an optional child scope for `workspaces`.
 * @param report - receives the current choices; called on arrival, list change, removal and
 *   replacement, and never with a stale value after the scope is disposed.
 * @returns a disposer that detaches the scope and stops all reporting.
 */
export function observeWorkspaces(ctx: RegistryContext, report: (value: WorkspaceChoices) => void): () => void {
  let unsubscribe: (() => void) | undefined;
  // Report the "no registry yet" state immediately, so a caller that attaches before the
  // service exists still has a defined value to render instead of `undefined`.
  report({ available: false, choices: [] });
  const scope = ctx.inject(["workspaces"], (inner) => {
    const registry = inner.workspaces;
    // Reading the choices and subscribing to them belong to the same lifetime: the
    // subscription is released exactly when this scope is (removal or replacement), so a
    // replaced registry cannot leave the previous list observed.
    const publish = (): void => { report(workspaceChoices(registry)); };
    publish();
    // Call `subscribe` on the owner, never as a detached function. `list` is an instance
    // whose `subscribe` uses `this` (the shipped `ClientWorkspaceModel.subscribe` starts
    // with `this.listeners.add(listener)`), so extracting the method and calling it bare
    // throws `TypeError: Cannot read properties of undefined (reading 'listeners')`.
    // That throw was swallowed by the child-scope fiber, so the subscription was never
    // established and the panel never learned about a later arrival.
    const list = registry?.list;
    if (typeof list?.subscribe === "function") unsubscribe = list.subscribe(publish);
    return () => {
      unsubscribe?.();
      unsubscribe = undefined;
      // The service is gone: say so rather than leaving the last list on screen.
      report({ available: false, choices: [] });
    };
  });
  return () => {
    // Release the subscription here as well as in the scope teardown. The teardown covers
    // service removal; this covers our own disposal, and it must not depend on the
    // framework running the callback for us — a seam whose cleanup only works one way
    // leaks a listener into a dead panel.
    unsubscribe?.();
    unsubscribe = undefined;
    void scope.dispose();
  };
}
