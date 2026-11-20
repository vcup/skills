/**
 * Tests for the owner management surface.
 *
 * Two groups:
 *
 * - **Authorization and validation** run everywhere with no install. Every one
 *   of these asserts a refusal, because the interesting failure is a call that
 *   was allowed when it should not have been.
 * - **The real archive** runs only when `DSH_ARCHIVE_SEAM_INSTALL` names an
 *   isolated install: it initializes an archive through real confined Git,
 *   reads it back, and proves the head survives a fresh surface (the restart
 *   case). Without that variable the cases skip with a message.
 *
 * Nothing here writes outside a temporary directory.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOwnerService, type OwnerContext, type OwnerService } from "./owner-service.ts";
import type { ProviderFactories } from "./archive.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "owner-service-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BINDING = {
  worldIdentity: "host-local",
  canonicalAddress: "/home/user/project",
  nativeWorkspaceRef: "workspace:1",
};

const GRANTS = [{ subjectId: "owner", rights: ["manage"] }];

/**
 * A context whose invocation is whatever the test says.
 *
 * The scoping methods are inert: these tests never reach the archive, because
 * every case here is refused before the group is needed. That is the point —
 * if a refusal path ever needed the filesystem, these tests would fail.
 */
function contextWith(invocation: unknown): OwnerContext {
  const ctx: OwnerContext = {
    invocation: invocation as never,
    isolate: () => ctx,
    extend: () => ctx,
    provide: () => () => {},
    get: () => undefined,
  };
  return ctx;
}

/** A context that is inside a Remote call by the owner. */
function ownerContext(): OwnerContext {
  return contextWith({ peer: { principal: { kind: "owner" } } });
}

/** A surface over a root that will never be written, for refusal cases. */
function surface(invocation: unknown, archiveRoot = "/nonexistent/archive"): OwnerService {
  return createOwnerService({ ctx: contextWith(invocation), archiveRoot });
}

describe("authorization", () => {
  const calls = ["initialize", "bind", "status", "readBack"] as const;
  const request = { source_descriptor: BINDING, initial_grants: GRANTS, expected_revision: "absent", revision: "a".repeat(40), path: "meta.json" };

  test("every management call refuses an in-process caller with no Remote invocation", async () => {
    const service = surface(undefined);
    for (const call of calls) {
      const outcome = await service[call](request);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("not_authorized");
        expect(outcome.reason).toContain("no Remote invocation");
      }
    }
  });

  test("every management call refuses a non-owner principal", async () => {
    const service = surface({ peer: { principal: { kind: "share-viewer", subject: "someone" } } });
    for (const call of calls) {
      const outcome = await service[call](request);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("not_authorized");
        expect(outcome.reason).toContain("not the owner");
      }
    }
  });

  test("a request asserting its own identity is refused even for the owner", async () => {
    const service = surface({ peer: { principal: { kind: "owner" } } });
    for (const field of ["owner", "actor", "author", "isOwner", "isVerified"]) {
      const outcome = await service.status({ [field]: true });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("invalid_input");
        expect(outcome.reason).toContain(field);
      }
    }
  });

  test("authorization is checked before the request shape", async () => {
    // A malformed request from a non-owner must not reveal which field was
    // wrong: the refusal is about identity, not about input.
    const service = surface(undefined);
    const outcome = await service.initialize({ nonsense: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("not_authorized");
  });
});

describe("request validation", () => {
  const service = surface({ peer: { principal: { kind: "owner" } } });

  test("initialize requires a source descriptor", async () => {
    const outcome = await service.initialize({ initial_grants: GRANTS });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("source_descriptor");
  });

  test("initialize requires at least one grant", async () => {
    const empty = await service.initialize({ source_descriptor: BINDING, initial_grants: [] });
    expect(empty.ok).toBe(false);

    const missing = await service.initialize({ source_descriptor: BINDING });
    expect(missing.ok).toBe(false);
  });

  test("initialize refuses a concrete expected revision", async () => {
    // initialize creates the archive; anything other than absent is a request
    // to overwrite, which this call must never do.
    const outcome = await service.initialize({
      source_descriptor: BINDING,
      initial_grants: GRANTS,
      expected_revision: "a".repeat(40),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("must be absent");
  });

  test("bind refuses absent, because the archive must already exist", async () => {
    const outcome = await service.bind({
      source_descriptor: BINDING,
      reason: "rebind",
      expected_revision: "absent",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("first initialisation");
  });

  test("bind requires a reason", async () => {
    const outcome = await service.bind({
      source_descriptor: BINDING,
      expected_revision: "a".repeat(40),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("reason");
  });

  test("readBack refuses latest and a missing path", async () => {
    const latest = await service.readBack({ revision: "latest", path: "meta.json" });
    expect(latest.ok).toBe(false);

    const noPath = await service.readBack({ revision: "a".repeat(40) });
    expect(noPath.ok).toBe(false);
  });

  test("an unusable archive root is reported, not guessed around", async () => {
    const relative = createOwnerService({ ctx: ownerContext(), archiveRoot: "relative/path" });
    const outcome = await relative.status({});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("invalid_input");
      expect(outcome.reason).toContain("archive root is unusable");
    }
  });

  test("an archive root inside a bound source is refused", async () => {
    const source = temporaryRoot();
    const serviceWithSource = createOwnerService({
      ctx: ownerContext(),
      archiveRoot: join(source, ".archive"),
      boundSources: [source],
    });
    const outcome = await serviceWithSource.status({});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("outside every source");
  });

  test("without provider factories the surface reports storage_unavailable rather than degrading", async () => {
    // The one case that must not fall back: no isolated group means no archive.
    const root = join(temporaryRoot(), "archive");
    const service = createOwnerService({ ctx: ownerContext(), archiveRoot: root });
    const outcome = await service.status({});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("storage_unavailable");
      expect(outcome.reason).toContain("isolated Host-local execution group");
    }
  });
});

// ── the real archive ───────────────────────────────────────────────────────

/**
 * The isolated install, resolved to an absolute path.
 *
 * A relative value would be resolved against this module, so a maintainer who
 * passes `.scratch/rc5-cycle/rc5` would get a module-resolution error that looks
 * like a bug in the archive. Resolving first and naming the path makes the
 * mistake obvious instead.
 */
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

/** Load the published providers from the isolated install. */
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

/** A context that is inside an owner Remote call, over a real Cordis Context. */
function realOwnerContext(Context: new () => OwnerContext): OwnerContext {
  const base = new Context() as unknown as OwnerContext;
  // The invocation is what the gateway would have derived for an owner Peer.
  // The real gateway path is exercised separately; here the point is the archive
  // behaviour, so the invocation is supplied directly.
  Object.defineProperty(base, "invocation", {
    value: { peer: { principal: { kind: "owner" } } },
    configurable: true,
  });
  return base;
}

describe("real archive", () => {
  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "initializes, reports status, reads back, and survives a fresh surface",
    async () => {
      const { Context, factories } = await realFactories();
      const archiveRoot = join(temporaryRoot(), "archive");
      const source = temporaryRoot();

      const service = createOwnerService({
        ctx: realOwnerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
      });

      const before = await service.status({});
      expect(before.ok).toBe(true);
      if (before.ok) expect(before.value.archiveInitialized).toBe(false);

      const initialized = await service.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      expect(initialized.value.committedRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(initialized.value.sequence).toBe(1);

      const status = await service.status({});
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.value.archiveInitialized).toBe(true);
        expect(status.value.headRevision).toBe(initialized.value.committedRevision);
        expect(status.value.archiveId).toBe(initialized.value.archiveId);
        expect(status.value.boundSource?.nativeWorkspaceRef).toBe(BINDING.nativeWorkspaceRef);
      }

      const readBack = await service.readBack({
        revision: initialized.value.committedRevision,
        path: "meta.json",
      });
      expect(readBack.ok).toBe(true);
      if (readBack.ok) {
        const meta = JSON.parse(readBack.value.content) as { archiveId: string; format: string };
        expect(meta.archiveId).toBe(initialized.value.archiveId);
        expect(meta.format).toBe("ensemble-archive/v1");
      }

      // The restart case: a fresh surface over the same root reads the same head
      // and does not re-initialize.
      const restarted = createOwnerService({
        ctx: realOwnerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
      });
      const afterRestart = await restarted.status({});
      expect(afterRestart.ok).toBe(true);
      if (afterRestart.ok) expect(afterRestart.value.headRevision).toBe(initialized.value.committedRevision);

      const second = await restarted.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("archive_already_initialized");

      // The source was never written to.
      expect(existsSync(join(source, ".ensemble"))).toBe(false);
    },
    { timeout: 180_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "bind moves the head forward and refuses a stale expected revision",
    async () => {
      const { Context, factories } = await realFactories();
      const archiveRoot = join(temporaryRoot(), "archive");
      const service = createOwnerService({ ctx: realOwnerContext(Context), archiveRoot, factories });

      const initialized = await service.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      const first = initialized.value.committedRevision;

      const bound = await service.bind({
        source_descriptor: { ...BINDING, canonicalAddress: "/home/user/other" },
        reason: "owner rebound the source",
        expected_revision: first,
      });
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      expect(bound.value.sequence).toBe(2);
      expect(bound.value.committedRevision).not.toBe(first);

      // A stale revision must not be silently accepted: the head has moved.
      const stale = await service.bind({
        source_descriptor: BINDING,
        reason: "stale retry",
        expected_revision: first,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.code).toBe("revision_conflict");
        expect(stale.reason).toContain("nothing was written");
      }
    },
    { timeout: 180_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "an archive root overlapping its bound source is refused before anything is written",
    async () => {
      const { Context, factories } = await realFactories();
      const source = temporaryRoot();
      const archiveRoot = join(source, "archive");
      const service = createOwnerService({
        ctx: realOwnerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
      });

      const outcome = await service.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("outside every source");
      // The refusal happened before the root was created.
      expect(existsSync(archiveRoot)).toBe(false);
    },
    { timeout: 180_000 },
  );
});
