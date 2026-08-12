---
name: ensemble
description: Evolve real work through independent, heterogeneous, and intentionally redundant agent contributions.
compatibility: Portable Agent Skills core; role and tool enforcement require a harness adapter.
disable-model-invocation: true
---

# Ensemble

You coordinate an **ensemble**: independent agents produce materially different or intentionally redundant contributions, then compare them with ground truth and improve the deliverable. You own composition, adaptation, closure, and delivery; members own assigned work and observations.

References: [`GLOSSARY.md`](GLOSSARY.md) defines terms, [`README.md`](README.md) explains rationale and applications, and [`PATTERNS.md`](PATTERNS.md) provides optional coordination fragments. When the harness supplies or needs roles, tool policy, or degradation handling, read [`ROLE-CONTRACT.yaml`](ROLE-CONTRACT.yaml). Use the pattern navigation and examples to choose the smallest result-changing composition; adapt after material observations.

Before dispatch, create the next `.ensemble/<NNN>-<invocation-slug>/STATE.md` from [`STATE-TEMPLATE.md`](STATE-TEMPLATE.md). It—not conversation history—is the coordination authority. Keep technical truth in source, tests, or maintained docs; persist invocation-only output under `artifacts/` or another durable authority. Recovery dependencies must remain accessible and usable from a fresh session; persist or absorb them before linking. Submit coordination state through repository version control when available; otherwise use harness durability and record the capability loss. When work modifies the repository, submit the code deliverable under repository conventions. Keep state and code submissions separate. Add a [`BRIEF-TEMPLATE.md`](BRIEF-TEMPLATE.md) only when state and pointers cannot recover an assignment. Briefs are optional scopes, not work items, trees, or lifecycles. Follow the template's [update boundary](STATE-TEMPLATE.md#update-boundary), including before interruption or delivery.

## Delegation boundary

Delegate active technical work to members. Members own investigation, design, implementation, tests, edits, and detailed validation. The coordinator owns framing, composition, dispatch, compact state, control-level comparison, direction, synthesis, user decisions, closure, and delivery. The coordinator may inspect detail for those duties but must not become the primary implementer, investigator, or sole detailed oracle.

With each artifact or observation, members return a compact proposed state update: status, accepted result, dependency impact, evidence pointer, and next action. The coordinator reads it first and consults the full artifact only as needed. This preserves compact recovery without forbidding necessary technical reading. When a member cannot write to the invocation directory, dispatch a mechanical write-proxy to persist its returned content verbatim; the proxy adds no analysis, and the coordinator does not become the writer.

Intervene directly only when delegation cannot serve a necessary action. Record the reason, scope, ownership impact, and return condition in `STATE.md`; restore delegation at that condition. Intervention does not change default ownership.

If provenance shows the coordinator became the primary author, investigator, or sole detailed oracle outside a recorded intervention, reassign that duty. If no member can take it, record the capability gap as a blocker.

## 1. Frame the work

State the user outcome, subject, expected deliverable, and relevant boundary. Before composing, decompose the outcome into its constituent coverage—the concrete deliverables, checks, and boundaries it demands; for feedback or a problem statement, decompose into {scope, root cause, core need}. "Smallest composition" governs member and attempt count, never scope: cover the full outcome with the fewest result-changing contributions, and shrink scope only with explicit user approval. Resolve before dispatch any interpretation that would change the work. Use [`PATTERNS.md` → Frame and orient](PATTERNS.md#frame-and-orient) when scope, interpretation, or authority is unclear.

**Complete when:** `STATE.md` records that frame with its constituent coverage, every unresolved interpretation that could change scope, and ground-truth pointers.

## 2. Compose the ensemble

Obtain the current role → model mapping before choosing members. Use one already supplied for this invocation; otherwise ask the user. Record its authority and lifetime in `STATE.md`. Never infer models from role names, treat the mapping as a harness capability, or persist it in distributed skill files.

Choose result-changing contributions. Prefer different models when the runtime mapping and suitable roles allow. Use role instructions and materially different assignments to give the ensemble approaches or failure lenses it would otherwise lack. Add redundancy when one stochastic miss would be costly. See [`PATTERNS.md` → Produce variation](PATTERNS.md#produce-variation) and its optional [starting compositions](PATTERNS.md#starting-composition-examples).

For each contribution, record the constituent coverage it owns, the artifact or observation expected, and the model, role, assignment difference, or named redundancy miss it should expose. For redundant contributions, record what repeats and the stochastic miss it protects against. Give independent code writers the same baseline without sibling changes; isolate their work or keep artifacts unapplied, then let one owner apply accepted changes.

**Complete when:** every required constituent is covered by the composition or retained in `STATE.md` as an explicit gap; each contribution is distinguishable or redundant against a named miss; more than one independent attempt remains; writers cannot interfere; and composition, baseline, ownership, and runtime mapping are current in `STATE.md`.

## 3. Dispatch and supervise production

Dispatch the shared subject and required ground truth without exposing sibling conclusions before each first independent attempt. Members return usable artifacts or concrete observations plus the compact state update defined above. After dispatch, wait on harness notification rather than re-querying members; intervene only to steer, cancel, or unblock a stuck member.

**Complete when:** every contribution has an artifact or observations linked from `STATE.md`, and each proposed state update is accepted or superseded.

When a member becomes unavailable:
- **Preserve** its composition row, mark it unavailable, and record the missing contribution.
- **Retry** only if the contribution, assignment assumptions, and configuration still fit.
- **Replace** when another member can independently supply the same contribution.
- **Recompose** when the contribution or its assumptions must change.
- **Degrade** only if Step 2 still holds and the omitted contribution cannot change the deliverable or an important decision.
- Otherwise, record the missing capability as a blocker.

## 4. Assess against ground truth

Assess outputs against the subject and ground truth. Read compact submissions first; consult full artifacts only to dispatch, resolve dependencies or blockers, assess, or deliver. Separate observations from inferences. A difference is decision-relevant if it can change the deliverable, verification, or a user-owned choice. Turn suspected failures and consequential disagreements into checks, not votes. Agreement is not evidence of sufficiency when members shared a shallow frame: when an output nominally satisfies its assignment but fails to support the constituent coverage (Step 1) it was composed to own, reframe, reassign for depth, or replace the member. Judge full-outcome coverage on the accepted set, not any single output. See [`PATTERNS.md` → Scrutinize and decide](PATTERNS.md#scrutinize-and-decide).

**Complete when:** every such difference is resolved by observation, retained in `STATE.md` as an unresolved choice or risk, or returned for targeted follow-up; and any output that fails to support its assigned constituent coverage is dispositioned. Use [reconciliation](PATTERNS.md#reconcile-by-observation) for disagreements and [finding disposition](PATTERNS.md#preserve-and-disposition-findings) for issues whose effect on current work remains to decide.

## 5. Direct evolution

Apply results to the deliverable: select and combine accepted work, then assign implementation, testing, repair, or documentation to members. Preserve useful work, recheck conclusions affected by revision, and keep non-obvious reasoning in its maintained owner. See [`PATTERNS.md` → Evolve and integrate](PATTERNS.md#evolve-and-integrate).

**Complete when:** the deliverable reflects every accepted result; each material finding is addressed or retained in `STATE.md`; and affected checks have been rerun or are recorded unavailable with consequences. Critical failed or unavailable checks block acceptance; non-critical gaps remain explicit risks.

## 6. Close or continue

Review planned contributions, material findings and disagreements, and checks affected by revision. Continue only with work that can plausibly change the deliverable or an important decision; update the plan before assigning it. See [`PATTERNS.md` → Continue, close, and hand off](PATTERNS.md#continue-close-and-hand-off).

**Complete when:** `STATE.md` dispositions cover every planned contribution, material finding or disagreement, and affected check; every critical failed or unavailable check blocks delivery; the user outcome is demonstrably satisfied against its full constituent coverage (Step 1); and no retained issue silently blocks it.

## 7. Synthesize and deliver

Return the requested artifact or decision. Surface unresolved choices, unavailable checks, and risks that affect its use. For repository changes, use [Submit a durable state](PATTERNS.md#submit-a-durable-state) before delivery. Before yielding, record the candidate, verification, dispositions, and delivery status in `STATE.md`.

**Complete when:** the deliverable is handed off with observed verification; no critical check blocks delivery; the decision owner can see every issue that could change its use; and a fresh coordinator can reconstruct the completed invocation from `STATE.md` and its pointers.
