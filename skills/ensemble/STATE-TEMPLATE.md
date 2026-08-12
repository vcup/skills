# Ensemble Invocation State

Create the next `.ensemble/<NNN>-<invocation-slug>/STATE.md`, using the largest prefix plus one from `001`. Never overwrite an invocation. Use the harness `ensemble_state` tool when available.

`STATE.md` is a compact recovery surface, not a work ledger or technical dossier. Replace stale facts; keep history in source control and linked artifacts.

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

Update before dispatch when the frame or composition changes; after evidence changes a decision, candidate, or check; and before interruption or delivery. Make each update recoverable through repository VCS when available, otherwise through harness durability with the loss recorded.
