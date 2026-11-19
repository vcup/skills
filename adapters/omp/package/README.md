# Ensemble for OMP

This package installs the ensemble method, its three task roles, and the
`ensemble_state` checkpoint tool into OMP 17.2.15.

## Install from the unpacked package

Unpack the package into a directory of your choice, then install that
directory from inside it:

```bash
cd <unpacked-package-directory>
omp install .
```

OMP 17.2.15's installer accepts a local directory or a registry spec, but not a
`.tgz` file, so the unpacked directory is the install target and the tarball
itself is only a transport. This package is a local build: it is **not
published to a registry and has no remote address**.

OMP enables the plugin from its plugin registry and discovers the package's
`skills/` and `agents/` directories. No separate skill install is required.

Building the package is a maintainer step that happens in the source
repository; its commands and the local staging path are documented there, not
in this package.

## What the package contains

| Capability | Location in the package |
|---|---|
| Ensemble method skill | `skills/ensemble/` |
| Always-on writing skill | `skills/always/` |
| Commit message skill | `skills/edit-commit-msg/` |
| Research role | `agents/ensemble-scout.md` |
| Assessment role | `agents/ensemble-reviewer.md` |
| Production role | `agents/ensemble-worker.md` |
| Checkpoint tool | `omp-extension/index.ts` |

## Use

Invoke the skill with the deliverable, constraints, and checks:

```text
/skill:ensemble Review the cache invalidation design, propose a fix, and verify concurrent reads.
```

The Lead chooses assignments and the records location before dispatch. The
supplied roles autoload this package's own ensemble skill for their
assignments and report to the Lead rather than opening another invocation.
Model selection and tool availability follow the current OMP configuration.

## Checkpoints

The `ensemble_state` tool writes one checkpoint file per invocation into
`.ensemble/<NNN>-<invocation-slug>/STATE.md`, relative to the session working
directory. The Lead allocates the next three-digit prefix from `001` through
`999`, one state writer at a time. The tool resolves the path against the
session working directory, rejects symlinked roots and symlinked invocation
directories, and replaces the file atomically through a temporary file and
rename. It does not provision an external archive, allocate numbers, validate
meaning, or commit history; atomic replacement alone does not guarantee
power-loss durability.

Keep `.ensemble/` in its own repository and exclude it locally from the product
repository when it is not already tracked. For records outside the workspace,
use ordinary authorized file tools and allocate identities there. The
[`STATE-TEMPLATE.md`](skills/ensemble/STATE-TEMPLATE.md) in the same records
area describes the checkpoint fields, and
[`EVOLUTION-TEMPLATE.md`](skills/ensemble/EVOLUTION-TEMPLATE.md) describes the
reflection record.

## Roles and managed tools

The packaged roles autoload the method for their assignments and follow the
records procedure the loaded skill names. Their tool allowlists decide which
file tools each role may use, and the only tool this package adds is
`ensemble_state`.
