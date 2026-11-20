# Skills

Portable skills packaged with native harness capabilities where needed.

Three consumption paths ship from one maintained method source: a **pure skill**
(any harness), an **OMP package**, and a **DSH probe package**. Each has its own
installation root, and no installed artifact requires this repository.

Jump straight to your path: [pure skill](#pure-skill-any-harness) ·
[Oh My Pi](#oh-my-pi) · [DeepSeek Harness](#deepseek-harness) ·
[DSH adapter guide](adapters/dsh/README.md)

## Install

Pick the path that matches the harness you use.

### Pure skill (any harness)

Install from this Git repository. No build step runs, and nothing outside the
installed directory is needed:

```bash
npx skills@latest add vcup/skills
```

To select a specific skill:

```bash
npx skills@latest add vcup/skills --skill ensemble
npx skills@latest add vcup/skills --skill always
npx skills@latest add vcup/skills --skill edit-commit-msg
```

Add `-a <agent>` to select the target harness. `@latest` selects the installer
version, not a skill release version. `npx skills` installs the selected method
under `skills/`; it does not install OMP task agents or state tools.

The generated `skills/ensemble/` directory is committed to this repository and
byte-identical to what the maintained source produces, so installing needs no
build step.

### Oh My Pi

The isolated OMP package is a local artifact: it is **not published to a
registry and has no remote address**. OMP 17.2.15's installer accepts a local
directory or a registry spec, but not a `.tgz` file. How you install depends on
what you have:

- **Maintainers, inside this repository's working tree:** build the staging root
  with the Make entry point, then install that directory:

  ```bash
  make pack-omp
  omp install ./build/pack/omp/staging
  ```

- **If you already have an unpacked package:** change into the unpacked
  directory and install it there; the package is self-contained and does not
  need this repository or its build scripts:

  ```bash
  omp install .
  ```

This package provides the `ensemble`, `always`, and `edit-commit-msg` skills, the
native `ensemble-*` task agents, and the path-safe `ensemble_state` tool in one
isolated installation root. OMP enables it through its plugin manager; no manual
`--extension` path is needed. The former mixed Git entry
(`omp install github:vcup/skills`) has been replaced by this package. Update or
remove it through OMP's plugin manager. See the [OMP guide](adapters/omp/README.md).

### DeepSeek Harness

The DSH package is the **Host-only probe** `dsh-ensemble-probe@0.1.0`, built
against DSH `0.2.2-rc.4`. It registers the `ensemble` skill as user-invocable and
one read-only `ensemble_reference` tool. It is not the full ensemble product:
domain tools, external archive, Client/GUI, and Host/execution-world separation
are not implemented. Startup output, the isolated-first-run recipe, and the
evidence behind these claims are in the [DSH adapter guide](adapters/dsh/README.md).

**Prerequisites.** `dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`
(otherwise `add` fails with `pnpm was not found`, exit 127). Keep `PNPM_HOME`
unchanged between `add` and `remove`, or `remove` fails on a store mismatch.
`--profile` comes before the pnpm verb. Use a profile that has an app row; `web`
is the shipped one and the safe choice.

From this repository, every line runs in the same directory:

```bash
make pack-dsh
dsh plugin --profile web add ./build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz
dsh plugin --profile web list                        # shows dsh-ensemble-probe@0.1.0
dsh --profile web                                    # start DSH
```

Then type `/ensemble <task>` in the composer; the skill is user-invocable only,
so it is not offered to the model. Remove it with:

```bash
dsh plugin --profile web remove dsh-ensemble-probe
```

Restart DSH afterwards to be sure the tool leaves the roster as well as the
skill catalog.

If you received the package on its own rather than from this repository, run the
same `add` from the directory that contains the `.tgz`. Two messages from `add`
are **not** failures: `Agent skills awaiting approval: …` and a peer-dependency
`WARN`; `add` still exits 0.
## Use

Invoke a skill with the deliverable, constraints, and completion checks.

**OMP:** `/skill:ensemble Review the cache invalidation design, propose a fix, and verify concurrent reads.`

The Lead chooses assignments and the records location before dispatch. The
packaged roles autoload the method for their assignments and report to the Lead
rather than opening another invocation. Model selection and tool availability
follow the current OMP configuration.

**Other harnesses:** use your native skill invocation and the
[portable method](skills/ensemble/SKILL.md).

**DSH:** the skill is user-invocable only; model-facing catalogs do not offer it.
`ensemble_reference` reads back one of the bundled references (`EVOLUTION-TEMPLATE.md`,
`GLOSSARY.md`, `PATTERNS.md`, `README.md`, `STATE-TEMPLATE.md`) and refuses any
other name, path, or symbolic link.

## Package surface

- [Ensemble](skills/ensemble/SKILL.md): portable method, [practice guide](skills/ensemble/README.md), and [patterns](skills/ensemble/PATTERNS.md).
- [Always](skills/always/SKILL.md): lossless clarity, compression, and logic audits (formerly `lossless`).
- [Edit commit message](skills/edit-commit-msg/SKILL.md): crafts Git's pending message without changing history or workflow state.
- [Scout](agents/ensemble-scout.md), [reviewer](agents/ensemble-reviewer.md), and [worker](agents/ensemble-worker.md): OMP-native assignment roles.
- [OMP adapter](adapters/omp/index.ts): the path-safe `ensemble_state` tool.
- [DSH adapter](adapters/dsh/README.md): the Host-only rc.4 probe and its evidence.
- [DSH design](docs/ensemble/README.md): the managed adapter design and its [delivery roadmap](ROADMAP.md).

## Where to read next

Find the entry point for what you are doing:

| Your task | Start here |
|---|---|
| Install or use a path | The **Install** and **Use** sections above; each package carries its own README |
| Build, test, pack, or diagnose the repository | [Development guide](docs/DEVELOPMENT.md) — Make is the only main interface |
| Understand the design contracts | [Design index](docs/ensemble/README.md), [distribution rules](docs/ensemble/DISTRIBUTION.md), [implementation plan](docs/ensemble/IMPLEMENTATION.md) |
| Check current delivery status and what is unverified | [P1 delivery record](docs/ensemble/P1-DELIVERY.md) and [roadmap](ROADMAP.md) |
| Find the evidence behind a claim | [Research and review records](docs/ensemble/research/README.md) |
| See how the method itself evolved | [Design evolution](docs/ensemble/EVOLUTION.md) |
| Inspect invocation history and coordination records | `.ensemble/` — records, not product behaviour |
| **Edit the ensemble skill text** | Edit [`content/ensemble/`](content/ensemble) — the maintained source. [`skills/ensemble/`](skills/ensemble) is **generated** from it, so editing it directly is wrong and `make check` will report drift. Change `content/`, then run `make content-build TARGET=skill`. |

Repository operations go through the Makefile. Run `make` to list grouped
targets, and `make check` for the offline default gate. Targets that need a real
DSH install take `INSTALL_DIR=`; the development guide explains how to prepare one.

## Design notes

`ensemble` covers full outcomes through independent contributions checked against
ground truth. `always` applies lossless clarity and logic checks throughout every
task, compressing language only after recovering its propositions, relations,
boundaries, and practical effect. `edit-commit-msg` reconstructs commit intent
from read-only evidence and writes only Git's pending message file; it never
creates, amends, or advances a commit.

Harness adapters use their strongest native capabilities instead of emulating a
lowest common denominator. On OMP:

- plugin installation supplies the skill and agents together;
- native task roles and tool allowlists provide contribution shapes;
- the harness selects models and reports available agents;
- task notifications eliminate polling;
- task outputs and artifacts are evidence pointers;
- `ensemble_state` atomically writes only `.ensemble/<NNN>-<slug>/STATE.md`.

The Lead remains responsible for the outcome and may investigate, implement,
integrate, or validate directly. Delegation exists to create useful independence
and parallelism, not to forbid Lead work.

[Separate distributions](docs/ensemble/DISTRIBUTION.md) keep `vcup/skills` as the
pure-skill Git installation source while OMP and DSH build their own package
roots. The pure skill directory is generated from a single maintained source and
committed, so `make check` can detect drift between source and committed output.
This overview is for maintainers of the source repository; installed skills and
packages receive only their own usage guides.

## Version control

Keep product changes under this repository's conventions. Concrete environment
configuration and high-frequency coordination/learning history belong in separate
private storage, not merely separate commits here. A managed adapter maintains
them through tools outside the workspace; current OMP only provides the documented
state writer. The [DSH plugin design](docs/ensemble/README.md) specifies the
proposed managed workflow. The [roadmap](ROADMAP.md) assesses its current stage.
Durable [research and review evidence](docs/ensemble/research/README.md) and the
[design evolution](docs/ensemble/EVOLUTION.md) belong in this repository alongside
the design they support. Run `make docs` to check maintained documentation without
private scratch files. The [P1 delivery record](docs/ensemble/P1-DELIVERY.md)
reports what the probes have verified and what remains unverified. For repository
operations and target variables see the [development guide](docs/DEVELOPMENT.md).
