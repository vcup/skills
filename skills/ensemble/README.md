# Ensemble Methodology

## Purpose

A single AI path shares one set of priors and blind spots. An ensemble introduces independent differences, checks their results against ground truth, and applies what they reveal to the deliverable.
The Lead owns composition, assessment, coaching, direction, and delivery; members own assigned work and detailed observations. Prefer a Lead capable of difficult judgment and instruction, concentrating its effort on enabling and improving members' work. It may still investigate or implement directly when this resolves a bottleneck or informs a consequential decision.

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

An assignment defines the current objective, scope, constraints, artifact, and completion criterion. Different directions, methods, tools, or evidence sources can create useful heterogeneity even with the same model. They do not establish different model priors or remove shared model blind spots.

### Environment and actual selection

Concrete providers, models, supported reasoning-effort values, access policy, endpoints, and credentials belong to the deployment, not this repository. Inspect native discovery and exact-route authorization. Select each member through the actual provider/model/effort fields where supported; distinguish a requested setting, a creation record, and the actual request configuration. A prompt asking for deeper thought changes instructions, not the configured effort.

Keep local role-to-route preferences outside the product repository. A preference is not an authorization grant or a guarantee of model quality; refresh capability checks when the environment changes. Credentials remain with the harness credential owner and never enter a learning archive.

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

Same-model repetition retains a shared model factor. Different methods may reveal its errors, but repetition or agreement alone cannot establish that shared blind spots are absent.

### Keep the first pass independent

Let members form their own artifact or observations before seeing sibling conclusions. Share ground truth and required contracts; independence prevents anchoring, not access to facts.

### Choose how to drive native agents

A member is a participating native agent. Harness labels such as `subagent` and `teammate` do not define separate ensemble roles. Choose context and collaboration capabilities separately; creating a fresh agent need not make it one-shot, and continuing an agent does not require a special teammate type.

| Need | Useful context choice | Trade-off to check |
|---|---|---|
| Unanchored first pass, competing design, independent test, or narrow source lookup | Fresh agent with a self-contained task packet | Reduces inherited conclusions and irrelevant history; omitted requirements or leading prompts can still spoil the attempt |
| Branch from rich, relevant investigation already completed by the Lead | Fork the completed context | Preserves evidence and constraints with less handoff loss; also inherits bias and context load, and may omit the current in-flight turn |
| Repair an artifact, apply coaching, or follow up on a local finding | Continue the existing agent | Preserves tacit knowledge and working method; verify current facts and do not count it as a new independent sample |
| Existing context is crowded, stale, or anchored | Fresh replacement with selected evidence and explicit handoff | Provides focus and a new reasoning path; reconstruct necessary inputs and ownership without claiming a blind review if answers were supplied |
| Multi-step shared work with dependencies or handoffs | Any suitable context choice plus native shared-task capabilities | Verify board access, claim/update authority, peer messaging and notifications; none follows from fresh/fork/reuse alone |

Match the task to the context before assigning or claiming it. A free member may hold unrelated history, stale assumptions, or the very answer an independent check must avoid. Conversely, prior source tracing, relevant constraints, and an established working method can make continuation valuable. Compare that benefit with context load, anchoring, and the cost of rebuilding the needed background; shared subject matter alone does not establish fit. Use the task, known prior work, and early artifacts as evidence rather than assuming the Lead can inspect every hidden influence. Unrelated earlier work does not itself invalidate an independent first attempt on a new question; continuing the same judgment after seeing answers remains a continuation, not a new sample.

Fresh creation is a normal composition choice, not a last resort after every existing member is unsuitable. The Lead may create a member specifically for a task, add an independent fresh reviewer alongside a knowledgeable continuing member, or keep a fresh member for later coaching. Reassess when the task changes or an early artifact reveals mismatch. A brief reason belongs in the existing attempt plan when consequential; this does not require an automatic matching score, permanent role roster, or new bookkeeping format.

Separate retained conversation from shared task information. A fresh member can access the same authorized board and evidence without inheriting another member's dialogue. Supply its objective and task/reference identifiers; have it read the full current task, relevant dependencies, constraints, and source baseline before claiming or acting. Claiming establishes ownership, not understanding or automatic context injection. Make all necessary task information retrievable without dumping every task or sibling conclusion into the first-pass prompt. Existing members must refresh that information too. If the task is already owned, use the native release/reassignment rules and notify the affected members; creating another agent does not transfer ownership.

Choose the model and supported execution backend for the assignment as well: bounded lookup often suits a fast model; difficult judgment may need another route. Use fresh agents and explicit task packets for cross-model work; fork preserves the provider/model, because reasoning records and other context may not transfer intact across models. If same-route effort adjustment is supported, state the prior and target levels, whether the change raises or lowers effort, and why; report an unknown direction when the route's ordering or prior value is unknown. Follow the [heterogeneity guidance](#sources-of-heterogeneity): effort is one difference, not a guarantee of quality or independence. Check actual selection fields, tool access, persistence, and continuation support before dispatch. Do not silently substitute a default model when a required route cannot be selected. Fresh context can reduce input load, but total latency and cost also include reconstruction, caching, and follow-up; measure rather than promise savings.

Where communication is supported, keep sibling conclusions out of independent first passes and use direct exchange for later cross-review and integration. Messages, shared task descriptions, and shared files can all expose answers. If peer messaging or the board is unavailable, use Lead-mediated handoffs or bounded parallel assignments only where they satisfy the work; record the missing capability when they do not. Never simulate a native task claim or infer archive permission from communication rights.

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

### Coach a working method, then test transfer

Before dispatch, supply a usable task packet and an early reviewable slice rather than only a broad role. General methods and common facts can be shared before independent production; the Lead's preferred conclusion and sibling reasoning cannot. If concrete answers become necessary for repair, share them and label the result as guided revision rather than preserving a false claim of independence.

After observing an error, identify the failing step, teach a bounded correction, and ask the member to apply it to an unseen neighboring case. Repeating the taught example establishes only that repair. For consequential learning claims, include a case where the lesson should not apply and a non-author check against independent authority. Escalating effort or replacing a model is one intervention, not a substitute for diagnosing poor inputs, unavailable tools, or an unclear completion condition.

The Lead's own guidance can create a shared blind spot. Preserve an evaluation path that has not inherited the disputed answer, and judge the coaching intervention with the same evidence discipline as member output. No fixed coaching ceremony or task-wide broadcast is required.

### Persist coordination through its owner

In plugin-managed mode, use domain tools to open work, record contributions and decisions, and associate verification with the candidate. The program maintains the compact [`STATE-TEMPLATE.md`](STATE-TEMPLATE.md) view and version history outside the workspace. Models do not rewrite generated Markdown or run archive Git commands. Native agent/task state remains owned by the harness.

For skill-only use, keep the equivalent checkpoint in a separate, locally excluded records area. Current OMP's `ensemble_state` only writes its allowed workspace path; it does not provision an external archive or commit history. Do not claim managed storage where no adapter provides it.

### Produce readings worth revisiting

A checkpoint answers what matters now; work history records changes; an evolution reading explains what evidence changed understanding and what later readers can learn. [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md) defines its causal questions, sequential ordering without narrative timestamps or work durations, review, corrections, and domain splitting. With managed archive support, the adapter manages identities, source links, publication, and generated documents. Otherwise, the Lead maintains the isolated records and review status; the Lead and reviewers assess whether the evidence supports the interpretation.

Record material turns, including failed approaches and limits, rather than narrating every tool call. Retrieve relevant lessons by problem and applicability, inspect their evidence, and test whether they still hold. A fresh context given a prior answer is not an independent evaluation of that answer. Promote a durable method change to this repository only after review; keep environment-specific advice and frequent drafts in the isolated archive.

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

Product source, maintained contracts, and reviewed reusable method changes follow product repository conventions. Concrete environment configuration, frequent coordination changes, learning drafts, and evolution readings have a separate storage and history owner; separate commits in the same repository are insufficient isolation. The repository's [DSH design](https://github.com/vcup/skills/blob/main/docs/ensemble/README.md) specifies domain tools and an entirely out-of-workspace archive. Those adapter documents are maintained separately from the portable skill; use only managed capabilities actually exposed by the current harness.
