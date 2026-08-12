# Ensemble Methodology

## Purpose

A single AI path shares one set of priors and blind spots. An ensemble introduces independent differences, checks their results against ground truth, and applies what they reveal to the deliverable.
The coordinator owns composition, assessment, direction, and delivery; members own assigned work and detailed observations. This boundary preserves useful independence.

The method applies to design, implementation, tests, research, review, repair, and delivery. These are overlapping applications, not modes or phases.

Evolution means the deliverable changes through repeated production and examination—not fixed generations, populations, or stall counters.

[`GLOSSARY.md`](GLOSSARY.md) defines terms; [`SKILL.md`](SKILL.md) is the execution contract.

## Sources of heterogeneity

Heterogeneity matters only when it can change an artifact, observation, or decision.

### Model

Different models may bring different priors, reasoning, capabilities, habits, and blind spots. Use genuine model differences for important independent attempts when available, but do not treat difference as proof: a narrow assignment can make different models repeat the same mistake.

### Role

A harness `role` can select a model, system prompt, tools, isolation, or other runtime behavior. Inspect the current harness and choose roles for the contribution they can actually perform; do not infer capability from a role name alone.

### Assignment

An assignment defines the current objective, scope, constraints, artifact, and completion criterion. It can direct different approaches, trade-offs, failure models, or observation methods, but cannot replace model or role diversity.

## What ensembles produce

An ensemble should produce work that can change the deliverable, not a pile of opinions. Contributions may include:

- competing or complementary designs;
- production changes;
- tests, reproductions, benchmarks, or discriminating prototypes;
- domain, correctness, security, lifecycle, migration, or performance findings;
- maintained comments, ADRs, and API docs;
- targeted repairs and verification;
- synthesis that applies accepted parts of several artifacts.

Reports carry observations and reasoning; they do not replace reading or running available ground truth.

## Observation before conclusion

Keep three statements distinct:

1. **Observation:** what was read, run, measured, or reproduced.
2. **Inference:** what those observations support.
3. **Decision:** what the work will do.

A concern is not evidence. If it could change the work, turn it into a hypothesis or check. A passing test supports only the behavior and conditions observed. Resolve consequential judgments by observation, not consensus.

## Common applications

Applications describe results, not workflows; they may overlap. When the outcome spans several, the frame must decompose coverage across all of them, not pick one. [`PATTERNS.md`](PATTERNS.md) supplies workflow fragments.

### Discover facts or map a surface

When paths, contracts, dependencies, owners, states, or impact boundaries are unknown, combine independent source, runtime, domain, and ecosystem tracing. Produce observation-backed facts, boundaries, unknowns, and next checks—not premature advice or inventories without connections.

### Run a bounded experiment

When one observation can test an assumption or distinguish approaches, run comparable prototypes, measurements, or falsification probes. Produce a direct answer; keep prototypes separate from production and avoid experiments that cannot distinguish outcomes.

### Form and validate a design

When feasible approaches have different consequences and no authority decides, compare designs, prototypes, constraints, and failure lenses. Produce an observed choice or explicit user-owned trade-off—not manufactured alternatives, prose voting, or untested assumptions.

### Deliver a feature, API, or behavior

Combine implementation, consumer use, edge analysis, tests, and independent review around an established contract. Deliver one integrated change with executable checks; fragments and separately passing branches are not delivery.

### Produce tests or independent verification

Build tests, fixtures, reproductions, measurements, oracles, boundary/property cases, stress schedules, compatibility fixtures, or benchmarks. They must exercise relevant states and fail on plausible defects without mirroring implementation assumptions or treating one pass as proof.

### Diagnose correctness or performance

Compare causal hypotheses through minimization, instrumentation, traces, schedule perturbation, or controlled measurement. Produce a reproduction and evidence-backed repair target. Do not vote on stories, patch speculatively, or alter the failure before observing it.

### Audit an existing artifact

Use risk-relevant, materially different lenses and add redundancy for costly misses. Produce deduplicated, observed findings with affected boundaries, unknowns, and dispositions—not repeated generic reviews, style noise, or consensus over reproducible defects.

### Repair and reverify

Combine root-cause repair, regression protection, blast-radius analysis, and independent recheck. Address accepted findings and rerun checks affected by changed behavior or assumptions; avoid symptom patches and original-example-only validation.

### Integrate, migrate, or compose

Trace producers, consumers, dispatch, contracts, compatibility, sequencing, rollout, and rollback. Produce one coherent change observed across combined, mixed-version, failure, and rollback states—not incompatible local patches or one-sided validation.

### Revise maintained docs or decisions

Check source/runtime facts, contradictions, alternatives, domain concerns, and reader needs. Produce maintained text whose claims, rationale, consequences, and unresolved choices match current ground truth—not polished false premises or documentation of an unmade decision.

The requested result selects the application. The same technical topic may require discovery, experiment, design, delivery, verification, diagnosis, audit, repair, composition, or documentation.

## Recommended practices

Use these practices only when their reason applies.

### Add redundancy for costly misses

Repeat an important lens when one stochastic miss would be costly. Heterogeneity broadens search; redundancy reduces dependence on one attempt. Add attempts only while they can change the work or confidence in a consequential judgment—never to reach a fixed population.

- **Same-configuration:** repeat model, role, assignment, and lens to reduce stochastic dependence.
- **Cross-model:** repeat the lens across models to expose model-specific blind spots.
- **Role-diverse:** repeat the concern through different initial instructions or capabilities.

Same-model repetition does not address model-specific blind spots.

### Keep the first pass independent

Let members form their own artifact or observations before seeing sibling conclusions. Share ground truth and required contracts; independence prevents anchoring, not access to facts.

### Wait on results, not polling

After dispatch, let the harness deliver results; re-querying members that have not reported gains no information. Intervene only to steer, cancel, or free a stuck member.

### Cross-check after independent production

When first-pass outputs differ consequentially, challenge the concrete claims or assign a targeted resolver. Seek observations that distinguish them.

### Preflight the composition

Name each distinct or intentionally redundant contribution before dispatch. Check models, role behavior, assignments, and tool fit; rename or remove isomorphic contributions.

### Match agent characteristics to the contribution

Use fast agents for breadth and cheap redundancy; deeper or cross-model agents for load-bearing design, difficult reconciliation, adversarial audit, or readiness; specialized roles where their instructions and tools fit. These are heuristics, not guarantees.

### Scale with consequence and uncertainty

Increase diversity, breadth, and redundancy when errors are costly, direct checks are weak, decisions are hard to reverse, or attempts disagree. Keep the ensemble small for direct, easily verified work.

### Persist compact state

Create `.ensemble/<NNN>-<invocation-slug>/STATE.md` from [`STATE-TEMPLATE.md`](STATE-TEMPLATE.md). Keep only the outcome, coverage, contributions, decisions, candidate, verification, and next action needed for recovery. Use a harness-provided state tool when available; technical truth remains in source, tests, maintained docs, and artifact pointers.

### Parallelize observation before modification

Independent research, design, and critique often parallelize safely. Give independent code alternatives separate baselines and accepted repository changes one owner. A repository-wide codemod by one owner is not concurrent writing.

### Validate the relevant state

Check the candidate that may be delivered. Exercise behavior implicated by accepted work and findings. An unavailable check is not a pass; name the unobserved boundary. After revision, rerun checks whose subject or assumptions changed.

### Preserve useful findings

Do not discard a finding because it is non-blocking. Record its relevance and impact, then use the repository's normal issue or decision mechanism when future value justifies maintenance. Disposition is separate from the finding's definition.

### Guard decision-relevant ambiguity

Investigate or ask when plausible meanings would change scope, assignments, composition, or validation. Ambiguity that could shrink scope to a convenient subset is decision-relevant—resolve it against the full coverage the outcome demands. Ignore harmless wording ambiguity.


### Demand material novelty

Another member or round earns its cost only through a new artifact, observation method, failure mechanism, prior, role behavior, or consequential challenge. Cosmetic variation does not advance the work.


## Unresolved questions

Preserve uncertainty and its consequences when observations cannot decide. Ask the user when the remaining choice is theirs. Use [`SKILL.md`](SKILL.md) closure criteria; do not invent fixed rounds or consensus thresholds.

## Harness integration

Use the strongest native capabilities the harness exposes: agent and model discovery, role-specific prompts and tools, isolated writers, direct artifacts, communication, notifications, and path-safe state tools. Do not recreate a missing capability through mandatory ceremony when an adapter can provide it directly.

The method still requires independent attempts, shared ground truth, assigned coverage, comparable artifacts or observations, and one accepted deliverable. If a harness lacks a useful capability, adapt the composition locally; do not turn that fallback into the portable method.

Version coordination state through repository VCS when available. Submit code under repository conventions and keep the two submissions separate.
