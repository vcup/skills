# Ensemble: package portable core and OMP adapter

- **Invocation directory:** `.ensemble/001-portable-package/`
- **Lifecycle:** active
- **Created:** 2026-08-06

## Outcome

- **Requested deliverable:** Independent `ensemble` repository installable with `npx skills`, with a portable role contract and a runnable OMP adapter.
- **Subject:** copied ensemble methodology plus package, role, and adapter files.
- **Relevant boundary:** `npx skills` installs the portable `skills/ensemble/` core only; OMP extension loading is separate runtime-adapter installation.
- **Constituent coverage:** portable core; role/degradation contract shipped with the skill; OMP agent discovery and tool allowlists; installation boundaries; observed validation.
- **Completion evidence:** `npx skills add . --list` finds `ensemble`; OMP loaded with this repository discovers the five `ensemble-*` agents.

## Runtime configuration

- **Harness capabilities:** `npx skills`  lists/install skills; OMP supports extension-package sibling `skills/` and `agents/` discovery.
- **Role → model mapping:** adapter leaves model selection to runtime configuration.
- **Configuration owner:** user / harness
- **Configuration scope:** invocation
- **Configuration lifetime:** invocation

## Authoritative state

- **Current candidate/revision:** package deliverable committed at `ffe3f72` (`Package portable ensemble skill and OMP adapter`); this `STATE.md` is pending its separate submission.
- **Ground-truth pointers:** Agent Skills specification; OMP task-agent discovery docs; `npx skills` README; `ffe3f72`; direct `npx skills` and OMP smoke observations.
- **Known stale material:** prior implementation in `~/.agents`, which is source material only and not this repository's deliverable.

## Current composition

| Member / attempt | Model | Role | Assigned coverage | Expected contribution | Difference or named redundancy miss | Status | Recovery pointer |
|---|---|---|---|---|---|---|---|
| coordinator | n/a | integrator | all | portable package + OMP adapter | direct implementation | returned | repository files |

- **Write ownership and baseline:** single writer in empty repository.
- **Missing-member disposition:** no independent members used; no harness decision was delegated.

## Accepted results

- Portable core copied under `skills/ensemble/`; its role contract is colocated as `ROLE-CONTRACT.yaml` so `npx skills` carries it.
- OMP extension package discovers five `ensemble-*` agents with tool allowlists and `autoloadSkills: [ensemble]`.
- Contract distinguishes semantic role capabilities from enforcement and requires recorded degradation.

## Open control issues

| Finding, disagreement, or unavailable check | Effect on deliverable / dependency | Disposition | Next owner/action | Pointer |
|---|---|---|---|---|
| `npx skills` installs skills, not extension modules or agents | OMP adapter cannot be installed by skill CLI | accepted / documented | user loads OMP adapter through native extension mechanism | README.md |
| OMP tool allowlists do not path-sandbox writes | state-writer path scope is not enforced | accepted / documented | record as adapter limit | adapters/omp/README.md |
| Claude, Codex, Copilot adapters absent | no auto role discovery/tool enforcement there | accepted / explicit fallback | use role assignments and record capability loss | adapters/README.md; ROLE-CONTRACT.yaml |

## Verification summary

| Observed boundary | Applies to state | Result | Unavailable consequence | Pointer |
|---|---|---|---|---|
| `npx --yes skills add . --list` | repository root | pass: found one skill, `ensemble` | — | command output |
| `npx skills add … --copy` into a temporary Codex project | installed portable payload | pass: installed `SKILL.md` and `ROLE-CONTRACT.yaml` | adapter files intentionally excluded | command output |
| OMP `--extension /home/vcup/codes/ensemble` smoke | adapter | pass: discovered five `ensemble-*` agents | — | process log |
| `package.json` parses | package | pass | — | node JSON parse |
## Current control state

- **Patterns currently composed:** Frame → Trace authority/state → implement under clear ownership → validate intended state → submit durable state.
- **What changed most recently:** committed package at `ffe3f72`; `npx skills` payload and OMP role discovery both revalidated. GPG signing timed out, so the repository's unavailable signer was bypassed for this commit; no repository policy required signing.
- **Affected results to recheck:** none.
- **Next action:** commit this state separately, then deliver.
- **Blockers:** none.
