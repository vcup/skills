# Ensemble Workflow Patterns

Optional workflow verbs—not phases, prerequisites, or legal transitions. Chain, nest, repeat, fuse, or omit them according to what can next change the work. [`SKILL.md`](SKILL.md) defines execution, [`GLOSSARY.md`](GLOSSARY.md) terms, and [`README.md`](README.md) rationale and applications.

## Use the catalog

1. Start from the deliverable and subject; signals suggest but never gate.
2. Choose the smallest pattern that can produce the next useful artifact or observation.
3. Branch for independent production; join before interacting decisions or writes.
4. After material change, revise stale contributions and recheck only affected work.
5. Repeat only for an unresolved finding, distinct lens, stale observation, changed assumption, or owner decision.

Cards state **Intent**, **Shape**, **Signals**, **Scale**, **Combinations**, **Output**, and **Failures**. [Provenance](#pattern-provenance) records why patterns remain.

## Find a pattern

| Current need | Start here |
|---|---|
| Scope, terminology, authority, or relevant surface is unclear | [Frame and orient](#frame-and-orient) |
| Produce independent alternatives, implementation, experiments, or redundancy | [Produce variation](#produce-variation) |
| Create independent tests, audit risks, inspect boundaries, or resolve disagreement | [Scrutinize and decide](#scrutinize-and-decide) |
| Repair, preserve findings, compose changes, validate, or maintain rationale | [Evolve and integrate](#evolve-and-integrate) |
| Decide readiness, probe assumptions, ask the user, recover, submit, or deliver | [Continue, close, and hand off](#continue-close-and-hand-off) |
| See how fragments can combine without becoming a fixed workflow | [Composition examples](#composition-examples) |
| Redirect after new observations change the work | [Adapt after observations](#adapt-after-observations) |


## Starting-composition examples

These sketches are neither exhaustive nor normative. Start composition with [`SKILL.md`](SKILL.md) Steps 1–3; let cards and observations govern later action. Member count and role/model choices remain contextual.

| Situation | Possible composition |
|---|---|
| Direct delivery | One owned production contribution plus another independent attempt whose artifact or observation can check or complement it. |
| Open review or design | Materially different assignments or risk lenses; redundancy only for costly misses. |
| Interrupted recovery | Recover state and authority, refresh stale observations, then recompose missing or stale contributions. |

For research, documentation, or decisions without executable artifacts, use materially different assignments and independent surface mapping rather than forcing an implementation-and-oracle shape.

# Frame and orient

## Frame the consequential question

- **Intent:** Align the subject, requested deliverable, observable success, ambiguity that would change the work, and the full constituent coverage the outcome demands. When the input is feedback or a problem statement, decompose it into {scope, root cause, core need} to turn it into required work.
- **Shape:** request + ground truth → decompose into constituent coverage → shared frame → next consequential question.
- **Signals:** agents may act on different subjects; design-only versus implementation is unclear; acceptance is implicit; a term has several consequential meanings; the outcome spans several application types.
- **Scale:** one sentence for direct work; a short boundary/non-goal map for several closable outcomes. Decompose only as far as needed to prevent scope-shrink; never build a work-breakdown tree.
- **Combinations:** any pattern, especially `Map the surface`, `Compete alternatives`, and `Ask the decision owner`.
- **Output:** shared subject, deliverable, relevant boundary, pinned interpretation or unresolved choice, and the constituent coverage the ensemble must satisfy.
- **Failures:** a requirements ledger; clarifying harmless wording; silently selecting one plausible interpretation; shrinking scope to a convenient subset—"smallest composition" governs member count, never outcome completeness.

## Resolve an alternate interpretation

- **Intent:** Test plausible meanings that would alter scope, ensemble composition, or validation.
- **Shape:** enumerate plausible meanings → trace their consequences → consult authority or user → pin meaning and revise work.
- **Signals:** overloaded domain or language term; conflicting conventions; interpretations imply different audit surfaces.
- **Scale:** one coordinator check; independent domain research when authoritative usage is unclear.
- **Combinations:** `Frame the consequential question`, `Map the surface`, `Preserve and disposition findings`.
- **Output:** resolved meaning and its concrete effect on assignments or checks.
- **Failures:** majority vote; glossary ceremony; recording ambiguity without changing the plan.

## Map the surface

- **Intent:** Establish what is relevant before committing scope, ownership, or validation.
- **Shape:** independent repository/domain investigations → combine observations → map callers, boundaries, contracts, dependencies, states, and unknowns.
- **Signals:** unfamiliar area; changed files omit effects; annotations, comments, dependencies, ADRs, lifecycle, or runtime state may matter.
- **Scale:** one caller trace locally; heterogeneous source/runtime/contract/ecosystem searches broadly.
- **Combinations:** `Fan out independent contributions`, `Trace authority and state`, `Walk a risky boundary`.
- **Output:** observation-backed surface map and bounded next checks.
- **Failures:** link inventory; recommendations before facts; treating changed files as the whole audit surface.

## Trace authority and state

- **Intent:** Identify the authority, scope, lifetime, current candidate, intended delivered state, and stale material for consequential facts.
- **Shape:** candidate facts/sources/revisions → classify authority and scope → trace consumers/dispatch → identify observed/intended state, lifetime, and stale observations.
- **Signals:** conflicting docs/source; user-specific configuration; invocation-only input; abandoned files; several patches; long-running work; validation may target another revision.
- **Scale:** one source/scope pointer locally; producer-consumer/state map across boundaries. Avoid automatic invalidation graphs.
- **Combinations:** `Validate the intended state`, `Join across boundaries`, `Recover from a checkpoint`, `Preserve durable reasoning`.
- **Output:** authoritative baseline plus each consequential fact's owner, scope, lifetime, affected boundaries, and stale/unobserved states.
- **Failures:** promoting user configuration to harness capability; distributing invocation-only facts; trusting summaries; validating a stale revision; forcing every reviewer to reconstruct history.

# Produce variation

## Fan out independent contributions

- **Intent:** Broaden production or observation before sibling conclusions anchor the ensemble.
- **Shape:** common subject/ground truth + materially different or intentionally redundant assignments → independent outputs → join.
- **Signals:** real alternatives; distributed facts; multiple failure models; one path offers narrow coverage.
- **Scale:** one extra perspective through several model/role/assignment differences; add only result-changing contributions.
- **Combinations:** `Add redundancy`, `Compete alternatives`, `Audit through risk lenses`, `Reconcile by observation`.
- **Output:** comparable independent artifacts or observations with visible differences.
- **Failures:** cosmetic labels; withholding ground truth; collecting without comparison; independent writers observing sibling changes.

## Add redundancy

- **Intent:** Reduce dependence on one stochastic attempt for an important contribution or lens.
- **Shape:** same consequential contribution → independent repeated attempts → compare misses and common results.
- **Signals:** costly miss; subtle concurrency/security/unsafe/lifecycle behavior; unstable outputs; a prior single attempt missed a defect.
- **Scale:** add attempts while another can materially change the work or confidence; never use a fixed population.
- **Combinations:** `Fan out independent contributions`, `Build an independent oracle`, `Audit through risk lenses`.
- **Output:** repeated independent artifacts or observations on one lens, including disagreements.
- **Failures:** calling redundancy heterogeneity; shared blind spots; counting agreement as proof.

## Compete alternatives

- **Intent:** Distinguish genuinely feasible approaches by observable consequences.
- **Shape:** common load-bearing question → independent alternatives → challenge assumptions → select, combine, or preserve a user choice.
- **Signals:** two or more choices survive constraints; consequences differ; prose cannot settle a key assumption.
- **Scale:** two designs; add prototypes or an independent assessor only for consequential uncertainty.
- **Combinations:** `Run a tracer experiment`, `Reconcile by observation`, `Probe a shared assumption`, `Implement under clear ownership`.
- **Output:** grounded choice, synthesis, or explicit unresolved trade-off.
- **Failures:** manufactured alternatives; voting; treating design support as implementation health.

## Run a tracer experiment

- **Intent:** Answer one discriminating question before broad commitment.
- **Shape:** question + possible outcomes → common observation method → bounded prototype/experiment → answer or refutation.
- **Signals:** one assumption carries the design; alternatives need measurement; a prototype can cheaply reduce uncertainty.
- **Scale:** smallest experiment that distinguishes outcomes; several comparable attempts when model variance matters.
- **Combinations:** `Compete alternatives`, `Build an independent oracle`, `Probe a shared assumption`.
- **Output:** direct observation or measurement, with prototype clearly separate from production.
- **Failures:** experiment unable to distinguish outcomes; polishing prototype into architecture; treating refutation as failure.

## Implement under clear ownership

- **Intent:** Apply accepted work to the real deliverable without writer interference.
- **Shape:** bounded contract + common baseline → owned modification → identifiable intended state.
- **Signals:** production code/tests/docs requested; repair accepted; several implementation slices proposed.
- **Scale:** one owner normally; isolated parallel slices only when independence and composition are credible.
- **Combinations:** `Preflight and reassess ownership`, `Build an independent oracle`, `Validate the intended state`.
- **Output:** integrated source, tests, or maintained artifact tied to a baseline.
- **Failures:** fragments presented as delivery; file-disjoint assumed behavior-disjoint; concurrent shared-worktree writers.

## Preflight and reassess ownership

- **Intent:** Decide whether implementation slices remain safe to run independently as knowledge changes.
- **Shape:** inspect files, symbols, contracts, tests, config, dependencies, generated output, global/lifecycle assumptions → isolate, repartition, or serialize → reassess after new coupling.
- **Signals:** multiple writers; initially disjoint tracks; changed shared interface; composition cost rising.
- **Scale:** pairwise check for a few slices; delegated overlap mapping for many.
- **Combinations:** `Map the surface`, `Implement under clear ownership`, `Join across boundaries`.
- **Output:** ownership/isolation plan and any parallel-to-serial fallback.
- **Failures:** one-time preflight treated as permanent; file-only analysis; coordinator manually merging technical details.

# Scrutinize and decide

## Build an independent oracle

- **Intent:** Produce observations not selected solely by the artifact producer.
- **Shape:** observable contract + plausible bug → independent test/reproduction/benchmark/trace → run on intended state → retain oracle and findings.
- **Signals:** producer chose all checks; subtle state/performance/compatibility; implementation and tests may share assumptions.
- **Scale:** one boundary test through heterogeneous property/stress/compatibility attempts and redundancy.
- **Combinations:** `Walk a risky boundary`, `Repair and re-examine`, `Validate the intended state`.
- **Output:** maintained executable observation capable of failing on a plausible defect.
- **Failures:** copying implementation logic; tautological tests; test plan without execution; unavailable check called pass.

## Audit through risk lenses

- **Intent:** Search a nominally complete artifact for consequential defects across materially different failure models.
- **Shape:** choose risk-relevant lenses → independent first pass → deduplicate and validate findings.
- **Signals:** readiness judgment; high consequence; broad audit surface; ordinary success-path checks are narrow.
- **Scale:** correctness/domain baseline plus security, lifecycle, performance, migration, operability, unsafe/FFI, dependencies, annotations, comments, or maintainability as risk suggests; add redundancy for costly misses.
- **Combinations:** `Fan out independent contributions`, `Walk a risky boundary`, `Cross-critique concrete claims`, `Preserve and disposition findings`.
- **Output:** evidence-backed findings, affected boundaries, and unknown coverage.
- **Failures:** fixed auditor matrix; synonymous lenses; style notes replacing defects; reports replacing source.

## Walk a risky boundary

- **Intent:** Expose failures hidden by local correctness at entry, dispatch, lifecycle, failure, compatibility, and rollback boundaries.
- **Shape:** change/claim → trace both sides and relevant states → exercise re-entry/failure/mixed states → observations and gaps.
- **Signals:** ABI/schema/API boundary; concurrency/lifecycle; migration; producer-consumer; happy-path-only evidence.
- **Scale:** one consumer trace locally; producer × consumer × old/new × failure/rollback matrix for migration.
- **Combinations:** `Map the surface`, `Build an independent oracle`, `Join across boundaries`, `Repair and re-examine`.
- **Output:** boundary/dispatch map, reproductions, and unobserved states.
- **Failures:** emitter-only validation; one schedule as proof; generic “edge case” review.

## Reconcile by observation

- **Intent:** Resolve consequential disagreement without voting or a universal evaluator.
- **Shape:** concrete difference → distinguishing check → observe → uphold, weaken, overturn, or retain unresolved.
- **Signals:** reports conflict; source/docs conflict; reports are suspiciously isomorphic; high-impact judgment has weak support.
- **Scale:** direct check; targeted cross-critique; resolver or independent assessor only for concrete remainder.
- **Combinations:** `Fan out independent contributions`, `Cross-critique concrete claims`, `Ask the decision owner`.
- **Output:** evidence-backed disposition or explicit unresolved choice/risk.
- **Failures:** majority vote; free-form debate; report overruling reproduction; mandatory evaluator ceremony.

## Cross-critique concrete claims

- **Intent:** Let independent critics challenge important first-pass claims after anchoring-resistant production.
- **Shape:** independent reports → exchange only consequential claims → classify upheld/weakened/overturned/unresolved → target remaining dispute.
- **Signals:** concrete disagreement; high-risk unsupported claim; isomorphic first-pass reports; direct check not yet available.
- **Scale:** one focused exchange; another pass only for a newly exposed distinct issue.
- **Combinations:** `Audit through risk lenses`, `Reconcile by observation`, `Probe a shared assumption`.
- **Output:** challenged claims with a smaller unresolved set.
- **Failures:** cross-critique before independent pass; universal second round; free-form debate.

# Evolve and integrate

## Repair and re-examine

- **Intent:** Root-cause an accepted finding and refresh affected observations.
- **Shape:** finding → cause and blast radius → revision + regression oracle → independent re-examination → rerun affected checks.
- **Signals:** concrete defect; oracle failure; boundary contradiction; implementation health blocks delivery.
- **Scale:** local loop; expand when observations expose a shared assumption; repeat until fixed or explicitly blocked.
- **Combinations:** `Build an independent oracle`, `Walk a risky boundary`, `Validate the intended state`, `Preserve durable reasoning`.
- **Output:** repaired artifact, regression protection, current findings and observations.
- **Failures:** symptom patch; global restart; green tests erase defect; assuming every effect is local.

## Preserve and disposition findings

- **Intent:** Keep useful issues and opportunities visible while deciding their effect on current work separately.
- **Shape:** finding + relevance/impact → fix, defer, accept, reject, or ask owner → persist through normal repository mechanism when useful.
- **Signals:** non-blocking improvement; uncovered boundary; reviewer suggestion; scope decision; residual risk.
- **Scale:** inline disposition; issue/decision record when later value justifies maintenance.
- **Combinations:** `Audit through risk lenses`, `Repair and re-examine`, `Ask the decision owner`, `Recover from a checkpoint`.
- **Output:** finding with explicit disposition and durable location when warranted.
- **Failures:** hiding improvements because non-blocking; every suggestion expands mission; glossary definition dictates policy.

## Join across boundaries

- **Intent:** Compose independently produced or cross-system changes into one coherent state.
- **Shape:** trace all endpoints/dispatch → establish shared contract/sequence → apply owned slices → observe combined, mixed, migration, and rollback states.
- **Signals:** producer-consumer; ABI/schema/version; multiple patches; external revision; migration/rollout.
- **Scale:** ordinary combined verification; named integration contribution when reconciliation/ownership is substantial.
- **Combinations:** `Trace authority and state`, `Preflight and reassess ownership`, `Walk a risky boundary`, `Validate the intended state`.
- **Output:** one all-sided revision with compatibility and sequencing observations.
- **Failures:** local commits treated as integration; validating one endpoint; universal Integration phase.

## Validate the intended state

- **Intent:** Establish what the candidate intended for delivery demonstrably does against the identified revision, and expose unobserved boundaries.
- **Shape:** discriminating check → relevant build/test/static/runtime/benchmark/failure/lifecycle/ABI/migration checks → observations + unavailable gaps.
- **Signals:** implementation/repair complete; candidate changed; checks ran on another snapshot; delivery judgment approaching.
- **Scale:** consequence and uncertainty, not “minimum targeted” or “always full suite.”
- **Combinations:** `Trace authority and state`, `Build an independent oracle`, `Join across boundaries`, `Submit a durable state`.
- **Output:** current observations tied to intended revision and unavailable checks with consequences.
- **Failures:** commit/green suite/confidence as proof; stale observations after candidate change; unavailable called pass; critical unavailable treated as non-blocking; endless unbounded checking.

## Preserve durable reasoning

- **Intent:** Put non-obvious rationale in its maintained owner.
- **Shape:** accepted reasoning → code structure/name/test/comment/ADR/API doc or pointer → consistency check.
- **Signals:** safety invariant; lifecycle constraint; decision consequence; future edits depend on reasoning.
- **Scale:** nothing for obvious work; update existing owner; disclose reference only when branching or sprawl earns it.
- **Combinations:** `Repair and re-examine`, `Join across boundaries`, `Recover from a checkpoint`.
- **Output:** current maintained rationale.
- **Failures:** duplicate source/status/report reasoning; mandatory documentation; stale comments.

# Continue, close, and hand off

## Check three-way readiness

- **Intent:** Keep exploration support, implementation health, and delivery readiness from substituting for each other.
- **Shape:** assess design/question stability + open implementation findings/current checks + requested deliverable/remaining decisions → continue, repair, ask, block, or deliver.
- **Signals:** design appears settled; tests are green; audit found defects; long work approaches closure.
- **Scale:** inline check for direct work; explicit compact acceptance map when several areas close independently.
- **Combinations:** `Repair and re-examine`, `Validate the intended state`, `Ask the decision owner`, `Deliver and synthesize`.
- **Output:** readiness decision grounded separately on the three concerns.
- **Failures:** stall equals done; design validity erases bugs; green implementation misses mission; ledger creep.

## Probe a shared assumption

- **Intent:** Apply bounded novelty when lenses collapse or alternatives oscillate without new observations.
- **Shape:** name shared assumption → orthogonal attempt must produce counterexample, falsifiable risk, new method, or material alternative → compare → redirect only on evidence.
- **Signals:** repeated low-information attempts; synonymous alternatives; rejected option returns without new evidence.
- **Scale:** one probe; repeat only for a newly exposed distinct assumption.
- **Combinations:** `Compete alternatives`, `Cross-critique concrete claims`, `Reconcile by observation`.
- **Output:** decision-changing observation/alternative or explicit no-change result.
- **Failures:** automatic disruptor; rhetoric; unbounded reset; probe bypasses assessment.

## Ask the decision owner

- **Intent:** Surface a consequential choice or residual risk that observations cannot decide for the user.
- **Shape:** unresolved alternatives/gap + observed consequences → concise owner choice → update deliverable and checks.
- **Signals:** values/trade-offs; unavailable decisive evidence; scope change; risk acceptance; inconclusive search.
- **Scale:** one concrete question with real alternatives; avoid delegating tool-discoverable facts.
- **Combinations:** `Frame the consequential question`, `Reconcile by observation`, `Preserve and disposition findings`, `Check three-way readiness`.
- **Output:** explicit user/owner decision and its consequences.
- **Failures:** agent accepts user-owned risk; artificial A/B questions; asking before exhausting accessible evidence.

## Recover from a checkpoint

- **Intent:** Resume from ground truth without conversation memory.
- **Shape:** read invocation state → inspect current candidate and evidence → refresh stale observations → resume the next useful pattern.
- **Signals:** interruption, handoff, or resumed session.
- **Scale:** one compact `.ensemble/<NNN>-<invocation-slug>/STATE.md` plus source and artifact pointers.
- **Combinations:** all patterns, especially `Trace authority and state`, `Preserve and disposition findings`, and `Check three-way readiness`.
- **Output:** current outcome, coverage, contributions, decisions, candidate, verification, and next action.
- **Failures:** conversation as technical memory; work ledger; copied reports; append-only event log; stale state outranking source.

## Submit a durable state

- **Intent:** Keep coordination state recoverable and submit the code deliverable under repository conventions without interleaving their history.
- **Shape:** validate candidate → version coordination state → submit code → record delivered candidate and observations.
- **Signals:** repository modification, handoff, interruption, or delivery.
- **Scale:** use repository conventions; read-only subject work needs no code submission.
- **Combinations:** `Implement under clear ownership`, `Validate the intended state`, `Recover from a checkpoint`, `Deliver and synthesize`.
- **Output:** identifiable state and code submissions tied to observed verification.
- **Failures:** commit treated as correctness; universal follow-up-commit policy; bypassed checks hidden; state unrecoverable; state and code interleaved.

## Deliver and synthesize

- **Intent:** Apply accepted contributions and hand off the requested artifact or decision in usable form.
- **Shape:** accepted artifacts/findings/observations → integrate real deliverable → identify verification and unresolved choices → hand off.
- **Signals:** internal work complete; several artifacts need synthesis; user expects code/tests/docs/decision rather than reports.
- **Scale:** concise delivery; final synthesis artifact only for genuinely long, multi-contribution work.
- **Combinations:** `Check three-way readiness`, `Submit a durable state`, `Preserve durable reasoning`.
- **Output:** actual requested deliverable, observed verification, and visible remaining issues.
- **Failures:** final report substitutes for code; mandatory archive; unresolved risk hidden; perfect history prioritized over delivery.

# Composition examples

Examples demonstrate composition syntax and common redirections. They are not normative scenario definitions or fixed workflows.

## Direct change

`Frame → Implement → Independent oracle or audit as risk suggests → Repair* → Validate → Submit/Deliver`

## Design into production

`Frame → Map surface → Fan out/Compete → Tracer experiment? → Reconcile → Implement → Oracle + Boundary walk → Repair* → Validate → Deliver`

## Hard bug or regression

`Frame/reproduce → Fan out causal hypotheses → tracer instrumentation → Reconcile → Repair → regression oracle → Validate → Deliver`

## Audit and fix-up

`Trace authority → Fan out risk lenses + Redundancy? → Audit/Boundary walk → Cross-critique? → Reconcile → Preserve/disposition → Repair* → Validate`

## Green tests but observable defect

`Frame → Build an independent oracle (reproduction) → Walk a risky boundary (lifecycle/concurrency) → Fan out risk lenses + Redundancy? → Reconcile → Repair + regression oracle → Probe a shared assumption? → Check three-way readiness → Validate intended state → Preserve findings → Deliver`

Example: tests pass, but hot reload deadlocks. Observation-driven redirection: reproduction blocks delivery and redirects to audit; audit finds a shared assumption and redirects to a bounded blast-radius probe; the probe bounds the defect, so work returns to repair and delivery. Three-way readiness keeps green tests (implementation health), stable design, and unresolved deadlock (delivery not ready) distinct. Existing tests stay green; repair targets the cause without restarting unrelated work.

## Migration or ABI change

`Frame → Map surface/Trace authority → Compete contract? → Preflight ownership → Implement slices → Join → Boundary walk + Oracle → Repair* → Validate mixed/rollback states → Deliver`

## Documentation or ADR

`Frame → Trace source/runtime/rationale → Fan out domain/reader lenses? → Reconcile contradictions → revise → validate claims → Preserve findings → Deliver`

## Long-running delivery

`Frame → compact checkpoint → repeatedly choose the smallest result-changing composition → update checkpoint at meaningful transitions → recover from ground truth → Three-way readiness → Deliver`

# Adapt after observations

Classify what changed and redirect minimally:

- meaning or scope changed → `Resolve an alternate interpretation` and reframe;
- relevant surface grew → `Map the surface`;
- source/revision authority changed → `Trace authority and state` and refresh stale observations;
- local defect → `Repair and re-examine`;
- shared assumption failed → broaden with `Walk a risky boundary` or revisit the affected choice;
- reports disagree → `Reconcile by observation`, then cross-critique only if needed;
- producer-selected checks are weak → `Build an independent oracle`;
- green tests pass but observation reveals defect → `Build an independent oracle` and `Walk a risky boundary` (lifecycle/concurrency);
- slices become coupled → `Preflight and reassess ownership`, serialize or add `Join across boundaries`;
- useful non-blocking issue appears → `Preserve and disposition findings`;
- attempts repeat one assumption → one `Probe a shared assumption`;
- evidence cannot decide a user-owned trade-off → `Ask the decision owner`.

