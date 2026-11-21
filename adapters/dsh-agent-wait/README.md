# DSH subagent-wait plugin

A **bounded** DeepSeek Harness plugin that registers one model tool,
`wait_subagents`: it lets a subagent wait for a change in its own subagent tree
inside the current tool execution, instead of ending its turn and being woken by
a completion notice later.

The installable package is `dsh-agent-wait`; the plugin's exported Cordis
`name` is `agent-wait`, but the **bundle patch `name` must be `dsh-agent-wait`**
(the npm spec the Loader resolves), never `agent-wait`. The user-facing
instructions ship in the packaged tgz as `package-readme.md` (copied to
`README.md` inside the package); this file is the repository-side maintainer
guide.

## What it does

`wait_subagents` blocks one model tool call until a change in the caller's own
subagent tree satisfies the request, a caller-supplied deadline elapses, or the
caller's `exec.signal` aborts. It reads the same public lifecycle edges the
built-in `list_agents`/`wait_agent` control plugins use — `subagent/start`,
`subagent/end`, `agent/status`, `agent/disposed` — plus an optional timer. It
never busy-loops.

Parameters:

- `agents?` — full names (slash paths from the tree root) or Session ids; omit
  for every visible subagent. The caller and `lead` are never valid targets.
- `event?` — `change` (default) or `idle`.
- `condition?` — `any` (default) or `all`.
- `timeout_ms?` — positive integer, or omit/`null` for unbounded.

Semantics that matter:

- `change` is a **transition from the baseline snapshot**, not "looks different
  now". A member that was already `inactive` at the baseline does not satisfy
  the wait by itself.
- A change is **latched**: once observed, it stays counted for the whole call
  even if the member's status later reverts. `condition: "all"` therefore means
  "every target changed at least once".
- The baseline is read synchronously right after the event listeners are
  attached (listen-then-read), so a transition cannot fall between subscription
  and snapshot.
- `idle` means "latest status is `inactive`"; already-inactive members satisfy
  immediately.

## Notification boundary (honest)

This plugin does **not** suppress or swallow the host's settlement
notifications. A child that finishes while the parent is mid-wait can both
satisfy the in-place wait and have its settlement notice delivered as steering;
that steering may open a further turn after the current one ends. The plugin
never rewrites the host's notification behaviour — it only observes the public
edges. So the guarantee is "the wait itself resolves in-place", not "there will
be no later turn".

## Supported DSH releases

`0.2.2-rc.4` and `0.2.2-rc.5`, with `0.2.2-rc.5` the default. The set is this
plugin's own decision, defined in
[`meta.ts`](meta.ts) as `SUPPORTED_DSH_VERSIONS`; it does **not** inherit the
ensemble probe's supported set, so a future ensemble-only change cannot move
this plugin's `engines.dsh`. Adding a release requires this plugin's own matrix
run (host typecheck + real Loader/native subagent wait) against it.

## Files

| File | Role |
|---|---|
| `index.ts` | Plugin entry: registers `wait_subagents`. The only file importing `@deepseek-ai/*`. |
| `wait.ts` | Dependency-free argument normalization, latched-change matching, result projection. |
| `meta.ts` | Package identity, this plugin's supported-version set, peers, capability status. No `@deepseek-ai/*` imports. |
| `wait.test.ts` | Unit tests for the dependency-free semantics. |
| `loader-check.ts` | Real-Loader verification (registers the tool, refuses a caller-less call). Not a `*.test.ts`. |
| `typecheck-host.ts` | Type gate for the Host entry against a real isolated DSH install. |
| `tsconfig.host.json` | Compiler options for the Host-entry modules. |
| `package-readme.md` | README placed in the packaged tgz (installer-facing). |

## Build and verify

```bash
make pack-dsh-agent-wait               # stage + tarball -> build/pack/dsh-agent-wait/
bun scripts/pack-dsh-agent-wait.ts     # same, directly

# Host-entry types against a real isolated install (needs typescript/@types/node)
bun adapters/dsh-agent-wait/typecheck-host.ts <isolated-install-dir>

# Real Loader: copy loader-check.ts beside the install and run with node.
# The gate needs two env vars to find the runtime and the installed package:
DSH_WAIT_RUNTIME=<isolated-install-dir> DSH_WAIT_PACKAGE=dsh-agent-wait \
  node loader-check.ts
```

The Make entry points (`pack-dsh-agent-wait`, `typecheck-wait-host`,
`wait-host-check`, `wait-loader-check`) and the root `tsconfig.json` include set
are owned by the shared Make/typecheck writer; the pack script and the two Host
gates are what this directory exports to them.

## What is not here

- No message delivery, no interrupt, no archive, no owner surface, no Client.
- No guarantee about cross-execution-world isolation (nothing here runs a
  subprocess).
- No model-facing domain write tools.

The tool observes; the caller acts (for example with `send_message`).
