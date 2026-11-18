# Ensemble Invocation State

In managed plugin mode, submit domain actions through the adapter tools; the program generates this checkpoint outside the workspace. Do not allocate paths, edit generated Markdown, or maintain `.ensemble/` manually.

For manual records, choose one supported location before dispatch:

- **Current OMP writer:** use `.ensemble/<NNN>-<invocation-slug>/STATE.md` relative to the session working directory. Keep `.ensemble/` in its own repository and exclude it locally from the product repository when it is not already tracked. The writer rejects symlink roots and invocation directories; it cannot redirect to an external archive. The Lead allocates the next three-digit prefix from `001` through `999`, with one state writer at a time. At exhaustion, choose a new authorized records location; do not overwrite an invocation or pass `1000` to this writer.
- **External records repository:** use ordinary authorized file tools for a checkpoint and its supporting materials. Allocate identities within that repository, keep explicit subject/baseline references, and report its actual location. Do not call the OMP writer for these paths.

Both manual options require explicit history management. `ensemble_state` replaces the complete checkpoint atomically; it does not allocate identities, validate its meaning, coordinate concurrent writers, or commit history. Existing tracked records require a separate migration decision rather than an automatic move.

`STATE.md` is a compact recovery view, not a work ledger or technical dossier. Keep technical truth in the subject and evidence; keep frequent history in a separate repository rather than the product commit stream.

```markdown
# Ensemble: <short outcome>

- **Lifecycle:** active / blocked / completed
- **Requested deliverable:** <what must be handed to the user>
- **Subject and boundary:** <artifact/problem and relevant limits>
- **Required coverage:** <concrete deliverables, checks, and boundaries>
- **Completion evidence:** <observable proof of success>

## Contributions

| Attempt | Assigned coverage | Material difference or redundancy | Status | Result / evidence pointer |
|---|---|---|---|---|
| <agent/task> | <owned constituent> | <model, role, approach, source, lens, or named repeated miss> | planned/running/returned/missing/superseded | <artifact, observation, or missing consequence> |

## Decisions and findings

- <accepted/rejected/unresolved result> — <evidence or authority> — <effect on deliverable>

## Candidate and verification

- **Candidate:** <commit, patch, files, design revision, or other identifiable state>
- **Observed checks:** <checks and results tied to candidate>
- **Unavailable critical checks:** <none or blocking consequence>
- **Unresolved choices or risks:** <none or consequence>

## Next

- **Next action:** <single result-changing action or delivered>
- **Blockers:** <none or explicit blocker>
```

Record material changes before dispatch, after evidence changes a decision/candidate/check, and before interruption or delivery. Managed tools maintain this view and its history; skill-only users maintain the isolated records area. Report persistence gaps explicitly. Specific deployment routes and credentials do not belong in the product repository; an inspiring evolution reading is maintained separately using `EVOLUTION-TEMPLATE.md`.
