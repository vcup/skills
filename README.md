# Skills

Portable agent skills, plus two DeepSeek Harness packages that add the native
tooling the harness does not ship. Everything comes from one maintained method
source per path, and no installed artifact needs this repository.

Jump to your path: [pure skill](#pure-skill-any-harness) ·
[Oh My Pi](#oh-my-pi) · [DSH ensemble](#deepseek-harness-ensemble) ·
[DSH subagent wait](#deepseek-harness-subagent-wait) ·
[repository map](#repository-map)

## What ships here

Four artifacts, one per consumer. All are built and installed locally; **none is
published to a registry and none has a remote install address**.

| Artifact | Identity | State |
|---|---|---|
| Pure skill | `skills/ensemble/`, committed and generated from `content/` | Installable from this Git repository today |
| OMP package | `@vcup/skills@0.2.0`, staging root | Local artifact only |
| DSH ensemble package | `dsh-ensemble@1.0.0`, tarball | Local candidate: the same frozen bytes passed the full `release-check` on DSH `0.2.2-rc.4` and `0.2.2-rc.5` (Linux); not published to a registry and not pushed to a remote |
| DSH subagent-wait plugin | `dsh-agent-wait@1.0.0`, tarball | Local candidate with its own release gate |

"Local candidate" is a precise claim: one frozen artifact was built, installed with
the ordinary installer, and put through the strict `release-check` door on both
tested Linux releases (`0.2.2-rc.4` and `0.2.2-rc.5`), including the authenticated
browser UI and the cross-container source gate. The boundaries that remain are the
ones [production status](docs/PRODUCTION.md#current-status) lists: nothing is
published, no remote CI run exists, no cross-host/WAN/TLS replica is claimed, no
physical-host isolation is claimed, and nothing here says anything about any
model's answer quality.

If you need a release conclusion, the only command that can give one is
`make release-check` with `INSTALL_DIR`, `PACKAGE`, `PACKAGE_SHA256`, `BROWSER`,
`SLOTS`, `CLIENT_TYPES` and a container runtime all supplied; missing any of them
exits 2 rather than reporting a partial pass. See [development](docs/DEVELOPMENT.md).

## Install

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
under `skills/`; it does not install OMP task agents or any DSH tool.

`skills/ensemble/` is committed and byte-identical to what the maintained source
produces, so installing needs no build step.

### Oh My Pi

The OMP package is a local artifact with no registry address. OMP 17.2.15's
installer accepts a local **directory** or a registry spec, but not a `.tgz`
file.

Inside this repository, build the staging root and install that directory:

```bash
make pack-omp
omp install ./build/pack/omp/staging
```

If you already have an unpacked package, change into it and install it there; it
is self-contained:

```bash
omp install .
```

The package provides the `ensemble`, `always` and `edit-commit-msg` skills, the
native `ensemble-*` task agents, and the path-safe `ensemble_state` tool in one
installation root. OMP enables it through its plugin manager; no manual
`--extension` path is needed. The former mixed Git entry
(`omp install github:vcup/skills`) is superseded by this package. Update or
remove it through OMP's plugin manager. See the [OMP guide](adapters/omp/README.md).

### DeepSeek Harness: ensemble

`dsh-ensemble@1.0.0` is built and tested against exactly DSH `0.2.2-rc.4` and
`0.2.2-rc.5` (`0.2.2-rc.5` is the default for a new install). Any other release
is refused rather than tried; `latest` is an observation, never a support signal.

The package carries four pieces that share one authorization and storage
boundary: the user-invocable `ensemble` skill; four model-facing tools
(`ensemble_work`, `ensemble_learn`, `ensemble_read`, `ensemble_upload`) plus the
read-only `ensemble_reference` reader; the owner-only `ensembleArchive` Remote
with its `ensemble-archive` CLI; and a web Client extension.

**Prerequisites.** `dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`
(without it `add` fails with `pnpm was not found`, exit 127). Keep `PNPM_HOME`
unchanged between `add` and `remove`, or `remove` fails on a store mismatch. Put
`--profile` before the pnpm verb, and use a profile that has an app row; `web` is
the shipped one and the safe choice.

```bash
make pack-dsh
dsh plugin --profile web add ./build/pack/dsh/dsh-ensemble-1.0.0.tgz
dsh plugin --profile web list        # shows dsh-ensemble@1.0.0
```

Two messages from `add` are **not** failures: `Agent skills awaiting approval: …`
and a peer-dependency `WARN`; `add` still exits 0. If you received the tarball on
its own, `build/` does not exist for you — run `add` from the directory that
holds it, with a path relative to that directory.

**Configure the deployment.** Four variables are read once when the plugin loads,
so a change needs a Host restart. They describe the deployment, not a request,
and no model argument can set them:

| Variable | Meaning |
|---|---|
| `DSH_ENSEMBLE_ARCHIVE_ROOT` | Absolute path, outside every bound source; created on first `initialize` |
| `DSH_ENSEMBLE_AUTHORITY_ID` | This Host's authority identity; owner actions are built from it |
| `DSH_ENSEMBLE_ARCHIVE_WORLD` | The archive's own execution-world label, chosen by the deployment |
| `DSH_ENSEMBLE_SOURCE_WORLD` | The source execution world this deployment maps to real services |

If `DSH_ENSEMBLE_SOURCE_WORLD` is unset, the owner Remote and CLI still work but
model tools refuse with `the caller's execution world has no deployment mapping`.
That refusal is deliberate: a caller cannot name its own world.

**First use.** Start the Host and create the archive for your project: the first
owner action is the `manage` → `initialize` request, reachable from the Client's
management tab (the CLI sends the same `request` object). Supply `initial_grants`
with a real subject — `{"kind":"owner","ownerId":…,"hostAuthorityId":…}` or
`{"kind":"session","sessionId":…,"rootSessionId":…}` — or the request is refused as
`invalid_input`. The probe-era `initialize`/`bind` wire methods are retired for
creation in 1.0 and cannot create a current archive; a directory written by the
0.3.0 probe is migrated explicitly, never opened as if it were current (see
[version support and upgrade](docs/UPGRADING.md)).

Then type the skill in the composer. The skill is user-invocable only, so the
model's catalog does not offer it:

```bash
dsh --profile web
```

```text
/ensemble Review the cache invalidation design, propose a fix, and verify concurrent reads.
```

Work and learning content is recorded through the model tools. Owner actions
(initialize, bind, grant, revoke, takeover, pause/resume, maintenance) are
available from the Client and from the `ensemble-archive` CLI. The CLI talks to a
**running** Host with your session cookie and never invents a principal:

```bash
: "${DSH_HOME:?Set DSH_HOME to the running Host data directory}"
ENSEMBLE_ARCHIVE="$DSH_HOME/profiles/web/node_modules/.bin/ensemble-archive"
"$ENSEMBLE_ARCHIVE" status --cookie-file jar.txt
```

The binary is installed into the profile's `node_modules/.bin`, not onto your
`PATH`. Credentials are accepted only from `--cookie-file`, `--cookie-stdin` or
`ENSEMBLE_ARCHIVE_COOKIE` — never from a command-line argument. Exit codes: `0`
success, `1` Host refused, `2` usage, `3` no credential (nothing sent), `4`
credential rejected, `5` unreachable.

**Upgrade.** Add the new tarball to the same profile and restart the Host. The
archive format is versioned; a package that does not recognise it refuses rather
than guessing. Keep the previous tarball until you have opened the archive once
with the new version.

```bash
dsh plugin --profile web add ./dsh-ensemble-<new version>.tgz
dsh plugin --profile web list
```

**Uninstall.** Both registrations are effects of the plugin's own fiber, so
unloading disposes them. On a running server the skill leaves the catalog
immediately, but a tool already in the roster can linger until a later session;
restart if you need both gone at once.

```bash
dsh plugin --profile web remove dsh-ensemble
```

Archive data lives outside the profile in `DSH_ENSEMBLE_ARCHIVE_ROOT` and is not
touched by `remove`. Moving from the earlier `dsh-ensemble-probe` package, or
from its Git-only workflow, is a separate explicit step: read
[version support and upgrade](docs/UPGRADING.md).

The install recipe, configuration table, CLI options, Client behaviour and the
evidence boundary behind each claim are maintained in the [DSH adapter
guide](adapters/dsh/README.md) and the package's own README.

### DeepSeek Harness: subagent wait

`dsh-agent-wait@1.0.0` is a second, independent DSH package. It registers one
model tool, `wait_subagents`, which blocks the caller's current turn until any or
all of its subagents change status (or are idle, on request), a deadline elapses,
or the call is cancelled. It observes; it never sends messages or suppresses the
Host's own completion notices, so a child finishing mid-wait can still deliver
its notice and open a later turn.

```bash
make pack-dsh-agent-wait
dsh plugin --profile web add ./build/pack/dsh-agent-wait/dsh-agent-wait-1.0.0.tgz
dsh plugin --profile web list        # shows dsh-agent-wait@1.0.0
```

It declares its **own** supported DSH set and does not inherit the ensemble
package's. See the [wait plugin guide](adapters/dsh-agent-wait/README.md).

## Use

Invoke a skill with the deliverable, constraints, and completion checks.

**OMP:** `/skill:ensemble Review the cache invalidation design, propose a fix, and verify concurrent reads.`

The Lead chooses assignments and the records location before dispatch. The
packaged roles autoload the method for their assignments and report to the Lead
rather than opening another invocation. Model selection and tool availability
follow the current OMP configuration.

**Other harnesses:** use your native skill invocation and the [portable
method](skills/ensemble/SKILL.md).

**DSH:** the skill is user-invocable only. Work and learning content is recorded
through the four domain tools; `ensemble_reference` reads back one of the bundled
references (`EVOLUTION-TEMPLATE.md`, `GLOSSARY.md`, `PATTERNS.md`, `README.md`,
`STATE-TEMPLATE.md`) and refuses any other name, path, or symbolic link.

## Package surface

- [Ensemble](skills/ensemble/SKILL.md): portable method, [practice guide](skills/ensemble/README.md), and [patterns](skills/ensemble/PATTERNS.md).
- [Always](skills/always/SKILL.md): lossless clarity, compression, and logic audits (formerly `lossless`).
- [Edit commit message](skills/edit-commit-msg/SKILL.md): crafts Git's pending message without changing history or workflow state.
- [Scout](agents/ensemble-scout.md), [reviewer](agents/ensemble-reviewer.md), and [worker](agents/ensemble-worker.md): OMP-native assignment roles.
- [OMP adapter](adapters/omp/index.ts): the path-safe `ensemble_state` tool.
- [DSH adapter](adapters/dsh/README.md): the `dsh-ensemble` package — tools, owner Remote, CLI, Client and its evidence.
- [DSH wait plugin](adapters/dsh-agent-wait/README.md): the in-place `wait_subagents` tool.
- [DSH design](docs/ensemble/README.md): the managed adapter's design contracts.

## Repository map

Read the entry that matches what you are doing:

| Your task | Start here |
|---|---|
| Install or use a path | The **Install** and **Use** sections above; each package carries its own README |
| Build, test, pack, or diagnose the repository | [Development guide](docs/DEVELOPMENT.md) — Make is the only main interface |
| See what is implemented, gate-verified, or still open | [Production status](docs/PRODUCTION.md), [roadmap](ROADMAP.md), [shared vocabulary](GLOSSARY.md) |
| Understand the design contracts | [Design index](docs/ensemble/README.md), [distribution rules](docs/ensemble/DISTRIBUTION.md), [implementation plan](docs/ensemble/IMPLEMENTATION.md) |
| Look up an exact action, field or refusal | [Command contracts](docs/ensemble/COMMANDS.md) |
| Bind, grant, migrate, back up or replicate | [Operations](docs/ensemble/OPERATIONS.md), [version support and upgrade](docs/UPGRADING.md) |
| Walk through a user journey | [User journeys](docs/ensemble/USER-JOURNEYS.md) |
| Check the historical delivery record | [P1 delivery record](docs/ensemble/P1-DELIVERY.md) |
| Find the evidence behind a claim | [Research and review records](docs/ensemble/research/README.md) |
| See how the method itself evolved | [Design evolution](docs/ensemble/EVOLUTION.md) |
| Inspect invocation history and coordination records | `.ensemble/` — records, not product behaviour |

Repository operations go through the Makefile. Run `make` to list grouped
targets, and `make check` for the offline default gate. Targets that need a real
DSH install take `INSTALL_DIR=`; the development guide explains `make
runtime-setup`.

### Editing the method text

Edit [`content/ensemble/`](content/ensemble) — the maintained source.
[`skills/ensemble/`](skills/ensemble) is **generated** from it, so editing it
directly is wrong and `make check` will report drift. Change `content/`, then run
`make content-build TARGET=skill`.

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

On DSH the adapter goes further: agents, messages, tasks and model selection stay
native, while project coordination facts, complete material and reviewed reading
live in a versioned archive outside the source workspace. The model never edits
state files, allocates numbers or runs Git; each write is one receipted commit
behind a current grant. Authority comes from the live native caller, never from a
field in the request.

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
configuration and high-frequency coordination/learning history belong in the
archive or other private storage, not merely separate commits here. Durable
[research and review evidence](docs/ensemble/research/README.md) and the [design
evolution](docs/ensemble/EVOLUTION.md) belong in this repository alongside the
design they support. Run `make docs` to check maintained documentation without
private scratch files. [Production status](docs/PRODUCTION.md) reports what is
verified and what is not. For repository operations and target variables see the
[development guide](docs/DEVELOPMENT.md).
