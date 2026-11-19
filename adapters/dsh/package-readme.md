# dsh-ensemble-probe

A **Host-only probe** for the DeepSeek Harness `0.2.2-rc.4`. It proves that the
published Loader can load one package that (a) registers the `ensemble` skill as
a user-invocable skill and (b) exposes one read-only tool over a fixed list of
reference files bundled in the package.

This package is not the ensemble product. It carries the method text and a
reference reader, and nothing else.

## Install

```bash
dsh plugin --profile <name> add ./dsh-ensemble-probe-0.1.0.tgz
dsh --profile <name>
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's bundle list. It requires a host that provides the `skills` and `tools`
services (`@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-tools`) at `0.2.2-rc.4`.

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

```bash
dsh plugin --profile <name> remove dsh-ensemble-probe
```

Both registrations are effects of the plugin's own fiber, so unloading the
package removes the skill provider and the tool.
