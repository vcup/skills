# Ensemble Glossary

Canonical terms. [`SKILL.md`](SKILL.md) defines behavior; [`README.md`](README.md) explains rationale and practice.

## Ensemble

A method that uses independent, materially different or intentionally redundant attempts to improve one complete deliverable through evidence-based selection, revision, and verification.

## Invocation

One ensemble effort toward a complete requested outcome, with its scope, attempts, judgments, and completion criteria. It may continue across interruptions or changes of participants.

## Candidate

The specific version of the proposed deliverable under assessment. Checks and acceptance judgments apply to that version and their stated conditions.

## Reflection

A proposed account of how evidence changed a judgment or method, including its limits and next test. Reviewing that account and establishing a reusable lesson are separate judgments.

## Member

A native agent participating in the ensemble, whether newly started, forked with inherited context, or continued from earlier work. A member may contribute to several attempts; its identity or harness label does not establish independence or collaboration capabilities.
_Avoid_: Teammate as a separate ensemble agent type; subagent as necessarily disposable.

## Attempt

A bounded effort on a stated question and input baseline that produces an assessable contribution. Independence depends on the conclusions and reasoning available before its initial result, not on a new name or task number.

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

## Challenge

A recorded objection to a specific judgment, supported by contrary evidence and an explanation of its impact. Its resolution may uphold, revise, or replace that judgment while preserving the earlier account.

## Disagreement

A decision-relevant difference among members' observations, inferences, artifacts, or recommendations.

## Revision

A change to the subject or artifact in response to work, observations, findings, or decisions: selection, synthesis, implementation, testing, repair, clarification, documentation, or rejection.

## Evolution

Improving actual work through repeated production, comparison, revision, and re-examination, without fixed rounds or a prescribed design/implementation order.

## Lead

The participant accountable for the complete outcome, composition, coaching, consequential decisions, and integration. Direct work remains available, while its primary responsibility is enabling and evaluating working members' contributions.
_Avoid_: A mandatory non-producing dispatcher, an infallible oracle.

## Contribution

An artifact or observation that an attempt supplies for assessment and possible use in the deliverable. Returned, accepted, and verified describe different judgments.

## Coaching

Evidence-based adjustment of a member's instructions, examples, or working method, followed by an opportunity to apply the change. It does not imply training model weights or establishing general competence.
_Avoid_: Weight training, successful instruction merely because it was acknowledged.

## Coordination checkpoint

A compact account of the current goal, contributions, decisions, candidate, verification, and next action. It supports recovery but is not the authority for native agent execution.

## Work history

The retained succession of recorded changes and their attributed actions. Order alone does not explain why a judgment changed.

## Evolution reading

An evidence-linked account of important changes in understanding or method, their causes, and lessons for later readers. It may synthesize parallel work and remains distinct from a current specification or an activity list.
_Avoid_: Every tool call retold as a story, a claim of exact reconstructed chronology.

## Lesson

Reusable guidance connecting a triggering situation to an action, supporting evidence, limitations, and conditions that would invalidate it. A proposed lesson and a demonstrated improvement are different states of knowledge.

## Learning domain

A subject with a coherent question set and audience for reviewing and reusing experience. A cross-domain finding can have one primary account and distinct consequences elsewhere.
_Avoid_: One domain per folder or per member.
