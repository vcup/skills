/**
 * Identify which native Settings row this plugin owns.
 *
 * The rule is small but every part of it was learned from a measured defect, so
 * it lives here — dependency-free, and therefore reachable from a unit test that
 * needs no DSH install — instead of inline in the Host composition.
 *
 * ## Why fiber identity does not work
 *
 * A Loader entry's `fiber` is **not** the fiber you captured from your own
 * context. `Entry._init()` stores the PromiseLike wrapper returned by
 * `ctx.registry.plugin(...)`: `Object.create(realFiber)` plus its own `then`.
 * So `entry.fiber === ctx.fiber` is false for every row of a real profile, which
 * made this plugin's target list permanently empty and the environment service
 * was never constructed — a real Host answered `native settings target is not
 * available` for a correctly configured install.
 *
 * Nor is a fiber captured *inside* a nested `ctx.inject(...)` callback usable: it
 * is a different child fiber of the same entry (measured: different `uid`, same
 * `entry`).
 *
 * ## What is stable
 *
 * The Loader entry behind the fiber. Every fiber in one row's tree shares that
 * entry object, and it survives wrapper creation. `uid` is the fallback for a
 * wrapper whose `entry` has not been attached yet, and only when the mounted
 * fiber exposes a numeric one.
 *
 * ## Why duplicates are refused
 *
 * Two rows resolving to the same plugin would mean two Settings targets claiming
 * one preference namespace. There is no correct merge for that, so it fails
 * closed at construction rather than silently picking one.
 *
 * @module adapters/dsh/native/mount
 */

/** The slice of a Loader fiber this module reads. */
export interface MountFiberLike {
  readonly entry?: unknown;
  readonly uid?: number | null;
}

/** The slice of a `configEditor.entries()` row this module reads. */
export interface ConfigRowLike {
  readonly options: { readonly id: string };
  readonly fiber?: MountFiberLike;
}

/** Outcome of identifying this plugin's own rows. */
export type OwnRowSelection =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether one profile row is the row this plugin was mounted as.
 * @param row - a row reported by `configEditor.entries()`.
 * @param mounted - the plugin's own fiber (the one captured in `apply`).
 * @returns true when the row and the mounted fiber share a Loader entry.
 */
export function isOwnRow(row: ConfigRowLike, mounted: MountFiberLike | undefined): boolean {
  if (mounted === undefined) return false;
  if (mounted.entry !== undefined && mounted.entry !== null) return row.fiber?.entry === mounted.entry;
  return typeof mounted.uid === "number" && row.fiber?.uid === mounted.uid;
}

/**
 * Select this plugin's own rows, refusing an ambiguous result.
 *
 * An empty selection is not an error here: a Host that mounts the plugin outside
 * a profile (the unit fixtures do) legitimately has no profile row, and the
 * caller decides what to do about it. More than one is an error, because it can
 * only be a duplicated row.
 * @param rows - every row the config editor reports.
 * @param mounted - the plugin's own fiber.
 * @returns the distinct row ids, or the reason the selection is ambiguous.
 */
export function selectOwnRows(rows: readonly ConfigRowLike[], mounted: MountFiberLike | undefined): OwnRowSelection {
  // Count matching *rows*, not distinct ids: two rows claiming one preference
  // namespace is the same ambiguity as two different ids, and the caller requires
  // exactly one target either way.
  const matched = rows.filter(row => isOwnRow(row, mounted));
  if (matched.length > 1) {
    const names = matched.map(row => row.options.id).join(", ");
    return { ok: false, reason: `more than one active Settings row belongs to this plugin (${names}); exactly one is required` };
  }
  return { ok: true, ids: matched.map(row => row.options.id) };
}
