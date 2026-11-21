/**
 * The owner management surface: `initialize`, `bind`, `status`, `readBack`.
 *
 * Three rules define this module, and each one closes a specific way the
 * obvious implementation goes wrong.
 *
 * 1. **Authorization comes from the invocation, never from the request.** Every
 *    method calls {@link ownerVerdict} on its own `ctx.invocation` before doing
 *    anything. There is no code path that reaches the archive without that
 *    check, and no request field can influence it: `assertedIdentityFields`
 *    rejects a payload that even tries.
 *
 * 2. **The archive lives on the Host, so its Git runs in the isolated group.**
 *    The group is built once at plugin start; if it cannot be built, the surface
 *    refuses every call with `storage_unavailable` rather than falling back to
 *    `child_process`. A degraded archive is worse than an absent one, because a
 *    degraded one writes somewhere the deployment did not choose.
 *
 * 3. **A failed initialize leaves nothing behind.** The repository is created,
 *    the initial tree is committed, and the ref is published with a
 *    compare-and-swap that requires the ref not to exist. If any step fails the
 *    ref is never published, so a retry sees an uninitialised archive rather
 *    than a half-written one.
 *
 * The methods are plain functions here, so they are testable without a gateway;
 * {@link bindOwnerRemote} marks them as Remote endpoints on a real Cordis
 * service, and the gateway path is exercised separately.
 *
 * @module adapters/dsh/owner-service
 */

import { existsSync } from "node:fs";

import {
  buildIsolatedGroup,
  ensureBareRepository,
  runGit,
  SeamUnavailableError,
  validateArchiveRoot,
  type ArchiveRoot,
  type ProviderFactories,
  type RootRefusal,
  type IsolatedContext,
  type SandboxLike,
  type SubprocessLike,
} from "./archive.ts";
import { assertedIdentityFields, ownerVerdict, type InvocationLike } from "./owner.ts";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_REF,
  canonicalJson,
  digestOf,
  initialMeta,
  judgeRetry,
  META_PATH,
  operationPath,
  operationRecord,
  parseMeta,
  receiptPath,
  receiptRecord,
  validateBinding,
  validateExpectedRevision,
  validateGrants,
  judgeWorld,
  type Grant,
  type ReceiptRecord,
  type SourceBinding,
  type TopologyDeclaration,
} from "./records.ts";

/** The refusal codes the surface returns. */
export type FailureCode =
  | "not_authorized"
  | "invalid_input"
  | "revision_conflict"
  | "storage_unavailable"
  | "archive_not_initialized"
  | "archive_already_initialized";

/** A management call's result: a value, or a code with a reason. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/**
 * The context shape this module needs.
 *
 * `invocation` is declared optional because it genuinely is: outside a Remote
 * call the property is `undefined`, and that is the case the authorization
 * check exists to refuse. `isolate`/`extend` return `IsolatedContext` so the
 * group builder can be handed this context without a cast.
 */
export interface OwnerContext extends InvocationLike {
  readonly invocation?: InvocationLike | undefined;
  readonly isolate: (name: string, label?: symbol) => IsolatedContext;
  readonly extend: () => IsolatedContext;
  readonly provide: (name: string, value: unknown) => unknown;
  readonly get: (name: string) => unknown;
}

/** What the surface needs from its environment. */
export interface OwnerServiceDeps {
  /** The plugin's context, used for `invocation` and for the isolated group. */
  readonly ctx: OwnerContext;
  /** Deployment-owned archive root. Not a caller value, not a cwd. */
  readonly archiveRoot: string;
  /** Sources bound to this archive, for the isolation check. */
  readonly boundSources?: readonly string[];
  /** Provider constructors; the plugin supplies the published local ones. */
  readonly factories?: ProviderFactories;
  /** Renderer identity recorded in metadata. */
  readonly renderer?: string;
  /**
   * The deployment's statement about which execution world it runs in.
   *
   * Required for `bind`: without it the archive cannot tell whether a source is
   * in its own world, and an unproven binding is refused rather than enabled.
   */
  readonly topology?: TopologyDeclaration;
}

/** What `initialize` returns. */
export interface InitializeResult {
  readonly archiveId: string;
  readonly committedRevision: string;
  readonly sequence: number;
  readonly headRevision: string;
}

/** What `bind` returns. */
export interface BindResult {
  readonly committedRevision: string;
  readonly sequence: number;
  readonly binding: SourceBinding;
}

/** What `status` returns. */
export interface StatusResult {
  readonly archiveInitialized: boolean;
  readonly headRevision: string | null;
  readonly sequence: number;
  readonly recordCount: number;
  readonly boundSource: SourceBinding | null;
  readonly archiveId: string | null;
}

/** What `readBack` returns. */
export interface ReadBackResult {
  readonly readRevision: string;
  readonly headRevision: string;
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

/** The four management methods. */
export interface OwnerService {
  initialize(request: Readonly<Record<string, unknown>>, invocation?: InvocationLike): Promise<Outcome<InitializeResult>>;
  bind(request: Readonly<Record<string, unknown>>, invocation?: InvocationLike): Promise<Outcome<BindResult>>;
  status(request: Readonly<Record<string, unknown>>, invocation?: InvocationLike): Promise<Outcome<StatusResult>>;
  readBack(request: Readonly<Record<string, unknown>>, invocation?: InvocationLike): Promise<Outcome<ReadBackResult>>;
}

/** The group's services, or the reason they are unavailable. */
type Group =
  | { readonly ok: true; readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the isolated group.
 *
 * A failure here is terminal for the surface: every call reports
 * `storage_unavailable`. That is deliberate — an archive that silently ran its
 * Git through the session's execution world would commit into a world the
 * deployment never chose, and the whole point of this slice is that it must not.
 * @param deps - the plugin's context and provider factories.
 * @returns the group, or the reason it could not be built.
 */
function buildGroup(deps: OwnerServiceDeps): Group {
  if (deps.factories === undefined) {
    return {
      ok: false,
      reason:
        "no local subprocess/sandbox providers were supplied; the archive requires its own isolated Host-local execution group",
    };
  }
  try {
    const group = buildIsolatedGroup(deps.ctx, deps.factories);
    return { ok: true, sandbox: group.sandbox, subprocess: group.subprocess };
  } catch (error) {
    const reason = error instanceof SeamUnavailableError ? error.message : (error as Error).message;
    return { ok: false, reason };
  }
}

/**
 * Read the current head, if the archive has been initialised.
 *
 * An absent root is not an error: it means the archive was never created, and
 * the caller reports that as `archiveInitialized: false`. Running Git there
 * instead would fail on a missing working directory, which reads like a broken
 * archive rather than an absent one.
 * @param group - the isolated services.
 * @param archiveRoot - the deployment root.
 * @returns the head commit, or null when there is no published ref.
 */
async function readHead(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
): Promise<string | null> {
  if (!existsSync(archiveRoot)) return null;
  const result = await runGit(group, archiveRoot, { kind: "rev-parse-head" }, { mode: "read-only" });
  const head = result.stdout.trim();
  return result.exitCode === 0 && head !== "" ? head : null;
}

/** Read one file at a revision. */
async function readAt(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
  revision: string,
  path: string,
): Promise<string | null> {
  const result = await runGit(group, archiveRoot, { kind: "read-tree-path", revision, path }, { mode: "read-only" });
  return result.exitCode === 0 ? result.stdout : null;
}

/** The refusal shape shared by the preamble steps. */
type Refusal = { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/** Authorize one call, or report the refusal. */
function authorize(invocation: InvocationLike | undefined): Refusal | undefined {
  const verdict = ownerVerdict(invocation);
  if (!verdict.ok) return { ok: false, code: "not_authorized", reason: verdict.reason };
  return undefined;
}

/** Reject a request that carries its own identity. */
function rejectAssertedIdentity(request: Readonly<Record<string, unknown>>): Refusal | undefined {
  const fields = assertedIdentityFields(request);
  if (fields.length === 0) return undefined;
  return {
    ok: false,
    code: "invalid_input",
    reason:
      `the request asserts its own identity (${fields.join(", ")}); authorization comes from the authenticated invocation, ` +
      "not from the payload",
  };
}

/**
 * Resolve the deployment root, or report why it is unusable.
 *
 * `extraSources` are candidate sources from *this request*, not only the
 * deployment-configured ones. Without them, a real install — where nothing
 * configures `boundSources` — would validate the root against an empty list and
 * accept a root that the source being bound actually overlaps.
 * @param deps - the surface's environment.
 * @param extraSources - candidate source paths from the current request.
 * @returns the validated root, or the refusal.
 */
function resolveRoot(deps: OwnerServiceDeps, extraSources: readonly string[] = []): ArchiveRoot | RootRefusal {
  const sources = [...(deps.boundSources ?? []), ...extraSources];
  return validateArchiveRoot(deps.archiveRoot, sources);
}

/**
 * Admit a source for a write: the same checks for `initialize` and `bind`.
 *
 * Both write entry points must run this, and it must use the *candidate* source
 * from the request. Checking only deployment-configured sources was a real gap:
 * the real plugin configures none, so the overlap test ran against an empty
 * list and both entries accepted a source sitting inside the archive root.
 *
 * The caller runs this after validating the request's own fields, so an
 * argument error is reported as an argument error rather than as a deployment
 * problem: a malformed request never has to be interpreted as an archive-root
 * refusal.
 *
 * Three checks, in order, each with its own reason:
 * 1. the binding is structurally sound;
 * 2. the deployment has evidenced the source is in the archive's own world;
 * 3. the archive root does not overlap the candidate source.
 * @param binding - the source being bound.
 * @param deps - the surface's environment.
 * @returns the validated root, or a refusal.
 */
function admitSource(
  binding: SourceBinding,
  deps: OwnerServiceDeps,
): { readonly root: ArchiveRoot } | { readonly ok: false; readonly code: FailureCode; readonly reason: string } {
  const bindingCheck = validateBinding(binding);
  if (!bindingCheck.ok) {
    return { ok: false, code: "invalid_input", reason: bindingCheck.reason };
  }

  // Same-world is a deployment fact, not a path comparison.
  const world = judgeWorld(binding, deps.topology);
  if (world.relation !== "same") {
    return { ok: false, code: "invalid_input", reason: world.reason };
  }

  // The candidate source participates in the overlap check, so a source inside
  // the root (or a root inside the source) is refused at both write entries.
  const root = resolveRoot(deps, [binding.canonicalAddress]);
  if (!root.ok) {
    return { ok: false, code: "invalid_input", reason: `the configured archive root is unusable: ${root.reason}` };
  }
  return { root };
}

/** Count the record files present at one revision. */
async function countRecords(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
  revision: string,
): Promise<number> {
  const listing = await runGit(group, archiveRoot, { kind: "list-tree", revision, prefix: "records" }, { mode: "read-only" });
  if (listing.exitCode !== 0) return 0;
  return listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".json")).length;
}

/** One file to write into a commit. */
interface TreeFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Read every file of a revision back as tree files.
 *
 * A commit names a whole tree, so a write that publishes only its own files
 * silently *deletes* everything it did not mention: after a second `bind` the
 * head would carry `meta.json` and the newest operation and receipt, and the
 * earlier ones would be unreachable even though their objects still exist. The
 * archive's value is that the head is a complete, auditable state, so each write
 * entry starts from the head it supersedes and layers its own files on top.
 *
 * Two fixed commands, both read-only, in the closed set: list the tree, then read
 * each blob at that revision.
 * @param group - the isolated services.
 * @param archiveRoot - the deployment root.
 * @param revision - the commit whose tree to read.
 * @returns the files, or the failure.
 */
async function readTreeFiles(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
  revision: string,
): Promise<{ ok: true; files: TreeFile[] } | { ok: false; code: FailureCode; reason: string }> {
  const listing = await runGit(group, archiveRoot, { kind: "list-tree", revision, prefix: "" }, { mode: "read-only" });
  if (listing.exitCode !== 0) {
    return {
      ok: false,
      code: "storage_unavailable",
      reason: `could not list the archive tree at ${revision}: ${listing.stderr.trim() || "no output"}`,
    };
  }
  const files: TreeFile[] = [];
  for (const line of listing.stdout.split("\n")) {
    const path = line.trim();
    if (path === "") continue;
    const content = await readAt(group, archiveRoot, revision, path);
    if (content === null) {
      return {
        ok: false,
        code: "storage_unavailable",
        reason: `the archive tree at ${revision} lists ${path} but it could not be read`,
      };
    }
    files.push({ path, content });
  }
  return { ok: true, files };
}

/**
 * Layer this write's files over the tree they supersede.
 *
 * Later entries win, so a write replaces `meta.json` and adds its own records
 * while every file it does not name is carried forward unchanged. The order is
 * the caller's: base first, then this write's files.
 * @param base - the files read from the head being superseded.
 * @param additions - this write's files.
 * @returns the merged file list, sorted by path for a stable tree.
 */
function mergeTreeFiles(base: readonly TreeFile[], additions: readonly TreeFile[]): TreeFile[] {
  const merged = new Map<string, TreeFile>();
  for (const file of base) merged.set(file.path, file);
  for (const file of additions) merged.set(file.path, file);
  return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Write a tree and publish it, with a compare-and-swap on the ref.
 *
 * The commit is created first and the ref moved second. That order is what
 * makes a failure safe: an unpublished commit is unreachable, so a crash leaves
 * the archive at its previous head rather than at a half-written one.
 * @param group - the isolated services.
 * @param archiveRoot - the deployment root.
 * @param files - the files of the new tree.
 * @param options - parent commit (null for the first) and message.
 * @returns the published revision, or the failure.
 */
async function commitTree(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
  files: readonly TreeFile[],
  options: { readonly parent: string | null; readonly message: string },
): Promise<{ ok: true; revision: string } | { ok: false; code: FailureCode; reason: string }> {
  const tree = await writeTree(group, archiveRoot, files);
  if (!tree.ok) return tree;

  const committed = await runGit(
    group,
    archiveRoot,
    options.parent === null
      ? { kind: "commit-tree", tree: tree.tree, message: options.message }
      : { kind: "commit-tree", tree: tree.tree, message: options.message, parent: options.parent },
  );
  if (committed.exitCode !== 0) {
    return { ok: false, code: "storage_unavailable", reason: `commit-tree failed: ${committed.stderr.trim() || committed.stdout.trim()}` };
  }
  const revision = committed.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    return { ok: false, code: "storage_unavailable", reason: `commit-tree returned ${JSON.stringify(revision)}, not a commit id` };
  }

  // The compare-and-swap: the ref must be exactly the parent we read (or absent
  // for the first commit), so a concurrent writer cannot be silently overwritten.
  const published = await runGit(group, archiveRoot, { kind: "update-ref", revision, expected: options.parent });
  if (published.exitCode !== 0) {
    return {
      ok: false,
      code: "revision_conflict",
      reason: `the ref moved while this commit was being prepared: ${published.stderr.trim() || published.stdout.trim()}`,
    };
  }
  return { ok: true, revision };
}

/**
 * Write the files of one tree into a Git tree object.
 *
 * Each file becomes a blob via `hash-object -w`, then the directory structure is
 * assembled with `mktree` from the leaves upward: `mktree` takes a flat list of
 * entries and rejects a name containing `/`, so a nested path such as
 * `records/checkpoint/x.json` has to be built as a subtree and referenced by
 * its id. This keeps every command in the fixed set and leaves no `.git/index`
 * in the archive; an index would be a second piece of mutable state to keep
 * consistent with the ref, for no benefit here.
 * @param group - the isolated services.
 * @param archiveRoot - the deployment root.
 * @param files - the files to write.
 * @returns the root tree id, or the failure.
 */
async function writeTree(
  group: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  archiveRoot: string,
  files: readonly TreeFile[],
): Promise<{ ok: true; tree: string } | { ok: false; code: FailureCode; reason: string }> {
  /** One blob entry in a tree. */
  interface BlobEntry {
    readonly id: string;
    readonly name: string;
  }
  /** A directory: either blobs or further directories, keyed by name. */
  type Dir = Map<string, BlobEntry | Dir>;

  const rootDir: Dir = new Map();
  for (const file of files) {
    const blob = await runGit(group, archiveRoot, { kind: "hash-object", content: file.content });
    if (blob.exitCode !== 0) {
      return { ok: false, code: "storage_unavailable", reason: `hash-object failed for ${file.path}: ${blob.stderr.trim()}` };
    }
    const id = blob.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(id)) {
      return { ok: false, code: "storage_unavailable", reason: `hash-object returned ${JSON.stringify(id)} for ${file.path}` };
    }
    const segments = file.path.split("/");
    const name = segments.pop() as string;
    let dir = rootDir;
    for (const segment of segments) {
      const next = dir.get(segment);
      if (next instanceof Map) {
        dir = next;
        continue;
      }
      const created: Dir = new Map();
      dir.set(segment, created);
      dir = created;
    }
    dir.set(name, { id, name });
  }

  /** Recursively write one directory and return its tree id. */
  const writeDir = async (dir: Dir): Promise<{ ok: true; id: string } | { ok: false; code: FailureCode; reason: string }> => {
    const entries: string[] = [];
    for (const [name, value] of [...dir.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (value instanceof Map) {
        const child = await writeDir(value);
        if (!child.ok) return child;
        entries.push(`040000 tree ${child.id}\t${name}`);
      } else {
        entries.push(`100644 blob ${value.id}\t${name}`);
      }
    }
    const tree = await runGit(group, archiveRoot, { kind: "mktree", entries });
    if (tree.exitCode !== 0) {
      return { ok: false, code: "storage_unavailable", reason: `mktree failed: ${tree.stderr.trim() || tree.stdout.trim()}` };
    }
    const id = tree.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(id)) {
      return { ok: false, code: "storage_unavailable", reason: `mktree returned ${JSON.stringify(id)}, not a tree id` };
    }
    return { ok: true, id };
  };

  const result = await writeDir(rootDir);
  return result.ok ? { ok: true, tree: result.id } : result;
}

/**
 * Build the owner management surface.
 *
 * Construction does not touch the filesystem: the group is built lazily on the
 * first call that needs it, so a plugin whose deployment did not configure an
 * archive root still loads and reports the problem per call instead of failing
 * to boot.
 * @param deps - context, deployment root, and provider factories.
 * @returns the four management methods.
 */
export function createOwnerService(deps: OwnerServiceDeps): OwnerService {
  let group: Group | undefined;
  const getGroup = (): Group => (group ??= buildGroup(deps));

  /**
   * Shared authorization preamble: no asserted identity, and an owner Peer.
   *
   * The deployment root is deliberately *not* resolved here. `initialize` and
   * `bind` must validate it against the candidate source from the request, so
   * resolving it against only the configured sources would be the very gap this
   * split exists to close.
   */
  function preflight(
    request: Readonly<Record<string, unknown>>,
    invocation: InvocationLike | undefined,
  ): Refusal | undefined {
    const identity = rejectAssertedIdentity(request);
    if (identity !== undefined) return identity;
    // The caller supplies the invocation it observed. Falling back to the
    // construction-time context would re-read an object with no invocation and
    // refuse a call the Remote had already authorised.
    return authorize(invocation ?? deps.ctx.invocation);
  }

  /** Resolve the root for a read-only call, where no candidate source exists. */
  function rootForRead(): { readonly root: ArchiveRoot } | Refusal {
    const root = resolveRoot(deps);
    if (!root.ok) {
      return { ok: false, code: "invalid_input", reason: `the configured archive root is unusable: ${root.reason}` };
    }
    return { root };
  }

  return {
    async initialize(request, invocation) {
      const denied = preflight(request, invocation);
      if (denied !== undefined) return denied;

      const binding = request.source_descriptor as SourceBinding | undefined;
      if (binding === undefined || typeof binding !== "object") {
        return { ok: false, code: "invalid_input", reason: "source_descriptor is required" };
      }

      const grants = request.initial_grants as readonly Grant[] | undefined;
      if (!Array.isArray(grants)) {
        return { ok: false, code: "invalid_input", reason: "initial_grants must be an array" };
      }
      const grantCheck = validateGrants(grants);
      if (!grantCheck.ok) return { ok: false, code: "invalid_input", reason: grantCheck.reason };

      // `initialize` is the one call that may use `absent`, because the owner is
      // creating the archive for the first time.
      const expected = validateExpectedRevision(request.expected_revision ?? "absent", { allowAbsent: true });
      if (!expected.ok) return { ok: false, code: "invalid_input", reason: expected.reason };
      if (expected.expected !== null) {
        return {
          ok: false,
          code: "invalid_input",
          reason: "initialize always creates a new archive; expected_revision must be absent",
        };
      }

      // The same admission both write entries use: shape, proven world, and
      // overlap with this candidate source. `initialize` previously checked only
      // the binding shape, so it could create an archive whose root overlapped
      // the source it was binding.
      const admitted = admitSource(binding, deps);
      if (!("root" in admitted)) return admitted;

      const live = getGroup();
      if (!live.ok) return { ok: false, code: "storage_unavailable", reason: live.reason };

      const created = await ensureBareRepository(live, admitted.root.path);
      if (!created.ok) return { ok: false, code: "storage_unavailable", reason: created.reason };

      const existing = await readHead(live, admitted.root.path);
      if (existing !== null) {
        return {
          ok: false,
          code: "archive_already_initialized",
          reason: `the archive at this root already has ${ARCHIVE_REF} at ${existing}; use bind/status instead of initialize`,
        };
      }

      const archiveId = `arch-${digestOf(canonicalJson(binding)).slice(0, 16)}`;
      const meta = initialMeta({ archiveId, binding, grants, renderer: deps.renderer ?? ARCHIVE_FORMAT });
      const operation = operationRecord({
        sequence: 1,
        actor: "owner",
        action: "initialize",
        payload: { binding, grants },
        changedIds: ["meta"],
        result: { archiveId },
      });
      const receipt = receiptRecord({
        payloadDigest: digestOf(canonicalJson({ binding, grants })),
        sequence: 1,
        result: { archiveId },
      });

      const committed = await commitTree(
        live,
        admitted.root.path,
        [
          { path: META_PATH, content: `${canonicalJson(meta)}\n` },
          { path: operationPath(1), content: `${canonicalJson(operation)}\n` },
          { path: receiptPath("owner", "initialize"), content: `${canonicalJson(receipt)}\n` },
        ],
        { parent: null, message: `initialize ${archiveId}` },
      );
      if (!committed.ok) return committed;

      return {
        ok: true,
        value: { archiveId, committedRevision: committed.revision, sequence: 1, headRevision: committed.revision },
      };
    },

    async bind(request, invocation) {
      const denied = preflight(request, invocation);
      if (denied !== undefined) return denied;

      const binding = request.source_descriptor as SourceBinding | undefined;
      if (binding === undefined || typeof binding !== "object") {
        return { ok: false, code: "invalid_input", reason: "source_descriptor is required" };
      }
      if (typeof request.reason !== "string" || request.reason.trim() === "") {
        return { ok: false, code: "invalid_input", reason: "reason is required for bind" };
      }

      const expected = validateExpectedRevision(request.expected_revision, { allowAbsent: false });
      if (!expected.ok) return { ok: false, code: "invalid_input", reason: expected.reason };
      if (expected.expected === null) {
        return { ok: false, code: "invalid_input", reason: "bind needs an existing revision" };
      }

      // The same admission `initialize` uses: shape, proven world, and overlap
      // against this candidate source. Checking only configured sources let a
      // binding through whose source sat inside the archive root.
      const admitted = admitSource(binding, deps);
      if (!("root" in admitted)) return admitted;

      const live = getGroup();
      if (!live.ok) return { ok: false, code: "storage_unavailable", reason: live.reason };

      const head = await readHead(live, admitted.root.path);
      if (head === null) {
        return {
          ok: false,
          code: "archive_not_initialized",
          reason: "no archive at this root; the owner must initialize before binding",
        };
      }
      if (head !== expected.expected) {
        return {
          ok: false,
          code: "revision_conflict",
          reason: `expected ${expected.expected} but the archive head is ${head}; nothing was written`,
        };
      }

      const metaText = await readAt(live, admitted.root.path, head, META_PATH);
      if (metaText === null) {
        return { ok: false, code: "storage_unavailable", reason: "the archive head has no meta.json" };
      }
      const parsed = parseMeta(metaText);
      if (!parsed.ok) return { ok: false, code: "invalid_input", reason: parsed.reason };

      const nextSequence = parsed.meta.sequence + 1;
      const nextMeta = { ...parsed.meta, sequence: nextSequence, binding };
      const payloadDigest = digestOf(canonicalJson({ binding, reason: request.reason }));
      const operation = operationRecord({
        sequence: nextSequence,
        actor: "owner",
        action: "bind",
        payload: { binding, reason: request.reason },
        changedIds: ["meta"],
        result: { sequence: nextSequence },
      });
      const receipt = receiptRecord({
        payloadDigest,
        sequence: nextSequence,
        result: { sequence: nextSequence },
      });

      // Start from the head this bind supersedes, so every earlier operation and
      // receipt is still published at the new head. Publishing only this call's
      // files would make the previous ones unreachable.
      const base = await readTreeFiles(live, admitted.root.path, head);
      if (!base.ok) return base;

      const committed = await commitTree(
        live,
        admitted.root.path,
        mergeTreeFiles(base.files, [
          { path: META_PATH, content: `${canonicalJson(nextMeta)}\n` },
          { path: operationPath(nextSequence), content: `${canonicalJson(operation)}\n` },
          { path: receiptPath("owner", String(request.operation_id ?? "bind")), content: `${canonicalJson(receipt)}\n` },
        ]),
        { parent: head, message: `bind at sequence ${nextSequence}` },
      );
      if (!committed.ok) return committed;

      return { ok: true, value: { committedRevision: committed.revision, sequence: nextSequence, binding } };
    },

    async status(request, invocation) {
      const denied = preflight(request, invocation);
      if (denied !== undefined) return denied;
      const ready = rootForRead();
      if (!("root" in ready)) return ready;

      const live = getGroup();
      if (!live.ok) return { ok: false, code: "storage_unavailable", reason: live.reason };

      const head = await readHead(live, ready.root.path);
      if (head === null) {
        return {
          ok: true,
          value: {
            archiveInitialized: false,
            headRevision: null,
            sequence: 0,
            recordCount: 0,
            boundSource: null,
            archiveId: null,
          },
        };
      }
      const metaText = await readAt(live, ready.root.path, head, META_PATH);
      if (metaText === null) {
        return { ok: false, code: "storage_unavailable", reason: "the archive head has no meta.json" };
      }
      const parsed = parseMeta(metaText);
      if (!parsed.ok) return { ok: false, code: "invalid_input", reason: parsed.reason };

      return {
        ok: true,
        value: {
          archiveInitialized: true,
          headRevision: head,
          sequence: parsed.meta.sequence,
          recordCount: await countRecords(live, ready.root.path, head),
          boundSource: parsed.meta.binding,
          archiveId: parsed.meta.archiveId,
        },
      };
    },

    async readBack(request, invocation) {
      const denied = preflight(request, invocation);
      if (denied !== undefined) return denied;
      const ready = rootForRead();
      if (!("root" in ready)) return ready;
      const revision = validateExpectedRevision(request.revision, { allowAbsent: false });
      if (!revision.ok) return { ok: false, code: "invalid_input", reason: revision.reason };
      if (revision.expected === null) {
        return { ok: false, code: "invalid_input", reason: "readBack needs a concrete revision" };
      }
      const path = request.path;
      if (typeof path !== "string" || path.trim() === "") {
        return { ok: false, code: "invalid_input", reason: "path must name one file inside the archive tree" };
      }

      const live = getGroup();
      if (!live.ok) return { ok: false, code: "storage_unavailable", reason: live.reason };

      const content = await readAt(live, ready.root.path, revision.expected, path);
      if (content === null) {
        return { ok: false, code: "invalid_input", reason: `no ${path} at revision ${revision.expected}` };
      }
      const head = await readHead(live, ready.root.path);
      return {
        ok: true,
        value: {
          readRevision: revision.expected,
          headRevision: head ?? revision.expected,
          path,
          content,
          bytes: new TextEncoder().encode(content).byteLength,
        },
      };
    },
  };
}

/**
 * The retry decision for a call that carries an operation key.
 *
 * Exposed so a caller can consult it before committing; the surface itself uses
 * it when a key has already been published.
 * @param receipt - the stored receipt, when the key was used before.
 * @param payloadDigest - the digest of the payload now being sent.
 * @returns the retry verdict.
 */
export function retryVerdict(receipt: ReceiptRecord | undefined, payloadDigest: string) {
  return judgeRetry(receipt, payloadDigest);
}
