# Ensemble Glossary

Canonical terms. [`SKILL.md`](SKILL.md) defines behavior; [`README.md`](README.md) explains rationale and practice.

## Ensemble

Independent members applied to shared work so their combined output can exceed one path. Outputs may include designs, code, tests, research, critiques, verification, or revisions.

## Member

One independent attempt, defined by its agent, model, role, and assignment.

## Attempt

One independently produced contribution. Repeated runs of the same configuration are separate attempts if neither inherits the other's conclusions.

## Harness

The system that starts and coordinates agents and exposes models, roles, communication, isolation, and artifact mechanisms.

## Model

The AI model underlying a member, with its own priors, tendencies, capabilities, and blind spots.

## Role

A harness subagent category that may select a model, system prompt, tools, isolation, or other runtime behavior. Inspect the harness definition; do not infer capability from the role name alone.

## Assignment

Task-specific instructions for one attempt: objective, scope, constraints, expected artifact, lens, and completion criterion. An assignment differs from model and role instructions.

## Heterogeneity

A member difference capable of changing an artifact, observation, or conclusion. Sources include model, role, assignment, knowledge, approach, trade-off, failure model, or observation method.

## Redundancy

Independent attempts at the same contribution or lens. Heterogeneity broadens possible results; redundancy reduces dependence on one attempt.

## Subject

The shared object of work: a problem, design, code state, implementation, test strategy, document, or decision. Members may address it wholly or through explicit scopes.

## Artifact

A usable member output or change, such as source, tests, design, prototype, patch, or maintained documentation. A report is an artifact; the subject it describes remains distinct.

## Observation

Something actually read, run, measured, reproduced, or inspected: source behavior, command output, test, benchmark, trace, document text, or concrete counterexample.

## Inference

A conclusion drawn from observations and the reasoning connecting them.

## Evidence

Observations used to support or challenge a decision. Evidence identifies both what was observed and the state or conditions to which it applies.

## Ground truth

The authority against which outputs are checked for the current question: source, executed behavior, tests, measurements, explicit requirements, public contracts, or authoritative docs.

## Finding

A concrete issue, opportunity, contradiction, gap, or risk and why it may matter. Its disposition is a separate decision.

## Disagreement

A decision-relevant difference among members' observations, inferences, artifacts, or recommendations.

## Revision

A change to the subject or artifact in response to work, observations, findings, or decisions: selection, synthesis, implementation, testing, repair, clarification, documentation, or rejection.

## Evolution

Improving the actual work through repeated production, comparison, revision, and re-examination—independent of fixed rounds or design/implementation order.
