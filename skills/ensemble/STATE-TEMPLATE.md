# Ensemble Invocation State Template

Before dispatch, create `.ensemble/<NNN>-<invocation-slug>/`, using the largest prefix plus one from `001`; rescan on collision and never overwrite, rename, or move an invocation. The prefix orders directories; `STATE.md` records completion.

`STATE.md` is this invocation's compact coordination and recovery authority, not a technical dossier. Dependencies must survive the recovery window and remain accessible and usable from a fresh session. Persist them under the invocation root or another maintained authority; save no disposable output. Add [`BRIEF-TEMPLATE.md`](BRIEF-TEMPLATE.md) only when state and durable pointers cannot recover an assignment.

```markdown
# Ensemble: <short outcome>

- **Invocation directory:** `.ensemble/<NNN>-<invocation-slug>/`
- **Lifecycle:** active / blocked / completed
- **Created:** <date or repository convention>

## Outcome

- **Requested deliverable:** <what must be handed to the user>
- **Subject:** <problem, artifact, code state, or decision>
- **Relevant boundary:** <scope and any non-goals needed to prevent drift>
- **Constituent coverage:** <the concrete deliverables, checks, and boundaries the outcome demands; from Step 1 decomposition>
- **Completion evidence:** <what observable result would demonstrate success>

## Runtime configuration

- **Harness capabilities:** <available roles, isolation, communication, artifact support>
- **Role → model mapping:** <user-provided mapping for this invocation>
- **Configuration owner:** user
- **Configuration scope:** invocation
- **Configuration lifetime:** this invocation only

## Authoritative state

- **Current candidate/revision:** <commit, patch, worktree, files, design revision, or other identifiable state>
- **Ground-truth pointers:** <source, issue, contract, user decision, or authoritative docs>
- **Known stale material:** <obsolete reports, source states, decisions, or observations>

When the candidate changes, rerun observations or checks whose subject or assumptions may be affected; keep unaffected results.

## Current composition

| Member / attempt | Model | Role | Assigned coverage | Expected contribution | Difference or named redundancy miss | Status | Recovery pointer |
|---|---|---|---|---|---|---|---|
| <id> | <runtime model> | <role> | <constituent coverage this member owns> | <short artifact/observation/lens> | <one-line reason> | planned/running/blocked/returned/unavailable/replaced/superseded | <durable artifact/brief/source pointer, or “row + ground truth”> |

- **Write ownership and baseline:** <compact owner/isolation/application summary or pointer>
- **Missing-member disposition:** <replacement, recomposition, degraded capability, or blocker>

## Accepted results

- <one-line result or decision> — <observation/artifact pointer> — applies to <candidate/state>

## Open control issues

| Finding, disagreement, or unavailable check | Effect on deliverable / dependency | Disposition | Next owner/action | Pointer |
|---|---|---|---|---|
| <compact issue> | <blocking, dependency impact, user choice, or non-blocking> | investigate/fix/defer/accept/reject/ask/block | <owner/action> | <brief/evidence> |

## Verification summary

| Observed boundary | Applies to state | Result | Unavailable consequence | Pointer |
|---|---|---|---|---|
| <compact check> | <revision> | pass/fail/finding/unavailable | <remaining unknown> | <output> |

## Decisions and user choices

- <one-line decision> — authority: <user/source/observation> — consequence: <what changed> — <pointer>

## Current control state

- **Patterns currently composed:** <names or links; these are a plan, not lifecycle states>
- **What changed most recently:** <fact/scope/authority/risk/assumption/defect/dependency/acceptance>
- **Affected results to recheck:** <only what the change can invalidate>
- **Next action:** <single concrete result-changing action>
- **Blockers:** <none or explicit blockers>

## Scoped recovery briefs

- <scope name> — <why a brief is needed> — `briefs/<scope>.md`

Omit this section when state, source, and artifacts recover every assignment. Briefs are neither mandatory work items nor a lifecycle tree.
```


## Coordinator recovery protocol

1. Locate `STATE.md` through available durable authority (repository, artifact store, or harness); if missing or empty, try other authorities before treating the invocation as unrecoverable. Then read it first.
2. Inspect the candidate and ground truth; source outranks summaries.
3. Reconfirm runtime configuration authority, scope, and lifetime; ask if expired or unclear.
4. Refresh stale observations; reconcile members and ownership; resume the next action.
5. Consult detail only to dispatch, resolve dependencies or blockers, assess, or deliver.

## Subagent recovery protocol

1. Read the outcome, relevant runtime configuration, authoritative state, and your composition row.
2. Follow its pointers and any assigned brief.
3. Inspect ground truth; summaries are not evidence.
4. Reject dependencies that cannot survive recovery; ask the coordinator to persist, absorb, replace, or remove them.
5. Return usable work plus status, findings, dependency impact, evidence, and next action.
6. Edit `STATE.md` only when delegated.

## Update boundary

Update `STATE.md` when recovery or the next action changes. Coalesce related facts; keep only applicable facts current:

- frame, scope, configuration, candidate, and lifecycle;
- composition, recovery pointers, ownership, baseline, and missing-member disposition;
- accepted results and artifact pointers;
- issues and dispositions;
- verification;
- user decisions;
- bounded intervention reason, scope, ownership impact, and return condition;
- current patterns, recent change, affected results, next action, and blockers;
- scoped briefs.

Update before handoff, interruption, completion, or delivery. Make each update recoverable through repository VCS when available; otherwise use harness durability and record the capability loss. An unrecoverable update is a pending recovery gap. Verify that every dependency's lifetime and identifier support fresh-session recovery; persist, absorb, replace, or remove failures.

Replace stale facts; do not append an event log. Keep history in source control, issues, or linked artifacts. On completion, record the candidate and delivery evidence, set lifecycle to `completed`, make the final state recoverable, and retain the directory.
