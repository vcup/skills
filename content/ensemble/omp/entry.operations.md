## Records on this path

This OMP package ships the skill and the `ensemble_state` tool together. The tool writes one checkpoint file per invocation; it does not provision an external archive, allocate numbers, validate meaning, or commit history.

**Location.** Use `.ensemble/<NNN>-<invocation-slug>/STATE.md` relative to the session working directory. The Lead allocates the next three-digit prefix from `001` through `999`, one state writer at a time. At exhaustion, choose another authorized records location; never overwrite an invocation or pass `1000` to the writer.

**What the writer enforces.** It resolves the path against the session working directory, rejects symlink roots and symlinked invocation directories, and replaces the file atomically through a temporary file and rename. It cannot redirect to an external archive. Atomic replacement alone does not guarantee power-loss durability.

**History.** Keep `.ensemble/` in its own repository and exclude it locally from the product repository when it is not already tracked. The writer does not commit; history management is explicit and separate. Existing tracked records stay in place until a migration is arranged.

**Records outside the workspace.** Use ordinary authorized file tools for those paths and allocate identities there; do not call `ensemble_state` for them. Report the actual location and any persistence gap.

**Evolution readings.** Follow [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md) in the same records area.

**Capabilities.** OMP supplies native task roles, model selection, isolation, and task notifications. The packaged roles autoload this skill for their assignments; a member reports to the Lead instead of opening another invocation. Model and tool availability follow the current OMP configuration.
