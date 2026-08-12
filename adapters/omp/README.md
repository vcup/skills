# OMP Adapter

Install online with:

```bash
omp install github:vcup/skills
```

OMP enables the plugin from its lockfile and discovers the package's `skills/` and `agents/` directories. No manual clone, local extension path, or separate skill install is required.

## Native capabilities

| Capability | Implementation |
|---|---|
| Portable method | `skills/ensemble/` |
| Independent research | `ensemble-scout` |
| Independent assessment | `ensemble-reviewer` |
| Owned production | `ensemble-worker` |
| Coordination state | `ensemble_state` custom tool |

`ensemble_state` accepts complete replacement content only for paths matching `.ensemble/<NNN>-<slug>/STATE.md`. It resolves paths against the session working directory and writes atomically through a temporary file and rename.

OMP auto-adds its coordination tools to task agents. Model choice, isolation, communication, artifacts, and result notification remain native harness concerns; the skill does not recreate them.
