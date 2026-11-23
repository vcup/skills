/**
 * Regression for the native Workspace registry seam.
 *
 * These tests exercise the seam through its **exported entry point**, the same one the
 * Client entry calls, against a context whose `inject` behaves like Cordis: it withholds
 * `workspaces` until the service is published, runs the callback on arrival, and disposes
 * the scope when the service goes away.
 *
 * The list below is a **class with a prototype `subscribe` that uses `this`**, mirroring
 * the shipped `ClientWorkspaceModel`. That detail is the whole point of one of these
 * tests: an earlier version of the seam extracted `subscribe` and called it detached,
 * which threw `TypeError: Cannot read properties of undefined (reading 'listeners')`
 * inside the child-scope fiber. The throw was swallowed, the subscription was never
 * established, and the panel never learned about a Workspace created after it mounted.
 * A fake written with arrow functions cannot catch that class of bug, so this file does
 * not use one.
 *
 * @module adapters/dsh/client/registry-seam.test
 */
import { describe, expect, test } from "bun:test";
import { observeWorkspaces, type RegistryContext, type WorkspaceChoices } from "./registry-seam.ts";

type Row = { workspaceId: string; path: string; title?: string };

/**
 * A registry list whose methods live on the prototype and depend on `this`, the shape the
 * shipped model has. Calling `subscribe` detached must fail exactly as it does in the page.
 */
class ModelList {
  private readonly listeners = new Set<() => void>();
  private current: readonly Row[];
  constructor(items: readonly Row[]) { this.current = [...items]; }
  getSnapshot() {
    return { items: this.current, archivedSessionIds: [], pinnedSessionIds: [], state: "idle" as const, phase: "ready" as const, error: null };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(next: readonly Row[]): void {
    this.current = [...next];
    for (const listener of this.listeners) listener();
  }
  get listenerCount(): number { return this.listeners.size; }
}

/**
 * A context whose service can arrive and be removed, like Cordis.
 *
 * Each `inject` gets its own fiber: the callback's teardown runs **exactly once**, whether
 * the scope is disposed by the caller or the service is removed, and never twice if both
 * happen. A disposed fiber never receives a later arrival, which is what real Cordis does
 * and what a fake must copy — an earlier version of this fake only removed the callback
 * from a waiting queue on `dispose`, so the teardown never ran and the listener count
 * stayed at 1. That made the fake look like a product bug and hid which side was wrong.
 */
function context() {
  const fibers = new Map<symbol, { callback?: (scope: { workspaces?: never }) => (() => void) | void; teardown?: () => void; disposed: boolean }>();
  let published: unknown;

  /** Run one fiber's callback if its service exists, collecting its teardown. */
  const start = (fiber: { callback?: (scope: { workspaces?: never }) => (() => void) | void; teardown?: () => void; disposed: boolean }): void => {
    if (fiber.disposed || fiber.callback === undefined || fiber.teardown !== undefined) return;
    const teardown = fiber.callback({ workspaces: published as never });
    if (typeof teardown === "function") fiber.teardown = teardown;
  };

  /** Dispose one fiber exactly once, whether or not it ever started. */
  const disposeFiber = (fiber: { callback?: (scope: { workspaces?: never }) => (() => void) | void; teardown?: () => void; disposed: boolean }): void => {
    if (fiber.disposed) return;
    fiber.disposed = true;
    const teardown = fiber.teardown;
    fiber.teardown = undefined;
    teardown?.();
  };

  return {
    ctx: {
      inject(_services: readonly string[], callback: (scope: { workspaces?: never }) => (() => void) | void) {
        const key = Symbol("fiber");
        const fiber = { callback, teardown: undefined as (() => void) | undefined, disposed: false };
        fibers.set(key, fiber);
        if (published !== undefined) start(fiber);
        return { dispose: () => { disposeFiber(fiber); fibers.delete(key); } };
      },
    } as RegistryContext,
    publish(workspaces: unknown) {
      published = workspaces;
      // A disposed fiber is gone: it must not be revived by an arrival.
      for (const fiber of [...fibers.values()]) start(fiber);
    },
    remove() {
      // Service unload disposes every live fiber, exactly once each.
      for (const [key, fiber] of [...fibers]) { disposeFiber(fiber); fibers.delete(key); }
    },
  };
}

describe("native Workspace registry seam", () => {
  test("a registry that arrives after the observer is attached still reports it", () => {
    const { ctx, publish } = context();
    const seen: WorkspaceChoices[] = [];
    const dispose = observeWorkspaces(ctx, value => seen.push(value));
    // Absent at attach time: the report must say so, not stay undefined.
    expect(seen.at(-1)).toEqual({ available: false, choices: [] });

    // Arrival, long after the caller finished attaching.
    publish({ list: new ModelList([{ workspaceId: "ws-1", path: "/host/one", title: "one" }]) });
    const last = seen.at(-1)!;
    expect(last.available).toBe(true);
    expect(last.choices.map(choice => choice.workspace_id)).toEqual(["ws-1"]);
    expect(last.choices[0]?.path).toBe("/host/one");
    dispose();
  });

  test("the subscription is actually installed, which a detached call silently breaks", () => {
    // The defect this pins: `const subscribe = list.subscribe; subscribe(cb)` loses `this`
    // and throws inside the fiber. The observable symptom is a listener count of 0.
    const { ctx, publish } = context();
    const list = new ModelList([{ workspaceId: "ws-1", path: "/host/one", title: "one" }]);
    publish({ list });
    const dispose = observeWorkspaces(ctx, () => undefined);
    expect(list.listenerCount).toBe(1);
    dispose();
    expect(list.listenerCount).toBe(0);
  });

  test("a list change re-reports, so the panel has something to re-render on", () => {
    const { ctx, publish } = context();
    const list = new ModelList([{ workspaceId: "ws-1", path: "/host/one", title: "one" }]);
    publish({ list });
    const seen: WorkspaceChoices[] = [];
    const dispose = observeWorkspaces(ctx, value => seen.push(value));
    expect(seen.at(-1)?.choices).toHaveLength(1);

    // The Host creates a second Workspace: the model emits and the seam must follow.
    list.emit([{ workspaceId: "ws-1", path: "/host/one", title: "one" }, { workspaceId: "ws-2", path: "/host/two", title: "two" }]);
    expect(seen.at(-1)?.choices.map(choice => choice.workspace_id)).toEqual(["ws-1", "ws-2"]);
    dispose();
  });

  test("removal reports unavailable again and releases the subscription", () => {
    const { ctx, publish, remove } = context();
    const list = new ModelList([{ workspaceId: "ws-1", path: "/host/one", title: "one" }]);
    publish({ list });
    const seen: WorkspaceChoices[] = [];
    const dispose = observeWorkspaces(ctx, value => seen.push(value));
    expect(list.listenerCount).toBe(1);

    // Service unload: the scope disposer must run, drop the rows, and stop observing.
    remove();
    expect(seen.at(-1)).toEqual({ available: false, choices: [] });
    expect(list.listenerCount).toBe(0);
    dispose();
  });

  test("a Host with no registry composes without throwing and reports unavailable", () => {
    const { ctx } = context();
    const seen: WorkspaceChoices[] = [];
    // Nothing is ever published: the service does not exist, a supported configuration.
    const dispose = observeWorkspaces(ctx, value => seen.push(value));
    expect(seen.at(-1)).toEqual({ available: false, choices: [] });
    dispose();
  });

  test("disposing after a service removal does not release twice", () => {
    // Both paths must be safe in either order: the scope disposed by us, then the service
    // removed; or removed first and our disposer running afterwards. A double release on a
    // real registry would unsubscribe someone else's listener.
    const { ctx, publish, remove } = context();
    const list = new ModelList([{ workspaceId: "ws-1", path: "/host/one", title: "one" }]);
    publish({ list });
    const reports: WorkspaceChoices[] = [];
    const dispose = observeWorkspaces(ctx, value => reports.push(value));
    expect(list.listenerCount).toBe(1);

    remove();
    expect(list.listenerCount).toBe(0);
    const afterRemoval = reports.length;
    dispose();                                   // second release must be a no-op
    expect(list.listenerCount).toBe(0);
    expect(reports.length).toBe(afterRemoval);   // and must not report again
  });

  test("a disposed observer is not revived by a later arrival", () => {
    // A panel that has been torn down must not start reporting again because the service
    // happened to appear afterwards.
    const { ctx, publish } = context();
    const reports: WorkspaceChoices[] = [];
    const dispose = observeWorkspaces(ctx, value => reports.push(value));
    dispose();
    const afterDispose = reports.length;

    const list = new ModelList([{ workspaceId: "ws-1", path: "/host/one", title: "one" }]);
    publish({ list });
    expect(list.listenerCount).toBe(0);
    expect(reports.length).toBe(afterDispose);
  });

  test("a detached subscribe call really does throw, so the guard above is meaningful", () => {
    // Keeps the regression honest: if a future runtime made `subscribe` this-free, the
    // listener-count assertion would stop testing anything, and this test says so.
    const list = new ModelList([]);
    const detached = list.subscribe;
    expect(() => detached(() => undefined)).toThrow();
    expect(list.listenerCount).toBe(0);
  });
});
