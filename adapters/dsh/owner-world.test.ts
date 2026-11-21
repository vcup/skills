/**
 * Tests for the cross-world binding refusal.
 *
 * Same-world is a deployment fact, so the only honest question a test can ask
 * is: when the deployment has *not* evidenced it, does `bind` actually refuse
 * and leave the archive untouched? These tests therefore drive `bind` through
 * the real archive seam and check the side effect — the head revision must not
 * move — rather than asserting that a helper returns a particular sentence.
 *
 * The local-Host case is the one the owner must *explicitly choose*: the
 * topology names the world, and a source is accepted only when the deployment's
 * declaration says that world is the archive's own. Nothing here derives a world
 * from a path or from a session cwd.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { judgeWorld } from "./records.ts";
import { createOwnerService } from "./owner-service.ts";
import type { ProviderFactories } from "./archive.ts";
import type { OwnerContext } from "./owner-service.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "world-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BINDING = {
  worldIdentity: "host-a",
  canonicalAddress: "/srv/source",
  nativeWorkspaceRef: "ws:1",
};

const GRANTS = [{ subjectId: "owner", rights: ["manage"] }];

describe("judgeWorld", () => {
  test("an undeclared topology is unproven, not assumed", () => {
    const verdict = judgeWorld(BINDING, undefined);
    expect(verdict.relation).toBe("unproven");
    if (verdict.relation === "unproven") expect(verdict.reason).toContain("has not declared");
  });

  test("a different world is refused as cross-world", () => {
    const verdict = judgeWorld(BINDING, {
      archiveWorldIdentity: "host-b",
      sourceWorlds: { "host-b": true },
    });
    expect(verdict.relation).toBe("unproven");
    if (verdict.relation === "unproven") {
      expect(verdict.reason).toContain("cross-world source is not supported");
      expect(verdict.reason).toContain("host-a");
      expect(verdict.reason).toContain("host-b");
    }
  });

  test("the same name without evidence is still unproven", () => {
    // Naming the archive's world is not evidence that the source lives in it.
    const verdict = judgeWorld(BINDING, { archiveWorldIdentity: "host-a" });
    expect(verdict.relation).toBe("unproven");
    if (verdict.relation === "unproven") expect(verdict.reason).toContain("has not evidenced");

    const explicitlyFalse = judgeWorld(BINDING, {
      archiveWorldIdentity: "host-a",
      sourceWorlds: { "host-a": false },
    });
    expect(explicitlyFalse.relation).toBe("unproven");
  });

  test("an evidenced same world is the only acceptance", () => {
    const verdict = judgeWorld(BINDING, {
      archiveWorldIdentity: "host-a",
      sourceWorlds: { "host-a": true },
    });
    expect(verdict).toEqual({ relation: "same" });
  });
});

// ── the refusal, driven through the real archive ────────────────────────────

/**
 * Resolve the isolated install to an absolute path, or fail loudly.
 *
 * A relative value would resolve against this module, so a maintainer passing
 * `.scratch/rc5-cycle/rc5` would get a module-resolution error that looks like a
 * bug in the archive rather than a bad path.
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

/** A real Cordis context carrying an owner invocation, as the gateway would. */
function ownerContext(Context: new () => OwnerContext): OwnerContext {
  const base = new Context() as unknown as OwnerContext;
  Object.defineProperty(base, "invocation", {
    value: { peer: { principal: { kind: "owner" } } },
    configurable: true,
  });
  return base;
}

describe("cross-world bind refusal", () => {
  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "an unproven world leaves the archive head untouched",
    async () => {
      const { Context, factories } = await realFactories();
      const archiveRoot = join(temporaryRoot(), "archive");
      const source = temporaryRoot();

      // The archive is created by a deployment that evidences the source's own
      // world: `initialize` runs the same admission as `bind`, so an unproven
      // world is refused there too — that is covered by the case below.
      const creating = createOwnerService({
        ctx: ownerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
        topology: { archiveWorldIdentity: BINDING.worldIdentity, sourceWorlds: { [BINDING.worldIdentity]: true } },
      });
      const initialized = await creating.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      const headAfterInit = initialized.value.committedRevision;

      // This deployment declares a *different* world than the source claims.
      const service = createOwnerService({
        ctx: ownerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
        topology: { archiveWorldIdentity: "host-b", sourceWorlds: { "host-b": true } },
      });

      const refused = await service.bind({
        source_descriptor: BINDING,
        reason: "attempt to bind a cross-world source",
        expected_revision: headAfterInit,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("invalid_input");
        expect(refused.reason).toContain("cross-world source is not supported");
      }

      // The side effect is the oracle: the head did not move, so nothing was
      // written and no half-binding was recorded.
      const after = await service.status({});
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value.headRevision).toBe(headAfterInit);
        expect(after.value.sequence).toBe(1);
      }
    },
    { timeout: 180_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "an evidenced same-world bind is accepted and moves the head",
    async () => {
      const { Context, factories } = await realFactories();
      const archiveRoot = join(temporaryRoot(), "archive");
      const source = temporaryRoot();

      const service = createOwnerService({
        ctx: ownerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
        topology: { archiveWorldIdentity: "host-a", sourceWorlds: { "host-a": true } },
      });

      const initialized = await service.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;

      const bound = await service.bind({
        source_descriptor: { ...BINDING, canonicalAddress: "/srv/source-moved" },
        reason: "owner moved the source",
        expected_revision: initialized.value.committedRevision,
      });
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      expect(bound.value.sequence).toBe(2);

      const after = await service.status({});
      expect(after.ok).toBe(true);
      if (after.ok) {
        // The head moved, which is the contrast that makes the refusal above
        // meaningful: the same code path accepts when the world is proven.
        expect(after.value.headRevision).toBe(bound.value.committedRevision);
        expect(after.value.sequence).toBe(2);
      }
    },
    { timeout: 180_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "without a declared topology bind is refused even for the right-looking world",
    async () => {
      const { Context, factories } = await realFactories();
      const archiveRoot = join(temporaryRoot(), "archive");
      const source = temporaryRoot();
      // No topology: the archive cannot tell whether the source is in its world,
      // so neither write entry may proceed.
      const undeclared = createOwnerService({
        ctx: ownerContext(Context),
        archiveRoot,
        factories,
      });

      const refusedInit = await undeclared.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(refusedInit.ok).toBe(false);
      if (!refusedInit.ok) {
        expect(refusedInit.code).toBe("invalid_input");
        expect(refusedInit.reason).toContain("has not declared");
      }
      // Nothing was created: an unproven deployment cannot leave a repository
      // behind that a later, declared one would adopt.
      expect(existsSync(archiveRoot)).toBe(false);

      // An archive a declared deployment created still refuses an undeclared
      // surface's `bind`, and its head does not move.
      const declaring = createOwnerService({
        ctx: ownerContext(Context),
        archiveRoot,
        boundSources: [source],
        factories,
        topology: { archiveWorldIdentity: BINDING.worldIdentity, sourceWorlds: { [BINDING.worldIdentity]: true } },
      });
      const initialized = await declaring.initialize({ source_descriptor: BINDING, initial_grants: GRANTS });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;

      const refused = await undeclared.bind({
        source_descriptor: BINDING,
        reason: "no topology declared",
        expected_revision: initialized.value.committedRevision,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("has not declared");

      const after = await undeclared.status({});
      if (after.ok) {
        expect(after.value.sequence).toBe(1);
        expect(after.value.headRevision).toBe(initialized.value.committedRevision);
      }
    },
    { timeout: 180_000 },
  );
});
