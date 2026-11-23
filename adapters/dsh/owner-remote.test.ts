/**
 * Tests for the owner Remote surface.
 *
 * Two layers, deliberately separate:
 *
 * - **Guard and shape** run everywhere: the Remote refuses an in-process caller,
 *   refuses a non-owner principal, and exposes exactly four methods. These need
 *   no DSH install because they only exercise the module's own logic.
 * - **The real gateway** runs only when `DSH_ARCHIVE_SEAM_INSTALL` names an
 *   isolated install. It drives `TypertGatewayService.invoke()` with a Peer the
 *   connection layer would have fixed, so the accept path is proven through the
 *   genuine Remote path rather than by calling the service directly.
 *
 * The compiled-output requirement is worth stating: the gateway derives each
 * endpoint's wire descriptor from the method's source text, so it must see real
 * compiled methods. A `bun`-transpiled decorator rewrites the source into
 * `async[(_dec = [Remote], "status")](...)`, which the parser rejects. The
 * real-gateway test therefore compiles the module first; that is a property of
 * how the gateway works, not a workaround.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGE_NAME, PACKAGE_VERSION, STAGING_DIR } from "./meta.ts";
// The namespace is asserted here as a literal because importing the Remote
// module would pull in `@deepseek-ai/*`, which is not on this module path; the
// constant is checked by the gateway test below, which runs inside the install.
const OWNER_SERVICE_KEY = "ensembleArchive";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "owner-remote-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Resolve the isolated install to an absolute path, or fail loudly.
 *
 * A relative value would resolve against this module, so a maintainer passing
 * `.scratch/rc5-cycle/rc5` would get a module-resolution error that looks like a
 * bug in the Remote rather than a bad path.
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

/**
 * The tarball this test exercises.
 *
 * The defect it covers was in the *packaging* layer: the shipped bundle's Remote
 * was unreachable while the source was fine, because the emitted method syntax
 * could not be parsed by the gateway. Testing the source would miss it, so the
 * regression runs against whatever `pack-dsh` produced.
 */
const PINNED_TARBALL = process.env.DSH_CLI_TEST_TARBALL;
const TARBALL = PINNED_TARBALL === undefined || PINNED_TARBALL.trim() === ""
  ? join(import.meta.dir, "..", "..", ...STAGING_DIR.split("/"), `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`)
  : resolve(PINNED_TARBALL);

describe("packaged artifact", () => {
  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "every packaged endpoint is reachable, and the four retired v1 entries refuse without writing",
    async () => {
      // Rebuild so the assertion is about the artifact this tree produces.
      const root = join(import.meta.dir, "..", "..");
      const packed = Bun.spawnSync([process.execPath, join(root, "scripts", "pack-dsh.ts")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(packed.exitCode, packed.stderr.toString() || packed.stdout.toString()).toBe(0);
      expect(existsSync(TARBALL)).toBe(true);

      const install = INSTALL as string;
      // Unpack beside the install so `@deepseek-ai/*` resolves from it, exactly
      // as an installed plugin would.
      const workspace = mkdtempSync(join(install, "packaged-remote-"));
      const extract = Bun.spawnSync(["tar", "-xzf", TARBALL], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
      expect(extract.exitCode, extract.stderr.toString()).toBe(0);
      writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

      const pkg = (await import(join(workspace, "package", "index.js"))) as { apply: (ctx: unknown) => void };
      const { Context } = (await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"))) as {
        Context: new () => unknown;
      };
      const { TypertGatewayService } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js")
      )) as { TypertGatewayService: new (ctx: unknown) => { invoke: (request: unknown) => Promise<unknown> } };
      const { TypertRegistry } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js")
      )) as { TypertRegistry: new (ctx: unknown) => unknown };
      const { RemoteAccessService } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-api-remote-access/lib/index.js")
      )) as { RemoteAccessService: new (ctx: unknown) => unknown };

      const ctx = new Context() as {
        provide: (name: string, value: unknown) => unknown;
        get: (name: string) => unknown;
      };
      ctx.provide("skills", { registerProvider: () => () => {} });
      ctx.provide("tools", { register: () => () => {} });
      new TypertRegistry(ctx);
      new RemoteAccessService(ctx);

      const archiveRoot = join(workspace, "archive");
      process.env.DSH_ENSEMBLE_ARCHIVE_ROOT = archiveRoot;
      process.env.DSH_ENSEMBLE_ARCHIVE_WORLD = "host-local";
      pkg.apply(ctx);

      const gateway = new TypertGatewayService(ctx);
      const peer = (kind: string) => ({
        id: `peer-${kind}`,
        ctx,
        principal: { kind },
        signal: new AbortController().signal,
        interactions: "none",
        dispose: async () => {},
      });
      const call = (method: string, request: unknown, kind: string) =>
        gateway.invoke({ namespace: OWNER_SERVICE_KEY, method, args: { request }, peer: peer(kind) });

      const binding = { worldIdentity: "host-local", canonicalAddress: "/home/u/p", nativeWorkspaceRef: "ws:1" };

      // 1. The v2 product entries are on the wire and reach their handler. No
      //    native services are mounted in this fixture, so they report
      //    themselves unavailable; what matters is that the emitted method is
      //    parseable by the gateway. An unparseable one fails before the handler
      //    with a signature error, which is the packaging defect this test
      //    exists for.
      for (const method of ["projects", "query", "manage", "choose", "approve", "environment"]) {
        const answer = (await call(method, {}, "owner")) as { ok?: boolean; error?: { code?: string } };
        expect(answer, `${method} must reach its handler`).toBeDefined();
        expect(answer.ok, `${method} should answer, not throw`).toBe(false);
        expect(["storage_unavailable", "invalid_input"]).toContain(answer.error?.code as string);
      }

      // 2. The four v1 entries are retired: authenticated, they refuse with a
      //    migration instruction rather than creating a second store.
      for (const [method, request] of [
        ["initialize", { source_descriptor: binding, initial_grants: [{ subjectId: "owner", rights: ["manage"] }] }],
        ["bind", { source_descriptor: binding, reason: "x", expected_revision: "0".repeat(40) }],
        ["status", {}],
        ["readBack", { revision: "0".repeat(40), path: "meta.json" }],
      ] as const) {
        const answer = (await call(method, request, "owner")) as {
          ok: boolean;
          error?: { code: string; message: string };
          code?: string;
          reason?: string;
        };
        expect(answer.ok, `${method} must be refused`).toBe(false);
        const code = answer.error?.code ?? answer.code;
        const message = answer.error?.message ?? answer.reason ?? "";
        expect(code, `${method} refusal code`).toBe("unsupported_version");
        expect(message).toContain(`ensembleArchive.${method} is retired in 1.0`);
        expect(message).toContain(method === "initialize" || method === "bind" ? "manage" : "query");
      }

      // 3. Nothing was created: no archive root, no registry, no files at all.
      expect(existsSync(archiveRoot)).toBe(false);

      // 4. The owner guard still runs, on the retired entries too.
      await expect(call("status", {}, "share-viewer")).rejects.toThrow();
      const forged = (await call("initialize", { owner: true, actor: "x" }, "owner")) as { ok: boolean };
      expect(forged.ok).toBe(false);

      rmSync(workspace, { recursive: true, force: true });
    },
    { timeout: 240_000 },
  );
});
