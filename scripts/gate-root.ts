/**
 * Per-run gate roots, created and removed without ever touching a path the caller
 * merely named.
 *
 * ## The bug this replaces
 *
 * Both browser gates used to do `rmSync(join(output, "serve"))` before starting, to
 * be sure they read a *fresh* `connection.json` rather than one left by an earlier
 * run (a stale handoff names a dead Host, and the browser then fails with
 * ECONNREFUSED — an environment symptom that reads like a product bug). The clear
 * was correct in intent and unsafe in method: `--output` is a caller-supplied path,
 * so a typo like `--output /` or `--output .` would have deleted a directory the
 * gate never created.
 *
 * ## What it does instead
 *
 * The run root is `mkdtemp` under the output directory, so it is **unique** and
 * **created by this process**. A stale handoff is impossible without deleting
 * anything, because the directory did not exist a moment ago. Removal at the end is
 * restricted to that same created path, so cleanup can only ever undo this run.
 *
 * The caller's `--output` is still validated before anything is created: a gate that
 * writes into `/`, into the repository root, through a `..` segment or through a
 * symlink is a refusal (exit 2), not a best effort.
 *
 * @module scripts/gate-root
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/** A directory this process created for one run, and is therefore allowed to remove. */
export interface RunRoot {
  /** Absolute, freshly created, unique to this run. */
  readonly path: string;
  /** Remove it. Refuses any path that is not exactly {@link path}. */
  remove(): void;
}

/**
 * Is this path ignored by the repository's own rules?
 *
 * Asked of `git check-ignore` rather than answered from a list here. Two reasons:
 *
 * - a hardcoded list drifts from `.gitignore`, and the drift is invisible until a gate
 *   writes into a path that was removed from the list's counterpart;
 * - "ignored" is git's verdict, including negation rules and nested `.gitignore` files.
 *   Re-implementing it would be a second source of truth for the same question.
 *
 * A path that does not exist yet is checked by its parent, because `check-ignore` answers
 * about existing paths: `build/production/client/auth` is not created until the gate runs,
 * but `build/` is already ignored and covers it.
 *
 * Returns false when git is unavailable — refusing an unverifiable path is the safe
 * direction, since the cost is a clearer error rather than a dirty checkout.
 */
function isIgnored(absolute: string, projectRoot: string): boolean {
  const probe = (target: string): boolean => {
    const result = spawnSync("git", ["-C", projectRoot, "check-ignore", "--quiet", "--no-index", target], {
      encoding: "utf8",
    });
    return result.status === 0;
  };
  // An existing path answers for itself.
  if (existsSync(absolute)) {
    if (probe(absolute)) return true;
    // `git` can fail for reasons unrelated to the path: a checkout copied without its
    // `.git` directory (which is how the Makefile tests build their fixture), a missing
    // `git` binary, or a path outside any work tree. Falling through to the rules file
    // keeps the guard usable there instead of refusing `build/` in a repository whose
    // `.gitignore` plainly allows it.
    return ignoredByRules(absolute, projectRoot);
  }
  // Otherwise walk up to the nearest existing ancestor: an ignored directory covers
  // everything a gate will create beneath it.
  let current = absolute;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
    if (existsSync(current)) {
      if (probe(current)) return true;
      return ignoredByRules(absolute, projectRoot);
    }
  }
}

/**
 * Read the repository's `.gitignore` directly, for when Git cannot answer.
 *
 * Only the simple forms are honoured — a leading-slash directory (`/build/`) and a bare
 * name (`node_modules`) — because those are the ones this repository uses to mark output
 * roots. Negation and nested `.gitignore` files are deliberately not re-implemented: git
 * remains the authority whenever it can answer, and this is the fallback for a tree that
 * has no `.git` at all.
 */
function ignoredByRules(absolute: string, projectRoot: string): boolean {
  let rules: string;
  try {
    rules = readFileSync(join(projectRoot, ".gitignore"), "utf8");
  } catch {
    return false;
  }
  const relativePath = absolute.slice(resolve(projectRoot).length + 1).split(sep).join("/");
  for (const rawLine of rules.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const pattern = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (pattern === "") continue;
    if (relativePath === pattern || relativePath.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

/**
 * Refuse an output directory a gate must not write into.
 *
 * Returns the reason as a string rather than throwing, so callers can print the
 * message they already use for prerequisites and keep one exit path.
 *
 * @param output  the caller's `--output`, already resolved
 * @param projectRoot  the repository root, which a gate must never write into
 */
export function outputProblem(output: string, projectRoot: string): string | undefined {
  const absolute = resolve(output);
  if (absolute === sep) return "refusing to use the filesystem root as --output";
  if (absolute === resolve(projectRoot)) {
    return `refusing to use the repository root as --output (${absolute})`;
  }
  // Inside the repository is fine only where Git ignores the path. `build/` and
  // `.scratch/` are the ignored roots — `make`'s own default is
  // `CLIENT_OUT=build/production/client`, so refusing every in-repo path would break the
  // documented commands. What must be refused is a path Git *tracks*: writing there puts
  // a profile, archive, cookies and a serve log beside the source, which is how one
  // ad-hoc probe left 1682 untracked files under `x/`.
  //
  // The question is answered by `.gitignore` itself rather than by a hardcoded list: a
  // name is not "ignored" because it looks ignored, and a list here would drift from the
  // file that actually decides.
  const rootWithSep = `${resolve(projectRoot)}${sep}`;
  if (absolute.startsWith(rootWithSep)) {
    if (!isIgnored(absolute, projectRoot)) {
      return (
        `refusing to write run output to a path Git tracks or does not ignore: ${absolute}\n` +
        `  A gate writes a profile, archive, cookies and a serve log; those must not land\n` +
        `  beside the source. Use an ignored root such as build/ (the make default) or\n` +
        `  .scratch/, e.g.\n` +
        `    --output build/production/client/<gate>\n` +
        `    --output .scratch/production-cycle/<gate>-run\n` +
        `  Nothing was started.`
      );
    }
  }
  // Checked on the *typed* path: `resolve` normalises `..` away, so after resolving
  // there is nothing left to see. The typed path is what the caller meant.
  if (output.split(sep).includes("..")) {
    return `--output must not contain a '..' segment: ${output}`;
  }
  // A symlinked output would make "the directory this run created" ambiguous: the
  // path names one thing and resolves to another, so cleanup could land elsewhere.
  // `lstat` is the call that sees the link itself; `stat` follows it and would report
  // the target's kind, which is exactly the information that hides the problem.
  try {
    if (lstatSync(absolute).isSymbolicLink()) return `--output must not be a symlink: ${absolute}`;
  } catch {
    // Not existing yet is the normal case; mkdir below creates it.
  }
  try {
    const real = realpathSync(absolute);
    if (real === sep) return "refusing to use the filesystem root as --output";
    if (real === realpathSync(projectRoot)) {
      return `refusing to write into the repository root (${real})`;
    }
  } catch {
    // Still absent: nothing to resolve.
  }
  return undefined;
}

/**
 * Create a unique run directory under `output`.
 *
 * `mkdtemp` appends random characters and fails rather than reusing an existing
 * directory, so two runs — including two runs of different agents sharing an output
 * parent — cannot collide, and this process can prove it created the path.
 */
export function createRunRoot(output: string, label: string): RunRoot {
  mkdirSync(output, { recursive: true });
  const path = mkdtempSync(join(output, `${label}-`));
  return {
    path,
    remove(): void {
      // Belt and braces: only the exact directory handed out above is removable, and
      // never a filesystem root or the caller's own output directory.
      const absolute = resolve(path);
      if (absolute === sep || absolute === resolve(output)) {
        throw new Error(`refusing to remove ${absolute}: not a run root`);
      }
      rmSync(absolute, { recursive: true, force: true });
    },
  };
}

/**
 * A temporary parent for run roots when the caller did not name an output.
 *
 * Kept separate from {@link createRunRoot} so tests can exercise the guard without
 * depending on the system temp directory's contents.
 */
export function temporaryParent(): string {
  return tmpdir();
}
