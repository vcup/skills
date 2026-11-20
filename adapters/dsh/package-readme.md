# dsh-ensemble-probe

A **Host-only probe** for the DeepSeek Harness `0.2.2-rc.4`. It proves that the
published Loader can load one package that (a) registers the `ensemble` skill as
a user-invocable skill and (b) exposes one read-only tool over a fixed list of
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
dsh plugin --profile web add ./dsh-ensemble-probe-0.1.0.tgz
dsh plugin --profile web list      # shows dsh-ensemble-probe@0.1.0
dsh --profile web
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's bundle list. It requires a host that provides the `skills` and `tools`
services (`@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-tools`) at `0.2.2-rc.4`.

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

## Capability status

The bundled method is a **pre-release method resource**. These are **not
implemented and not accepted** in this package:

- domain tools for coordination, records, or learning;
- an external Git archive, its transactions, receipts, or recovery;
- authorization and binding for archive access;
- a Client/GUI half, resource views, or settings;
- model/provider selection policy;
- any guarantee about Host/execution-world separation.

The method text states the same limits. When a step of the method needs a
capability this package does not provide, report the gap; do not improvise a
records mechanism and do not substitute another toolchain's storage.

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
`Already up to date`), but it has never been exercised against a newer build
because none exists yet. This package therefore recommends add, list, boot, and
remove only.
