# DSH Adapter — Host-only P1 probe

A bounded probe for the DeepSeek Harness `0.2.2-rc.4` (pinned source
`3f321d32bfe382212a8ed8785c1d47a5a300aa23`). It exists to answer one P1
question with real evidence: **can the published Loader load a package that
registers the `ensemble` skill and one read-only reference tool, with no source
checkout present?**

It answers that question and nothing else. See [What this is
not](#what-this-is-not).

## Files

| File | Role |
|---|---|
| `index.ts` | Plugin entry: registers the skill provider and `ensemble_reference`. The only file importing `@deepseek-ai/*`. |
| `meta.ts` | Names, peers, `engines.dsh`, rank, reference enumeration, output budget. |
| `reference.ts` | Closed-enumeration reader: allowlist, symlink refusal, 64 KiB budget. No DSH imports. |
| `skill.ts` | Frontmatter parsing and provider factory. No DSH imports. |
| `package-readme.md` | README placed in the packaged bundle (not this repository's). |
| `loader-check.ts` | Real-Loader verification script. Not a `*.test.ts`; runs against an isolated install. |
| `tsconfig.json` | Type check for the DSH modules that do not import `@deepseek-ai/*` (`meta`, `reference`, `skill`) plus `scripts/pack-dsh*` and `typecheck-host.ts`. |
| `tsconfig.host.json` | Compiler options for the Host entry modules (`index.ts`, `loader-check.ts`), which import `@deepseek-ai/*` and are therefore **not** in any repository tsconfig. |
| `typecheck-host.ts` | Runs the check above against a real isolated rc.4 install. Separate gate; not part of the repository typecheck. |

## Package

`scripts/pack-dsh.ts` produces `build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz`
(git-ignored). The bundled skill text comes from the in-memory
`build('dsh')` result of `scripts/build-ensemble.ts`; the ignored default
staging directory is never read, so a stale checkout cannot enter a package.

The staged package holds exactly eleven files:

```text
package.json                    dsh.bundle.patch -> ./cordis.patch.yml
cordis.patch.yml                one insert row naming this package
index.js                        bun-built entry, @deepseek-ai/* left external
bundle-manifest.json            {target: dsh, files:[{path,sha256,bytes}]}
README.md                       package home (from package-readme.md)
skills/ensemble/SKILL.md        user-invocable instructions
skills/ensemble/README.md       five references, fixed enumeration
skills/ensemble/PATTERNS.md
skills/ensemble/GLOSSARY.md
skills/ensemble/STATE-TEMPLATE.md
skills/ensemble/EVOLUTION-TEMPLATE.md
```

## Commands

Repository operations go through the Make entry point (see the [development guide](../../docs/DEVELOPMENT.md)):

```bash
make pack-dsh                 # stage + npm pack
make test-narrow              # repository tests for this probe
make typecheck                # type check, dependency-free modules
```

Two checks need an installation that resolves `@deepseek-ai/*`; neither is part
of the full test or repository typecheck. Pass an already prepared isolated
rc.4 install through `INSTALL_DIR` (see the development guide for how it is
prepared):

```bash
make typecheck-host INSTALL_DIR=<isolated-rc4-install-dir>   # Host entry types
make host-check INSTALL_DIR=<isolated-rc4-install-dir>       # real Loader behaviour
```

`make profile-check INSTALL_DIR=<isolated-rc4-install-dir>` and `make
isolation-check INSTALL_DIR=<isolated-rc4-install-dir>` are gates: they exit 0
only when the capability is actually verified; without a usable install they
exit 2 with an explicit configuration error, so they never report a pass by
skipping a check. `make diagnose INSTALL_DIR=<isolated-rc4-install-dir>` is
observation only (`OBSERVATION ONLY — not a check`) and always exits 0 without
asserting a conclusion.

`typecheck-host.ts` copies the modules beside the install, compiles them with
that install's `tsc` under `tsconfig.host.json`, and refuses a directory without
`@deepseek-ai/dsh-skill@0.2.2-rc.4`. No shim, stub, or hand-written declaration
is involved. It proves the Host entry modules type-check against the published
rc.4 types; it is not part of the repository typecheck (`make typecheck`), and nothing in this repository
type-checks `index.ts` or `loader-check.ts` without such an install.

## What was run, and where it stops

Observed in a container-only isolated install (published rc.4 packages plus this
tarball, with an isolated home):

| Command | Result |
|---|---|
| `make pack-dsh`（同一脚本） | exit 0, 11 files, stable sha256 across runs |
| `bun test` | exit 0; the 18 probe tests pass |
| `tsc -p adapters/dsh/tsconfig.json` | exit 0 (dependency-free modules + pack scripts) |
| `bun adapters/dsh/typecheck-host.ts <install>` | exit 0 — `index.ts` + `loader-check.ts` against published rc.4 types |
| `tsc -p tsconfig.json` | exit 0 |
| `python3 scripts/check-docs.py` | exit 0 |
| `node loader-check.ts` | exit 0, 44 PASS |
| `dsh plugin --profile probe add <tarball>` | exit 0; bundle appended to `dsh.profile.bundles` |
| `dsh --profile probe --dump-config` | exit 0; `# == dsh-ensemble-probe` layer present |
| `dsh plugin --profile probe remove <tarball>` | exit 0; bundle and dependency removed |
| `dsh --profile probe` and `--profile probe --help` | **timed out** (124) with no output; profile boot is **not verified** |

`--dump-config` shows the layer is composed; it does not show the row
activating. The row's activation is proven by `loader-check.ts` under `boot()`,
which is the same Loader the CLI uses, but not the CLI's own profile boot.

## Registration behaviour

- **Skill `ensemble`.** Registered through `ctx.skills.registerProvider` with
  `rank = 600` (`BUNDLED_SKILL_RANK`, rc.4 `packages/skill/skill/src/index.ts`
  line 28) and the invocation policy parsed from the bundled frontmatter:
  `disable-model-invocation: true` ⇒ `{modelInvocable: false, userInvocable:
  true}`, matching `packages/skill/skill-filesystem/src/index.ts` lines
  1015–1021. The skill is therefore reachable by a user gesture and absent from
  model-facing catalogs. A project-local source outranks it; the registry keeps
  one winning definition and never concatenates bodies.
- **Duplicate provider.** A second registration of the same provider name in one
  layer fails; the Loader reports that row as an inactive entry with a warning
  and the first provider keeps serving. Verified in the real Loader.
- **Unload.** Both registrations are effects of the plugin's fiber. Disposing
  the tree removes the provider and the tool.
- **`ensemble_reference`.** Accepts exactly one of the five reference names. The
  schema declares the enumeration, and `execute` re-validates it, so a relaxed
  schema would not widen what the body accepts. Any separator, traversal
  segment, absolute path, unknown name, or `SKILL.md` is rejected with
  `UNKNOWN_RESOURCE`; a symbolic link fails with `RESOURCE_UNAVAILABLE`; a file
  over 65536 bytes fails with `OUTPUT_BUDGET_EXCEEDED`. It never truncates,
  paginates, or falls back to another directory.

## What this is not

Not implemented and not accepted here: domain/coordination tools, an external
Git archive, receipts or recovery, archive authorization and binding, the
Client/GUI half, settings, model/provider selection policy, and any claim about
Host/execution-world separation. The probe runs in the same execution world as
its caller and says so.

`loader-check.ts` proves the published Loader loads this package in a container
install. It is not evidence about a real Host, a running GUI, or a profile
installation, and it is not a substitute for the R8/R15/R18 acceptance runs.
