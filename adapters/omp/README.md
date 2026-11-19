# OMP Adapter

The isolated OMP package is built in the working tree and installed from its local staging directory. It is **not published to a registry and has no remote address**. Build it from the repository root, then install the local directory:

```bash
bun scripts/pack-omp.ts
omp install ./build/pack/omp/staging
```

OMP 17.2.15's installer accepts a local directory or a registry spec, but not a `.tgz` file, so the staging directory is the install target; the tarball from `npm pack` is an inspection artifact. The former mixed entry `omp install github:vcup/skills` is superseded and is not an unresolved remote install. These working-tree artifacts are not committed or published in this round; see the [P1 delivery record](../../docs/ensemble/P1-DELIVERY.md).

OMP enables the plugin from its lockfile and discovers the package's `skills/` and `agents/` directories. No manual clone, local extension path, or separate skill install is required.

## Use ensemble

Invoke the skill with the deliverable, constraints, and checks:

```text
/skill:ensemble Review the cache invalidation design, propose a fix, and verify concurrent reads.
```

The Lead chooses assignments and the records location before dispatch. The supplied scout, reviewer, and worker roles load the ensemble method for their assignments; they report to the Lead rather than opening another invocation. Model selection and tool availability follow the current OMP configuration.

For checkpoints, the current writer uses the session workspace's `.ensemble/` directory. If that directory is untracked, keep it as a separate records repository and exclude it locally from product Git. For a repository outside the workspace, use ordinary file tools instead. Existing tracked records stay in place until a migration is arranged. The [checkpoint guide](../../skills/ensemble/STATE-TEMPLATE.md) explains both paths and the three-digit numbering limit.

## Native capabilities

| Capability | Implementation |
|---|---|
| Portable methods | `skills/ensemble/`, `skills/always/`, `skills/edit-commit-msg/` |
| Independent research | `ensemble-scout` |
| Independent assessment | `ensemble-reviewer` |
| Owned production | `ensemble-worker` |
| Coordination state | `ensemble_state` custom tool |

`ensemble_state` accepts `{path, content}` with complete replacement Markdown and a path matching `.ensemble/<NNN>-<slug>/STATE.md`. It resolves paths against the session working directory, rejects symlink roots/invocation directories, and writes through a temporary file and rename. The Lead serializes writes: this tool has no CAS, semantic validation, automatic numbering, history commits, or external archive configuration. Atomic replacement does not by itself guarantee power-loss durability.

User invocation remains available with `disable-model-invocation: true`; the packaged task roles explicitly autoload the method for their assignments. This distinction follows the pinned OMP [skill discovery](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/extensibility/skills.ts) and [task execution](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/task/executor.ts) sources.

OMP auto-adds its coordination tools to task agents. Model choice, isolation, communication, artifacts, and result notification remain native harness concerns; the skill does not recreate them.
