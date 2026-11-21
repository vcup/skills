/**
 * `bind` must extend the archive, not replace it.
 *
 * A commit is a whole tree, so every write entry has to carry forward the files
 * it did not touch. `initialize` starts from an empty tree, but `bind` starts
 * from the head it is about to supersede: if it publishes only its own
 * `meta.json` plus the new operation and receipt, the previous operation and
 * receipt become unreachable from the head, and the history stops being an
 * audit trail — the records are still in the object database, but nothing at
 * the head refers to them, so `readBack` and `status` can no longer show what
 * happened.
 *
 * The test therefore drives the real entry points and inspects the **head tree**
 * after two binds, not the object database: the question is what the archive
 * still publishes, not what it merely retained.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOwnerService, type OwnerContext, type OwnerService } from "./owner-service.ts";
import type { ProviderFactories } from "./archive.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "owner-preserve-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function ownerContext(Context: new () => OwnerContext): OwnerContext {
  const base = new Context() as unknown as OwnerContext;
  Object.defineProperty(base, "invocation", {
    value: { peer: { principal: { kind: "owner" } } },
    configurable: true,
  });
  return base;
}

const WORLD = { archiveWorldIdentity: "host-a", sourceWorlds: { "host-a": true } };
const GRANTS = [{ subjectId: "owner", rights: ["manage"] }];

function bindingFor(canonicalAddress: string) {
  return { worldIdentity: "host-a", canonicalAddress, nativeWorkspaceRef: "ws:1" };
}

/**
 * Every path the head tree publishes, read through the archive's own reader.
 *
 * `readBack` takes one path at a time, so the test asks for the paths it
 * expects. That is deliberate: the assertion is about named records surviving,
 * and a generic tree listing would not say which record is which.
 */
async function readOrNull(service: OwnerService, revision: string, path: string): Promise<string | null> {
  const outcome = await service.readBack({ revision, path });
  return outcome.ok ? outcome.value.content : null;
}

describe("bind preserves the archive it extends", () => {
  test.skipIf(SKIP)(
    "initialize, bind, bind: the head still publishes every earlier operation and receipt",
    async () => {
      const { Context, factories } = await realFactories();
      const root = temporaryRoot();
      const archiveRoot = join(root, "archive");
      const source = join(root, "source");
      const service = createOwnerService({
        ctx: ownerContext(Context),
        archiveRoot,
        factories,
        topology: WORLD,
      });
      // The source only has to be a real, non-overlapping directory; the archive
      // never reads it.
      mkdirSync(source, { recursive: true });

      const initialized = await service.initialize({
        source_descriptor: bindingFor(source),
        initial_grants: GRANTS,
      });
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;

      const firstBind = await service.bind({
        source_descriptor: bindingFor(source),
        reason: "first rebind",
        expected_revision: initialized.value.committedRevision,
      });
      expect(firstBind.ok).toBe(true);
      if (!firstBind.ok) return;
      expect(firstBind.value.sequence).toBe(2);

      const secondBind = await service.bind({
        source_descriptor: bindingFor(source),
        reason: "second rebind",
        expected_revision: firstBind.value.committedRevision,
      });
      expect(secondBind.ok).toBe(true);
      if (!secondBind.ok) return;
      expect(secondBind.value.sequence).toBe(3);

      const head = secondBind.value.committedRevision;

      // What the head must still publish: the metadata, all three operations,
      // and the receipts of both write entries.
      expect(await readOrNull(service, head, "meta.json")).not.toBeNull();
      for (const sequence of [1, 2, 3]) {
        const operation = await readOrNull(service, head, `operations/${sequence}.json`);
        expect(operation, `operations/${sequence}.json must still be at the head`).not.toBeNull();
      }
      expect(await readOrNull(service, head, "receipts/owner/initialize.json")).not.toBeNull();
      expect(await readOrNull(service, head, "receipts/owner/bind.json")).not.toBeNull();

      // The count `status` reports is derived from the head tree, so it is the
      // second, independent view of the same property. `recordCount` counts
      // `records/**` only, and this bounded version writes no domain records —
      // operations and receipts are the audit trail here — so it stays 0. The
      // sequence is what proves the head advanced without losing history.
      const status = await service.status({});
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.value.sequence).toBe(3);
        expect(status.value.recordCount).toBe(0);
      }
    },
    { timeout: 180_000 },
  );
});
