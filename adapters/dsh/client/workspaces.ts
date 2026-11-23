/**
 * The native Workspace registry, as the Client is allowed to see it.
 *
 * Why this seam exists: binding an archive needs a `source_descriptor` whose
 * `nativeWorkspaceRef` is the registry's own workspace id and whose
 * `canonicalAddress` is that Workspace's directory. Those are opaque native
 * identities, so a form that asked an operator to type them would be asking for
 * the very facts the Host already holds — and a typo would produce a refusal that
 * reads like an authorization failure. This module reads the registry through its
 * public service and exposes exactly two facts per Workspace: the id the Host
 * will verify and the path it will resolve. Nothing here creates trust: the Host
 * still revalidates both, and a Workspace the registry does not hold cannot be
 * selected.
 *
 * The registry service is optional from this module's point of view: a Client
 * composed without it reports `available: false` rather than inventing rows.
 *
 * @module adapters/dsh/client/workspaces
 */

/** One selectable native Workspace, in registry order. */
export interface WorkspaceChoice {
  readonly workspace_id: string;
  readonly title: string;
  readonly path: string;
}

/** A host-provided observable snapshot. */
export interface WorkspaceListSnapshot {
  readonly items?: readonly unknown[];
}

/**
 * The registry face this module consumes.
 *
 * `list` is a host observable, so it carries a `subscribe` alongside
 * `getSnapshot`; both are optional here because this Client treats the registry as
 * optional composition and must not assume a Host provides either half.
 */
export interface WorkspaceRegistry {
  readonly list: {
    getSnapshot?(): WorkspaceListSnapshot;
    subscribe?(listener: () => void): () => void;
  };
  create?(input: { path: string }): Promise<unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the current Workspace rows.
 *
 * Rows whose identity is malformed are dropped rather than rendered: a row the
 * Host could not have produced must not become a selectable value that later
 * fails as `not_authorized`.
 * @param registry - native registry service, or undefined when not composed.
 * @returns the choices and whether the registry is usable at all.
 */
export function workspaceChoices(registry: WorkspaceRegistry | undefined): { available: boolean; choices: readonly WorkspaceChoice[] } {
  if (registry === undefined || typeof registry.list?.getSnapshot !== "function") return { available: false, choices: [] };
  const snapshot = registry.list.getSnapshot();
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const choices: WorkspaceChoice[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!record(item)) continue;
    const workspace_id = typeof item.workspaceId === "string" ? item.workspaceId : undefined;
    const path = typeof item.path === "string" ? item.path : undefined;
    if (workspace_id === undefined || workspace_id === "" || path === undefined || path === "" || seen.has(workspace_id)) continue;
    seen.add(workspace_id);
    choices.push({ workspace_id, title: typeof item.title === "string" && item.title !== "" ? item.title : path, path });
  }
  return { available: true, choices };
}

/**
 * Build the source descriptor the Host's decoder expects from a chosen Workspace.
 *
 * The caller supplies the deployment's source-world identity because that is a
 * Host configuration fact, not a registry one; the two native facts come from the
 * selection so they cannot be mistyped. The descriptor is still only a claim —
 * the Host resolves the path through its own source-world filesystem and refuses
 * a Workspace it does not hold, a path that is not canonical, or a world mismatch.
 * @param choice - selected Workspace.
 * @param worldIdentity - configured source execution world.
 * @returns the closed descriptor object.
 */
export function sourceDescriptor(choice: WorkspaceChoice, worldIdentity: string): Record<string, string> {
  return { worldIdentity, canonicalAddress: choice.path, nativeWorkspaceRef: choice.workspace_id };
}
