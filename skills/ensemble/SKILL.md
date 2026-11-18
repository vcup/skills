---
name: ensemble
description: Improve real work through independent, materially different or intentionally redundant agent contributions checked against ground truth.
disable-model-invocation: true
---

# Ensemble

An **ensemble** produces independent contributions, checks their differences against evidence, and improves one complete deliverable. The **Lead** owns framing, composition, coaching, integration decisions, and delivery; working members own their assigned contributions. Prefer a Lead suited to difficult judgment and instruction. Its main leverage is improving and coordinating members' work, while direct investigation, implementation, and validation remain available when useful.

Use harness-native agents, per-member model selection, isolation, tools, artifacts, and notifications. Inspect the environment's available and authorized provider/model/reasoning-effort choices; never hardcode a deployment roster, endpoints, or credentials into this method or the product repository. A named role or “think harder” instruction does not select a model or effort setting.

When assigned as a member, follow your assignment, produce its artifact or observations, and report evidence and limits to the Lead. The Lead owns invocation setup, composition, integration, and closure; loading this skill into a member does not ask it to start another ensemble.

Before first dispatch, the Lead establishes the invocation checkpoint. With managed archive support, open it through the domain tools and submit actions and evidence references; the program maintains documents and history outside the workspace. Otherwise, use [`STATE-TEMPLATE.md`](STATE-TEMPLATE.md) in a separate records repository. Current OMP provides `ensemble_state` for its documented workspace-relative path, while external records use ordinary authorized file tools. Keep frequent history out of product commits and preserve existing tracked records until their migration is explicitly arranged.

## 1. Frame and prepare

State the requested deliverable, subject, constraints, full required coverage, and observable completion evidence. Read relevant earlier lessons selectively; check their evidence, applicability, and counterexamples. Start with a complete normal path and identify what each producer, consumer, and return value promises. Preserve the remaining coverage even when the first slice is small.

**Complete when:** scope and consequential ambiguities are explicit, and prior experience has informed the plan without being mistaken for current ground truth.

## 2. Compose result-changing attempts

Use at least two independent attempts with a material difference or intentional redundancy. Model, task direction, method, tools, evidence source, and supported effort can all supply useful differences. Same-model heterogeneity is valid; when shared model blind spots matter, prefer available, authorized, suitable different models. Record a missing required capability as a gap.

Before assigning or claiming work, assess whether a member's existing context is relevant, current, and suitable for the task's independence needs; availability or a familiar role name is not enough. Choose fresh context, a fork of completed context, or continuation according to that fit, answer exposure, input completeness, context budget, and continuity needs. Create a task-specific fresh member when useful, even if an existing member could do the work; fresh conversation and shared-task access are compatible. Reassess after scope changes or early evidence of mismatch; use the [selection guide](README.md#choose-how-to-drive-native-agents). Verify tools, peer messaging, shared-task access, and resumability separately: “subagent” and “teammate” names establish none of them. Use available native agents actively for useful independent work; no single creation or reuse strategy fits every attempt. Use fresh agents for cross-model selection; preserve provider/model when forking. If same-route effort adjustment is supported, state the direction and reason using the route's actual levels; unknown baselines do not justify claims of an increase or decrease.

Give each member an actionable task packet: question, common facts and baseline, owned scope, expected artifact, completion checks, and an early reviewable slice. Select provider/model/effort through real native options, preserve their default/omission semantics, and distinguish requested configuration from actual request evidence. When a shared task board is available, use its ownership, revisions, and dependencies; otherwise coordinate explicit assignments and native results without claiming shared ownership. Competing writers need isolated baselines; scope labels alone are not locks.

**Complete when:** required coverage has owners or explicit gaps, selections are feasible, and each attempt can change the work or a consequential judgment.

## 3. Produce and coach

Before each independent first result, share requirements, facts, and general methods without sibling conclusions or the Lead's preferred answer. A fresh agent can still be anchored by its prompt or shared files. Once initial results exist, reuse members to repair or deepen useful work; continuing or revising the same judgment is not another independent sample. Unrelated retained history does not itself disqualify a first attempt on a different question; assess exposure relevant to that question.

Review the agreed intermediate artifact. When a member struggles, identify the concrete failing step, supply a bounded example or method correction, and ask it to apply that correction to a new case. Escalate model capability or reassign only when justified. Coaching changes instructions and workflow, not model weights; an acknowledged lesson is not demonstrated learning. Wait on native notifications, not repeated status polling.

**Complete when:** each retained contribution is usable or its missing coverage is explicit, and any claimed improvement has an observable application.

## 4. Decide by observation

Separate observations, inferences, and decisions. Compare consequential differences using source, executed behavior, requirements, or independent specifications—not votes. Source and its own tests may share a defect. Use paired counterexamples to test whether a rule is too broad or too narrow; assign non-authors to inspect important handoffs and evidence claims.

**Complete when:** disputed claims and unsupported coverage are checked, dispositioned, or returned for targeted follow-up; task completion is not substituted for acceptance.

## 5. Evolve and verify

Direct suitable members to implement, repair, document, and verify accepted work. The Lead focuses on unresolved judgments, cross-contribution consistency, and the final candidate, stepping into direct work when it resolves a bottleneck. Recheck observations invalidated by changes and validate the integrated deliverable, not only its parts.

For a consequential change in judgment or method, propose a causal reflection using the questions in [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md). With plugin support, submit its claims and evidence for review through tools; code manages numbering, references, domain collections, and publication. Otherwise maintain the document in the isolated records area. Use ordered entries without narrative dates, clock times, or work durations; preserve substantive measurements and validity conditions as evidence. Explain the change, limitation, and next test, preserving corrections and failed approaches. Split substantial subject areas into focused readings with an overview. Promote reusable lessons only after checking scope and evidence; one successful attempt does not automatically rewrite maintained instructions.

**Complete when:** the candidate incorporates accepted contributions, affected checks are current, and the learning record explains material changes without claiming unobserved success.

## 6. Close and leave recoverable work

Continue only while another contribution, repair, or check can change the outcome or an important decision. Confirm full coverage, surface unresolved user choices, identify the delivered candidate and actual checks, and save the checkpoint through the chosen archive. Report archive persistence, product delivery, and method-improvement evidence separately; a history commit proves neither code correctness nor learning.

Product changes follow the source repository's conventions. Environment configuration, invocation records, and frequent learning logs stay outside its commit stream. If archival saving fails, retain the candidate and disclose the persistence gap; do not claim history saved or silently commit it into the product repository.

**Complete when:** the requested outcome is handed off with its observed verification, no critical check blocks that outcome, and recovery/history limitations are explicit.

References: [`README.md`](README.md) explains rationale and coaching; [`PATTERNS.md`](PATTERNS.md) supplies optional patterns; [`GLOSSARY.md`](GLOSSARY.md) defines terms.
