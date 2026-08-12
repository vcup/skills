# Ensemble Scoped Brief Template

Create `.ensemble/<NNN>-<invocation-slug>/briefs/<scope>.md` only when state and durable pointers cannot recover one assignment. A scope may be a subsystem, candidate, investigation, audit lens, migration slice, or other natural unit—not a required work item, tree, or lifecycle.

The coordinator normally reads only the summary, dependency impact, status, and proposed state update; the member reads the brief and ground truth. Dependencies must survive the recovery window and remain accessible and usable from a fresh session. Persist needed content under the invocation root or another maintained authority before linking.

```markdown
# Scoped brief: <scope>

## Assignment

- **Contribution:** <usable artifact or observations required>
- **Why this scope needs a brief:** <technical context too large or specialized for STATE.md>
- **Boundary / non-goals:** <what this assignment owns and excludes>
- **Parent invocation:** `../STATE.md`
- **Member / attempt:** <composition row id>

## Ground truth and baseline

- **Authoritative source/state:** <source, revision, contract, user decision>
- **Relevant files or interfaces:** <pointers only>
- **Required prior observations:** <artifact pointers>
- **Known stale material:** <what must not be inherited>

## Technical context

<Only assignment-specific details absent from maintained source, tests, docs, or linked artifacts. Prefer pointers.>

## Expected output

- **Artifact or observations:** <path and form>
- **Checks or coverage boundary:** <what to exercise or explicitly leave unknown>
- **Completion criterion:** <checkable assignment-level condition>

## Dependencies and coordination

- **Consumes:** <other artifacts/contracts>
- **Can affect:** <other scopes, shared assumptions, contracts, ownership>
- **Write ownership / isolation:** <baseline and ownership, when modifying>
- **Follow-up channel:** <artifact or coordinator-mediated request>

## Current status

- **Status:** planned / running / blocked / returned / unavailable / replaced / superseded
- **Material findings:** <compact list with evidence pointers>
- **Unavailable checks:** <boundary and consequence>
- **Next technical action:** <within this assignment>

## Proposed STATE.md update

- **Member status:** <new status>
- **Accepted result or finding:** <one-line control fact>
- **Dependency impact:** <none or affected scope/contract>
- **Evidence/artifact pointer:** <durable path>
- **Recommended next action:** <coordinator-level action>
```

Update a brief only when its recovery context materially changes; replace stale content instead of appending a transcript. Retain a completed brief only if it still aids reproduction, maintenance, audit, or recovery. Otherwise the artifact and state pointer suffice.
