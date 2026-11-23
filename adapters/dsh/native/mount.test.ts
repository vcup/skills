/**
 * Regression tests for the Settings-row identity rule.
 *
 * Every case here is a defect that reached a real Host, or a refusal the Host
 * depends on. The wrapper case is the important one: a Loader row's `fiber` is
 * `Object.create(realFiber)` plus a `then`, so identical-looking fibers are not
 * the same object, and the original strict comparison therefore matched nothing
 * in any real profile.
 */

import { describe, expect, test } from "bun:test";
import { isOwnRow, selectOwnRows, type ConfigRowLike, type MountFiberLike } from "./mount.ts";

/** A Loader entry stub; identity is the only thing that matters. */
function entry(id: string) {
  return { id, options: { id } } as unknown as object;
}

/** The PromiseLike wrapper a Loader row stores, mirroring `Entry._init()`. */
function wrapper(real: MountFiberLike): MountFiberLike {
  return Object.assign(Object.create(real as object) as MountFiberLike, { then: () => undefined });
}

function row(id: string, fiber: MountFiberLike | undefined): ConfigRowLike {
  return { options: { id }, ...(fiber === undefined ? {} : { fiber }) };
}

describe("settings row identity", () => {
  test("a wrapper around the mounted fiber is recognised, and the raw fiber is not used", () => {
    const shared = entry("include:dsh-ensemble");
    const real: MountFiberLike = { entry: shared, uid: 187 };
    const wrapped = wrapper(real);

    // The exact defect: wrapper identity differs from the fiber it wraps.
    expect((wrapped as unknown) === (real as unknown)).toBe(false);
    // ...but they share the Loader entry, which is the stable handle.
    expect(isOwnRow(row("dsh-ensemble", wrapped), real)).toBe(true);
    // The old rule would have matched nothing:
    expect((wrapped as unknown) === (real as unknown)).toBe(false);
  });

  test("a foreign row with an identical uid but a different entry is refused", () => {
    const mine: MountFiberLike = { entry: entry("include:dsh-ensemble"), uid: 52 };
    const foreign: MountFiberLike = { entry: entry("include:other-ensemble"), uid: 52 };
    expect(isOwnRow(row("dsh-ensemble", foreign), mine)).toBe(false);
  });

  test("a child fiber of the same entry still identifies the row", () => {
    // A fiber captured inside a nested ctx.inject callback has a different uid
    // but the same entry; identity must come from the entry, not the uid.
    const shared = entry("include:dsh-ensemble");
    const fromApply: MountFiberLike = { entry: shared, uid: 52 };
    const fromInject: MountFiberLike = { entry: shared, uid: 187 };
    expect(isOwnRow(row("dsh-ensemble", fromInject), fromApply)).toBe(true);
  });

  test("uid is only a fallback, and only when it is a number", () => {
    expect(isOwnRow(row("dsh-ensemble", { uid: 7 }), { uid: 7 })).toBe(true);
    expect(isOwnRow(row("dsh-ensemble", { uid: 7 }), { uid: null })).toBe(false);
    expect(isOwnRow(row("dsh-ensemble", { uid: 7 }), {})).toBe(false);
    // With an entry available the uid must not override it.
    expect(isOwnRow(row("dsh-ensemble", { entry: entry("a"), uid: 7 }), { entry: entry("b"), uid: 7 })).toBe(false);
  });

  test("an unmounted plugin matches nothing instead of everything", () => {
    expect(isOwnRow(row("dsh-ensemble", { entry: entry("include:dsh-ensemble") }), undefined)).toBe(false);
    expect(selectOwnRows([row("dsh-ensemble", { entry: entry("x") })], undefined)).toEqual({ ok: true, ids: [] });
  });

  test("exactly one row is selected; duplicates are refused rather than merged", () => {
    const shared = entry("include:dsh-ensemble");
    const mounted: MountFiberLike = { entry: shared, uid: 52 };
    const rows = [
      row("llm", { entry: entry("include:llm") }),
      row("dsh-ensemble", wrapper(mounted)),
      row("settings", { entry: entry("include:settings") }),
    ];
    expect(selectOwnRows(rows, mounted)).toEqual({ ok: true, ids: ["dsh-ensemble"] });

    const duplicated = [...rows, row("dsh-ensemble", wrapper(mounted))];
    const refused = selectOwnRows(duplicated, mounted);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("more than one active Settings row");

    // Two *different* ids both claiming the plugin is the same ambiguity: one
    // entry object cannot be two, so a real duplicate appears as two rows sharing
    // one entry.
    const shared2 = entry("include:dsh-ensemble");
    const alias = selectOwnRows([
      { options: { id: "dsh-ensemble" }, fiber: wrapper({ entry: shared2, uid: 3 }) },
      { options: { id: "dsh-ensemble-alias" }, fiber: wrapper({ entry: shared2, uid: 3 }) },
    ], { entry: shared2, uid: 3 });
    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.reason).toContain("dsh-ensemble, dsh-ensemble-alias");
  });
});
