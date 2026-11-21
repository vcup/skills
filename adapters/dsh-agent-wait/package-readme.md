# dsh-agent-wait

A **bounded** DeepSeek Harness plugin that registers one model tool,
`wait_subagents`. It lets a subagent wait for its own subagent tree to change
without ending its turn — the wait resolves inside the current tool execution
instead of the agent ending its turn and being woken by a completion notice
later.

It is tested against DSH `0.2.2-rc.4` and `0.2.2-rc.5` (`0.2.2-rc.5` is the
default). It is **not** a coordination product: it observes, it never sends
messages or makes decisions for you.

## Install

`dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`; without it `add`
fails with `pnpm was not found` (exit 127). Keep `PNPM_HOME` the same across
`add` and `remove`, or `remove` fails on a store mismatch. `--profile` comes
before the pnpm verb.

Add the package to a profile that has an app row. `web` is the shipped profile
and is the safe choice:

```bash
dsh plugin --profile web add ./dsh-agent-wait-0.1.0.tgz
dsh plugin --profile web list      # shows dsh-agent-wait@0.1.0
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

## Uninstall

Use the same `DSH_HOME` and `PNPM_HOME` you installed with:

```bash
dsh plugin --profile web remove dsh-agent-wait
```

The tool registration is an effect of the plugin's own fiber, so unloading the
package disposes it and aborts outstanding waits.
