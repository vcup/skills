# dsh-ensemble-probe

A **Host-only probe** for DeepSeek Harness `0.2.2-rc.4` and `0.2.2-rc.5`
(`0.2.2-rc.5` is the default for new installs). It proves that the published
Loader can load one package that (a) registers the `ensemble` skill as a
user-invocable skill and (b) exposes one read-only tool over a fixed list of
reference files bundled in the package.

This package is not the ensemble product. It carries the method text and a
reference reader, and nothing else.

## Install

`dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`; without it `add`
fails with `pnpm was not found` (exit 127). Keep `PNPM_HOME` the same across
`add` and `remove`, or `remove` fails on a store mismatch. `--profile` comes
before the pnpm verb.

Add the package to a profile that has an app row. `web` is the shipped profile
and is the safe choice:

```bash
dsh plugin --profile web add ./dsh-ensemble-probe-0.2.0.tgz
dsh plugin --profile web list      # shows dsh-ensemble-probe@0.2.0
dsh --profile web
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's bundle list. It requires a host that provides the `skills` and `tools`
services (`@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-tools`) at exactly
`0.2.2-rc.4` or `0.2.2-rc.5`; any other release is refused until it is tested
and explicitly added. `@deepseek-ai/cordis` remains at `~4.1.0`.

Do **not** point `--profile` at a custom composition with no app/startup row:
such a profile boots and then keeps running without printing help, which looks
like a hang.

Two messages from `add` are not failures: `Agent skills awaiting approval: … Run
"pnpm approve" to review them.` and a peer-dependency `WARN`. Both are non-fatal
and `add` exits 0.

## First use

Type the skill name in the composer:

```text
/ensemble <task, constraints, and completion checks>
```

The skill is user-invocable only. Model-facing catalogs and the `skill` tool do
not offer it, so asking the model to "use the ensemble skill" will not reach it.

Whether a model turn completes is outside this package's evidence: a turn needs
provider credentials, and without an API key DSH reports
`no API key for provider route`.

## What it registers

| Capability | Behaviour |
|---|---|
| Skill `ensemble` | User-invocable only (`disable-model-invocation: true` in the bundled instructions). Model-facing catalogs and the `skill` tool do not offer it. |
| Tool `ensemble_reference` | Reads back exactly one of `EVOLUTION-TEMPLATE.md`, `GLOSSARY.md`, `PATTERNS.md`, `README.md`, `STATE-TEMPLATE.md` from this package. |

`ensemble_reference` takes a resource name from that fixed enumeration. It has
no path argument, refuses any name outside the enumeration, refuses symbolic
links, and returns at most 65536 bytes per call. A larger resource fails with
`OUTPUT_BUDGET_EXCEEDED`; the probe does not paginate or truncate. Failures are
reported, never replaced by a different source.

## Owner archive (bounded)

0.2.0 exposes an owner-only Remote namespace `ensembleArchive` with
`initialize`, `bind`, `status`, and `readBack`; each takes one object argument
named `request`. Reach it only as an authenticated owner Peer through the
Typert Remote gateway — there is no `dsh` subcommand for it and in-process
calls have no gateway invocation and are refused. Set
`DSH_ENSEMBLE_ARCHIVE_ROOT` before the Host starts (read once at plugin load);
it must be absolute and outside every bound source; the directory is created on
first `initialize`. A relative, empty, or overlapping root is refused. The
plugin validates non-overlap after realpath and records the owner-supplied
`worldIdentity` in the binding; it does not prove Host and source share an
execution world. The real Web token/cookie handshake is not part of the
verified evidence — gateway authorization is.

## Capability status

0.2.0 is a bounded first slice, **not phase 2 complete**. The owner archive
above is implemented; the following are **not** implemented or accepted here:

- model-facing domain write tools for coordination, records, or learning;
- grant/revoke/takeover of archive authority;
- a Client/GUI half, resource views, or settings;
- model/provider selection policy;
- any guarantee about physical Host/execution-world separation.

When a step of the method needs a capability this package does not provide,
report the gap; do not improvise a records mechanism or substitute another
toolchain's storage.

## Uninstall

Use the same `DSH_HOME` and `PNPM_HOME` you installed with:

```bash
dsh plugin --profile web remove dsh-ensemble-probe
```

Both registrations are effects of the plugin's own fiber, so unloading the
package disposes them. On a **running** server the skill disappears from the
catalog immediately, but a tool already in the roster can linger until a later
or fresh session. Restart DSH if you need both gone at once.

The `update` verb exists and runs (`dsh plugin --profile web update` reports
`Already up to date` on an unchanged install). The 0.1.0 → 0.1.1 in-place
upgrade was observed with the real CLI: adding 0.1.1 to the same profile
replaced 0.1.0 (pnpm printed `- 0.1.0` / `+ 0.1.1`), and `plugin list` plus the
on-disk manifest showed 0.1.1 with the explicit rc.4/rc.5 set and no private
peer copies.
