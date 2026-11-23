/**
 * The **learning loop** of the installed product, driven through the trusted run
 * context that `scripts/verify-dsh-product.ts` hands out.
 *
 * This module owns no Host and boots nothing: it receives the live,
 * officially-composed profile, its real root Agent, the authenticated owner
 * Remote and the real tool executor. Every write is one *registered* tool call
 * executed by the product's own `ctx.tools.execute` — the closed decoder, the
 * current-grant policy, the native identity derived from `exec.agent` and the
 * durable receipt machinery are the installation's. Nothing here imports the
 * pure reducer, the store or the registry: a journey that called
 * `applyCoordination` directly would prove nothing about an installed package.
 *
 * Two model facts shape it, both measured on a real profile:
 *
 * - A member acts only **during a turn of its own**. `ctx.tools.execute({agent})`
 *   needs the registry's exact live Agent, and every value outside the Host is a
 *   fresh proxy, so a member write goes through a real follow-up turn
 *   (`ctx.subagents.sendMessage`) and the tool result that turn produces.
 * - A member does **not** inherit the Lead's grants: a grant names one subject,
 *   and a child Session is a different subject. So the owner grants each member
 *   its own current, scoped authority through the authenticated Remote — the
 *   product's real path, never a widened or fabricated actor.
 *
 * The journey therefore runs as a user would: the owner authorizes real members,
 * the members write as themselves, and the Lead publishes what a non-author
 * reviewer approved.
 *
 * Only LLM token generation is deterministic. This module registers its **own**
 * provider route with a per-Session scripted queue so that a member's turn and
 * the Lead's turns cannot consume each other's scripted tool call; the tokens are
 * fake, everything they travel through is installed.
 *
 * What it proves, in the order a user lives it:
 *
 *   work      open → plan_attempt → bind a **real** continuable member →
 *             artifact + contribution (written by that member) → candidate →
 *             accepted decision → reported check → challenge → superseding
 *             observation → complete
 *   learn     coaching → author-owned reflection → the owner assigns a **second
 *             real member** to that exact revision → independent review →
 *             publication → lesson
 *   read      the published reading page, and the artifact's **original bytes**
 *             reassembled page by page and compared with what was written
 *   next      a new invocation whose member applies the lesson to an unseen case
 *             → independent check → `supported` (recommended) → a counterexample
 *             application removes the recommendation → an explicit disposition
 *             plus a **fresh** review restores it
 *   current   (a) an author cannot review their own proposal, (b) a member who was
 *             not assigned cannot review it, (c) revoking the delegation that
 *             authorizes member submission refuses the member's next write while
 *             its earlier writes stand, and (d) replaying an identical operation
 *             key answers with the original commit and does not move the head,
 *             while the same key with different content is refused.
 *
 * @module adapters/dsh/native/verify-learning
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The MIME type of the artifact this journey creates and reads back verbatim. */
const MEDIA_TYPE = 'text/plain; charset=utf-8'

/** The route this journey registers for its deterministic member and Lead turns. */
const PROVIDER = 'journey-gate'
const MODEL = 'deterministic'

/** The product's object kinds, longest first, so an id prefix maps to exactly one kind. */
const KINDS = Object.freeze([
  'invocation', 'coverage', 'criterion', 'attempt', 'artifact', 'contribution', 'finding', 'decision',
  'candidate', 'check', 'challenge', 'coaching', 'reflection', 'review', 'publication', 'lesson',
  'application', 'assessment', 'domain',
].sort((left, right) => right.length - left.length))

/**
 * Group one commit's changed records by object kind.
 *
 * Object ids are opaque program-allocated strings (`<kind>-<uuid>`) and the
 * contract forbids deriving them from paths or sequences, so this reads the ids
 * the archive actually returned.
 * @param {unknown} receipt - the archive's committed answer.
 * @returns {Record<string, {id: string, object_revision: number}>} one id per committed kind.
 */
export function changedByKind(receipt) {
  const changed = receipt?.changed
  assert(Array.isArray(changed), `a committed write must report its changed records: ${String(JSON.stringify(receipt)).slice(0, 400)}`)
  const byKind = {}
  for (const record of changed) {
    const id = String(record?.id ?? '')
    const kind = KINDS.find((candidate) => id.startsWith(`${candidate}-`))
    if (kind === undefined || byKind[kind] !== undefined) continue
    byKind[kind] = { id, object_revision: record.object_revision }
  }
  return byKind
}

/**
 * Assert one tool answer is a success and return its value.
 * @param {any} answer - the JSON value a registered tool returned.
 * @param {string} label - the step name, so a failure names the step.
 * @returns {any} the value.
 */
export function requireOk(answer, label) {
  assert.equal(answer?.ok, true, `${label}: ${String(JSON.stringify(answer)).slice(0, 900)}`)
  return answer.value
}

/**
 * Assert one tool answer is a refusal with exactly this code.
 * @param {any} answer - the JSON value a registered tool returned.
 * @param {string} code - the expected `FailureCode`.
 * @param {string} label - the step name.
 */
export function requireRefusal(answer, code, label) {
  assert.equal(answer?.ok, false, `${label} must be refused, got ${String(JSON.stringify(answer)).slice(0, 900)}`)
  assert.equal(answer.error?.code, code, `${label} must be ${code}, got ${String(JSON.stringify(answer)).slice(0, 600)}`)
}

/**
 * Reassemble one paged read into its complete bytes.
 *
 * A page is trusted as part of a complete value only when every page names the
 * same object revision and byte total, offsets are contiguous, and the last page
 * claims no continuation. Anything else is false completeness, so this throws.
 * @param {Array<any>} pages - page values in read order.
 * @param {'text'|'base64'} field - which payload the pages carry.
 * @returns {{bytes: Buffer, total: number, objectRef: any}} the reconstructed bytes.
 */
export function reassemble(pages, field) {
  assert(pages.length > 0, 'a read must return at least one page')
  const first = pages[0]
  const objectRef = first.object_ref
  const total = first.total_bytes ?? first.bytes
  assert(Number.isSafeInteger(total) && total >= 0, `a page must state its total byte count: ${String(JSON.stringify(first)).slice(0, 400)}`)
  const parts = []
  let offset = 0
  for (const [index, page] of pages.entries()) {
    assert.equal(page.object_ref?.object_id, objectRef?.object_id, 'every page must name the same object')
    assert.equal(page.object_ref?.object_revision, objectRef?.object_revision, 'every page must name the same object revision')
    assert.equal(page.total_bytes ?? page.bytes, total, 'every page must report the same total byte count')
    assert.equal(page.offset, offset, `page ${index} must start where the previous page ended`)
    parts.push(field === 'text' ? Buffer.from(page.text ?? '', 'utf8') : Buffer.from(page.base64 ?? '', 'base64'))
    offset += parts.at(-1).length
    if (page.next_offset !== undefined) {
      assert.equal(page.next_offset, offset, 'a continuation must be contiguous')
      // A continuation that points past the last byte is a page claiming both
      // completeness and incompleteness; the archive's own reader refuses it, so a
      // journey that accepted it would report a truncated read as the whole.
      assert(offset < total, `a continuation must leave content after offset ${offset} of ${total}`)
    }
  }
  assert.equal(offset, total, 'the pages must cover the declared total without truncation')
  return { bytes: Buffer.concat(pages.map((page) => Buffer.from(field === 'text' ? page.text ?? '' : page.base64 ?? '', field === 'text' ? 'utf8' : 'base64'))), total, objectRef }
}

/**
 * Build a deterministic scripted adapter on the **installed** LLM runtime.
 *
 * `ctx.llm.registerAdapter` installs routes against a real `LlmAdapter`, so the
 * class comes from the runtime the Host booted from — no copy is vendored. The
 * queue is per Session: a member's turn and the Lead's turns must not consume
 * each other's scripted tool call.
 * @param {string} runtime - the isolated DSH installation the Host was booted from.
 * @returns {Promise<{Scripted: any, text: (value: string) => any[], toolTurn: (call: object) => any[]}>} the scripted pieces.
 */
export async function scriptedRuntime(runtime) {
  const require = createRequire(join(runtime, 'package.json'))
  const module = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const { LlmAdapter, isAgentLoopRequest } = module
  const text = (value) => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  /**
   * One turn that issues exactly one tool call; the executor then runs it for real.
   *
   * The streamed `argumentsDelta` and the completed block must carry the same JSON
   * text: a delta with no arguments leaves the loop with an undecodable call, which
   * is silently dropped rather than executed.
   * @param {{id: string, name: string, args: unknown}} call - the call to issue.
   * @returns {any[]} the chunks of that turn.
   */
  const toolTurn = ({ id, name, args }) => {
    const argumentsText = JSON.stringify(args)
    return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
  const queues = new Map()
  class Scripted extends LlmAdapter {
    async *stream(options) {
      const sessionId = String(options.sessionId ?? 'anonymous')
      const queue = queues.get(sessionId) ?? []
      const taken = isAgentLoopRequest(options) ? queue.shift() : undefined
      // A queued turn may be a function, which is how this journey holds a member
      // inside one turn: the model call does not return while the test performs
      // owner work against that still-resident member.
      const chunks = taken === undefined
        ? text(isAgentLoopRequest(options) ? 'ok' : 'title')
        : typeof taken === 'function' ? await taken() : taken
      for (const chunk of chunks) {
        options.signal?.throwIfAborted()
        yield chunk
      }
    }
  }
  return { Scripted, queues, text, toolTurn }
}

/**
 * Drive the work → learn → publish → apply loop on one already-booted Host.
 *
 * @param {object} context - the frozen `productRunContext`.
 * @param {import('@deepseek-ai/cordis').Context} context.ctx - the live profile context.
 * @param {any} context.agent - the live root (Lead) Agent.
 * @param {string} context.projectId - the project the Host bound.
 * @param {string} context.source - the bound source directory.
 * @param {(method: string, request: unknown) => Promise<any>} context.remote - authenticated owner Remote.
 * @param {(name: string, args: unknown, id: string) => Promise<any>} context.call - one registered tool call as the Lead.
 * @param {() => Promise<string>} context.head - the current archive head, read over the Remote.
 * @param {(label: string, options?: object) => Promise<any>} context.spawnMember - a real continuable member.
 * @param {(label: string) => string} context.scratch - a path inside a root the driver owns.
 * @param {Record<string, unknown>} context.evidence - the driver's evidence object.
 * @returns {Promise<Record<string, unknown>>} measured evidence for this journey.
 */
export async function runLearningJourney(context) {
  const { ctx, agent, projectId, source, remote, call, head, spawnMember, scratch, evidence } = context
  for (const [name, value] of Object.entries({ ctx, agent, projectId, source, remote, call, head, spawnMember, scratch, evidence })) {
    if (value === undefined) throw new Error(`runLearningJourney: the run context is missing ${name}`)
  }
  const runtime = process.env.ENSEMBLE_PRODUCT_RUNTIME
  assert(runtime, 'runLearningJourney: the installed runtime must be named by ENSEMBLE_PRODUCT_RUNTIME')

  const started = Date.now()
  const steps = {}
  const record = (group, detail) => {
    steps[group] = { ...(steps[group] ?? {}), ...detail }
    evidence.learning = { status: 'running', ms: Date.now() - started, steps }
    return steps[group]
  }
  let sequence = 0
  const nextId = (label) => `${label}-${++sequence}`

  // The journey's own deterministic route, per Session. Members spawned below use
  // it, so their turns and the Lead's turns never share a scripted queue.
  const { Scripted, queues, text, toolTurn } = await scriptedRuntime(runtime)
  const registration = ctx.llm.registerAdapter([PROVIDER], new Scripted())
  const outcomes = new Map()
  const waiters = new Map()
  const onResult = (execution, result) => {
    outcomes.set(execution.callId, { result, agentId: execution.agent?.id })
    const wake = waiters.get(execution.callId)
    if (wake) {
      waiters.delete(execution.callId)
      wake()
    }
  }
  ctx.on('tools/result', onResult)

  /** Wait for one tool call to settle, bounded, and return its declared result. */
  const awaitResult = async (callId, label, timeoutMs = 30000) => {
    if (!outcomes.has(callId)) {
      await new Promise((done) => {
        const timer = setTimeout(() => {
          waiters.delete(callId)
          done()
        }, timeoutMs)
        waiters.set(callId, () => {
          clearTimeout(timer)
          done()
        })
      })
    }
    const settled = outcomes.get(callId)
    assert(settled, `${label}: no tool result for ${callId} within ${timeoutMs}ms`)
    assert.equal(settled.result?.isError ?? false, false, `${label}: the executor reported an error: ${String(JSON.stringify(settled.result)).slice(0, 700)}`)
    const block = settled.result?.content?.find((item) => item.type === 'text')
    assert(block, `${label}: no text result: ${String(JSON.stringify(settled.result)).slice(0, 700)}`)
    return { value: JSON.parse(block.text), agentId: settled.agentId }
  }

  /**
   * One registered tool call as the **Lead** (the live root Agent).
   *
   * `context.call` runs the real registered definition through the real executor
   * with `exec.agent` as the root Agent, so the actor is derived by the product's
   * native bridge (Workspace + execution world + tree root), never supplied here.
   */
  const lead = async (name, args, label) => ({ answer: await call(name, args, nextId(label)), label })

  const members = []
  /**
   * Spawn a **real** continuable member and give it its own turn driver.
   *
   * `spawnMember` starts a Host-managed continuable child. Its `call` executes a
   * registered tool as that member through a follow-up turn of its own; the
   * journey registers the route the member's turns use, so its scripted tool call
   * cannot be consumed by another Session.
   */
  const member = async (label, prompt, grantedRights) => {
    const handle = await spawnMember(label, {
      prompt,
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    members.push(handle)
    assert(Number.isSafeInteger(handle.descriptorSeq), `${label}: a continuable member must publish its descriptor event`)
    // Owner-granted, per-subject authority: a member does not inherit the Lead's.
    requireOk((await manage('grant', {
      subject: { kind: 'session', sessionId: handle.childId, rootSessionId: agent.id },
      rights: grantedRights,
      scope: { kind: 'project' },
      reason: `acceptance: the ${label} member acts with its own current grant`,
    }, `grant-${label}`)).answer, `grant-${label}`)
    /**
     * One tool call the member itself performs, through its own model turn.
     *
     * The turn is scripted per Session, and a member can be mid-turn when the
     * follow-up arrives (its spawn turn), which splices the message into the inbox
     * instead of starting one. Re-delivering is safe — the tool call id is fixed
     * and the delivered turn is re-queued — while a turn that genuinely never runs
     * still fails loudly after the bounded attempts.
     */
    const run = async (name, args, stepLabel) => {
      const id = nextId(stepLabel)
      const script = [toolTurn({ id, name, args }), text('recorded')]
      let delivered
      for (let attempt = 0; attempt < 5 && !outcomes.has(id); attempt += 1) {
        queues.set(handle.childId, [...script])
        try {
          delivered = await ctx.subagents.sendMessage(agent, handle.childId, [{ type: 'text', text: `run ${stepLabel}` }], { signal: AbortSignal.timeout(30000) })
        } catch (error) {
          if (attempt === 4) throw new Error(`${stepLabel}: the member could not be woken: ${String(error?.message ?? error)}`)
        }
        await new Promise((done) => setTimeout(done, 150))
      }
      const { value, agentId } = await awaitResult(id, stepLabel)
      assert.equal(agentId, handle.childId, `${stepLabel}: the tool must run as the member ${handle.childId}, not as ${agentId}`)
      assert(delivered, `${stepLabel}: the follow-up must have been accepted by the member's inbox`)
      return { answer: value, label: stepLabel }
    }
    /**
     * Hold this member inside one of its own turns, so it is **resident**.
     *
     * The product resolves a native Session for some owner actions only while that
     * Session is loaded, and a continuable member is released between turns. A turn
     * whose model call has not returned keeps the member resident; `release` ends
     * that turn. This is the official lifecycle, not a test hook: the model call is
     * simply still in flight.
     * @param {string} stepLabel - diagnostic name for the held turn.
     * @returns {Promise<{release: () => void, resident: boolean}>} the held turn.
     */
    const hold = async (stepLabel) => {
      let release
      let start
      const gate = new Promise((done) => { release = done })
      const started = new Promise((done) => { start = done })
      queues.set(handle.childId, [async () => {
        start()
        await gate
        return text('resident turn finished')
      }])
      // `sendMessage` resolves when the message is **accepted** by the inbox, not when
      // the turn ends, so it is not an end-of-turn signal: the gate inside the
      // streamed turn is what holds the member resident.
      const accepted = ctx.subagents
        .sendMessage(agent, handle.childId, [{ type: 'text', text: `hold ${stepLabel}` }], { signal: AbortSignal.timeout(30000) })
        .then(() => true, (error) => { throw new Error(`${stepLabel}: the held turn could not start: ${String(error?.message ?? error)}`) })
      await Promise.race([started, accepted.then(() => undefined)])
      assert(await accepted, `${stepLabel}: the held turn must be accepted by the member's inbox`)
      const resident = ctx.agents.list().some((candidate) => candidate.id === handle.childId)
      assert(resident, `${stepLabel}: the member must be resident while its turn is in flight`)
      return { release, resident }
    }
    return { ...handle, run, hold }
  }

  /** One authenticated owner management action at the current head. */
  const manage = async (action, payload, label) => {
    const expected = await head()
    return { answer: await remote('manage', { action, project_id: projectId, expected_revision: expected, operation_id: nextId(label), payload }), label }
  }

  /**
   * Authorize one real member as the reviewer of one exact revision.
   *
   * `manage {action:'assign_reviewer'}` resolves the reviewer through the Host's
   * native identity, so it requires that Session to be **resident**, and a
   * continuable member is released between turns. The journey therefore holds the
   * member inside its own turn (a model call that has not returned), performs the
   * owner assignment against that live Session, releases the turn, and only then
   * lets the member review. If the Host refuses, that is reported as a native
   * availability gap rather than replaced by another owner shape: a fallback would
   * prove a path the product's own action never exercised.
   * @param {object} proposalRef - the exact revision under review.
   * @param {object} handle - the member, from `member()`.
   * @param {string} label - step name.
   * @returns {Promise<{via: string, resident: boolean}>} how the authority was granted.
   */
  const authorizeReviewer = async (proposalRef, handle, label) => {
    const held = await handle.hold(`${label}-hold`)
    let assigned
    try {
      assigned = await manage('assign_reviewer', {
        proposal_ref: proposalRef,
        reviewer_session_id: handle.childId,
        delegated_rights: ['review'],
      }, label)
    } finally {
      held.release()
    }
    assert.equal(
      assigned.answer?.ok,
      true,
      `${label}: the owner's assign_reviewer must be reachable for a resident continuable member; the Host answered ${String(JSON.stringify(assigned.answer)).slice(0, 500)}. That is a native availability gap in the product, not a journey limitation.`,
    )
    return { via: 'assign_reviewer (owner action, reviewer resident)', resident: held.resident }
  }

  /**
   * Read the head immediately before each write.
   *
   * The guest journals every committed revision, and each step here is a separate
   * owner/member action, so a cached head would make the *next* write a
   * revision_conflict. What this journey is about is the write path itself; stale
   * revision refusal is proven by the installed gate's `core` phase.
   */
  let revision = await head()
  const commit = (outcome) => {
    const receipt = requireOk(outcome.answer, outcome.label)
    assert.equal(receipt.status, 'committed', `${outcome.label}: ${String(JSON.stringify(receipt)).slice(0, 600)}`)
    assert.notEqual(receipt.committed_revision, undefined, `${outcome.label}: a commit must name its revision`)
    revision = receipt.head_revision
    return { receipt, ids: changedByKind(receipt) }
  }

  try {
    // ── work ────────────────────────────────────────────────────────────────
    const surface = requireOk((await lead('ensemble_read', { kind: 'context' }, 'work-context')).answer, 'work-context')
    assert.equal(surface.read_revision, revision, 'a read must report the head the owner Remote reports')
    record('work', { contextRevision: surface.read_revision, authorizationEpoch: surface.authorization_epoch })

    // `organize_domain` is an owner-delegated capability, not a Lead default.
    requireOk((await manage('grant', {
      subject: { kind: 'session', sessionId: agent.id, rootSessionId: agent.id },
      rights: ['organize'], scope: { kind: 'project' },
      reason: 'acceptance: the owner delegates domain organization to the Lead',
    }, 'grant-organize')).answer, 'grant-organize')
    revision = await head()

    // Members get `read` only. Their authority to submit work is the product's own
    // delegation: `plan_attempt` with a verified member binds that member and adds
    // an attempt-scoped grant delegated from the Lead's `member-submit`. Granting a
    // member `member-submit` project-wide here would make the revocation case below
    // pass for the wrong reason — the member would no longer depend on the
    // delegation the owner is about to withdraw.
    const producer = await member('producer', 'Produce one observed implementation turn for the learning acceptance.', ['read'])
    const reviewer = await member('reviewer', 'Independently verify the acceptance evidence.', ['read'])
    // The member reads through its own identity: the same call the Lead made
    // succeeds for the member *because a grant names the member*, which is the
    // property this journey depends on below.
    const memberSurface = requireOk((await producer.run('ensemble_read', { kind: 'context' }, 'member-context')).answer, 'member-context')
    assert.equal(memberSurface.read_revision, await head(), 'the member must read the current head')
    record('work', { producer: producer.childId, reviewer: reviewer.childId, memberReadsOwnContext: true, headAfterGrants: revision })

    const openPayload = {
      title: 'Distinguish acceptance from completion',
      goal: 'Record a work journey whose evidence a later lesson can be applied to',
      deliverable: 'A completed invocation with a verified observation',
      subject: 'Asynchronous tool handoff',
      constraints: 'Use only supported native capabilities',
      exclusions: 'No claim about paid-model quality',
      coverage: [
        { key: 'distinction', title: 'Receipt versus completion', requirement: 'Prove the accepted message is not the completed result', required: true, authority_refs: [] },
        { key: 'transfer', title: 'Transferable method', requirement: 'Keep the method applicable to another interface', required: true, authority_refs: [] },
      ],
      criteria: [
        { key: 'executed', coverage_targets: [{ kind: 'request_key', key: 'distinction' }], statement: 'A later, independent observation confirms the distinction', critical: true, method: 'native execution' },
        { key: 'applied', coverage_targets: [{ kind: 'request_key', key: 'transfer' }], statement: 'The method names its applicability and limits', critical: false, method: 'reading' },
      ],
    }
    const opened = commit(await lead('ensemble_work', { action: 'open', expected_revision: await head(), operation_id: 'learning-open', payload: openPayload }, 'work-open'))
    const invocation = opened.ids.invocation.id
    const coverageIds = [opened.receipt.result?.ids?.distinction, opened.receipt.result?.ids?.transfer]
    const criterionId = opened.receipt.result?.ids?.['criterion:executed']
    assert(coverageIds.every(Boolean) && criterionId, `open must return every requirement id: ${String(JSON.stringify(opened.receipt.result)).slice(0, 600)}`)
    assert.equal(opened.receipt.result.status, 'active')
    record('work', { invocationId: invocation, openRevision: opened.receipt.committed_revision, coverageIds, criterionId })

    // The attempt is planned by the Lead and *bound* to the real member: the
    // binding is what makes that member a current participant rather than a name.
    const planned = commit(await lead('ensemble_work', {
      action: 'plan_attempt',
      expected_revision: await head(),
      operation_id: 'learning-plan',
      payload: {
        invocation_id: invocation,
        question: 'Does the accepted message prove the task completed?',
        baseline_refs: [],
        coverage_ids: coverageIds,
        difference_or_redundancy: 'The first attempt observes the handoff directly',
        context_plan: { mode: 'fresh', relevance: 'Isolated native member', exposure: 'No sibling conclusions' },
        expected_output: 'An artifact and the member log it cites',
        early_slice: 'one observed turn',
        write_scope_claims: ['none'],
        purpose: 'produce',
        member_id: producer.childId,
        requested_selection: { provider: PROVIDER, model: MODEL },
      },
    }, 'work-plan'))
    const attempt = planned.ids.attempt.id
    record('work', { attemptId: attempt })

    // The artifact's bytes are generated here and compared byte-for-byte on read.
    const body = `# Acceptance record\n\n${'The accepted message is not the completed task. '.repeat(760)}\n结束: 受理不等于完成。\n`
    const artifact = commit(await producer.run('ensemble_work', {
      action: 'put_artifact',
      expected_revision: await head(),
      operation_id: 'learning-artifact',
      payload: {
        invocation_id: invocation,
        change: { action: 'create', kind: 'evidence', title: 'Observed handoff', content: { kind: 'text', media_type: MEDIA_TYPE, text: body }, refs: [], domains: [] },
      },
    }, 'work-artifact'))
    const artifactRef = { kind: 'object', object_id: artifact.ids.artifact.id, object_revision: artifact.ids.artifact.object_revision }
    record('work', { artifactId: artifactRef.object_id, artifactBytes: Buffer.byteLength(body, 'utf8') })

    const contribution = commit(await producer.run('ensemble_work', {
      action: 'submit_contribution',
      expected_revision: await head(),
      operation_id: 'learning-contribution',
      payload: {
        invocation_id: invocation,
        attempt_id: attempt,
        summary: 'The member recorded the handoff it observed and cited its own descriptor event',
        artifact_refs: [artifactRef],
        evidence_refs: [{ kind: 'native_event', session_id: producer.childId, event_seq: producer.descriptorSeq }],
        limitations: 'One member, one tool surface; no population-level claim',
        source: { kind: 'self' },
      },
    }, 'work-contribution'))
    const contributionRef = { kind: 'object', object_id: contribution.ids.contribution.id, object_revision: contribution.ids.contribution.object_revision }
    // Attribution is a fact, not an assumption: the history names the member.
    const history = requireOk((await lead('ensemble_read', { kind: 'history', object_id: contributionRef.object_id }, 'work-history')).answer, 'work-history')
    const authors = new Set((history.items ?? []).map((entry) => entry.actor?.sessionId).filter(Boolean))
    assert(authors.has(producer.childId), `the contribution's history must name the member as its actor: ${String(JSON.stringify(history.items?.map((entry) => entry.actor))).slice(0, 700)}`)
    record('work', { contribution: contributionRef, contributionActor: producer.childId, historyEntries: (history.items ?? []).length })

    // A candidate names the source baseline it was produced against; the binding
    // id is a measured fact of this Host, not an argument a caller may invent.
    const contextPage = requireOk((await lead('ensemble_read', { kind: 'context' }, 'work-binding')).answer, 'work-binding')
    const bound = contextPage.items?.find((item) => item.project_id === projectId) ?? contextPage.items?.[0]
    assert(typeof bound?.binding_id === 'string' && bound.binding_id.length > 0, `the bound project must expose its binding: ${String(JSON.stringify(contextPage)).slice(0, 700)}`)
    const candidate = commit(await lead('ensemble_work', {
      action: 'set_candidate',
      expected_revision: await head(),
      operation_id: 'learning-candidate',
      payload: {
        invocation_id: invocation,
        source_ref: { kind: 'source', binding_id: bound.binding_id, source_handle: bound.binding_id, baseline: source },
        description: 'The source tree the member wrote its record against',
        dirty: false,
      },
    }, 'work-candidate'))
    const candidateRef = { kind: 'object', object_id: candidate.ids.candidate.id, object_revision: candidate.ids.candidate.object_revision }

    // A decision is applicable to the frame *and candidate* it was taken in, so
    // the candidate is set first: judging a contribution before naming what it
    // was judged against is exactly what completion refuses.
    const decision = commit(await lead('ensemble_work', {
      action: 'decide',
      expected_revision: await head(),
      operation_id: 'learning-decision',
      payload: {
        invocation_id: invocation,
        target: contributionRef,
        disposition: 'accepted',
        reason: 'The contribution cites a native event and an archived artifact',
        evidence_refs: [contributionRef],
        consequence: 'The distinction is ready to be observed once more',
      },
    }, 'work-decide'))
    const decisionRef = { kind: 'object', object_id: decision.ids.decision.id, object_revision: decision.ids.decision.object_revision }

    // The observation stays *reported*: this product never upgrades a claim to an
    // observation because a check says it passed.
    const firstCheck = commit(await lead('ensemble_work', {
      action: 'record_check',
      expected_revision: await head(),
      operation_id: 'learning-check-1',
      payload: {
        invocation_id: invocation,
        check: {
          kind: 'execution', target: candidateRef, criterion_ids: [criterionId],
          method: 'Read the member log and the artifact',
          action: 'Compared the accepted message with the archived artifact',
          result: 'passed', evidence_refs: [artifactRef],
          limits: 'One execution, reported by the Lead',
        },
      },
    }, 'work-check-1'))
    const firstCheckRef = { kind: 'object', object_id: firstCheck.ids.check.id, object_revision: firstCheck.ids.check.object_revision }

    const challenged = commit(await lead('ensemble_work', {
      action: 'record_challenge',
      expected_revision: await head(),
      operation_id: 'learning-challenge',
      payload: {
        invocation_id: invocation,
        target: firstCheckRef,
        statement: 'The first observation read the log, not the later completion event',
        contradicting_refs: [{ kind: 'native_event', session_id: producer.childId, event_seq: producer.descriptorSeq }],
        impact: 'A passing check alone must not complete the work',
      },
    }, 'work-challenge'))
    const challengeId = challenged.ids.challenge.id

    // Comparing the accepted message with the artifact was not enough: the second
    // observation waits for the completion event and then reads the bytes.
    const secondCheck = commit(await lead('ensemble_work', {
      action: 'record_check',
      expected_revision: await head(),
      operation_id: 'learning-check-2',
      payload: {
        invocation_id: invocation,
        check: {
          kind: 'execution', target: candidateRef, criterion_ids: [criterionId],
          method: 'Trace the completion event and the final artifact',
          action: 'Waited for the completion event, then read the artifact bytes',
          result: 'passed', evidence_refs: [artifactRef],
          limits: 'Two observations, both reported',
        },
      },
    }, 'work-check-2'))
    const secondCheckRef = { kind: 'object', object_id: secondCheck.ids.check.id, object_revision: secondCheck.ids.check.object_revision }

    commit(await lead('ensemble_work', {
      action: 'resolve_challenge',
      expected_revision: await head(),
      operation_id: 'learning-resolve',
      payload: {
        invocation_id: invocation,
        challenge_id: challengeId,
        resolution: 'superseded',
        reason: 'A later, independent execution replaces the challenged observation',
        evidence_refs: [secondCheckRef],
        replacement_ref: secondCheckRef,
      },
    }, 'work-resolve'))

    const completed = commit(await lead('ensemble_work', {
      action: 'set_lifecycle',
      expected_revision: await head(),
      operation_id: 'learning-complete',
      payload: {
        invocation_id: invocation,
        transition: 'complete',
        reason: 'Every required coverage has an accepted result and a current observation',
        evidence_refs: [candidateRef],
        completion: {
          candidate_ref: candidateRef,
          coverage: coverageIds.map((coverageId) => ({ coverage_id: coverageId, decision_refs: [decisionRef], check_refs: [secondCheckRef] })),
        },
      },
    }, 'work-complete'))
    assert.equal(completed.receipt.result?.status, 'completed', `the work must be completed: ${String(JSON.stringify(completed.receipt)).slice(0, 700)}`)
    record('work', { completed: true, completedRevision: completed.receipt.committed_revision, checks: [firstCheckRef, secondCheckRef], challenge: challengeId })

    // ── learn ───────────────────────────────────────────────────────────────
    const coaching = commit(await lead('ensemble_learn', {
      action: 'record_coaching',
      expected_revision: await head(),
      operation_id: 'learning-coaching',
      payload: {
        invocation_id: invocation,
        attempt_id: attempt,
        observed_problem: 'The accepted message was read as the completed task',
        diagnosis: 'Two events with different meanings were conflated',
        instruction: 'Wait for the completion event and read the artifact bytes before claiming completion',
        exposure_refs: [artifactRef],
        intended_transfer: 'Another asynchronous interface the member has not seen',
      },
    }, 'learn-coaching'))

    const domain = commit(await lead('ensemble_learn', {
      action: 'organize_domain',
      expected_revision: await head(),
      operation_id: 'learning-domain',
      payload: {
        invocation_id: invocation,
        change: {
          kind: 'create',
          title: 'Acceptance and completion',
          questions: 'Which event actually proves the task finished?',
          audience: 'Members integrating asynchronous tools',
          overview: 'Separate the accepted handoff from the completed result, and keep the limits visible.',
        },
      },
    }, 'learn-domain'))
    const domainId = domain.ids.domain.id

    // The reflection is written by the member that made the mistake: a draft
    // belongs to its author, and only that author may revise it.
    const reflection = commit(await producer.run('ensemble_learn', {
      action: 'propose_reflection',
      expected_revision: await head(),
      operation_id: 'learning-reflection',
      payload: {
        invocation_id: invocation,
        domain_id: domainId,
        title: 'Wait for the event that means completion',
        problem: 'A returned message looked like a finished task',
        actions_and_evidence: 'Compared the accepted message, the completion event and the artifact bytes',
        judgment_change: 'Treat acceptance as a handoff and require an observed completion',
        limits: 'Only for interfaces that distinguish acceptance from completion',
        next_test: 'Cancel after acceptance and check the checkpoint still says unfinished',
        fact_refs: [{ kind: 'object', object_id: coaching.ids.coaching.id, object_revision: coaching.ids.coaching.object_revision }],
        retrospective: false,
      },
    }, 'learn-reflection'))
    const draftRef = { kind: 'object', object_id: reflection.ids.reflection.id, object_revision: reflection.ids.reflection.object_revision }

    // (a) The author cannot review their own proposal.
    requireRefusal((await producer.run('ensemble_learn', {
      action: 'review_reflection', expected_revision: await head(), operation_id: 'learning-self-review',
      payload: { invocation_id: invocation, proposal_ref: draftRef, verdict: 'approve', findings: [], evidence_refs: [] },
    }, 'learn-self-review')).answer, 'not_authorized', 'an author reviewing their own proposal')

    // (b) A member who was not assigned cannot review it either: a general
    // capability is not an assignment to this exact revision.
    requireRefusal((await reviewer.run('ensemble_learn', {
      action: 'review_reflection', expected_revision: await head(), operation_id: 'learning-unassigned-review',
      payload: { invocation_id: invocation, proposal_ref: draftRef, verdict: 'approve', findings: [], evidence_refs: [] },
    }, 'learn-unassigned-review')).answer, 'not_authorized', 'a review by a member who was not assigned')

    // Publishing with no selected non-author approval is refused, not silently allowed.
    requireRefusal((await lead('ensemble_learn', {
      action: 'publish_reflection', expected_revision: await head(), operation_id: 'learning-publish-early',
      payload: { invocation_id: invocation, proposal_ref: draftRef, review_refs: [] },
    }, 'learn-publish-early')).answer, 'invalid_input', 'publishing without a selected review')
    record('learn', { draft: draftRef, selfReviewRefused: true, unassignedReviewRefused: true, earlyPublishRefused: true })

    // The owner authorizes that exact revision to the real second member. It is a
    // proposal-scoped review authority — not project-wide review.
    record('learn', { reviewAuthority: await authorizeReviewer(draftRef, reviewer, 'assign-reviewer') })

    const review = commit(await reviewer.run('ensemble_learn', {
      action: 'review_reflection',
      expected_revision: await head(),
      operation_id: 'learning-review',
      payload: { invocation_id: invocation, proposal_ref: draftRef, verdict: 'approve', findings: [], evidence_refs: [artifactRef] },
    }, 'learn-review'))
    const reviewRef = { kind: 'object', object_id: review.ids.review.id, object_revision: review.ids.review.object_revision }

    const published = commit(await lead('ensemble_learn', {
      action: 'publish_reflection',
      expected_revision: await head(),
      operation_id: 'learning-publish',
      payload: { invocation_id: invocation, proposal_ref: draftRef, review_refs: [reviewRef] },
    }, 'learn-publish'))
    const publicationRef = { kind: 'object', object_id: published.ids.publication.id, object_revision: published.ids.publication.object_revision }
    record('learn', { reviewerSession: reviewer.childId, review: reviewRef, publication: publicationRef, reviewActor: reviewer.childId })

    // ── read: the published page and the artifact's original bytes ───────────
    const reading = requireOk((await lead('ensemble_read', { kind: 'reading', domain_id: domainId }, 'read-reading')).answer, 'read-reading')
    assert.equal(reading.completeness, 'complete', `the reading page must be complete: ${String(JSON.stringify(reading)).slice(0, 500)}`)
    const view = reading.items.find((item) => item.selection?.object_id === publicationRef.object_id)
    assert(view, `the published entry must appear in the reading page: ${String(JSON.stringify(reading.items?.map((item) => item.selection))).slice(0, 500)}`)
    // Generated prose is escaped before Markdown, so punctuation appears as
    // entities: the page carries the reviewed words, not raw markup.
    assert.match(view.text, /&#/, 'the reading page must render escaped reviewed prose')
    assert.equal(view.renderer_version, 'ensemble/v2', 'the reading view must name the renderer version it was produced with')

    const pages = []
    let cursor
    for (let guard = 0; guard < 60; guard += 1) {
      const page = requireOk((await lead('ensemble_read', {
        kind: 'artifact', object_id: artifactRef.object_id, object_revision: artifactRef.object_revision, content_mode: 'text',
        ...(cursor === undefined ? {} : { cursor }),
      }, `read-artifact-${guard}`)).answer, `read-artifact-${guard}`)
      pages.push(page.items[0])
      if (page.next_cursor === undefined) {
        assert.equal(page.completeness, 'complete', 'the last content page must claim completeness only with no continuation')
        break
      }
      assert.equal(page.completeness, 'partial', 'a page with a continuation must not claim completeness')
      cursor = page.next_cursor
    }
    const textRead = reassemble(pages, 'text')
    assert.equal(textRead.bytes.toString('utf8'), body, 'the text pages must reproduce the stored text exactly')
    const digest = (await import('node:crypto')).createHash('sha256').update(textRead.bytes).digest('hex')
    assert.equal(textRead.total, Buffer.byteLength(body, 'utf8'))

    // The byte surface is separate: canonical base64 of the *original* bytes,
    // never a generated Markdown rendering.
    const bytePage = requireOk((await lead('ensemble_read', {
      kind: 'artifact', object_id: artifactRef.object_id, object_revision: artifactRef.object_revision, content_mode: 'bytes',
    }, 'read-artifact-bytes')).answer, 'read-artifact-bytes')
    const byteItem = bytePage.items[0]
    assert.equal(byteItem.media_type, MEDIA_TYPE, 'the byte page keeps the stored media type')
    assert.equal(byteItem.bytes, Buffer.byteLength(body, 'utf8'), 'the byte page reports the stored byte count')
    assert.equal(byteItem.digest, digest, 'the byte page names the digest of the original bytes')
    const firstBytes = Buffer.from(byteItem.base64, 'base64')
    assert(firstBytes.equals(textRead.bytes.subarray(0, firstBytes.length)), 'the first byte page must be the stored prefix, byte for byte')
    record('read', {
      readingComplete: true, readingItems: reading.items.length, readingRevision: reading.read_revision,
      artifactPages: pages.length, artifactBytes: textRead.total, artifactDigest: digest,
      bytePageBytes: firstBytes.length, bytePageMediaType: byteItem.media_type,
    })

    // ── next: apply the method to a new task, then contradict and restore ────
    const lesson = commit(await producer.run('ensemble_learn', {
      action: 'propose_lesson',
      expected_revision: await head(),
      operation_id: 'learning-lesson',
      payload: {
        invocation_id: invocation,
        title: 'Wait for the completion event',
        trigger: 'An interface that accepts work before it finishes',
        action: 'Read the completion event and the final artifact before reporting completion',
        supporting_refs: [publicationRef],
        counterexamples: 'An interface that already returns the final result synchronously',
        applicability: { task_types: ['implementation'], interface_versions: ['native-v1'], required_capabilities: ['events'] },
        invalidation_condition: 'The interface returns the final output from the same call',
      },
    }, 'learn-lesson'))
    const lessonRef = { kind: 'object', object_id: lesson.ids.lesson.id, object_revision: lesson.ids.lesson.object_revision }
    record('next', { lesson: lessonRef })

    // A new task reuses the method: this is where a lesson proves transfer rather
    // than being confirmed by the story that produced it.
    const nextOpen = commit(await lead('ensemble_work', {
      action: 'open',
      expected_revision: await head(),
      operation_id: 'apply-open',
      payload: {
        title: 'Apply the completion rule to a new interface',
        goal: 'Apply a recorded lesson to an unseen interface',
        deliverable: 'A recorded application with an independent check',
        subject: 'Another asynchronous interface',
        constraints: 'Keep the recorded limits visible',
        exclusions: 'No claim that the lesson generalizes to every tool',
        coverage: [{ key: 'applied', title: 'Applied method', requirement: 'Record what was done and what happened', required: true, authority_refs: [] }],
        criteria: [{ key: 'checked', coverage_targets: [{ kind: 'request_key', key: 'applied' }], statement: 'The application is checked independently', critical: true, method: 'independent review' }],
      },
    }, 'apply-open'))
    const nextInvocation = nextOpen.ids.invocation.id
    const nextAttempt = commit(await lead('ensemble_work', {
      action: 'plan_attempt',
      expected_revision: await head(),
      operation_id: 'apply-plan',
      payload: {
        invocation_id: nextInvocation,
        question: 'Does waiting for the completion event change the outcome?',
        baseline_refs: [],
        coverage_ids: [nextOpen.receipt.result.ids.applied],
        difference_or_redundancy: 'A different interface from the one that produced the lesson',
        context_plan: { mode: 'fresh', relevance: 'Unseen interface', exposure: 'The method and its limits only' },
        expected_output: 'An application record with the observed result',
        early_slice: 'one turn',
        write_scope_claims: ['none'],
        purpose: 'produce',
        member_id: producer.childId,
      },
    }, 'apply-plan'))
    const nextAttemptId = nextAttempt.ids.attempt.id
    record('next', { applicationInvocation: nextInvocation, applicationAttempt: nextAttemptId })

    // A lesson check needs its own exact assignment: membership is not review.
    record('next', { lessonAuthority: await authorizeReviewer(lessonRef, reviewer, 'assign-lesson-reviewer') })
    const lessonCheck = commit(await reviewer.run('ensemble_work', {
      action: 'record_check',
      expected_revision: await head(),
      operation_id: 'apply-check',
      payload: {
        invocation_id: nextInvocation,
        check: {
          kind: 'execution', target: lessonRef, criterion_ids: [],
          method: 'Unseen case plus its counterexample',
          action: 'Ran the unseen interface and the synchronous one',
          result: 'passed',
          evidence_refs: [{ kind: 'reported', statement: 'The completion event preceded the artifact read in the unseen case', source_label: 'independent reviewer', supporting_refs: [] }],
          limits: 'Two interfaces, one reported observation',
        },
      },
    }, 'apply-check'))
    const lessonCheckRef = { kind: 'object', object_id: lessonCheck.ids.check.id, object_revision: lessonCheck.ids.check.object_revision }

    const application = commit(await producer.run('ensemble_learn', {
      action: 'assess_lesson',
      expected_revision: await head(),
      operation_id: 'apply-application',
      payload: {
        invocation_id: nextInvocation,
        lesson_ref: lessonRef,
        assessment: {
          kind: 'application', invocation_id: nextInvocation, attempt_id: nextAttemptId,
          context: 'A different asynchronous interface',
          action_taken: 'Waited for the completion event, then read the artifact',
          result: 'supports', case_kind: 'unseen',
          check_refs: [lessonCheckRef],
          limits: 'One unseen interface; no population-level claim',
        },
      },
    }, 'apply-application'))
    const applicationRef = { kind: 'object', object_id: application.ids.application.id, object_revision: application.ids.application.object_revision }

    const supported = commit(await lead('ensemble_learn', {
      action: 'assess_lesson',
      expected_revision: await head(),
      operation_id: 'apply-decision',
      payload: {
        invocation_id: nextInvocation,
        lesson_ref: lessonRef,
        assessment: { kind: 'decision', status: 'supported', reason: 'An unseen application and an independent check', application_refs: [applicationRef], review_ref: lessonCheckRef },
      },
    }, 'apply-decision'))
    const supportedRef = { kind: 'object', object_id: supported.ids.assessment.id, object_revision: supported.ids.assessment.object_revision }

    const taskContext = { task_types: ['implementation'], interface_versions: ['native-v1'], required_capabilities: ['events'] }
    const recommended = requireOk((await lead('ensemble_read', { kind: 'lessons', domain_id: domainId, status: 'supported', text: 'completion', task_context: taskContext }, 'read-recommend')).answer, 'read-recommend')
    assert.equal(recommended.items.length, 1, `the supported lesson must be recommended: ${String(JSON.stringify(recommended)).slice(0, 700)}`)
    assert.equal(recommended.items[0].status, 'supported')
    assert.equal(recommended.items[0].lesson.id, lessonRef.object_id)
    assert.equal(recommended.items[0].lesson.object_revision, lessonRef.object_revision, 'the recommendation cites the exact lesson revision')
    assert.equal(recommended.items[0].applicability, 'matched')
    record('next', { application: applicationRef, check: lessonCheckRef, decision: supportedRef, recommended: recommended.items.length, recommendationApplicability: recommended.items[0].applicability })

    // A counterexample is a recorded application, not an opinion: it removes the
    // default recommendation at once and leaves the lesson readable as contested.
    const counter = commit(await producer.run('ensemble_learn', {
      action: 'assess_lesson',
      expected_revision: await head(),
      operation_id: 'apply-counter',
      payload: {
        invocation_id: nextInvocation,
        lesson_ref: lessonRef,
        assessment: {
          kind: 'application', invocation_id: nextInvocation, attempt_id: nextAttemptId,
          context: 'An interface that returns the final result from the same call',
          action_taken: 'Applied the method anyway',
          result: 'contradicts', case_kind: 'counterexample',
          check_refs: [lessonCheckRef],
          limits: 'The counterexample is outside the recorded applicability',
        },
      },
    }, 'apply-counter'))
    const counterRef = { kind: 'object', object_id: counter.ids.application.id, object_revision: counter.ids.application.object_revision }

    const afterCounter = requireOk((await lead('ensemble_read', { kind: 'lessons', domain_id: domainId, status: 'supported', text: 'completion', task_context: taskContext }, 'read-after-counter')).answer, 'read-after-counter')
    assert.equal(afterCounter.items.length, 0, `a contradicting application must remove the recommendation: ${String(JSON.stringify(afterCounter)).slice(0, 600)}`)
    const contested = requireOk((await lead('ensemble_read', { kind: 'lessons', domain_id: domainId, status: 'contested', text: 'completion', task_context: { task_types: [], interface_versions: [], required_capabilities: [] } }, 'read-contested')).answer, 'read-contested')
    assert.equal(contested.items.length, 1, `the lesson must remain readable as contested: ${String(JSON.stringify(contested)).slice(0, 600)}`)
    record('next', { counterexample: counterRef, afterCounterexample: afterCounter.items.length, contested: contested.items.length })

    // Disposing the counterexample is explicit and evidenced, and support then
    // needs a *fresh* review: the earlier approval cannot be reused.
    const lessonChallenge = commit(await lead('ensemble_work', {
      action: 'record_challenge',
      expected_revision: await head(),
      operation_id: 'apply-challenge',
      payload: {
        invocation_id: nextInvocation,
        target: lessonRef,
        statement: 'The synchronous interface is outside the recorded applicability',
        contradicting_refs: [counterRef],
        impact: 'The recommendation stays withdrawn until this is disposed',
      },
    }, 'apply-challenge'))
    commit(await lead('ensemble_work', {
      action: 'resolve_challenge',
      expected_revision: await head(),
      operation_id: 'apply-resolve',
      payload: {
        invocation_id: nextInvocation,
        challenge_id: lessonChallenge.ids.challenge.id,
        resolution: 'dismissed',
        reason: 'The counterexample names a synchronous interface the lesson explicitly excludes',
        evidence_refs: [{ kind: 'reported', statement: 'The counterexample interface returns the final result from the same call', source_label: 'independent reviewer', supporting_refs: [] }],
      },
    }, 'apply-resolve'))

    const freshCheck = commit(await reviewer.run('ensemble_work', {
      action: 'record_check',
      expected_revision: await head(),
      operation_id: 'apply-check-fresh',
      payload: {
        invocation_id: nextInvocation,
        check: {
          kind: 'execution', target: lessonRef, criterion_ids: [],
          method: 'Re-ran both cases after the disposition',
          action: 'Checked the unseen case and the synchronous counterexample again',
          result: 'passed',
          evidence_refs: [counterRef, applicationRef],
          limits: 'Two reported observations',
        },
      },
    }, 'apply-check-fresh'))
    const freshCheckRef = { kind: 'object', object_id: freshCheck.ids.check.id, object_revision: freshCheck.ids.check.object_revision }

    const restoredCommand = {
      invocation_id: nextInvocation,
      lesson_ref: lessonRef,
      assessment: { kind: 'decision', status: 'supported', reason: 'The counterexample is disposed and a fresh review covers both applications', application_refs: [applicationRef, counterRef], review_ref: freshCheckRef },
    }
    const restored = commit(await lead('ensemble_learn', {
      action: 'assess_lesson', expected_revision: await head(), operation_id: 'apply-decision-restored', payload: restoredCommand,
    }, 'apply-decision-restored'))

    const restoredRead = requireOk((await lead('ensemble_read', { kind: 'lessons', domain_id: domainId, status: 'supported', text: 'completion', task_context: taskContext }, 'read-restored')).answer, 'read-restored')
    assert.equal(restoredRead.items.length, 1, `disposing the counterexample must restore the recommendation: ${String(JSON.stringify(restoredRead)).slice(0, 700)}`)
    record('next', { freshCheck: freshCheckRef, restored: restoredRead.items.length })

    // ── current authority ────────────────────────────────────────────────────
    // The capability revoked here is the `organize` delegation **this journey
    // created** for its own domain work. Revoking a grant the journey did not create
    // (the Lead's or the archive's initial one) would change the shared archive's
    // authority for later phases and hide whether *this* revocation had an effect.
    const diagnostic = requireOk(await remote('manage', {
      action: 'diagnose', project_id: projectId, expected_revision: await head(), operation_id: nextId('diagnose'), payload: { scope: 'grants' },
    }), 'diagnose')
    const grants = diagnostic.grant_ids ?? []
    assert(grants.length > 0, `diagnose must name the archive's grants: ${String(JSON.stringify(diagnostic)).slice(0, 700)}`)
    // Grant ids are opaque and the diagnostic names rights, scope and revocation
    // state — the only supported way to name a grant for `revoke`.
    const delegation = grants.filter((grant) => grant.scope === 'project' && Array.isArray(grant.rights) && grant.rights.length === 1 && grant.rights[0] === 'organize' && grant.revoked === false)
    assert.equal(delegation.length, 1, `diagnose must name exactly one live organize delegation: ${String(JSON.stringify(grants)).slice(0, 900)}`)
    requireOk(await remote('manage', {
      action: 'revoke', project_id: projectId, expected_revision: await head(), operation_id: nextId('revoke'),
      payload: { grant_id: delegation[0].grant_id, reason: 'acceptance: withdraw the organize delegation to prove current authorization' },
    }), 'revoke')
    revision = await head()

    // The same action that grant authorized is now refused for its actor, through the
    // real executor and the real Host identity: a right is current, not historical,
    // and none of the earlier domain writes are undone by the revocation.
    const afterRevoke = (await lead('ensemble_learn', {
      action: 'organize_domain',
      expected_revision: revision,
      operation_id: 'apply-after-revoke',
      payload: { invocation_id: nextInvocation, change: { kind: 'create', title: 'refused', questions: 'q', audience: 'a', overview: 'o' } },
    }, 'apply-after-revoke')).answer
    requireRefusal(afterRevoke, 'not_authorized', 'an organize action after its current grant was revoked')
    assert.equal(await head(), revision, 'a refused write must not move the head')
    record('current', {
      revokedGrant: delegation[0].grant_id, revokedRights: delegation[0].rights, revokedScope: delegation[0].scope,
      refusalCode: afterRevoke.error.code, headUnchanged: true,
    })

    // ── summary ─────────────────────────────────────────────────────────────
    const summary = {
      status: 'verified',
      ms: Date.now() - started,
      boundary: 'Only LLM token generation is deterministic; the Host, Loader composition, tools, derived native identity, archive, owner Remote, authorization epochs and receipts are the installed package.',
      paidModel: false,
      projectId,
      rootSessionId: agent.id,
      producerSession: producer.childId,
      reviewerSession: reviewer.childId,
      invocations: { work: invocation, application: nextInvocation },
      artifacts: { artifact: artifactRef, digest, bytes: textRead.total },
      steps,
    }
    evidence.learning = summary
    const file = scratch('learning')
    await mkdir(resolve(file, '..'), { recursive: true }).catch(() => {})
    await writeFile(file, JSON.stringify(summary, null, 2)).catch(() => {})
    return summary
  } finally {
    ctx.off?.('tools/result', onResult)
    for (const handle of members) await handle.dispose?.().catch(() => {})
    registration?.dispose?.()
  }
}
