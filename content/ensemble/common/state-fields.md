The checkpoint records these fields. They are a description of the recovery view, not a form to fill in by hand.

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

Record material changes before dispatch, after evidence changes a decision, candidate, or check, and before interruption or delivery. Report persistence gaps explicitly. Specific deployment routes and credentials do not belong in the product repository; an inspiring evolution reading is maintained separately using [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md).
