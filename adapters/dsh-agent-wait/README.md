# DSH subagent-wait plugin

Version **1.0.0** is a local production candidate, not a registry release.
This DeepSeek Harness plugin registers one model tool,
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
- The live baseline is seeded and listeners attached in one synchronous section,
  before asynchronous catalog discovery. Known-member transitions during that
  discovery are latched; a previously unobserved member's first status establishes
  its baseline. Target selection is fixed when discovery returns.
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

## Runtime and distribution

The manifest requires Node >=24.9.0, matching both supported DSH CLI manifests;
this candidate was validated on Linux with Node 26.13.1. Other operating systems
are unverified. Runtime waiting uses Node events/timers; the native gate needs
POSIX tools including `timeout`. Repository metadata points to the real source
repository. No `private` field prevents a future authorized npm publication, but
this task publishes nothing and assigns no repository license.

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
make pack-dsh-agent-wait
bun test adapters/dsh-agent-wait/wait.test.ts scripts/pack-dsh-agent-wait.test.ts scripts/verify-dsh-wait.test.ts

# Actual published Host types; writes only to a new temporary directory.
bun adapters/dsh-agent-wait/typecheck-host.ts <isolated-install-dir>

# One command for both supported releases. Paths are read-only inputs.
bun scripts/verify-dsh-wait.ts --runtime <rc4-install-dir> --runtime <rc5-install-dir>
# Optionally test an already-built candidate rather than packing current source:
bun scripts/verify-dsh-wait.ts --runtime <install-dir> --package <candidate.tgz>
```

The maintained [native gate](../../scripts/verify-dsh-wait.ts) requires Bun, Node
(with the runtime's supported Node features), npm, pnpm and `timeout`. The supplied
runtime must already contain the matching published DSH packages. It does not
install a DSH runtime or modify the supplied installation. Use `TMPDIR` to choose
a filesystem with sufficient free space; every invocation creates a new directory
there, prints it, and retains redacted logs and a package SHA256 for inspection.
No prior scratch report, private profile, credential, paid model, or browser is
needed. There is no implicit download fallback: pnpm runs with `--offline`.

Each lane performs standard `dsh plugin --profile web add/list/remove` in a fresh
`DSH_HOME`/`PNPM_HOME`, checks actual installed version and official compatibility
resolution (one installation-scoped instance of each peer, no private runtime
copies), then runs two native paths:

1. [Minimal Loader fixture](native/fixture.mjs) plus [lifecycle checks](native/check.mjs):
   actual AgentLoop, Subagents, ToolRunner, persistence and cold resume, with a
   deterministic LLM adapter replacing only model I/O. The same tool call observes
   A run back to inactive before B changes, and the persisted result and continuation
   both belong to turn 1. It covers strict arguments, budgets, deadline and caller
   cancellation during discovery, timers, caller disposal, restart, and unload.
2. [Standard CLI scenario](native/cli.mjs): the normal installed web profile loads
   the bundle, an added test plugin drives native agents, and the model consumes
   the wait result in the same turn. The web server uses a temporary port, no
   browser is opened, and `appExit` shuts it down. This opens a local test listener;
   it is not a GUI test or a claim about physical Host isolation.

Delayed or oversized discovery responses are explicitly labelled fault injection;
normal lifecycle evidence uses real subagent activation and messages, not synthetic
`emit` calls. A nonzero child exit (including timeout) fails the gate. The lighter
[Loader check](loader-check.ts) only proves registration and the caller guard; it
is not a replacement for this native gate. Shared Make/CI integration is a separate
repository concern; the direct native command above is self-contained.

## Resource contract

[wait.ts](wait.ts) defines finite resource budgets: 10,000 targets, 1,024 UTF-16
code units per canonical name, 65,536 combined name units, 1 MiB rendered result,
50,000 discovery rows, 20,000 pre-discovery observations and 64 simultaneous waits.
Oversized selections fail explicitly; no result or `all` selection is truncated.
The upstream catalog must return before its row budget can be checked. After
selection, unrelated events cannot grow the wait's cache. Satisfaction checks are
constant time per relevant event; sorting and serialization happen on settlement.

All settlement paths release listeners, the optional timer, buffered observations,
and pending discovery. Cancellation is checked before and after async reads.
Unknown argument keys are rejected rather than turning a misspelled deadline into
an infinite wait. See the [installed guide](package-readme.md) for error behaviour,
upgrade and cancellation semantics. Package metadata and Host gates derive their
support claims solely from this plugin's [metadata](meta.ts).

The packer refuses source paths, output/parent symlinks, and nonempty destinations
without this package's bundle marker. It only replaces its own staging directory;
custom output must be a dedicated external directory or this package's build tree.

## What is not here

- No message delivery, no interrupt, no archive, no owner surface, no Client.
- No guarantee about cross-execution-world isolation (nothing here runs a
  subprocess).
- No model-facing domain write tools.

The tool observes; the caller acts (for example with `send_message`).
