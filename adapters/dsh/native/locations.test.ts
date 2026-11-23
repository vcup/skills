/**
 * Regression guard for the execution-world liveness check.
 *
 * The defect this covers: the source world's `current()` compared
 * `ctx.get("fs")` against a proxy captured earlier. Cordis mints a fresh service
 * proxy on **every** access, so that comparison is permanently false and every
 * source selection was refused with "requires the registered Host-local
 * execution world" while destination selections worked.
 *
 * A unit test that injects a fixed stand-in object cannot catch this: the bug
 * only appears with a real filesystem service on a real `Context`. This test
 * builds the real thing and asserts the fact callers depend on — the scope label
 * is stable and a live service on it reads as current.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The subset of Cordis's public `Context` this test relies on.
 *
 * The install is loaded by a **runtime-computed path**, so TypeScript cannot infer
 * anything from `import()`; the shapes below are transcribed from the real
 * declarations in the isolated install
 * (`@deepseek-ai/cordis/lib/types/context.d.ts` and `reflect.d.ts`):
 *
 * - `Context.isolate` is a `static readonly unique symbol`;
 * - an instance exposes `[symbols.isolate]: Dict<symbol>`, i.e. service name → the
 *   scope label symbol for that name;
 * - `get(name, strict?)` returns the service, or `undefined` when absent (the
 *   declared overload returns `any`, exactly as it does for plugins).
 *
 * A previous version of this test answered `new () => never`, which made `ctx`
 * `never`: every `ctx[Context.isolate]` and `ctx.get(...)` then failed to compile,
 * and — worse — the file recorded no type evidence at all. These are precise
 * structural descriptions rather than `as any`/`as never` escapes.
 */
interface LiveContext {
  get(name: string, strict?: boolean): unknown;
  /** Isolation map: service name to its scope label. Absent before a provider exists. */
  readonly [isolate: symbol]: Record<string, symbol | undefined>;
}

/** `Context` as constructed, plus the static isolate symbol the product reads. */
type ContextClass = (new () => LiveContext) & { readonly isolate: symbol };

/** `LocalFileSystem` as constructed: `(ctx, config)` per `dsh-fs-local`. */
type LocalFileSystemClass = new (ctx: LiveContext, config: { cwd: string; diffBasisMaxBytes: number }) => unknown;

function resolveInstall(): string | undefined {
  const raw = process.env.DSH_ARCHIVE_SEAM_INSTALL;
  if (raw === undefined || raw.trim() === "") return undefined;
  const absolute = resolve(raw);
  if (!existsSync(join(absolute, "node_modules/@deepseek-ai/cordis/package.json"))) {
    throw new Error(`DSH_ARCHIVE_SEAM_INSTALL=${absolute} is not an isolated DSH install`);
  }
  return absolute;
}

const INSTALL = resolveInstall();
const SKIP = INSTALL === undefined || INSTALL === "";

describe("execution world liveness", () => {
  test.skipIf(SKIP)(
    "service proxies differ on every access, so liveness must read the stable isolation scope",
    async () => {
      const install = INSTALL as string;
      const cordis = await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js")) as { Context: ContextClass };
      const fsLocal = await import(join(install, "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js")) as { LocalFileSystem: LocalFileSystemClass };
      const { Context } = cordis;

      const ctx = new Context();
      const fs = new fsLocal.LocalFileSystem(ctx, { cwd: "/tmp", diffBasisMaxBytes: 1024 });
      // Read the scope *after* the provider exists: before a service is provided
      // its label is `undefined`, which is a second trap for a predicate that
      // captures too early.
      const sourceScope = ctx[Context.isolate].fs;
      expect(sourceScope).toBeDefined();

      // The fact that makes proxy comparison wrong, asserted rather than assumed:
      // two reads of the same live service are not the same object.
      const firstRead = ctx.get("fs");
      const secondRead = ctx.get("fs");
      expect(firstRead).toBeDefined();
      expect(secondRead).toBeDefined();
      expect(
        firstRead === secondRead,
        "if Cordis ever hands out a stable proxy, the liveness check may compare proxies again",
      ).toBe(false);

      // The scope label IS stable, and is what the product relies on.
      expect(ctx[Context.isolate].fs).toBe(sourceScope);

      // A predicate built from the scope plus presence reads true while the
      // service is mounted — the exact shape the product now uses.
      const current = () => ctx[Context.isolate].fs === sourceScope && ctx.get("fs") !== undefined;
      expect(current()).toBe(true);
      expect(fs).toBeDefined();
    },
  );
});
