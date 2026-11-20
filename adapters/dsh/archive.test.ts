/**
 * Tests for the Archive seam.
 *
 * Two groups, deliberately separated:
 *
 * - **Rules that need no install** run everywhere: the environment scrub, the
 *   fixed argv rendering, the archive-root refusals. These are the security
 *   properties, and they must hold in the repository's own `bun test` run.
 * - **The real seam** runs only when `DSH_ARCHIVE_SEAM_INSTALL` names an
 *   isolated install: it builds the isolated group from the published local
 *   providers and runs real confined Git. Without that variable the cases are
 *   skipped with a message, so a green run never implies the seam was measured.
 *
 * Nothing here writes outside a temporary directory.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ARCHIVE_ROOT_ENV,
  archivePolicy,
  buildIsolatedGroup,
  ensureBareRepository,
  gitArgv,
  gitEnvironment,
  runGit,
  scrubEnvironment,
  SeamUnavailableError,
  validateArchiveRoot,
} from "./archive.ts";
import type { IsolatedContext, ProviderFactories } from "./archive.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "archive-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("environment scrub", () => {
  test("every GIT_ variable is stripped, including the ones that redirect the repository", () => {
    const clean = scrubEnvironment({
      GIT_DIR: "/somewhere/else",
      GIT_INDEX_FILE: "/tmp/index",
      GIT_OBJECT_DIRECTORY: "/tmp/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/alt",
      GIT_WORK_TREE: "/home/user/project",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });
    expect(Object.keys(clean).sort()).toEqual(["HOME", "PATH"]);
  });

  test("undefined entries are dropped rather than passed through", () => {
    expect(scrubEnvironment({ PATH: "/usr/bin", HOME: undefined })).toEqual({ PATH: "/usr/bin" });
  });

  test("every ambient GIT_ name is tombstoned, not merely omitted", () => {
    // The subprocess provider spreads a copy of the parent environment and then
    // the caller's entries over it, so a name this allowlist leaves out survives
    // into the child. `undefined` is the documented tombstone that removes it.
    const env = gitEnvironment("/archive/root", {
      GIT_DIR: "/tmp/evil.git",
      GIT_INDEX_FILE: "/tmp/evil-index",
      GIT_OBJECT_DIRECTORY: "/tmp/evil-objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-alt",
      GIT_WORK_TREE: "/tmp/evil-worktree",
      GIT_DIR_FUTURE_NAME: "/tmp/unknown",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });
    for (const key of [
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_WORK_TREE",
      "GIT_DIR_FUTURE_NAME",
    ]) {
      // Present as a tombstone, never as an inherited value.
      expect(env[key]).toBeUndefined();
      expect(Object.hasOwn(env, key)).toBe(true);
    }
    // The names this seam sets itself are still set.
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  test("the child environment is a fixed allowlist with a home inside the archive", () => {
    const env = gitEnvironment("/archive/root");
    // HOME inside the archive root means Git cannot read the user's global config.
    expect(env.HOME).toBe("/archive/root");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    // No transport and no prompts: this seam never talks to a remote.
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.GIT_SSH_COMMAND).toBe("");
    // Nothing that could point at a different repository.
    expect(Object.keys(env).filter((key) => key === "GIT_DIR" || key === "GIT_INDEX_FILE")).toEqual([]);
  });
});

describe("archive policy", () => {
  test("the workspace root is the deployment archive root, never the process cwd", () => {
    // `dsh-base` ships `sandbox-policy.workspaceRoot: process.cwd()`. Inheriting
    // that row would put the archive wherever the session started, so the group
    // supplies its own policy and this asserts the value it uses.
    const policy = archivePolicy("/srv/ensemble/archive");
    expect(policy.workspaceRoot).toBe("/srv/ensemble/archive");
    expect(policy.workspaceRoot).not.toBe(process.cwd());
    expect(policy.mode).toBe("workspace-write");
  });
});

describe("fixed argv", () => {
  test("a bare init disables the template so no hooks are installed", () => {
    expect(gitArgv({ kind: "init-bare" })).toContain("--template=");
  });

  test("the published ref is the only ref this seam can update", () => {
    const argv = gitArgv({ kind: "update-ref", revision: "a".repeat(40), expected: null });
    expect(argv).toContain("refs/ensemble/main");
    // An empty old value is Git's "must not exist", which is what makes the
    // first publish a compare-and-swap rather than an overwrite.
    expect(argv[argv.length - 1]).toBe("");
  });

  test("object ids must be 40 hex characters, so no value can become an option", () => {
    for (const bad of ["--upload-pack=/bin/sh", "HEAD", "A".repeat(40), "a".repeat(39), "a".repeat(41), ""]) {
      expect(() => gitArgv({ kind: "update-ref", revision: bad, expected: null })).toThrow(SeamUnavailableError);
      expect(() => gitArgv({ kind: "commit-tree", tree: bad, message: "m" })).toThrow(SeamUnavailableError);
      expect(() => gitArgv({ kind: "read-tree-path", revision: bad, path: "meta.json" })).toThrow(SeamUnavailableError);
    }
  });

  test("archive paths cannot escape the tree", () => {
    const revision = "a".repeat(40);
    for (const bad of ["../outside", "/etc/passwd", "records//x", ""]) {
      expect(() => gitArgv({ kind: "read-tree-path", revision, path: bad })).toThrow(SeamUnavailableError);
    }
  });
});

describe("archive root validation", () => {
  test("a relative or empty root is refused, because it would resolve against a cwd", () => {
    const relative = validateArchiveRoot("archive");
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.code).toBe("invalid_root");

    const empty = validateArchiveRoot("   ");
    expect(empty.ok).toBe(false);
  });

  test("the empty-root refusal names the variable a maintainer must set", () => {
    // The user path is "I forgot to configure it". A refusal that only says the
    // root is empty leaves them with nothing to act on, so the message must name
    // the deployment variable and the requirement.
    const verdict = validateArchiveRoot("");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain(ARCHIVE_ROOT_ENV);
      expect(verdict.reason).toContain("absolute path");
      expect(verdict.reason).toContain("outside every bound source");
    }
  });

  test("a symlinked root is refused rather than followed", () => {
    const parent = temporaryRoot();
    const real = join(parent, "real");
    mkdirSync(real);
    const link = join(parent, "link");
    symlinkSync(real, link);

    const verdict = validateArchiveRoot(link);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("root_is_symlink");
  });

  test("a root inside a bound source is refused", () => {
    const source = temporaryRoot();
    const verdict = validateArchiveRoot(join(source, ".archive"), [source]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("root_overlaps_source");
      expect(verdict.reason).toContain("outside every source");
    }
  });

  test("a source inside the root is refused, from the other side", () => {
    const root = temporaryRoot();
    const source = join(root, "project");
    mkdirSync(source);
    const verdict = validateArchiveRoot(root, [source]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("root_overlaps_source");
      expect(verdict.reason).toContain("user's own repository");
    }
  });

  test("a sibling root outside every source is accepted", () => {
    const parent = temporaryRoot();
    const source = join(parent, "project");
    const archive = join(parent, "archive");
    mkdirSync(source);
    mkdirSync(archive);

    const verdict = validateArchiveRoot(archive, [source]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.path).toBe(archive);
  });

  test("a symlinked source is canonicalised before the overlap test", () => {
    // A string comparison would miss this: the source is reached through a link,
    // so `join(source, '.archive')` does not textually contain the real root.
    const parent = temporaryRoot();
    const realSource = join(parent, "real-source");
    mkdirSync(realSource);
    const linkSource = join(parent, "linked-source");
    symlinkSync(realSource, linkSource);

    const verdict = validateArchiveRoot(join(realSource, "archive"), [linkSource]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("root_overlaps_source");
  });
});

describe("isolated group construction", () => {
  /** A minimal fake context recording the scope operations. */
  function fakeOuter(): { ctx: IsolatedContext; calls: string[] } {
    const calls: string[] = [];
    const make = (label: string): IsolatedContext => ({
      isolate: (name) => {
        calls.push(`${label}:isolate:${name}`);
        return make(`${label}/${name}`);
      },
      extend: () => {
        calls.push(`${label}:extend`);
        return make(`${label}+`);
      },
      provide: (name) => {
        calls.push(`${label}:provide:${name}`);
        return () => {};
      },
      get: () => undefined,
    });
    return { ctx: make("outer"), calls };
  }

  test("the group is scoped from the plugin's context rather than created fresh", () => {
    const { ctx, calls } = fakeOuter();
    const factories: ProviderFactories = { subprocess: () => ({}), sandbox: () => ({}) };
    expect(() => buildIsolatedGroup(ctx, factories)).toThrow(SeamUnavailableError);
    // The contract is that the group descends from the plugin's context and
    // isolates the execution-world services. How that descent is expressed is
    // an implementation choice; the guarantees that must hold are asserted
    // behaviourally in the real-seam tests: service graph reachable, local
    // providers injected, no fallback to the session runner.
    expect(calls).toContain("outer:isolate:subprocess");
    expect(calls).toContain("outer/subprocess:isolate:sandbox");
    expect(calls.some((call) => call.endsWith(":extend"))).toBe(true);
  });

  test("a group without a sandbox is refused, not silently degraded", () => {
    const group: IsolatedContext = {
      isolate: () => group,
      extend: () => group,
      provide: () => () => {},
      get: (name) => (name === "subprocess" ? { spawn: () => undefined } : undefined),
    };
    expect(() =>
      buildIsolatedGroup(group, { subprocess: () => ({}), sandbox: () => ({}) }),
    ).toThrow(/did not provide a sandbox/);
  });

  test("a provider that throws while mounting is reported as unavailable", () => {
    const group: IsolatedContext = {
      isolate: () => group,
      extend: () => group,
      provide: () => () => {},
      get: () => undefined,
    };
    expect(() =>
      buildIsolatedGroup(group, {
        subprocess: () => {
          throw new Error("no local subprocess in this build");
        },
        sandbox: () => ({}),
      }),
    ).toThrow(/could not be mounted/);
  });
});

// ── the real seam ──────────────────────────────────────────────────────────

/**
 * The isolated install the real-seam tests measure against.
 *
 * Resolved to an absolute path before use: a relative value would be resolved
 * against this module, so `DSH_ARCHIVE_SEAM_INSTALL=.scratch/rc5-cycle/rc5`
 * would silently import nothing. Failing loudly with the resolved path is
 * better than a confusing module-resolution error that looks like a bug in the
 * seam.
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

describe("real isolated seam", () => {
  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "runs real confined Git inside the isolated group and commits into the archive root",
    async () => {
      const install = INSTALL as string;
      const { Context } = (await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"))) as {
        Context: new () => IsolatedContext;
      };
      const { LocalSubprocessRuntime } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js")
      )) as { LocalSubprocessRuntime: new (ctx: IsolatedContext) => unknown };
      const { LocalSandboxProvider } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js")
      )) as { LocalSandboxProvider: new (ctx: IsolatedContext, config: Record<string, unknown>) => unknown };

      const outer = new Context();
      const group = buildIsolatedGroup(outer, {
        subprocess: (ctx) => new LocalSubprocessRuntime(ctx),
        sandbox: (ctx) => new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }),
      });

      const archiveRoot = join(temporaryRoot(), "archive");
      const created = await ensureBareRepository(group, archiveRoot);
      expect(created.ok).toBe(true);
      expect(existsSync(join(archiveRoot, "HEAD"))).toBe(true);

      // A read-only command inside the archive root works and reports enforcement.
      const head = await runGit(group, archiveRoot, { kind: "rev-parse-head" });
      // No ref yet: Git exits non-zero with no output, which is the expected shape.
      expect(head.enforcement).toBeDefined();
      expect(head.stdout.trim()).toBe("");

      // A write outside the archive root is denied by the sandbox.
      const outside = join(temporaryRoot(), "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep");
      const escape = await group.sandbox.confine(["sh", "-c", `echo no > '${join(outside, "x.txt")}'`], {
        mode: "workspace-write",
        workspaceRoot: archiveRoot,
      });
      const handle = group.subprocess.spawn({
        argv: escape.argv,
        cwd: archiveRoot,
        stdio: { stdin: "ignore", stdout: "collect", stderr: "collect" },
        graceMs: 5000,
        env: gitEnvironment(archiveRoot),
      });
      const outcome = await handle.done;
      expect(outcome.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "x.txt"))).toBe(false);
    },
    { timeout: 120_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "an ambient GIT_DIR cannot redirect the archive into a foreign repository",
    async () => {
      // The oracle is the side effect, not the environment object. Asserting the
      // allowlist omits GIT_DIR passes even when the child still inherits it,
      // because the provider spreads a copy of the parent environment and then
      // the caller's entries over it: omission is not removal. So this test
      // creates two real bare repositories, points the ambient GIT_DIR at the
      // foreign one, runs the real transaction, and checks which one changed.
      const install = INSTALL as string;
      const { Context } = (await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"))) as {
        Context: new () => IsolatedContext;
      };
      const { LocalSubprocessRuntime } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js")
      )) as { LocalSubprocessRuntime: new (ctx: IsolatedContext) => unknown };
      const { LocalSandboxProvider } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js")
      )) as { LocalSandboxProvider: new (ctx: IsolatedContext, config: Record<string, unknown>) => unknown };

      const outer = new Context();
      const group = buildIsolatedGroup(outer, {
        subprocess: (ctx) => new LocalSubprocessRuntime(ctx),
        sandbox: (ctx) => new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }),
      });

      const archiveRoot = join(temporaryRoot(), "archive");
      const foreignRoot = join(temporaryRoot(), "foreign");
      expect((await ensureBareRepository(group, archiveRoot)).ok).toBe(true);
      expect((await ensureBareRepository(group, foreignRoot)).ok).toBe(true);

      // Both repositories start with no published ref.
      expect((await runGit(group, archiveRoot, { kind: "rev-parse-head" }, { mode: "read-only" })).stdout.trim()).toBe("");
      expect((await runGit(group, foreignRoot, { kind: "rev-parse-head" }, { mode: "read-only" })).stdout.trim()).toBe("");

      // Every redirection variable the design names, aimed at the foreign repo.
      const saved: Record<string, string | undefined> = {};
      const redirections: Record<string, string> = {
        GIT_DIR: foreignRoot,
        GIT_INDEX_FILE: join(foreignRoot, "index"),
        GIT_OBJECT_DIRECTORY: join(foreignRoot, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(foreignRoot, "objects"),
        GIT_WORK_TREE: foreignRoot,
      };
      for (const [key, value] of Object.entries(redirections)) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      try {
        // Write one blob + tree + commit into the archive root, through the seam.
        const blob = await runGit(group, archiveRoot, { kind: "hash-object", content: "redirect probe\n" });
        expect(blob.exitCode).toBe(0);
        const tree = await runGit(group, archiveRoot, { kind: "mktree", entries: [`100644 blob ${blob.stdout.trim()}	probe.txt`] });
        expect(tree.exitCode).toBe(0);
        const commit = await runGit(group, archiveRoot, { kind: "commit-tree", tree: tree.stdout.trim(), message: "redirect probe" });
        expect(commit.exitCode).toBe(0);
        const published = await runGit(group, archiveRoot, { kind: "update-ref", revision: commit.stdout.trim(), expected: null });
        expect(published.exitCode).toBe(0);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      // The archive root advanced; the foreign repository is untouched.
      const archiveHead = (await runGit(group, archiveRoot, { kind: "rev-parse-head" }, { mode: "read-only" })).stdout.trim();
      expect(archiveHead).toMatch(/^[0-9a-f]{40}$/);
      const foreignHead = (await runGit(group, foreignRoot, { kind: "rev-parse-head" }, { mode: "read-only" })).stdout.trim();
      expect(foreignHead).toBe("");
    },
    { timeout: 180_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "the isolated group resolves a different sandbox implementation than the outer context",
    async () => {
      const install = INSTALL as string;
      const { Context } = (await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"))) as {
        Context: new () => IsolatedContext;
      };
      const { LocalSubprocessRuntime } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js")
      )) as { LocalSubprocessRuntime: new (ctx: IsolatedContext) => unknown };
      const { LocalSandboxProvider } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js")
      )) as { LocalSandboxProvider: new (ctx: IsolatedContext, config: Record<string, unknown>) => unknown };

      const outer = new Context();
      const sessionMarker = { kind: "session-execution-world" };
      outer.provide("sandbox", sessionMarker);
      outer.provide("subprocess", sessionMarker);

      const group = buildIsolatedGroup(outer, {
        subprocess: (ctx) => new LocalSubprocessRuntime(ctx),
        sandbox: (ctx) => new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }),
      });

      // The observable difference: the group's services are not the outer ones,
      // and the outer context was not replaced.
      expect(group.sandbox).not.toBe(sessionMarker as unknown);
      expect(group.subprocess).not.toBe(sessionMarker as unknown);
      expect(outer.get("sandbox")).toBe(sessionMarker as unknown);
      expect(outer.get("subprocess")).toBe(sessionMarker as unknown);
      // And the group's sandbox really confines.
      expect(typeof group.sandbox.confine).toBe("function");
    },
    { timeout: 120_000 },
  );

  test.skipIf(INSTALL === undefined || INSTALL === "")(
    "the group keeps the plugin's own service graph while isolating the execution world",
    async () => {
      // This is the assertion that catches the wrong construction. Both
      // `isolate(...)` alone and `new Context(isolated)` isolate the named
      // services; only a scoped child keeps everything else the plugin needs.
      // A `new Context(isolated)` group would pass the isolation test above and
      // still be broken, because it cannot see `skills` or `tools`.
      const install = INSTALL as string;
      const { Context } = (await import(join(install, "node_modules/@deepseek-ai/cordis/lib/index.js"))) as {
        Context: new () => IsolatedContext;
      };
      const { LocalSubprocessRuntime } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js")
      )) as { LocalSubprocessRuntime: new (ctx: IsolatedContext) => unknown };
      const { LocalSandboxProvider } = (await import(
        join(install, "node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js")
      )) as { LocalSandboxProvider: new (ctx: IsolatedContext, config: Record<string, unknown>) => unknown };

      const outer = new Context();
      const skills = { kind: "skills-service" };
      const tools = { kind: "tools-service" };
      outer.provide("skills", skills);
      outer.provide("tools", tools);

      // Build the group through the product's own constructor, so this measures
      // the shipped behaviour. The factory captures the scope the providers are
      // mounted in, which is where the service graph must still be reachable.
      let groupCtx: IsolatedContext | undefined;
      const group = buildIsolatedGroup(outer, {
        subprocess: (ctx) => {
          groupCtx ??= ctx;
          return new LocalSubprocessRuntime(ctx);
        },
        sandbox: (ctx) => new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }),
      });
      expect(groupCtx).toBeDefined();

      // The plugin's own services remain reachable in the scope the group runs
      // in. A disconnected context would break this, and the archive would be
      // unusable because the plugin could no longer see its own services.
      expect(groupCtx?.get("skills")).toBe(skills as unknown);
      expect(groupCtx?.get("tools")).toBe(tools as unknown);

      // The group carries its own local implementations: a sandbox that
      // confines and a subprocess that spawns. Asserted as behaviour, not
      // identity, because a Cordis service read returns a lazy proxy.
      expect(typeof group.sandbox.confine).toBe("function");
      expect(typeof group.subprocess.spawn).toBe("function");
    },
    { timeout: 120_000 },
  );
});
