/**
 * Counterexamples driven through the **real** `initialize`/`bind` entries.
 *
 * Every case here is a defect that was found by hand and that a green unit suite
 * had missed, because the unit tests exercised the validators rather than the
 * entry points that call them. Each test therefore has the same three-part
 * shape, and all three parts matter:
 *
 * 1. **the refusal** — the real entry returns `ok: false` with the reason that
 *    names the actual problem;
 * 2. **the head did not move** — `status` still reports the revision it reported
 *    before the call, so nothing was written and no half-binding was recorded;
 * 3. **the source tree is untouched** — the source directory's file list and
 *    contents are byte-identical afterwards, which is the property the whole
 *    archive design exists to protect.
 *
 * The cases:
 *
 * 1. `boundSources` is not wired in the real plugin, so `resolveRoot` sees an
 *    empty list. A source *inside* the archive root must still be refused,
 *    because the candidate source from the request participates in the overlap
 *    check.
 * 2. `bind` with a same-world source whose `canonicalAddress` is inside the root
 *    must be refused for the same reason (`initialize` and `bind` share the
 *    admission).
 * 3. A directory the plugin did not create must never be adopted: an existing
 *    bare repository (has `HEAD`, no ownership marker), and a non-empty
 *    directory with no repository at all.
 * 4. A symlinked *parent* must not alias the root into a source: the root leaf
 *    does not exist yet, so a naive `existsSync`-then-`realpath` resolves
 *    nothing and the alias slips through.
 * 5. The decisive oracle for the child environment: a malformed `.gitconfig`
 *    inside the archive root (which is also the child's `HOME`) must not make
 *    Git fail, and a hostile `GIT_CONFIG_GLOBAL` in the parent must not reach
 *    the child. These two assert *success*, because it is the protection being
 *    proven, not a refusal.
 *
 * These need a real isolated DSH install (`DSH_ARCHIVE_SEAM_INSTALL`), because
 * the archive's Git runs inside a real isolated group. Without it they skip with
 * a message rather than pretending to have run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createOwnerService, type OwnerContext, type OwnerService } from "./owner-service.ts";
import type { ProviderFactories } from "./archive.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "owner-entry-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A source whose canonical address is a real directory, so it can be hashed. */
function sourceTree(): string {
  const root = temporaryRoot();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "# a source this archive must never touch\n");
  writeFileSync(join(root, "docs", "note.md"), "content that must survive every refusal\n");
  return root;
}

/**
 * A stable fingerprint of a directory tree: every path, its size, and its
 * content digest.
 *
 * `mtime` is deliberately excluded: reading a file is not a change, and a
 * filesystem that updates atime must not make this test flaky. Content, names
 * and sizes are what a write would disturb.
 * @param root - the directory to fingerprint.
 * @returns sorted `path:sha256:bytes` lines.
 */
function fingerprint(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stats = statSync(full, { throwIfNoEntry: false });
      if (stats === undefined) continue;
      if (stats.isDirectory()) {
        lines.push(`${relative(root, full)}/`);
        walk(full);
        continue;
      }
      const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
      lines.push(`${relative(root, full)}:${digest}:${stats.size}`);
    }
  };
  walk(root);
  return lines.sort();
}

/** Resolve the isolated install to an absolute path, or fail loudly. */
function resolveInstall(): string | undefined {
  const raw = process.env.DSH_ARCHIVE_SEAM_INSTALL;
  if (raw === undefined || raw.trim() === "") return undefined;
  const absolute = resolve(raw);
  if (!existsSync(join(absolute, "node_modules/@deepseek-ai/cordis/package.json"))) {
    throw new Error(
      `DSH_ARCHIVE_SEAM_INSTALL=${absolute} is not an isolated DSH install: no @deepseek-ai/cordis in its node_modules`,
    );
  }
  return absolute;
}

const INSTALL = resolveInstall();
const SKIP = INSTALL === undefined || INSTALL === "";

/** The published providers, loaded from the isolated install. */
async function realFactories(): Promise<{ Context: new () => OwnerContext; factories: ProviderFactories }> {
  const install = INSTALL as string;
  const { Context } = (await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"))) as {
    Context: new () => OwnerContext;
  };
  const { LocalSubprocessRuntime } = (await import(
    join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js")
  )) as { LocalSubprocessRuntime: new (ctx: never) => unknown };
  const { LocalSandboxProvider } = (await import(
    join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js")
  )) as { LocalSandboxProvider: new (ctx: never, config: Record<string, unknown>) => unknown };
  return {
    Context,
    factories: {
      subprocess: (ctx) => new LocalSubprocessRuntime(ctx as never),
      sandbox: (ctx) =>
        new LocalSandboxProvider(ctx as never, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }),
    },
  };
}

/** A real Cordis context carrying an owner invocation, as the gateway would. */
function ownerContext(Context: new () => OwnerContext): OwnerContext {
  const base = new Context() as unknown as OwnerContext;
  Object.defineProperty(base, "invocation", {
    value: { peer: { principal: { kind: "owner" } } },
    configurable: true,
  });
  return base;
}

/** The deployment declaration that evidences one same world. */
const SAME_WORLD = { archiveWorldIdentity: "host-a", sourceWorlds: { "host-a": true } };

/** A binding for a source in the world above. */
function bindingFor(canonicalAddress: string) {
  return { worldIdentity: "host-a", canonicalAddress, nativeWorkspaceRef: "ws:1" };
}

const GRANTS = [{ subjectId: "owner", rights: ["manage"] }];

/** Build a real surface over one root, with a proven same world. */
async function surfaceOver(
  archiveRoot: string,
  options: { readonly boundSources?: readonly string[] } = {},
): Promise<OwnerService> {
  const { Context, factories } = await realFactories();
  return createOwnerService({
    ctx: ownerContext(Context),
    archiveRoot,
    factories,
    topology: SAME_WORLD,
    ...(options.boundSources === undefined ? {} : { boundSources: options.boundSources }),
  });
}

/** The head revision `status` reports, or null. */
async function headOf(service: OwnerService): Promise<string | null> {
  const status = await service.status({});
  expect(status.ok).toBe(true);
  return status.ok ? status.value.headRevision : null;
}

describe("real entry refusals", () => {
  test.skipIf(SKIP)(
    "1. initialize refuses a source inside the archive root even though boundSources is empty",
    async () => {
      // The real plugin wires no `boundSources`; the deployment configured only
      // the root. Before the fix, the overlap test ran against an empty list and
      // the source below was accepted — creating an archive whose Git lives
      // inside the source it records.
      const root = temporaryRoot();
      const archiveRoot = join(root, "archive");
      const source = join(archiveRoot, "source");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "keep.md"), "the source must not gain a repository\n");

      const before = fingerprint(source);
      const service = await surfaceOver(archiveRoot);

      const outcome = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("invalid_input");
        expect(outcome.reason).toContain("is inside the archive root");
      }

      // Nothing was created. The root exists because the test put the source
      // inside it; what must not exist is an archive: no repository, no marker,
      // and no second entry beside the source.
      expect(readdirSync(archiveRoot)).toEqual(["source"]);
      expect(existsSync(join(archiveRoot, "HEAD"))).toBe(false);
      expect(existsSync(join(archiveRoot, "ensemble-archive.json"))).toBe(false);
      expect(await headOf(service)).toBeNull();
      expect(fingerprint(source)).toEqual(before);
    },
    { timeout: 180_000 },
  );

  test.skipIf(SKIP)(
    "2. bind refuses a same-world source whose canonical address is inside the archive root",
    async () => {
      const root = temporaryRoot();
      const archiveRoot = join(root, "archive");
      const outside = sourceTree();
      const inside = join(archiveRoot, "inner-source");

      const service = await surfaceOver(archiveRoot);
      const initialized = await service.initialize({
        source_descriptor: bindingFor(outside),
        initial_grants: GRANTS,
      });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      const headAfterInit = initialized.value.committedRevision;

      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, "keep.md"), "must not be adopted\n");
      const beforeInside = fingerprint(inside);
      const beforeOutside = fingerprint(outside);

      // Same world, so the world check passes and the overlap check decides.
      const refused = await service.bind({
        source_descriptor: bindingFor(inside),
        reason: "bind a source that sits inside the archive root",
        expected_revision: headAfterInit,
      });

      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("invalid_input");
        expect(refused.reason).toContain("is inside the archive root");
      }

      // The side effect is the oracle: the head did not move.
      expect(await headOf(service)).toBe(headAfterInit);
      expect(fingerprint(inside)).toEqual(beforeInside);
      expect(fingerprint(outside)).toEqual(beforeOutside);
    },
    { timeout: 180_000 },
  );

  test.skipIf(SKIP)(
    "3a. initialize refuses to adopt an existing bare repository it did not create",
    async () => {
      // A user's own bare repository has a `HEAD` and nothing else that says
      // whose it is. Adopting it would commit into data the plugin does not own,
      // so the ownership marker is required.
      const root = temporaryRoot();
      const archiveRoot = join(root, "user-bare.git");
      mkdirSync(archiveRoot);
      writeFileSync(join(archiveRoot, "HEAD"), "ref: refs/heads/user-main\n");
      mkdirSync(join(archiveRoot, "objects"));
      mkdirSync(join(archiveRoot, "refs"));
      writeFileSync(join(archiveRoot, "refs", "keep"), "the user's own ref namespace\n");

      const before = fingerprint(archiveRoot);
      const service = await surfaceOver(archiveRoot);
      const source = sourceTree();

      const outcome = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("storage_unavailable");
        expect(outcome.reason).toContain("already a Git repository this plugin did not create");
        expect(outcome.reason).toContain("ensemble-archive.json");
      }

      // Byte-identical: no marker, no new ref, no rewritten HEAD.
      expect(fingerprint(archiveRoot)).toEqual(before);
      expect(existsSync(join(archiveRoot, "ensemble-archive.json"))).toBe(false);
      expect(existsSync(join(archiveRoot, "refs", "ensemble"))).toBe(false);
    },
    { timeout: 180_000 },
  );

  test.skipIf(SKIP)(
    "3b. initialize refuses a non-empty user directory that is not a repository",
    async () => {
      // The other half of the same rule: `git init --bare` in a directory the
      // user filled would bury their files under a repository layout.
      const root = temporaryRoot();
      const archiveRoot = join(root, "user-notes");
      mkdirSync(archiveRoot);
      writeFileSync(join(archiveRoot, "todo.md"), "the user's notes\n");
      mkdirSync(join(archiveRoot, "drafts"));
      writeFileSync(join(archiveRoot, "drafts", "draft.md"), "work in progress\n");

      const before = fingerprint(archiveRoot);
      const service = await surfaceOver(archiveRoot);
      const source = sourceTree();

      const outcome = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("storage_unavailable");
        expect(outcome.reason).toContain("is not empty and has no ensemble-archive.json");
      }

      expect(fingerprint(archiveRoot)).toEqual(before);
      expect(existsSync(join(archiveRoot, "HEAD"))).toBe(false);
    },
    { timeout: 180_000 },
  );

  test.skipIf(SKIP)(
    "4. initialize refuses a root whose symlinked parent aliases into the source",
    async () => {
      // The leaf does not exist yet, which is the normal first-run case. A
      // canonicalisation that only resolves an existing *root* resolves nothing
      // here, and the alias then slips past the overlap test.
      const root = temporaryRoot();
      const source = sourceTree();
      const linkDir = join(root, "linkdir");
      mkdirSync(linkDir);
      const alias = join(linkDir, "alias");
      symlinkSync(source, alias);

      const archiveRoot = join(alias, "newarchive");
      // Sanity: the alias really does point into the source, and the leaf is
      // absent, so this is the case under test rather than a resolved path.
      expect(existsSync(archiveRoot)).toBe(false);
      const before = fingerprint(source);
      expect(before.length).toBeGreaterThan(0);

      const service = await surfaceOver(archiveRoot);
      const outcome = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("invalid_input");
        expect(outcome.reason).toContain("is inside the bound source");
      }

      // The source did not gain an archive directory through the alias.
      expect(existsSync(join(source, "newarchive"))).toBe(false);
      expect(fingerprint(source)).toEqual(before);
    },
    { timeout: 180_000 },
  );

  test.skipIf(SKIP)(
    "5a. the archive's Git ignores a malformed .gitconfig in its own root",
    async () => {
      // The archive root is also the child's `HOME`, so Git would read
      // `<root>/.gitconfig` unless `GIT_CONFIG_GLOBAL=/dev/null` reaches the
      // child. This is the decisive oracle: a broken config file makes Git fail
      // with `fatal: bad config line 1`, so a *successful* bind proves the
      // protection survived the environment merge.
      const root = temporaryRoot();
      const archiveRoot = join(root, "archive");
      const source = sourceTree();

      const service = await surfaceOver(archiveRoot);
      const initialized = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;

      // A config Git cannot parse, in the directory that is the child's HOME.
      writeFileSync(join(archiveRoot, ".gitconfig"), "this is not a config file\n");

      const bound = await service.bind({
        source_descriptor: bindingFor(source),
        reason: "bind with a malformed config in the archive root",
        expected_revision: initialized.value.committedRevision,
      });

      expect(bound.ok).toBe(true);
      if (bound.ok) expect(bound.value.sequence).toBe(2);
      expect(await headOf(service)).toBe(bound.ok ? bound.value.committedRevision : null);
    },
    { timeout: 180_000 },
  );

  test.skipIf(SKIP)(
    "5b. a hostile GIT_CONFIG_GLOBAL in the parent cannot reach the archive's Git",
    async () => {
      // The tombstone-then-protect order is what this proves: if the ambient
      // mask ran *after* the fixed protections, it would delete our
      // `GIT_CONFIG_GLOBAL=/dev/null` and the child would inherit the bad file.
      const root = temporaryRoot();
      const archiveRoot = join(root, "archive");
      const source = sourceTree();
      const hostile = join(temporaryRoot(), "hostile-gitconfig");
      writeFileSync(hostile, "this is not a config file either\n");

      const service = await surfaceOver(archiveRoot);
      const initialized = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;

      // Both halves are needed, and that is the point of the case. A hostile
      // parent alone proves nothing: if the tombstone removes our
      // `GIT_CONFIG_GLOBAL=/dev/null`, Git falls back to `$HOME/.gitconfig`,
      // which is the archive root — and there is no config there to trip over.
      // Putting a malformed one there makes that fallback observable, so this
      // case fails exactly when the ambient mask runs after the protections.
      writeFileSync(join(archiveRoot, ".gitconfig"), "this is not a config file either\n");

      const previous = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = hostile;
      try {
        const bound = await service.bind({
          source_descriptor: bindingFor(source),
          reason: "bind while the parent environment is hostile",
          expected_revision: initialized.value.committedRevision,
        });
        expect(bound.ok).toBe(true);
        if (bound.ok) expect(bound.value.sequence).toBe(2);
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
    },
    { timeout: 180_000 },
  );
});
