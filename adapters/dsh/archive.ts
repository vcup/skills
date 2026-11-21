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

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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
 * The environment the Git child receives.
 *
 * Order matters, and getting it backwards silently disables the protections.
 * The subprocess provider builds the child environment by spreading a *copy of
 * the parent environment* and then this object over it, so:
 *
 * 1. every ambient `GIT_*` name is tombstoned with `undefined` — the provider's
 *    documented removal — because a name we merely omit survives into the child;
 * 2. only then are the fixed protections written, so a hostile parent that sets
 *    `GIT_CONFIG_GLOBAL` cannot tombstone our `/dev/null`.
 *
 * Doing it the other way round was a real defect: the tombstone loop ran last
 * and deleted `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`, which let Git fall back
 * to `$HOME/.gitconfig` — and `HOME` is the archive root, so a user's global
 * config could influence an archive commit.
 *
 * This is a subtraction plus tombstones, not an allowlist: the provider always
 * merges onto the parent environment, so an allowlist is not achievable without
 * replacing the provider. The protections below are what make the subtraction
 * safe.
 * @param archiveRoot - the deployment-owned archive root.
 * @param parentEnvironment - the environment to mask; defaults to the process's.
 * @returns the child environment.
 */
export function gitEnvironment(
  archiveRoot: string,
  parentEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  // 1. Mask every `GIT_*` name the parent carries, including names this code has
  //    never heard of. `undefined` is the provider's tombstone: it removes the
  //    entry from the child rather than forwarding it.
  for (const key of Object.keys(parentEnvironment)) {
    if (key.toUpperCase().startsWith("GIT_")) env[key] = undefined;
  }

  // 2. The fixed protections, applied after the mask so they cannot be removed.
  env.PATH = "/usr/local/bin:/usr/bin:/bin";
  // HOME inside the archive root: with GIT_CONFIG_GLOBAL=/dev/null below, there
  // is no user-level config for Git to find even if it looks.
  env.HOME = archiveRoot;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  // No hooks: a bare repository's hooksPath is never consulted when this is set,
  // and the template is disabled at `init` so none are installed either.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  // No transport, no prompts, no pager: this seam never talks to a remote.
  env.GIT_ASKPASS = "";
  env.GIT_SSH_COMMAND = "";
  env.GIT_ALLOW_PROTOCOL = "file";
  env.LC_ALL = "C";

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

  // Canonicalise through the deepest existing ancestor, then re-append the
  // remainder. A root that does not exist yet is the normal first-run case, and
  // using the raw string there was a real defect: `/outside/link/newarchive`
  // where `link` points into a source would alias into that source and slip
  // past the overlap test, because the leaf did not exist to be resolved.
  const canonical = canonicaliseExisting(resolved);
  if (canonical === undefined) {
    return {
      ok: false,
      code: "invalid_root",
      reason: `the archive root ${resolved} cannot be canonicalised: no existing ancestor could be resolved`,
    };
  }
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
      // An empty prefix means "every path". It must not be rendered as an empty
      // pathspec: `git ls-tree ... -- ""` fails with "empty string is not a valid
      // pathspec", so the separator is omitted rather than followed by nothing.
      if (command.prefix === "") {
        return ["git", "ls-tree", "-r", "--name-only", command.revision];
      }
      if (!/^[A-Za-z0-9._-]+$/.test(command.prefix)) {
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
 * The marker file that says this directory is an archive this plugin created.
 *
 * A bare repository is indistinguishable by shape from any other bare
 * repository, so `HEAD` alone cannot say "we made this". Without a marker,
 * pointing the deployment at a user's own bare repository would let the plugin
 * adopt it and commit into it — the one outcome that could corrupt data the
 * plugin does not own. The marker is written at creation and required
 * afterwards.
 */
export const OWNERSHIP_MARKER = "ensemble-archive.json";

/**
 * What the marker records. Deliberately minimal: the identity this plugin
 * minted, so a mismatch is visible rather than silently migrating.
 */
export interface OwnershipRecord {
  readonly format: string;
  readonly packageName: string;
}

/**
 * Create the archive's bare repository if it is not there yet.
 *
 * Three cases, and only two are accepted:
 * - the marker is present: this is our archive, proceed;
 * - the directory does not exist (or exists and is empty): create it, `git init`
 *   it, and write the marker;
 * - anything else — a non-empty directory, or a bare repository without our
 *   marker — is refused, because adopting a directory the plugin did not create
 *   is how a user's own repository would get overwritten.
 * @param group - the isolated services.
 * @param archiveRoot - the validated root.
 * @returns the root, or a refusal.
 */
export async function ensureBareRepository(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
): Promise<{ ok: true; created: boolean } | { ok: false; code: "root_not_owned"; reason: string }> {
  const markerPath = join(archiveRoot, OWNERSHIP_MARKER);

  if (existsSync(markerPath)) {
    // Our marker: confirm it is structurally ours, so a corrupt file is a refusal
    // rather than a shrug.
    try {
      const record = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<OwnershipRecord>;
      if (record.format !== "ensemble-archive/v1" || typeof record.packageName !== "string") {
        return {
          ok: false,
          code: "root_not_owned",
          reason: `${markerPath} is not an archive ownership marker this plugin wrote`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        code: "root_not_owned",
        reason: `${markerPath} cannot be read as an ownership marker: ${(error as Error).message}`,
      };
    }
    return { ok: true, created: false };
  }

  if (existsSync(archiveRoot)) {
    const stats = lstatSync(archiveRoot);
    if (!stats.isDirectory()) {
      return { ok: false, code: "root_not_owned", reason: `the archive root ${archiveRoot} exists and is not a directory` };
    }
    // An existing bare repository without our marker is exactly the case that
    // must be refused: it may be the user's, and `HEAD` alone does not say whose.
    if (existsSync(join(archiveRoot, "HEAD"))) {
      return {
        ok: false,
        code: "root_not_owned",
        reason:
          `the archive root ${archiveRoot} is already a Git repository this plugin did not create ` +
          `(no ${OWNERSHIP_MARKER}); refusing to adopt a repository the deployment did not give this archive`,
      };
    }
    const remaining = readdirSync(archiveRoot);
    if (remaining.length > 0) {
      return {
        ok: false,
        code: "root_not_owned",
        reason:
          `the archive root ${archiveRoot} is not empty and has no ${OWNERSHIP_MARKER}; ` +
          "refusing to initialise a repository inside a directory this plugin does not own",
      };
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

  // Write the marker only after the repository exists, so a failed init leaves
  // no marker claiming a repository that is not there.
  const record: OwnershipRecord = { format: "ensemble-archive/v1", packageName: "dsh-ensemble-probe" };
  writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, created: true };
}
