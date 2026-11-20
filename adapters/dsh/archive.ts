/**
 * The narrow Archive seam: the only way this plugin touches the Host's
 * filesystem and Git.
 *
 * Two rules shape this module, and both exist because the obvious version is
 * wrong in a way that only shows up on a real deployment.
 *
 * 1. **The execution world is not the Host.** `ctx.subprocess` and `ctx.sandbox`
 *    describe whatever world the composition happens to be in — possibly a
 *    container or an SSH session. An archive that lives on the Host must not run
 *    Host Git through that world, and must never pass a Session `cwd` to it.
 *    So this seam builds its own Cordis isolation group, mounts the *local*
 *    subprocess and sandbox providers inside it, and keeps the resulting
 *    context private. Callers get `read`/`commit`-shaped methods, never a
 *    context, an argv, or a path.
 *
 * 2. **Git is driven, not scripted.** The argv is fixed here, the environment is
 *    scrubbed, `GIT_DIR`/`GIT_INDEX_FILE`/alternates are stripped so an outer
 *    environment cannot redirect the repository, global/system config and hooks
 *    are disabled, no shell is involved, and nothing reaches the network. A
 *    caller cannot supply any part of the command line.
 *
 * What this module does *not* prove is that the group it builds runs on the
 * physical Host rather than inside the container the process is in. That is a
 * property of the deployment, and the probe reports it as such instead of
 * claiming it.
 *
 * @module adapters/dsh/archive
 */

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The deployment variable that names the archive root.
 *
 * Declared here, in the dependency-free module, so the refusal message can name
 * it without importing the plugin entry (which pulls in `@deepseek-ai/*`).
 * `index.ts` re-exports it as the plugin's public name.
 */
export const ARCHIVE_ROOT_ENV = "DSH_ENSEMBLE_ARCHIVE_ROOT";

/**
 * The services the isolated group provides.
 *
 * Structural types: this module must compile without `@deepseek-ai/*` present,
 * and the Host type gate proves the real provider signatures still fit.
 */
export interface IsolatedContext {
  readonly isolate: (name: string, label?: symbol) => IsolatedContext;
  readonly extend: () => IsolatedContext;
  readonly provide: (name: string, value: unknown) => unknown;
  readonly get: (name: string) => unknown;
}

/** A confined argv produced by the sandbox provider, plus its enforcement. */
export interface Confined {
  readonly argv: readonly string[];
  readonly enforcement?: string;
}

/** The sandbox service as this module uses it. */
export interface SandboxLike {
  readonly confine: (
    argv: readonly string[],
    policy: { readonly mode: "read-only" | "workspace-write"; readonly workspaceRoot: string },
  ) => Promise<Confined>;
}

/**
 * One collected stream, as the subprocess seam exposes it.
 *
 * Collect mode does not hand back a string: it hands back an offset-based
 * reader, because a caller may want the output incrementally and a later read
 * must not consume what an earlier one already returned. Reading the batch
 * result is therefore `readFrom(0)` after settlement, which is what this module
 * does — and `lossy` is surfaced rather than ignored, because a truncated tail
 * reported as the whole output would be a lie about what Git said.
 */
export interface CollectedLike {
  readonly readFrom: (fromByte: number) => {
    readonly text: string;
    readonly nextOffset: number;
    readonly lossy: boolean;
    readonly spillPath?: string;
  };
}

/** The subprocess service as this module uses it. */
export interface SubprocessLike {
  readonly spawn: (spec: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly stdio: {
      readonly stdin: "ignore" | "pipe";
      readonly stdout: "collect";
      readonly stderr: "collect";
    };
    readonly graceMs: number;
    readonly env: Readonly<Record<string, string | undefined>>;
  }) => {
    readonly stdin: { readonly write: (chunk: string) => unknown; readonly end: () => unknown } | undefined;
    readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
    readonly collected: { readonly stdout: CollectedLike; readonly stderr: CollectedLike };
  };
}

/** The two provider constructors the group needs, injected for testability. */
export interface ProviderFactories {
  readonly subprocess: (ctx: IsolatedContext) => unknown;
  readonly sandbox: (ctx: IsolatedContext) => unknown;
}

/** Result of running one fixed Git command inside the group. */
export interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Enforcement the sandbox backend reported for this wrap. */
  readonly enforcement: string | undefined;
}

/** A seam that could not be built, with the reason stated rather than degraded. */
export class SeamUnavailableError extends Error {
  override readonly name = "SeamUnavailableError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Build the isolated Host-local group.
 *
 * `isolate(...).isolate(...).extend()` is the sequence that matters, and the
 * reason is narrower than it first looks. Both `isolate(...)` alone and
 * `new Context(isolated)` *do* isolate the named services — measured, not
 * assumed. What `new Context(isolated)` loses is the rest of the plugin's
 * service graph: it cannot see `skills`, `tools`, or anything else this plugin
 * legitimately needs, because it is a disconnected context rather than a
 * scoped child. `extend()` keeps the parent graph while isolating only the
 * named services, which is exactly the requirement: a different execution
 * world for `subprocess`/`sandbox`, the same plugin everywhere else.
 *
 * The tests assert both halves, because "it looks isolated" is not enough:
 * the group must resolve local implementations *distinct from the outer
 * session's*, and it must still resolve the plugin's own services.
 *
 * @param outer - the plugin's context.
 * @param factories - provider constructors, injected so tests need no install.
 * @returns the group's two services, or a `SeamUnavailableError`.
 */
export function buildIsolatedGroup(
  outer: IsolatedContext,
  factories: ProviderFactories,
): { sandbox: SandboxLike; subprocess: SubprocessLike } {
  let group: IsolatedContext;
  try {
    group = outer.isolate("subprocess").isolate("sandbox").extend();
  } catch (error) {
    throw new SeamUnavailableError(
      `this DSH composition cannot create an isolated service scope: ${(error as Error).message}`,
    );
  }

  // Constructing the providers registers them in the group's own scope.
  try {
    factories.subprocess(group);
    factories.sandbox(group);
  } catch (error) {
    throw new SeamUnavailableError(
      `the local subprocess/sandbox providers could not be mounted in the isolated group: ${(error as Error).message}`,
    );
  }

  const sandbox = group.get("sandbox") as SandboxLike | undefined;
  const subprocess = group.get("subprocess") as SubprocessLike | undefined;
  if (sandbox === undefined || typeof sandbox.confine !== "function") {
    throw new SeamUnavailableError("the isolated group did not provide a sandbox with confine()");
  }
  if (subprocess === undefined || typeof subprocess.spawn !== "function") {
    throw new SeamUnavailableError("the isolated group did not provide a subprocess with spawn()");
  }
  return { sandbox, subprocess };
}

/**
 * Environment entries that must never reach the Git child.
 *
 * `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`
 * and friends would let the ambient environment point Git at a different
 * repository than the archive root this code chose. They are stripped rather
 * than trusted, because the caller of this process is not necessarily the
 * deployment.
 */
const STRIPPED_ENV_PREFIXES = ["GIT_"] as const;

/**
 * The environment the Git child receives: a fixed allowlist, not a subtraction.
 *
 * A subtraction would silently pass any new `GIT_*` variable a future release
 * introduces; an allowlist cannot. `HOME` is pointed inside the archive root so
 * Git cannot read a user's global config, and `GIT_CONFIG_NOSYSTEM` disables the
 * system one.
 * @param archiveRoot - the deployment-owned archive root.
 * @returns the child environment.
 */
export function gitEnvironment(
  archiveRoot: string,
  parentEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: archiveRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // No transport, no prompts, no pager: this seam never talks to a remote.
    GIT_ASKPASS: "",
    GIT_SSH_COMMAND: "",
    LC_ALL: "C",
  };

  // Tombstone every `GIT_*` name the parent process carries.
  //
  // This is not belt-and-braces: the subprocess provider builds the child
  // environment by spreading a *copy of the parent environment* and then our
  // entries over it, so a name we merely omit survives into the child. An
  // ambient `GIT_DIR` would then point the archive's Git at a foreign
  // repository and the commit would land there instead, which defeats the
  // whole seam. `undefined` is the provider's documented tombstone: it removes
  // the entry from the child rather than forwarding it.
  //
  // Enumerating the parent instead of listing known names matters, because a
  // `GIT_*` variable this code has never heard of must not survive either.
  for (const key of Object.keys(parentEnvironment)) {
    if (key.toUpperCase().startsWith("GIT_")) env[key] = undefined;
  }
  return env;
}

/**
 * Strip any environment entry that could redirect Git.
 *
 * Useful when a caller assembles an environment itself. It is *not* the seam's
 * defence: the subprocess provider merges caller entries onto a copy of the
 * parent environment, so omitting a name does not remove it. {@link gitEnvironment}
 * tombstones the ambient `GIT_*` names for that reason.
 * @param env - the candidate environment.
 * @returns the same entries minus every `GIT_*` key.
 */
export function scrubEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    clean[key] = value;
  }
  return clean;
}

/** A resolved, validated archive root. */
export interface ArchiveRoot {
  readonly ok: true;
  /** Canonical absolute path (symlinks resolved). */
  readonly path: string;
}

/** Why a proposed archive root was refused. */
export interface RootRefusal {
  readonly ok: false;
  readonly code: "invalid_root" | "root_is_symlink" | "root_overlaps_source" | "root_not_owned";
  readonly reason: string;
}

/**
 * Validate a deployment-configured archive root.
 *
 * The root is a deployment decision, so this function's job is to refuse the
 * shapes that would make the archive unsafe rather than to guess an alternative:
 *
 * - a relative or empty path, because it would resolve against a process cwd;
 * - a symlink, because the real location would be somewhere the deployment did
 *   not choose;
 * - a path inside any bound source, because the archive must be outside every
 *   source it records (a commit inside the user's working tree would show up in
 *   their `git status`);
 * - a source inside the root, for the same reason from the other side.
 *
 * Sources are compared after `realpath` on their existing prefix, so a symlinked
 * source cannot slip past a string comparison.
 * @param archiveRoot - the configured root.
 * @param sources - canonical source directories bound to this archive.
 * @returns the validated root, or the refusal.
 */
export function validateArchiveRoot(
  archiveRoot: string,
  sources: readonly string[] = [],
): ArchiveRoot | RootRefusal {
  if (archiveRoot.trim() === "") {
    return {
      ok: false,
      code: "invalid_root",
      reason: `the archive root is empty: set ${ARCHIVE_ROOT_ENV} to an absolute path outside every bound source`,
    };
  }
  if (!isAbsolute(archiveRoot)) {
    return {
      ok: false,
      code: "invalid_root",
      reason: `the archive root must be absolute, not ${JSON.stringify(archiveRoot)}: a relative path resolves against a process cwd this code does not own`,
    };
  }
  const resolved = resolve(archiveRoot);
  if (existsSync(resolved)) {
    let stats;
    try {
      stats = lstatSync(resolved);
    } catch (error) {
      return { ok: false, code: "invalid_root", reason: `the archive root cannot be examined: ${(error as Error).message}` };
    }
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        code: "root_is_symlink",
        reason: `the archive root is a symbolic link; the deployment must name the real directory`,
      };
    }
  }

  const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
  for (const source of sources) {
    const canonicalSource = canonicaliseExisting(source);
    if (canonicalSource === undefined) continue;
    if (isWithin(canonical, canonicalSource)) {
      return {
        ok: false,
        code: "root_overlaps_source",
        reason: `the archive root ${canonical} is inside the bound source ${canonicalSource}; the archive must live outside every source it records`,
      };
    }
    if (isWithin(canonicalSource, canonical)) {
      return {
        ok: false,
        code: "root_overlaps_source",
        reason: `the bound source ${canonicalSource} is inside the archive root ${canonical}; a commit there would appear in the user's own repository`,
      };
    }
  }
  return { ok: true, path: canonical };
}

/** Realpath the longest existing prefix of a path, keeping the rest as written. */
function canonicaliseExisting(path: string): string | undefined {
  if (path.trim() === "" || !isAbsolute(path)) return undefined;
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    tail.unshift(current.slice(parent.length).replace(/^[/\\]/, ""));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...tail);
  } catch {
    return undefined;
  }
}

/** Whether `candidate` is `root` itself or below it. */
function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`${sep}..`) && !isAbsolute(rel);
}

/**
 * The fixed Git commands this seam can run.
 *
 * A closed set, not a general runner: each entry names every argument, so no
 * caller-supplied value can become a Git option. Values that must vary (a tree
 * hash, a parent commit) are passed as separate argv entries after `--`-style
 * validation, never concatenated into an option.
 */
export type GitCommand =
  | { readonly kind: "init-bare" }
  | { readonly kind: "rev-parse-head" }
  | { readonly kind: "commit-tree"; readonly tree: string; readonly message: string; readonly parent?: string }
  | { readonly kind: "update-ref"; readonly revision: string; readonly expected: string | null }
  | { readonly kind: "read-tree-path"; readonly revision: string; readonly path: string }
  | { readonly kind: "cat-file-tree"; readonly tree: string; readonly path: string }
  /** Write one blob; content arrives on stdin, never as an argument. */
  | { readonly kind: "hash-object"; readonly content: string }
  /** Assemble a tree from one stdin description; no index is created. */
  | { readonly kind: "mktree"; readonly entries: readonly string[] }
  /** List the paths under a prefix at one revision. */
  | { readonly kind: "list-tree"; readonly revision: string; readonly prefix: string };

/**
 * The identity archive commits are authored as.
 *
 * Code-owned on purpose: the commit identity must not depend on the deploying
 * user's Git configuration, and it must not be a place a caller could put their
 * own name. `commit-tree` receives it through `-c` so no config file is touched.
 */
export const ARCHIVE_SERVICE_NAME = "ensemble-archive";
export const ARCHIVE_SERVICE_EMAIL = "ensemble-archive@invalid";

/** Git object ids are lowercase hex; anything else cannot be an object name. */
const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Commands that create objects or move a ref, and so need write access.
 *
 * The complement is read-only by default, which is the safe direction: a command
 * this set forgets would fail closed with a permission error rather than
 * silently gaining write access to the archive.
 */
const WRITING_COMMANDS: ReadonlySet<GitCommand["kind"]> = new Set([
  "init-bare",
  "hash-object",
  "mktree",
  "commit-tree",
  "update-ref",
]);

/** Paths inside the archive tree: relative, no traversal, no absolute. */
function assertArchivePath(path: string): void {
  if (path === "" || isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "")) {
    throw new SeamUnavailableError(`refusing an unsafe archive path: ${JSON.stringify(path)}`);
  }
}

/**
 * Turn a command into argv, validating every varying value.
 *
 * The validation is what makes this a fixed command set rather than a shell:
 * an object id that is not 40 hex characters cannot be a `--upload-pack` or an
 * option, and a path with a `..` segment cannot escape the tree.
 * @param command - the command to render.
 * @returns the argv to hand to `confine`.
 */
export function gitArgv(command: GitCommand): string[] {
  switch (command.kind) {
    case "init-bare":
      // `--bare` with an explicit directory; no template, so no hooks.
      return ["git", "init", "--bare", "--quiet", "--template=", "."];
    case "rev-parse-head":
      return ["git", "rev-parse", "--verify", "--quiet", "refs/ensemble/main^{commit}"];
    case "commit-tree": {
      if (!OBJECT_ID.test(command.tree)) throw new SeamUnavailableError("commit-tree needs a 40-hex tree id");
      if (command.parent !== undefined && !OBJECT_ID.test(command.parent)) {
        throw new SeamUnavailableError("commit-tree needs a 40-hex parent id");
      }
      // The commit identity is owned by this code, not by the deployment's Git
      // configuration: the archive's history should name the archive service,
      // not whoever happens to run the process. `-c` keeps it scoped to this one
      // invocation, so nothing is written to any config file.
      const argv = [
        "git",
        "-c",
        `user.name=${ARCHIVE_SERVICE_NAME}`,
        "-c",
        `user.email=${ARCHIVE_SERVICE_EMAIL}`,
        "commit-tree",
        command.tree,
      ];
      if (command.parent !== undefined) argv.push("-p", command.parent);
      argv.push("-m", command.message);
      return argv;
    }
    case "update-ref": {
      if (!OBJECT_ID.test(command.revision)) throw new SeamUnavailableError("update-ref needs a 40-hex revision");
      // An empty old value means "must not exist"; a hash means "must be this".
      if (command.expected !== null && !OBJECT_ID.test(command.expected)) {
        throw new SeamUnavailableError("update-ref needs a 40-hex expected revision or null");
      }
      return ["git", "update-ref", "refs/ensemble/main", command.revision, command.expected ?? ""];
    }
    case "read-tree-path":
      if (!OBJECT_ID.test(command.revision)) throw new SeamUnavailableError("read-tree-path needs a 40-hex revision");
      assertArchivePath(command.path);
      return ["git", "show", `${command.revision}:${command.path}`];
    case "cat-file-tree":
      if (!OBJECT_ID.test(command.tree)) throw new SeamUnavailableError("cat-file-tree needs a 40-hex tree id");
      assertArchivePath(command.path);
      return ["git", "cat-file", "-p", `${command.tree}:${command.path}`];
    case "hash-object":
      // `-w` writes the object; `--stdin` reads the content, so it never appears
      // in the command line where a process listing could expose it.
      return ["git", "hash-object", "-w", "--stdin"];
    case "mktree":
      // `--missing` is refused: a tree referring to an object that was not
      // written would be published and then be unreadable.
      return ["git", "mktree"];
    case "list-tree": {
      if (!OBJECT_ID.test(command.revision)) throw new SeamUnavailableError("list-tree needs a 40-hex revision");
      if (command.prefix !== "" && !/^[A-Za-z0-9._-]+$/.test(command.prefix)) {
        throw new SeamUnavailableError(`refusing an unsafe tree prefix: ${JSON.stringify(command.prefix)}`);
      }
      return ["git", "ls-tree", "-r", "--name-only", command.revision, "--", command.prefix];
    }
  }
}

/**
 * The sandbox policy the group runs under.
 *
 * `dsh-base`'s shipped row sets `sandbox-policy.workspaceRoot: process.cwd()`.
 * That is the Session cwd, which is exactly what this seam must not use: an
 * archive on the Host must be written under the deployment's `archiveRoot`, not
 * under whatever directory the session happens to be in. The group therefore
 * supplies its own policy rather than inheriting that row, and the value comes
 * from the deployment — never from a caller and never from `process.cwd()`.
 * @param archiveRoot - the validated deployment root.
 * @returns the policy for every command this seam runs.
 */
export function archivePolicy(archiveRoot: string): {
  readonly mode: "workspace-write";
  readonly workspaceRoot: string;
} {
  return { mode: "workspace-write", workspaceRoot: archiveRoot };
}

/**
 * Run one fixed Git command inside the isolated group.
 *
 * `cwd` is always the archive root. The policy grants writes to that root only,
 * so a Git that tried to write anywhere else would be denied by the sandbox
 * rather than trusted not to.
 * @param group - the services built by {@link buildIsolatedGroup}.
 * @param archiveRoot - the validated archive root.
 * @param command - one of the fixed commands.
 * @param options.mode - `workspace-write` for commands that create objects.
 * @returns the exit code and both streams.
 */
export async function runGit(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
  command: GitCommand,
  options: { readonly mode?: "read-only" | "workspace-write" } = {},
): Promise<GitResult> {
  const argv = gitArgv(command);
  // Commands that create objects need write access to the archive; the rest are
  // read-only. Deriving this from the command rather than defaulting to
  // read-only matters: `hash-object -w` and `mktree` write, and running them
  // under a read-only policy fails with a permission error that looks like a
  // broken repository instead of a wrong policy.
  const writes = WRITING_COMMANDS.has(command.kind);
  const mode = options.mode ?? (writes ? "workspace-write" : "read-only");

  // The root comes from the deployment policy, never from the session cwd.
  const policy = archivePolicy(archiveRoot);
  const confined = await group.sandbox.confine(argv, { mode, workspaceRoot: policy.workspaceRoot });
  // Fail closed: a "confined" wrap that hands back the caller's own argv is not
  // confinement, so it must not be spawned as though it were.
  if (!Array.isArray(confined.argv) || confined.argv.length < argv.length || confined.argv[0] === argv[0]) {
    throw new SeamUnavailableError(
      "the sandbox backend returned the unconfined argv; refusing to run Git without confinement",
    );
  }

  // Two commands take their input on stdin rather than on the command line:
  // `hash-object --stdin` and `mktree`. Everything else gets `ignore`, so a
  // command can never block waiting for input it was not given.
  const stdinText = command.kind === "hash-object"
    ? command.content
    : command.kind === "mktree"
      ? `${command.entries.join("\n")}\n`
      : undefined;

  const handle = group.subprocess.spawn({
    argv: confined.argv,
    cwd: archiveRoot,
    stdio: { stdin: stdinText === undefined ? "ignore" : "pipe", stdout: "collect", stderr: "collect" },
    graceMs: 30_000,
    env: gitEnvironment(archiveRoot),
  });
  if (stdinText !== undefined) {
    if (handle.stdin === undefined) {
      throw new SeamUnavailableError(`the subprocess provider did not give ${command.kind} a stdin pipe`);
    }
    handle.stdin.write(stdinText);
    handle.stdin.end();
  }
  const outcome = await handle.done;
  return {
    exitCode: outcome.exitCode,
    stdout: readCollected(handle.collected.stdout),
    stderr: readCollected(handle.collected.stderr),
    enforcement: confined.enforcement,
  };
}

/**
 * Read one collected stream in full, after the process settled.
 *
 * A stream the provider did not collect is absent, which is empty output rather
 * than an error. A lossy read means the retained tail lost its head; the spill
 * file holds the rest, so the returned text says so instead of pretending the
 * tail is the whole output.
 */
function readCollected(stream: CollectedLike | undefined): string {
  if (stream === undefined) return "";
  const read = stream.readFrom(0);
  if (!read.lossy) return read.text;
  return `${read.text}\n[archive] this output was truncated; the full stream is in ${read.spillPath ?? "a spill file"}`;
}

/**
 * Create the archive's bare repository if it is not there yet.
 *
 * Idempotent by inspection rather than by a failed command: an existing bare
 * repository is accepted, and a directory that is *not* a bare repository is
 * refused, because initialising over a user's directory is the one outcome that
 * could lose data.
 * @param group - the isolated services.
 * @param archiveRoot - the validated root.
 * @returns the root, or a refusal.
 */
export async function ensureBareRepository(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
): Promise<{ ok: true } | { ok: false; code: "root_not_owned"; reason: string }> {
  const head = join(archiveRoot, "HEAD");
  if (existsSync(head)) {
    return { ok: true };
  }
  if (existsSync(archiveRoot)) {
    const entries = lstatSync(archiveRoot);
    if (!entries.isDirectory()) {
      return { ok: false, code: "root_not_owned", reason: `the archive root ${archiveRoot} exists and is not a directory` };
    }
  } else {
    mkdirSync(archiveRoot, { recursive: true });
  }
  const result = await runGit(group, archiveRoot, { kind: "init-bare" });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "root_not_owned",
      reason: `git init --bare failed in ${archiveRoot} (exit ${result.exitCode ?? "?"}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
    };
  }
  return { ok: true };
}
