# dsh-agent-wait

Version **1.0.0** is a local production candidate, not an npm publication.
This DeepSeek Harness plugin registers one model tool,
`wait_subagents`. It lets a subagent wait for its own subagent tree to change
without ending its turn — the wait resolves inside the current tool execution
instead of the agent ending its turn and being woken by a completion notice
later.

It is tested against DSH `0.2.2-rc.4` and `0.2.2-rc.5` (`0.2.2-rc.5` is the
default). It is **not** a coordination product: it observes, it never sends
messages or makes decisions for you.

## Runtime and platform

Node.js **24.9.0 or newer** is required, matching both supported DSH releases.
Native acceptance was run on Linux with Node 26.13.1. This plugin's waiting code
uses Node events and timers, but macOS and Windows have not been validated; no
cross-platform support claim follows from successful Linux tests. The maintainer's
native verification command additionally requires a POSIX shell environment and
GNU-compatible `timeout`.

The package carries repository provenance and has no `private` publication block.
It remains an unpublished local candidate. Repository licensing has not been
assigned by this package; no license is invented here.

## Install

`dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`; without it `add`
fails with `pnpm was not found` (exit 127). Keep `PNPM_HOME` the same across
`add` and `remove`, or `remove` fails on a store mismatch. `--profile` comes
before the pnpm verb.

Add the package to a profile that has an app row. `web` is the shipped profile
and is the safe choice:

```bash
dsh plugin --profile web add ./dsh-agent-wait-1.0.0.tgz
dsh plugin --profile web list      # shows dsh-agent-wait@1.0.0
dsh --profile web
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's bundle list. It requires a host that provides the `tools`,
`subagents`, and `agents` services (`@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-agent`) at exactly
`0.2.2-rc.4` or `0.2.2-rc.5`; any other release is refused until it is tested
and explicitly added. `@deepseek-ai/cordis` remains at `~4.1.0`.

Do **not** point `--profile` at a custom composition with no app/startup row:
such a profile boots and then keeps running without printing help, which looks
like a hang.

## Use

The model calls `wait_subagents` during a turn. It blocks that one tool call
(and therefore the turn) until the condition is met, the deadline elapses, or
the call is cancelled.

```jsonc
// Wait for the first subagent to change status since this call began.
{}

// Wait for all of the caller's subagents to have changed.
{ "condition": "all" }

// Wait for two named subagents (paths from the tree root); finish on the
// first of them to change.
{ "agents": ["review/checker", "builder"], "condition": "any" }

// Wait until every named subagent is inactive (idle mode; already-inactive
// members satisfy immediately).
{ "agents": ["a", "b"], "event": "idle", "condition": "all" }

// Same as the first, but never longer than five minutes.
{ "timeout_ms": 300000 }
```

- `agents` — omit to wait on every visible subagent; otherwise a non-empty list
  of full names (slash paths from the root, e.g. `reviewer/checker`) or Session
  ids. The caller and the root (`lead`) are never valid targets.
- `event` — `change` (default) means a target must change from the snapshot
  taken when the call began; `idle` means it must reach `inactive`.
- `condition` — `any` (default) finishes on the first satisfying target; `all`
  requires every target to have changed (or reached inactive).
- `timeout_ms` — a positive integer deadline in milliseconds, or omit/`null`
  for an unbounded wait.

The result reports `condition`, `event`, `timedOut`, the members that satisfied
the wait (`satisfiedBy`), every member that changed (`changed`), and each
waited-on member's latest status (`members`), including the terminal
`stopReason` when the wait observed that member's `subagent/end` edge.

The deadline starts when the call starts, so it covers tree discovery too. If
discovery has not finished when the deadline fires, the result is
`timedOut: true` with empty `members`/`changed`/`satisfiedBy` — that is a
"target discovery did not complete in time" outcome, distinct from the
`EMPTY_SELECTION` error that means the tree has no reachable member to wait on.

### Change means a transition, not a state

In `change` mode (the default), a member that was **already inactive** when the
call began does not satisfy the wait by itself; the wait is for something that
*changed* after the snapshot. The snapshot is taken when the call starts, and
listeners are attached before the first re-read so a change that lands in the
same instant is not missed.

### It observes, it does not act

`wait_subagents` never delivers a message, never interrupts, and never swallows
the host's own notifications. The parent's settlement notice is still delivered
by the subagent runtime exactly as it would be without this plugin; this tool
only lets the waiting agent observe the same public lifecycle edges
(`subagent/start`, `subagent/end`, `agent/status`, `agent/disposed`) and keep
working in the same turn.

This tool does **not** guarantee "no later turn". A child that finishes while
the parent is mid-wait can both satisfy the in-place wait and have its
settlement notice delivered as steering; that steering may open a further turn
after the current one ends. The plugin does not suppress that upstream delivery,
because it must not rewrite the host's notification behaviour.

## Boundaries

- Only the caller's own subagent tree is visible; names, statuses, and Session
  ids come from the same discovery `list_agents` uses, and nothing from another
  workspace is ever exposed.
- Unknown or unreachable members are explicit errors, not silent omissions.
- An empty selection (a tree with no member other than the caller) returns an
  explicit `EMPTY_SELECTION` error instead of pretending to wait.
- The wait is implemented with real event subscriptions plus an optional timer —
  never a busy loop. It is cancellable through the tool executor's own signal,
  and unloading the plugin aborts outstanding waits.
- The stop-reason vocabulary is the public `@deepseek-ai/dsh-subagent` one
  (`completed`, `aborted`, `error`, `max-tokens`, `refusal`); an unknown future
  reason is reported as `error`, never as success.

## Upgrade from 0.1.0

Use the same profile and homes as the original install, then restart that profile:

```bash
dsh plugin --profile web add ./dsh-agent-wait-1.0.0.tgz
dsh plugin --profile web list
dsh --profile web
```

The tool name, valid parameters, fixed target selection, latched `change`, explicit
`idle`, and infinite default remain compatible. Unknown parameters now fail
explicitly: `timeoutMs` is not an alias for `timeout_ms`. `null` is accepted only
for `timeout_ms`, not `event` or `condition`.

## Resource limits and cancellation

The tool never truncates a target set or claims a partial `all` success. It returns
`WAIT_RESOURCE_LIMIT` when a selection exceeds 10,000 targets, a canonical name
exceeds 1,024 UTF-16 code units, combined names exceed 65,536 code units, or the
rendered result exceeds 1 MiB. An explicit list above 10,000 entries remains a
`WAIT_INVALID_TARGETS` error. Select fewer agents to reduce the result.

Discovery accepts at most 50,000 catalog entries and buffers at most 20,000 live
agent observations; after discovery it retains only selected targets. At most 64
waits can run concurrently in one loaded plugin. Releasing a wait returns that
capacity. These limits bound memory, not wait duration: omitted/`null` deadlines
still allocate no timer and have no implicit timeout. Upstream catalog discovery
has its own allocation costs before it returns to the plugin.

Caller abort, caller disposal, plugin unload/restart, timeout, and normal completion
all remove observers and cancel pending discovery. A late read cannot resume a
settled wait. Reload registers a fresh tool; it does not revive old waits.
New children created after discovery do not enlarge the fixed target set. In
`idle` mode a disposed/unavailable member is not `inactive`; cancellation or an
explicit deadline remains available if that condition cannot be reached.

## Uninstall

Use the same `DSH_HOME` and `PNPM_HOME` you installed with:

```bash
dsh plugin --profile web remove dsh-agent-wait
```

The tool registration is an effect of the plugin's own fiber, so unloading the
package disposes it and aborts outstanding waits.
