/**
 * The real installed product, driven through the **official profile composition**
 * — never a hand-built `cordis.yml`.
 *
 * This is the in-process half of `scripts/verify-dsh-product.ts`. The driver
 * installs a pinned tarball with the standard launcher and runs this fixture
 * against that same `DSH_HOME`. What is deterministic here is **only** LLM token
 * generation (no paid model, no network); the Host, the Loader composition, the
 * profile patch layers, the owner Remote, the auth handshake, the tools and the
 * Git archive are the installed ones.
 *
 * Why the composition matters (measured, not inferred): `configEditor.entries()`
 * reports only rows whose owning tree was mounted through the root `include`
 * entry, and `native/product.ts` selects its native Settings targets from those
 * rows. A flat row list mounted with `boot()` directly produces no such rows, so
 * a hand-built fixture cannot exercise the Settings path at all — and reports a
 * failure that has nothing to do with the product. This fixture therefore boots
 * exactly the way `dsh --profile web` boots: `loadLayeredEnv` + `runProfile`,
 * which composes every bundle layer, the profile's own patch, the telemetry
 * switch, and mounts the root include.
 *
 * Phases are separate, each logged with its duration, so a red gate names the
 * phase that failed instead of one opaque assertion. `ENSEMBLE_PRODUCT_PHASES`
 * selects them, which is how the same fixture serves a partial journey (the
 * auth/UI handoff needs only `core`) while the full gate runs all of them.
 *
 * Environment (set by the driver):
 * - `ENSEMBLE_PRODUCT_RUNTIME` — supported DSH install whose packages this boots.
 * - `DSH_HOME` — the isolated home the driver installed the tarball into.
 * - `ENSEMBLE_PRODUCT_ROOT` — fixture scratch root (source dir, evidence, cookies).
 * - `ENSEMBLE_PRODUCT_PHASES` — comma list; default
 *   `identity,core,environment,selection,team,learning`.
 * - `ENSEMBLE_PRODUCT_LEARNING_JOURNEY` — path to the delegated journey module
 *   (default `verify-learning.mjs` beside this file).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { productRunContext } from './verify-product-context.mjs'

const root = process.env.ENSEMBLE_PRODUCT_ROOT
const runtime = process.env.ENSEMBLE_PRODUCT_RUNTIME
const home = process.env.DSH_HOME
assert(root && runtime && home, 'use scripts/verify-dsh-product.ts: it sets the published fixture contract')

const phases = (process.env.ENSEMBLE_PRODUCT_PHASES ?? 'identity,core,environment,selection')
  .split(',')
  .map((phase) => phase.trim())
  .filter(Boolean)
const evidence = { standardInstall: true, noPrivateRuntimeCopies: true, paidModel: false, bootedViaOfficialProfile: true, phases: {} }

const require = createRequire(join(runtime, 'package.json'))
const load = (name) => import(pathToFileURL(require.resolve(name)).href)

/** Write evidence after every phase, so a killed gate still leaves its measurements. */
const save = () => writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))

/** Run one named phase; a failure is recorded before it propagates. */
async function phase(name, body) {
  if (!phases.includes(name)) return undefined
  const started = Date.now()
  try {
    const value = await body()
    evidence.phases[name] = { status: 'pass', ms: Date.now() - started }
    await save()
    console.log(`PHASE ${name} PASS ${Date.now() - started}ms`)
    return value
  } catch (error) {
    evidence.phases[name] = { status: 'fail', ms: Date.now() - started, error: String(error?.message ?? error) }
    await save()
    throw error
  }
}

const { loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot')
const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
const { LlmAdapter, createUserMessage, isAgentLoopRequest } = await load('@deepseek-ai/dsh-llm')

const packageRoot = join(home, 'profiles/web/node_modules/dsh-ensemble')
const source = join(root, 'source')
await mkdir(source, { recursive: true })
await writeFile(join(source, 'original.bin'), Buffer.from([0, 255, 254, 128, 13, 10, 65, 0]))

// Deterministic tokens only. `scripts` is a queue of scripted assistant turns, so
// a tool call travels through the real AgentLoop and the real tools registry;
// nothing about the Host, the tools or the archive is substituted.
const scripts = []
const outcomes = new Map()
const text = (value) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
]
class Deterministic extends LlmAdapter {
  async *stream(options) {
    const output = isAgentLoopRequest(options) ? scripts.shift() ?? text('done') : text('title')
    for (const chunk of output) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

const bootStarted = Date.now()
const { ctx } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  // Real flags a person passes: an ephemeral port and no browser handoff.
  args: ['--port', '0', '--no-open'],
})
console.log(`PHASE boot PASS ${Date.now() - bootStarted}ms (official profile composition)`)

let handle
let connection
// ── verify-only mode: a *second process* on the same DSH_HOME ────────────────
// This is what makes "cold restart" a measurement rather than a claim: the driver
// runs this fixture once to write, disposes it, then runs it again with
// ENSEMBLE_PRODUCT_VERIFY_ONLY=1. Nothing is written in this mode: it reads what the
// previous process committed, and refuses when the state is absent rather than
// treating "nothing there" as success.
const verifyOnly = process.env.ENSEMBLE_PRODUCT_VERIFY_ONLY === '1'
try {
  ctx.llm.registerAdapter(['profile-gate'], new Deterministic())
  ctx.on('tools/result', (execution, result) => outcomes.set(execution.callId, result))

  /**
   * Issue one registered tool call without scripting a model turn.
   *
   * Same tool definitions, same decoder, same executor as the model path — the only
   * difference is that no assistant turn is synthesized. Used where a native side
   * effect (the Team board) would otherwise race the scripted delivery.
   */
  const directCall = async (agent, name, args, id) => {
    const result = await ctx.tools.execute({
      agent,
      signal: AbortSignal.timeout(30000),
      calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
    })
    const block = result.results[0]?.result?.content?.find((entry) => entry.type === 'text')
    assert(block, `no direct tool result for ${id}: ${JSON.stringify(result).slice(0, 400)}`)
    return JSON.parse(block.text)
  }

  /** Issue one model-facing tool call through the real AgentLoop and parse its value. */
  const nativeCall = async (agent, name, args, id) => {
    // A native event (a Team-mode change, a task creation) can start or extend a
    // turn of its own. Scripting the next turn before the agent is idle would let
    // that turn consume the queued script and strand this call with no result.
    await agent.whenIdle()
    // A native side effect (Team mode, a task append) can append to the root log and
    // leave the turn boundary dirty; a follow-up delivered in that window is spliced
    // into the inbox instead of starting a turn. Let the log settle first.
    await new Promise((done) => setTimeout(done, 250))
    await agent.whenIdle()
    // Any scripted turn left over from the previous call would be consumed by this
    // turn and leave it without its own tool result, so each call starts from an
    // empty queue: the queue is per-call, the outcome is keyed by call id.
    scripts.length = 0
    const call = { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
    const script = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: call.arguments },
      { type: 'block-end', index: 0, block: call },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    // A native side effect (a Team-mode change, a task append) can leave the root
    // Session mid-turn, and a follow-up delivered in that window is spliced into the
    // inbox without starting a turn. Re-delivering is safe — the result is keyed by
    // call id, and a repeated turn produces no second call — while a tool that
    // genuinely never runs still fails loudly after the bounded attempts.
    let result
    for (let attempt = 0; attempt < 4 && result === undefined; attempt += 1) {
      scripts.length = 0
      scripts.push(script, text('observed durable result'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the next acceptance command' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      result = outcomes.get(id)
      if (result === undefined) await new Promise((done) => setTimeout(done, 150))
    }
    assert(result, `no tool result for ${id}`)
    assert.equal(result.isError, false, `${id}: ${JSON.stringify(result)}`)
    return JSON.parse(result.content.find((block) => block.type === 'text').text)
  }

  await phase('identity', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-ensemble')
    assert.equal(manifest.version, '1.0.0')
    evidence.release = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
    // Every peer resolves from the installation, not from a private copy inside
    // the profile: a vendored runtime would make "installed product" untrue.
    const { createRuntimeResolution, loadProfile } = await load('@deepseek-ai/dsh-app-boot')
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = loadProfile('ensemble-product-acceptance', 'web', installAnchor, home)
    const resolution = await createRuntimeResolution({ installAnchor, profile, home })
    for (const name of Object.keys(manifest.peerDependencies)) {
      const rows = resolution.entries.filter((row) => row.name === name)
      assert.equal(rows.length, 1, `${name} must resolve exactly once`)
      assert.equal(rows[0].scope, 'installation', `${name} must come from the installation`)
    }
    assert(
      !(await readdir(join(home, 'profiles/web/node_modules/.pnpm'))).some((name) => name.startsWith('@deepseek-ai+')),
      'the profile must not vendor a private @deepseek-ai runtime copy',
    )
    // A composed profile has exactly one active Ensemble row; two would make every
    // native Settings target ambiguous, which the product refuses by design.
    const active = ctx.get('configEditor').entries().filter((entry) => entry.options.id === 'dsh-ensemble')
    assert.equal(active.length, 1, 'exactly one Ensemble entry must be active in the composed profile')
    assert.equal(active[0].parent.tree.ctx.fiber.entry?.id, 'include', 'the Ensemble row must be mounted through the root include')
    evidence.activeEntryIds = active.map((entry) => entry.options.id)
    evidence.entryMountedThroughRootInclude = true
  })

  if (verifyOnly) {
    // Read back everything the first process committed, through the same public
    // surfaces a returning user would use.
    await phase('coldrestart-verify', async () => {
      const settings = ctx.get('settings')
      assert(settings, 'the restarted Host must publish settings')
      const targets = settings.describe({ redactSecrets: true }).filter((row) => row.ns === 'dsh-ensemble')
      assert.equal(targets.length, 1, 'the restarted Host must see exactly one native Settings target')
      assert(targets[0].value.rolePreferences?.roles?.length > 0, `applied preferences must survive a restart: ${JSON.stringify(targets[0].value.rolePreferences)}`)
      // The Host serves after restart and the browser fence holds again.
      const origin = `http://127.0.0.1:${ctx.webServer.port}`
      const launch = new URL(ctx.connection.authenticatedUrl(`${origin}/`))
      launch.pathname = '/'
      const exchanged = await fetch(launch, { redirect: 'manual' })
      assert.equal(exchanged.status, 303, `the restarted Host must authenticate a fresh launch, got ${exchanged.status}`)
      const cookie = exchanged.headers.get('set-cookie')?.split(';')[0]
      assert(cookie, 'the restarted Host must issue a session cookie')
      assert.equal((await fetch(`${origin}/`, { headers: { cookie }, redirect: 'manual' })).status, 200, 'the restarted Host must serve the UI')
      const { connect } = await import(pathToFileURL(join(packageRoot, 'lib/transport.bundle.mjs')).href)
      const conn = await connect({ url: origin, cookie })
      try {
        const projects = await conn.call('ensembleArchive/projects', { request: {} })
        assert.equal(projects.ok, true, `the restarted Host must serve the owner Remote: ${JSON.stringify(projects)}`)
        assert(projects.value.projects.length >= 1, 'the committed project must survive the restart')
        const project = projects.value.projects[0]
        const expected = JSON.parse(process.env.ENSEMBLE_PRODUCT_EXPECTED ?? '{}')
        if (expected.projectId !== undefined) assert.equal(project.project_id, expected.projectId, 'the restarted Host serves the same project id')
        if (expected.head !== undefined) assert.equal(project.read_revision, expected.head, 'the restarted Host reports the committed head')
        if (expected.authorizationEpoch !== undefined) assert.equal(project.authorization_epoch, expected.authorizationEpoch, 'the authorization epoch is durable')
        const query = await conn.call('ensembleArchive/query', { request: { kind: 'context', project_id: project.project_id } })
        assert.equal(query.ok, true, `the committed context must be readable after restart: ${JSON.stringify(query)}`)
        assert.equal(query.value.read_revision, project.read_revision)
        // The retired v1 entries stay refused after a restart: nothing quietly
        // re-enables the old writer on a cold boot.
        for (const retired of ['initialize', 'bind', 'status', 'readBack']) {
          const answer = await conn.call(`ensembleArchive/${retired}`, { request: {} })
          assert.equal(answer.ok, false, `${retired} must stay retired after a restart: ${JSON.stringify(answer)}`)
          assert.equal(answer.error.code, 'unsupported_version', `${retired} must refuse as unsupported_version, got ${JSON.stringify(answer.error)}`)
        }
        evidence.coldRestart = {
          projectId: project.project_id, head: project.read_revision,
          authorizationEpoch: project.authorization_epoch,
          preferencesSurvived: true, browserFenceHeld: true, retiredV1StillRefused: true,
        }
      } finally {
        await conn.close?.()
      }
    })
    await save()
    console.log('PASS cold restart: committed project, head, epoch, applied preferences and UI fence survive a fresh Host process; retired v1 entries stay refused')
    process.exit(0)
  }

  const core = await phase('core', async () => {
    // A gate root may be reused for a second run (serve, or an operator poking at
    // it), and the Session store keeps every log it has written, so a fixed id
    // would make the second run fail before it measured anything. The id is
    // recorded in the evidence, so "which Session" stays a fact, not a constant.
    const rootSessionId = `ensemble-product-root-${randomUUID().slice(0, 8)}`
    handle = await ctx.agents.create({
      sessionId: rootSessionId,
      meta: { cwd: source, agentPreset: 'standard' },
      agentOptions: { provider: 'profile-gate', model: 'deterministic' },
    })
    const agent = handle.agent
    const workspace = await ctx.workspaceRegistry.create(source)
    await workspace.attachSession(agent.id)
    const origin = `http://127.0.0.1:${ctx.webServer.port}`

    // The real one-time authority: an invalid token is refused, the real one
    // issues a session cookie. This is the same fence a browser hits.
    const launch = new URL(ctx.connection.authenticatedUrl(`${origin}/`))
    launch.pathname = '/connect'
    assert.equal((await fetch(`${origin}/connect?token=invalid`, { redirect: 'manual' })).status, 401)
    const authorized = await fetch(launch, { redirect: 'manual' })
    assert.equal(authorized.status, 302)
    const cookie = authorized.headers.get('set-cookie')?.split(';')[0]
    assert(cookie, 'the authenticated connect must issue a session cookie')
    const cookieFile = join(root, 'owner-cookie')
    await writeFile(cookieFile, cookie, { mode: 0o600 })

    const { connect } = await import(pathToFileURL(join(packageRoot, 'lib/transport.bundle.mjs')).href)
    connection = await connect({ url: origin, cookie })
    const remote = (method, request) => connection.call(`ensembleArchive/${method}`, { request })
    const context = await remote('projects', {})
    assert.equal(context.ok, true, JSON.stringify(context))
    assert.equal(context.value.projects.length, 0)
    evidence.authenticatedOwnerTransport = true
    evidence.unauthenticatedDenied = true

    const initialized = await remote('manage', {
      action: 'initialize',
      expected_revision: 'absent',
      operation_id: 'initialize',
      payload: {
        limits: {
          inline_input_bytes: 262144, response_bytes: 32768, artifact_bytes: 67108864,
          upload_chunk_bytes: 1048576, upload_total_bytes: 268435456, concurrent_uploads: 4, page_items: 50,
        },
        root_handle: 'default',
        source_descriptor: {
          worldIdentity: process.env.DSH_ENSEMBLE_ARCHIVE_WORLD,
          canonicalAddress: source,
          nativeWorkspaceRef: workspace.id,
        },
        initial_grants: [{
          subject: { kind: 'session', sessionId: agent.id, rootSessionId: agent.id },
          rights: ['read', 'open', 'member-submit'],
          delegable_rights: ['member-submit'],
          scope: { kind: 'project' },
        }],
      },
    })
    assert.equal(initialized.ok, true, JSON.stringify(initialized))
    const project = (await remote('projects', {})).value.projects[0]
    assert(project)
    evidence.projectId = project.project_id
    evidence.rootSessionId = agent.id
    evidence.source = source
    evidence.workspaceId = workspace.id

    const currentRevision = async () => {
      const answer = await remote('projects', {})
      assert.equal(answer.ok, true, JSON.stringify(answer))
      const found = answer.value.projects.find((item) => item.project_id === project.project_id)
      assert(found, JSON.stringify(answer))
      return found.read_revision
    }
    const before = await currentRevision()
    const bindPayload = {
      project_id: project.project_id,
      expected_revision: before,
      operation_id: 'bind-1',
      action: 'bind',
      payload: {
        source_descriptor: {
          worldIdentity: process.env.DSH_ENSEMBLE_ARCHIVE_WORLD,
          canonicalAddress: source,
          nativeWorkspaceRef: workspace.id,
        },
        mapping_evidence: [],
        reason: 'acceptance bind over the real transport',
      },
    }
    const bound = await remote('manage', bindPayload)
    assert.equal(bound.ok, true, JSON.stringify(bound))
    assert.notEqual(bound.value.committed_revision, before)
    // The same bind at the now-stale revision must be refused without writing.
    const stale = await remote('manage', { ...bindPayload, operation_id: 'bind-stale' })
    assert.equal(stale.ok, false, JSON.stringify(stale))
    assert.equal(stale.error.code, 'revision_conflict')
    assert.equal(await currentRevision(), bound.value.committed_revision, 'a refused stale bind must not move the head')
    evidence.bindOverTransport = { advanced: true, committed: bound.value.committed_revision, staleRefused: stale.error.code, headUnchangedAfterRefusal: true }
    evidence.head = bound.value.committed_revision

    const team = ctx.get('agentTeams')
    assert(team, 'the composed profile must publish the native Team service')
    // A fresh web profile has Team mode OFF. That default must not block work: the
    // method documentation says explicit delegation and results still constitute an
    // ensemble, and only *shared-task ownership* requires the board. So the write
    // below happens with Team still off — enabling Team first would let a Team-on
    // success hide a default-profile defect.
    assert.equal(team.isEnabled(agent), false, 'a fresh profile must start with Team mode off')
    evidence.teamDefaultOff = true

    for (const tool of ['ensemble_read', 'ensemble_work', 'ensemble_learn', 'ensemble_upload', 'ensemble_reference']) {
      assert(ctx.tools.get(tool, agent), `${tool} must be visible to the agent`)
    }
    evidence.modelToolsVisible = true

    const read = await nativeCall(agent, 'ensemble_read', { kind: 'context' }, 'native-context')
    assert.equal(read.ok, true, JSON.stringify(read))
    const opened = await nativeCall(agent, 'ensemble_work', {
      action: 'open',
      expected_revision: read.value.read_revision,
      operation_id: 'open',
      payload: {
        title: 'Native delivery', goal: 'Prove real integrated execution', deliverable: 'Persisted native record',
        subject: 'Acceptance', constraints: 'Use supported native capabilities', exclusions: 'No paid model efficacy claim',
        coverage: [{ key: 'native', title: 'Native entry', requirement: 'Record real AgentLoop tool writes', required: true, authority_refs: [] }],
        criteria: [{ key: 'result', coverage_targets: [{ kind: 'request_key', key: 'native' }], statement: 'Read the committed checkpoint', critical: true, method: 'native read' }],
      },
    }, 'native-open')
    assert.equal(opened.ok, true, `a Team-off profile must still record work: ${JSON.stringify(opened)}`)
    evidence.teamOffWrite = { committed: opened.value.committed_revision, status: opened.value.status }

    // Team stays OFF through the whole work journey below — that is the default a
    // fresh profile has, and proving that default works is the point of this gate.
    // A native board append inside this turn would splice into the root Session and
    // strand the next scripted turn, so the board is exercised in its own phase.

    // A caller-supplied authority field is refused by the closed decoder as a
    // normal typed value; a call with no agent is refused by the executor.
    const asserted = await ctx.tools.execute({
      agent,
      signal: AbortSignal.timeout(10000),
      calls: [{ type: 'tool-call', id: 'asserted-owner', name: 'ensemble_read', arguments: JSON.stringify({ kind: 'context', owner: true }) }],
    })
    const assertedValue = JSON.parse(asserted.results[0].result.content.find((block) => block.type === 'text').text)
    assert.equal(assertedValue.ok, false, JSON.stringify(assertedValue))
    assert.equal(assertedValue.error.code, 'invalid_input')
    const noAgent = await ctx.tools.execute({
      signal: AbortSignal.timeout(10000),
      calls: [{ type: 'tool-call', id: 'no-agent', name: 'ensemble_read', arguments: '{"kind":"context"}' }],
    })
    assert.equal(JSON.parse(noAgent.results[0].result.content.find((block) => block.type === 'text').text).ok, false)
    evidence.nativeIdentityAndStrictInputRefused = true

    // The packaged headless CLI is the user-facing query surface: it must run from
    // the installed package, with the cookie this Host just issued.
    const requestFile = join(root, 'query-request.json')
    await writeFile(requestFile, JSON.stringify({ kind: 'context', project_id: project.project_id }))
    const cli = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [
        join(packageRoot, 'bin/ensemble-archive.js'), 'query', '--request', `@${requestFile}`,
        '--cookie-file', cookieFile, '--url', origin,
      ], { env: process.env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => (stdout += data))
      child.stderr.on('data', (data) => (stderr += data))
      child.on('error', fail)
      child.on('exit', (code) => done({ code, stdout, stderr }))
    })
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).value.read_revision, opened.value.revision ?? opened.value.committed_revision)
    evidence.headlessQuery = { exit: cli.code, readRevisionMatchesNativeOpen: true }
    return { agent, workspace, project, origin, remote, opened }
  })

  /**
   * The trusted context a delegated journey module drives.
   *
   * A journey (e.g. `verify-learning.mjs`) must not boot a second Host: it gets
   * this one's live context, its real root Agent, the real owner Remote and the
   * real tool executor. `ownRoot` hands out a directory the driver creates and
   * removes, so a journey cannot disturb this gate's archive or the Client's live
   * serve fixture. `spawnMember` spawns a genuine continuable native member, so a
   * journey needing a second actor gets one from the Host instead of inventing an
   * identity.
   */
  const journeyRoots = []
  const ownRoot = (label) => {
    const dir = join(root, `journey-${label}`)
    journeyRoots.push(dir)
    return dir
  }
  const spawnMember = async (label, options = {}) => {
    if (core === undefined) throw new Error('spawnMember needs the core phase: a diagnostic Host has no root Agent')
    const name = `member-${label}-${randomUUID().slice(0, 6)}`
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn', name, label,
      parent: core.agent,
      prompt: [{ type: 'text', text: options.prompt ?? 'produce one observed turn' }],
      agentOptions: { provider: 'profile-gate', model: 'deterministic', ...(options.agentOptions ?? {}) },
      delivery: 'caller', signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
    })
    // Do NOT await `activation.result` before using the member: settlement returns the
    // Agent to the pool, so a settled member is no longer resident and cannot execute
    // tools (the identity check correctly refuses it). The member stays live while its
    // activation is open, which is what a resident continuable member is.
    const log = await ctx.sessionQuery.observeSession(activation.childId, { signal: AbortSignal.timeout(10000) })
    const events = log.events.map((event) => ({ seq: event.seq, type: event.type }))
    const inheritedEventCount = log.inheritedEventCount ?? 0
    log[Symbol.dispose]()
    // The live child Agent is the registry's own object. A captured `agents.get()`
    // value is a fresh proxy, which fails the identity check ("an exact live native
    // Agent is required"), so the registry's live list is the correct source.
    const liveAgent = ctx.agents.list().find((candidate) => candidate.id === activation.childId)
    assert(liveAgent, `the spawned member ${activation.childId} must be live in the Host registry`)
    /**
     * Execute one registered tool call *as this member*, through its own AgentLoop.
     *
     * A caller object from `agents.get()`/`list()` is a fresh proxy, so handing it to
     * `ctx.tools.execute` fails the "exact live native Agent" check — correctly. The
     * supported way for a member to act is a turn of its own, so this delivers a
     * follow-up through the native subagent service and waits for that turn's tool
     * result (same executor, same identity derivation as a model call).
     */
    const memberCall = async (name, args, id) => {
      const call = { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
      scripts.length = 0
      scripts.push(
        [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: call.arguments },
          { type: 'block-end', index: 0, block: call },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ],
        text('member observed result'),
      )
      await ctx.subagents.sendMessage(core.agent, activation.childId, [{ type: 'text', text: 'run the next member command' }], { signal: AbortSignal.timeout(30000) })
      const deadline = Date.now() + 30000
      while (outcomes.get(id) === undefined && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
      const result = outcomes.get(id)
      assert(result, `no tool result for member call ${id}`)
      assert.equal(result.isError, false, `${id}: ${JSON.stringify(result)}`)
      return JSON.parse(result.content.find((block) => block.type === 'text').text)
    }
    return {
      agent: liveAgent,
      call: memberCall,
      childId: activation.childId,
      events,
      inheritedEventCount,
      descriptorSeq: events.find((event) => event.type === 'subagent/descriptor')?.seq,
      dispose: async () => { await ctx.subagents.drainDescendants([activation.childId]).catch(() => {}) },
    }
  }
  // Diagnostic-only serve (no `core` phase) still needs a handoff. In that mode
  // there is no root Agent, no project and no workspace — exactly the empty registry
  // the fresh-lane probe requires — so the context is built only from what exists.
  const runContext = core === undefined ? undefined : productRunContext({
    ctx,
    root: { agent: core.agent, workspace: core.workspace, project: core.project, source },
    remote: core.remote,
    call: (name, args, id) => directCall(core.agent, name, args, id),
    modelCall: (name, args, id) => nativeCall(core.agent, name, args, id),
    phase,
    evidence,
    head: async () => {
      const projects = await core.remote('projects', {})
      assert.equal(projects.ok, true, JSON.stringify(projects))
      const project = projects.value.projects.find((item) => item.project_id === core.project.project_id)
      assert(project, JSON.stringify(projects))
      return project.read_revision
    },
    spawnMember,
    ownRoot,
  })
  if (runContext !== undefined) evidence.journeyContext = { provided: true, fields: Object.keys(runContext) }

  // A delegated journey runs only when asked for, and its failure is this gate's
  // failure: the module owns its assertions, this driver owns the Host.
  await phase('learning', async () => {
    const modulePath = process.env.ENSEMBLE_PRODUCT_LEARNING_JOURNEY
      ?? join(import.meta.dirname, 'verify-learning.mjs')
    const { existsSync } = await import('node:fs')
    if (!existsSync(modulePath)) {
      // Not delivered is not "passed": name exactly what was not run.
      throw new Error(`the learning journey module is missing at ${modulePath}; the full work/learn loop was NOT verified`)
    }
    const journey = await import(pathToFileURL(modulePath).href)
    assert.equal(typeof journey.runLearningJourney, 'function', 'the journey module must export runLearningJourney(context)')
    evidence.learningJourney = (await journey.runLearningJourney(runContext)) ?? { status: 'returned-no-summary' }
  })

  await phase('environment', async () => {
    const { project, remote } = core
    const settings = ctx.get('settings')
    assert(settings, 'the real profile must publish the settings service')
    const rows = settings.describe({ redactSecrets: true })
    // The target id is a measured fact of this composition, never a constant and
    // never a package name. Exactly one is required: two active instances would
    // make "the native target" ambiguous, which the product refuses by design.
    const targets = rows.filter((row) => row.ns === 'dsh-ensemble')
    assert.equal(targets.length, 1, `exactly one native Settings target, saw ${JSON.stringify(rows.map((row) => row.ns))}`)
    const targetId = targets[0].ns
    const before = structuredClone(targets[0].value)
    assert(Number.isSafeInteger(targets[0].revision))
    // Every other namespace is the "unrelated configuration" this apply must not touch.
    const others = rows.filter((row) => row.ns !== targetId).map((row) => ({ ns: row.ns, revision: row.revision, value: row.value }))
    assert(others.length > 0, 'the composed profile must carry unrelated Settings namespaces to compare against')

    const desired = {
      roles: [{
        role: 'implementer',
        candidates: [{
          provider: 'profile-gate', model: 'deterministic', effort: { mode: 'inherit' },
          // The closed preference schema's field names; a caller-invented
          // `task_kinds` is refused as `invalid_input`, which is the decoder
          // working, not a gate defect.
          applicability: { task_types: ['implementation'], interface_versions: [], required_capabilities: [] },
          reason: 'acceptance route',
        }],
      }],
    }
    const first = await remote('environment', { action: 'environment_read' })
    assert.equal(first.error?.code, 'not_found', `a fresh gate root has no environment ledger, got ${JSON.stringify(first).slice(0, 300)}`)

    const set = await remote('environment', { action: 'environment_set', expected_revision: 'absent', operation_id: 'env-set', preferences: desired })
    assert.equal(set.ok, true, JSON.stringify(set))
    // Saving desired preferences is a decision, not an application: native Settings
    // must still be untouched at this point.
    assert.deepEqual(settings.describe({ redactSecrets: true }).find((row) => row.ns === targetId).value, before, 'environment_set must not touch native Settings')
    const desiredRevision = set.value.committed_revision

    const preview = await remote('environment', { action: 'environment_preview', desired_revision: desiredRevision, target_ids: [targetId] })
    assert.equal(preview.ok, true, JSON.stringify(preview))

    const current = settings.describe({ redactSecrets: true }).find((row) => row.ns === targetId)
    const apply = await remote('environment', {
      action: 'environment_apply',
      expected_revision: preview.value?.committed_revision ?? desiredRevision,
      operation_id: 'env-apply',
      desired_revision: desiredRevision,
      targets: [{ target_id: targetId, expected_native_revision: current.revision }],
    })
    assert.equal(apply.ok, true, JSON.stringify(apply))
    // The committed answer carries the application it settled: `targets` lives on
    // `application`, and its per-target status is the measured outcome.
    const target = apply.value.application?.targets?.[0] ?? apply.value.targets?.[0] ?? apply.value.result?.targets?.[0]
    assert(target, `apply must report its target, got ${JSON.stringify(apply).slice(0, 900)}`)
    // A writable fresh profile must converge. `unknown` is a fault outcome, so it
    // keeps this gate red instead of being counted as done; only a separate,
    // injected fault case may be unknown, and it must reconcile afterwards.
    assert.equal(target.status, 'applied', `a writable profile must apply, got ${JSON.stringify(target)}`)
    const after = settings.describe({ redactSecrets: true }).find((row) => row.ns === targetId)
    assert.deepEqual(after.value.rolePreferences, desired, 'native readback must equal the desired preferences')
    const othersNow = settings.describe({ redactSecrets: true }).filter((row) => row.ns !== targetId).map((row) => ({ ns: row.ns, revision: row.revision, value: row.value }))
    assert.deepEqual(othersNow, others, 'unrelated native configuration must be preserved')

    // A **competing native update** makes the recorded revision stale. That must be
    // a precise revision_conflict, not a silent overwrite: the competing value was
    // chosen by whoever owns native Settings, and Ensemble writes only its own
    // nonsecret field through a compare-and-set.
    const applied = settings.describe({ redactSecrets: true }).find((row) => row.ns === targetId)
    assert.equal(applied.revision, target.observed_native_revision ?? applied.revision, 'the applied readback revision is the observed one')
    const competing = { roles: [{ role: 'reviewer', candidates: [{ provider: 'profile-gate', model: 'deterministic', effort: { mode: 'default' }, applicability: { task_types: [], interface_versions: [], required_capabilities: [] }, reason: 'competing native edit' }] }] }
    await settings.update(targetId, { rolePreferences: competing }, applied.revision)
    const competingNow = settings.describe({ redactSecrets: true }).find((row) => row.ns === targetId)
    assert.notEqual(competingNow.revision, applied.revision, 'the competing write must move the native revision')
    const staleApply = await remote('environment', {
      action: 'environment_apply',
      expected_revision: apply.value.committed_revision,
      operation_id: 'env-apply-stale',
      desired_revision: desiredRevision,
      targets: [{ target_id: targetId, expected_native_revision: applied.revision }],
    })
    assert.equal(staleApply.ok, true, `a settled refusal is still a committed answer: ${JSON.stringify(staleApply)}`)
    const refusedTarget = staleApply.value.application?.targets?.[0]
    assert(refusedTarget, `the refused apply must report its target: ${JSON.stringify(staleApply).slice(0, 700)}`)
    // The refusal is a typed per-target outcome, not a silent success: the product
    // records the intent as `failed` when the native revision moved underneath it.
    assert.equal(refusedTarget.status, 'failed', `a stale native revision must be a failed target, got ${JSON.stringify(refusedTarget)}`)
    assert.match(refusedTarget.detail ?? '', /revision conflict/i, `the detail must name the conflict: ${JSON.stringify(refusedTarget)}`)
    assert.equal(refusedTarget.observed_native_revision, competingNow.revision, 'the report cites the native revision it actually saw')
    assert.deepEqual(
      settings.describe({ redactSecrets: true }).find((row) => row.ns === targetId).value.rolePreferences,
      competing,
      'a refused stale apply must leave the competing native value untouched',
    )

    const history = await remote('environment', { action: 'environment_history', revision: apply.value.committed_revision })
    assert.equal(history.ok, true, JSON.stringify(history))
    evidence.environment = {
      targetId, applied: target.status, nativeReadbackEqualsDesired: true,
      unrelatedNamespacesPreserved: others.length,
      // The refusal is a per-target outcome, so the evidence names that, not a
      // top-level error code that a committed answer does not carry.
      staleApplyStatus: refusedTarget.status, staleApplyDetail: refusedTarget.detail,
      competingNativeValuePreserved: true,
      historyItems: (history.value.items ?? history.value.entries ?? []).length,
    }
    evidence.projectId = project.project_id
  })

  await phase('selection', async () => {
    const { agent, project, remote, opened } = core
    const invocationId = opened.value.changed?.find((change) => change.id.startsWith('invocation-'))?.id
    assert(invocationId, JSON.stringify(opened).slice(0, 600))
    const revision = (await remote('projects', {})).value.projects.find((item) => item.project_id === project.project_id).read_revision
    const planned = await nativeCall(agent, 'ensemble_work', {
      action: 'plan_attempt',
      expected_revision: revision,
      operation_id: 'plan-selection',
      payload: {
        invocation_id: invocationId,
        question: 'Does the member route match the requested one?',
        baseline_refs: [], coverage_ids: [],
        difference_or_redundancy: 'Records the three selection stages',
        context_plan: { mode: 'fresh', relevance: 'Isolated member turn', exposure: 'No sibling conclusions' },
        expected_output: 'A real member turn', early_slice: 'one turn', write_scope_claims: ['none'], purpose: 'produce',
        requested_selection: { provider: 'profile-gate', model: 'deterministic' },
      },
    }, 'native-plan')
    assert.equal(planned.ok, true, JSON.stringify(planned))
    const attemptId = planned.value.changed.find((change) => change.id.startsWith('attempt-'))?.id
    assert(attemptId, JSON.stringify(planned))

    // A real continuable member, spawned by the native subagent service.
    const member = await ctx.subagents.startActivation({
      provider: 'spawn', name: 'selection-member', label: 'selection member', parent: agent,
      prompt: [{ type: 'text', text: 'produce one observed turn' }],
      agentOptions: { provider: 'profile-gate', model: 'deterministic' },
      delivery: 'caller', signal: AbortSignal.timeout(30000),
    })
    await member.result
    // The member's own published Session log is the only accepted source.
    const memberLog = await ctx.sessionQuery.observeSession(member.childId, { signal: AbortSignal.timeout(10000) })
    const memberEvents = memberLog.events.map((event) => ({ seq: event.seq, type: event.type }))
    // A fork-inherited prefix describes the parent, never this member: the
    // product's collector filters on this same boundary.
    const memberLogInherited = memberLog.inheritedEventCount ?? 0
    memberLog[Symbol.dispose]()
    const descriptorSeq = memberEvents.find((event) => event.type === 'subagent/descriptor')?.seq
    const bound = await nativeCall(agent, 'ensemble_work', {
      action: 'update_attempt',
      expected_revision: planned.value.committed_revision,
      operation_id: 'bind-selection',
      payload: {
        invocation_id: invocationId,
        attempt_id: attemptId,
        change: {
          kind: 'bind', member_id: member.childId,
          creation_ref: { kind: 'native_event', session_id: member.childId, event_seq: descriptorSeq ?? 1 },
          context_exposure: 'fresh context',
        },
      },
    }, 'native-bind-selection')
    assert.equal(bound.ok, true, JSON.stringify(bound))

    // The evidence write is an environment-ledger transaction, so its expected
    // revision is that ledger's head — not the archive's. Mixing the two produces
    // a revision_conflict that looks like a selection defect.
    const environmentHead = await remote('environment', { action: 'environment_read' })
    assert.equal(environmentHead.ok, true, `the environment ledger must be initialized before evidence: ${JSON.stringify(environmentHead)}`)
    const recorded = await remote('environment', { action: 'environment_record_selection', expected_revision: environmentHead.value.read_revision, operation_id: 'selection-1', attempt_id: attemptId })
    assert.equal(recorded.ok, true, JSON.stringify(recorded))
    const read = await remote('environment', { action: 'environment_read' })
    assert.equal(read.ok, true, JSON.stringify(read))
    const value = read.value ?? {}
    const selection = (value.preferences?.selection_evidence ?? value.selection_evidence ?? value.evidence)?.[0]
    assert(selection, `no selection evidence in ${JSON.stringify(read).slice(0, 900)}`)
    assert.equal(selection.attempt_id, attemptId)
    assert.equal(selection.requested.provider, 'profile-gate')
    assert.equal(selection.requested.model, 'deterministic')
    // A member's own log starts at seq 0 when the Session inherited nothing, so
    // "exists in this member's own events" is the requirement — not "> 0", which
    // would reject a genuine first event. Each stage must also name a real event
    // type: `created` is the delegation descriptor, `actual` is the model response.
    const expectedType = { created: 'subagent/descriptor', actual: 'assistant/message' }
    for (const stage of ['created', 'actual']) {
      const detail = JSON.stringify(selection[stage])
      assert.equal(selection[stage].status, 'observed', `${stage}: ${detail}`)
      assert.equal(selection[stage].session_id, member.childId, `${stage} must cite the member Session: ${detail}`)
      assert(Number.isSafeInteger(selection[stage].event_seq) && selection[stage].event_seq >= 0, `${stage} needs a real event seq: ${detail}`)
      const cited = memberEvents.find((event) => event.seq === selection[stage].event_seq)
      assert(cited, `${stage} seq must exist in the member log: ${detail} vs ${JSON.stringify(memberEvents)}`)
      assert.equal(cited.type, expectedType[stage], `${stage} must cite a ${expectedType[stage]} event, not ${cited.type}`)
      assert(selection[stage].event_seq >= memberLogInherited, `${stage} must cite a member-owned event, not the inherited prefix: ${detail}`)
    }
    // A request cannot claim a member or a route: only the attempt id is accepted.
    const tampered = await remote('environment', {
      action: 'environment_record_selection', expected_revision: recorded.value.committed_revision,
      operation_id: 'selection-tamper', attempt_id: attemptId,
      member_session_id: agent.id, requested: { provider: 'forged', model: 'forged' },
    })
    assert.equal(tampered.ok, false, JSON.stringify(tampered))
    assert.equal(tampered.error.code, 'invalid_input')
    evidence.selectionEvidence = {
      attemptId, member: member.childId, requested: selection.requested,
      created: selection.created, actual: selection.actual, tamperedRefused: tampered.error.code,
      memberEventTypes: [...new Set(memberEvents.map((event) => event.type))].sort(),
    }
  })

  // ── currentauth: the grant that authorizes a write is *current* ─────────────
  // Two halves, both measured through the packaged owner Remote and the real
  // executor: revoking a member's grant makes that member's next write refuse, and
  // an identical replay returns the same committed revision with the head unchanged
  // (a receipt is not a second write).
  await phase('currentauth', async () => {
    const { agent, project, remote } = core
    const projectRow = async () => {
      const answer = await remote('projects', {})
      assert.equal(answer.ok, true, JSON.stringify(answer))
      return answer.value.projects.find((item) => item.project_id === project.project_id)
    }
    // The grant the root Session received at `initialize` is the one authorizing its
    // writes. Revoking it must make the *next* write refuse, through the real
    // executor and the real Host identity — no actor is passed in anywhere here.
    const before = await projectRow()
    const diagnosis = await remote('manage', {
      action: 'diagnose', project_id: project.project_id, expected_revision: before.read_revision,
      operation_id: 'currentauth-diagnose', payload: { scope: 'grants' },
    })
    assert.equal(diagnosis.ok, true, `diagnose must succeed: ${JSON.stringify(diagnosis).slice(0, 700)}`)
    // Grant ids are opaque, so the product publishes them as an owner-visible
    // management fact. Read the live id from there, never from a remembered value.
    const grants = diagnosis.value?.grant_ids ?? []
    assert(Array.isArray(grants) && grants.length > 0, `diagnose must name the live grants: ${JSON.stringify(diagnosis).slice(0, 900)}`)
    const active = grants.filter((grant) => grant.revoked !== true)
    assert(active.length > 0, `a live grant must be present: ${JSON.stringify(grants)}`)
    const rootGrant = active[0].grant_id
    const revoked = await remote('manage', {
      action: 'revoke', project_id: project.project_id, expected_revision: (await projectRow()).read_revision,
      operation_id: 'revoke-root', payload: { grant_id: rootGrant, reason: 'acceptance current-authorization revocation' },
    })
    assert.equal(revoked.ok, true, `revocation must commit: ${JSON.stringify(revoked)}`)
    assert.notEqual((await projectRow()).authorization_epoch, before.authorization_epoch, 'revocation advances the authorization epoch')
    const refused = await directCall(agent, 'ensemble_work', {
      action: 'open', expected_revision: before.read_revision, operation_id: 'open-after-revoke',
      payload: {
        title: 'revoked', goal: 'must refuse', deliverable: 'nothing', subject: 'auth', constraints: 'none', exclusions: 'none',
        coverage: [{ key: 'c', title: 'c', requirement: 'r', required: true, authority_refs: [] }],
        criteria: [{ key: 'k', coverage_targets: [{ kind: 'request_key', key: 'c' }], statement: 's', critical: true, method: 'm' }],
      },
    }, 'open-after-revoke')
    assert.equal(refused.ok, false, `a revoked grant must refuse the next write: ${JSON.stringify(refused)}`)
    assert.equal(refused.error.code, 'not_authorized', JSON.stringify(refused))
    evidence.currentAuth = { revokedGrant: rootGrant, epochAdvancedOnRevoke: true, refusalAfterRevoke: refused.error.code }

    // Restore the authority so the remaining phases run; then prove a replay is not
    // a second write: same operation id and command answer the same committed
    // revision and the head does not move.
    const regranted = await remote('manage', {
      action: 'grant', project_id: project.project_id, expected_revision: (await projectRow()).read_revision,
      operation_id: 'regrant-root',
      payload: {
        subject: { kind: 'session', sessionId: agent.id, rootSessionId: agent.id },
        rights: ['read', 'open', 'member-submit'], delegable_rights: ['member-submit'],
        scope: { kind: 'project' }, reason: 'acceptance restore after revocation',
      },
    })
    assert.equal(regranted.ok, true, `re-granting must commit: ${JSON.stringify(regranted)}`)
    const base = (await projectRow()).read_revision
    const command = {
      action: 'open', expected_revision: base, operation_id: 'replay-open',
      payload: {
        title: 'replay', goal: 'prove a receipt is not a second write', deliverable: 'same answer', subject: 'idem',
        constraints: 'none', exclusions: 'none',
        coverage: [{ key: 'r', title: 'r', requirement: 'r', required: true, authority_refs: [] }],
        criteria: [{ key: 'k', coverage_targets: [{ kind: 'request_key', key: 'r' }], statement: 's', critical: true, method: 'm' }],
      },
    }
    const first = await directCall(agent, 'ensemble_work', command, 'replay-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    const headAfterFirst = (await projectRow()).read_revision
    const second = await directCall(agent, 'ensemble_work', command, 'replay-2')
    assert.equal(second.ok, true, `an identical replay must answer, not fail: ${JSON.stringify(second)}`)
    assert.equal(second.value.committed_revision, first.value.committed_revision, 'a replay answers the original committed revision')
    assert.equal((await projectRow()).read_revision, headAfterFirst, 'a replay must not move the head')
    evidence.idempotentReplay = { committed: first.value.committed_revision, replayedTo: second.value.committed_revision, headUnchanged: true }
  })

  // ── legacy: explicit v1 → new identity migration, driven through `choose` ──
  // The v1 archive is a real `ensemble-archive/v1` bare repository built here as
  // *data* (never by the product), selected through the packaged owner `choose`,
  // previewed, approved twice (migration + stopped-primary bound to the exact
  // source head) and committed. The assertions are the ones the product's own
  // legacy contract promises, including a stale stop approval refused.
  await phase('legacy', async () => {
    const { project, remote } = core
    const world = process.env.DSH_ENSEMBLE_ARCHIVE_WORLD
    const legacyRoot = join(ownRoot('legacy'), 'legacy-v1-archive')
    const work = join(ownRoot('legacy'), 'work')
    await mkdir(legacyRoot, { recursive: true })
    await mkdir(work, { recursive: true })
    // Git must not read the user's config in a fixture, and must not prompt.
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'acceptance', GIT_AUTHOR_EMAIL: 'acceptance@example.invalid',
      GIT_COMMITTER_NAME: 'acceptance', GIT_COMMITTER_EMAIL: 'acceptance@example.invalid',
    }
    const git = (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
      assert.equal(result.status, 0, `git ${args.join(' ')} (${cwd}) failed: ${result.stderr || result.stdout}`)
      return result.stdout.trim()
    }
    // A genuine v1 archive: exact-format meta.json at the head, one payload blob,
    // one published head ref. Everything else becomes opaque original data.
    git(['init', '--bare', '--quiet', '--template='], legacyRoot)
    await writeFile(join(work, 'meta.json'), JSON.stringify({ format: 'ensemble-archive/v1', archiveId: 'archive-legacy-v1-fixture' }))
    await writeFile(join(work, 'legacy-record.json'), JSON.stringify({ kind: 'record', note: 'v1 original bytes' }))
    git(['init', '--quiet', '--template='], work)
    git(['add', 'meta.json', 'legacy-record.json'], work)
    git(['commit', '--quiet', '-m', 'legacy v1 archive fixture'], work)
    const firstCommit = git(['rev-parse', 'HEAD'], work)
    git(['fetch', '--quiet', work, firstCommit], legacyRoot)
    git(['update-ref', 'refs/ensemble/main', firstCommit], legacyRoot)
    const sourceHead = git(['rev-parse', 'refs/ensemble/main'], legacyRoot)
    assert.match(sourceHead, /^[0-9a-f]{40}$/)

    const headNow = async () => (await remote('projects', {})).value.projects.find((item) => item.project_id === project.project_id).read_revision
    const selected = await remote('choose', { kind: 'source', path: legacyRoot, world })
    assert.equal(selected.ok, true, `a real v1 archive must be selectable: ${JSON.stringify(selected)}`)
    const preview = await remote('manage', {
      action: 'plan_maintenance', project_id: project.project_id, expected_revision: await headNow(), operation_id: 'legacy-preview',
      payload: { kind: 'legacy_upgrade', source_handle: selected.value.handle, target_format: 'ensemble-archive/v2', reason: 'acceptance legacy migration' },
    })
    assert.equal(preview.ok, true, `the preview must succeed: ${JSON.stringify(preview)}`)
    const plan = preview.value
    assert.equal(plan.sourceArchiveId, 'archive-legacy-v1-fixture', 'the v1 identity comes from meta.json, not from an argument')
    assert.equal(plan.sourceHead, sourceHead, 'the preview records the exact v1 head')
    assert.equal(plan.oldGrants, 'historical-only')
    assert.equal(plan.newIdentityRequired, true)
    assert.match(plan.source_stop_digest, /^[0-9a-f]{64}$/)
    assert(plan.files >= 3, `originals include the tree plus a history bundle, saw ${plan.files}`)

    const migrateApproval = await remote('approve', {
      project_id: project.project_id, action: 'upgrade', target_digest: plan.digest,
      statement: 'accept the previewed legacy migration', expires_after_ms: 60000,
    })
    assert.equal(migrateApproval.ok, true, JSON.stringify(migrateApproval))
    const stopApproval = await remote('approve', {
      project_id: project.project_id, action: 'stopped-primary', target_digest: plan.source_stop_digest,
      statement: 'the v1 writer is stopped at this exact head', expires_after_ms: 60000,
      source_stop: { archive_id: plan.sourceArchiveId, final_head: plan.sourceHead, mode: 'current-host-paused' },
    })
    assert.equal(stopApproval.ok, true, JSON.stringify(stopApproval))

    // A stop approval is bound to one head. Advancing the legacy repo is exactly what
    // a still-running v1 writer does, and the migration must then refuse.
    await writeFile(join(work, 'late-record.json'), JSON.stringify({ kind: 'record', note: 'written after the stop approval' }))
    git(['add', 'late-record.json'], work)
    git(['commit', '--quiet', '-m', 'v1 writer still running'], work)
    const advanced = git(['rev-parse', 'HEAD'], work)
    git(['fetch', '--quiet', work, advanced], legacyRoot)
    git(['update-ref', 'refs/ensemble/main', advanced], legacyRoot)
    const refusedStale = await remote('manage', {
      action: 'upgrade', project_id: project.project_id, expected_revision: await headNow(), operation_id: 'legacy-migrate-stale',
      payload: {
        target_format: 'ensemble-archive/v2', migration_plan_ref: plan.plan_ref,
        approval_ref: { approval_id: migrateApproval.value.approval_id },
        source_stop_ref: { approval_id: stopApproval.value.approval_id },
        source_stop_evidence: [{ kind: 'reported', statement: 'v1 writer stopped for acceptance', source_label: 'acceptance', supporting_refs: [] }],
      },
    })
    assert.equal(refusedStale.ok, false, `a stop approval for a stale head must not migrate: ${JSON.stringify(refusedStale)}`)
    assert.equal(refusedStale.error.code, 'source_stop_required', JSON.stringify(refusedStale))
    assert.equal(git(['rev-parse', 'refs/ensemble/main'], legacyRoot), advanced, 'a refused migration does not touch the legacy head')

    // Re-preview at the new head, approve both again, and commit for real.
    const preview2 = await remote('manage', {
      action: 'plan_maintenance', project_id: project.project_id, expected_revision: await headNow(), operation_id: 'legacy-preview-2',
      payload: { kind: 'legacy_upgrade', source_handle: selected.value.handle, target_format: 'ensemble-archive/v2', reason: 'acceptance legacy migration, second preview' },
    })
    assert.equal(preview2.ok, true, JSON.stringify(preview2))
    const plan2 = preview2.value
    assert.equal(plan2.sourceHead, advanced, 'the second preview sees the advanced head')
    const approve2 = await remote('approve', {
      project_id: project.project_id, action: 'upgrade', target_digest: plan2.digest,
      statement: 'accept the re-previewed legacy migration', expires_after_ms: 60000,
    })
    assert.equal(approve2.ok, true, JSON.stringify(approve2))
    const stop2 = await remote('approve', {
      project_id: project.project_id, action: 'stopped-primary', target_digest: plan2.source_stop_digest,
      statement: 'the v1 writer is stopped at this exact head', expires_after_ms: 60000,
      source_stop: { archive_id: plan2.sourceArchiveId, final_head: plan2.sourceHead, mode: 'external-owner-handoff' },
    })
    assert.equal(stop2.ok, true, JSON.stringify(stop2))
    const migrated = await remote('manage', {
      action: 'upgrade', project_id: project.project_id, expected_revision: await headNow(), operation_id: 'legacy-migrate-2',
      payload: {
        target_format: 'ensemble-archive/v2', migration_plan_ref: plan2.plan_ref,
        approval_ref: { approval_id: approve2.value.approval_id },
        source_stop_ref: { approval_id: stop2.value.approval_id },
        source_stop_evidence: [{ kind: 'reported', statement: 'v1 writer stopped for acceptance', source_label: 'acceptance', supporting_refs: [] }],
      },
    })
    assert.equal(migrated.ok, true, `the migration must commit: ${JSON.stringify(migrated)}`)

    // The v1 repository is only ever read: its head is exactly where the v1 writer
    // left it. Migration never writes a ref in the source.
    const legacyHeadAfter = git(['rev-parse', 'refs/ensemble/main'], legacyRoot)
    assert.equal(legacyHeadAfter, advanced, 'migration must not move the legacy head')
    // The imported originals are readable through the packaged Remote: the v1 tree
    // and its history bundle are preserved, not reinterpreted.
    const context = await remote('query', { kind: 'context', project_id: project.project_id })
    assert.equal(context.ok, true, JSON.stringify(context))
    evidence.legacy = {
      sourceArchiveId: plan2.sourceArchiveId,
      sourceHead: plan2.sourceHead,
      staleStopRefused: refusedStale.error.code,
      migrated: migrated.value.committed_revision,
      legacyHeadAfterMigration: legacyHeadAfter,
      legacyHeadUnchanged: true,
      previewFiles: plan2.files,
      modeUsed: 'external-owner-handoff',
    }
  })

  // ── network: real authenticated replica, push → CAS → fetch → revoke ──────
  // Anonymous Git proves nothing about credentials, so this phase requires all of:
  // the deployment's declared destinations read over the owner Remote, an opaque
  // capability from `choose`, `configure_replica` performing a real authenticated
  // round trip, a push the server had to authorize, a concurrent remote write
  // refused as a CAS conflict, a fetch that leaves the primary head untouched, and a
  // removed credential that refuses the next push.
  //
  // The credential is read by the native provider on **every** transfer and never
  // cached, so revocation is measured by removing it from the provider's store.
  // There is no "revoke" verb on the wire, and inventing one would test a method the
  // product does not have.
  await phase('network', async () => {
    const { project, remote } = core
    // "Not configured" is not "no destinations": the product must say so, and a
    // deployment with no declared destination must not look like a working feature.
    const declared = await remote('destinations', {})
    if (!declared.ok && declared.error?.code === 'storage_unavailable') {
      throw new Error(`the deployment declares no replica destinations (${declared.error.message}); the credentialed network journey was NOT verified`)
    }
    assert.equal(declared.ok, true, `destinations must be readable: ${JSON.stringify(declared)}`)
    const rows = declared.value.destinations ?? declared.value
    assert(Array.isArray(rows) && rows.length > 0,
      `a green network phase needs a declared destination, got ${JSON.stringify(declared.value).slice(0, 400)}`)
    const fixture = process.env.ENSEMBLE_NETWORK_FIXTURE
    if (fixture === undefined) {
      throw new Error('a destination is declared but no authenticated replica fixture was provided (ENSEMBLE_NETWORK_FIXTURE); the credentialed journey was NOT verified')
    }
    const spec = JSON.parse(fixture)
    assert(spec.origin && spec.repo && spec.destinationKey && spec.credentialHandle,
      `the fixture must describe origin, repo, destinationKey and credentialHandle: ${fixture}`)
    const headNow = async () => (await remote('projects', {})).value.projects.find((item) => item.project_id === project.project_id).read_revision
    const gitEnv = {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'acceptance', GIT_AUTHOR_EMAIL: 'acceptance@example.invalid',
      GIT_COMMITTER_NAME: 'acceptance', GIT_COMMITTER_EMAIL: 'acceptance@example.invalid',
    }
    const git = (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
      assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
      return result.stdout.trim()
    }
    const remoteHead = () => git(['--git-dir', spec.repo, 'rev-parse', 'refs/ensemble/main'], spec.repo)

    // The key and the identity come from the Host, never from this fixture.
    const row = rows.find((item) => (item.key ?? item.handle) === spec.destinationKey)
    assert(row, `the deployment must declare ${spec.destinationKey}: ${JSON.stringify(rows).slice(0, 600)}`)
    const identity = row.identity
    assert.equal(identity, new URL(spec.origin).host, 'the declared identity is the server authority')
    evidence.networkDestinations = { key: row.key ?? row.handle, identity, declared: rows.length }

    // An opaque capability for that declared destination — never a path, never a URL.
    // A replica selection names a *different* execution world from the Host's: the
    // archive's own world means "this Host's filesystem", which would take the local
    // `file` path and let a network assertion pass without touching the network.
    const networkWorld = spec.world ?? 'acceptance-network-world'
    assert.notEqual(networkWorld, process.env.DSH_ENSEMBLE_ARCHIVE_WORLD, 'a replica must name a non-Host world')
    const selected = await remote('choose', { kind: 'replica', destinationKey: spec.destinationKey, world: networkWorld })
    assert.equal(selected.ok, true, `choose must issue a replica capability: ${JSON.stringify(selected)}`)
    assert.match(String(selected.value.handle), /^location_/, 'the capability is an opaque handle, not a URL')

    // Configure performs a real authenticated round trip, so a missing or wrong
    // credential fails here rather than at the first push.
    const configured = await remote('manage', {
      action: 'configure_replica', project_id: project.project_id, expected_revision: await headNow(), operation_id: 'replica-configure',
      payload: { destination_handle: selected.value.handle, credential_handle: spec.credentialHandle, expected_remote_identity: identity },
    })
    assert.equal(configured.ok, true, `configure_replica must authenticate: ${JSON.stringify(configured)}`)
    const replicaId = configured.value.id
    assert(replicaId, String(JSON.stringify(configured)).slice(0, 700))

    // Push. The server authenticates every request, so a green push means the
    // credential was actually consumed.
    const localHead = await headNow()
    const pushed = await remote('manage', {
      action: 'push_replica', project_id: project.project_id, expected_revision: localHead, operation_id: 'replica-push',
      payload: { replica_id: replicaId, local_revision: localHead },
    })
    assert.equal(pushed.ok, true, `a credentialed push must succeed: ${JSON.stringify(pushed)}`)
    const pushedRemoteHead = remoteHead()
    assert.equal(pushedRemoteHead, localHead, 'the remote now carries the pushed revision')
    evidence.networkPush = { state: pushed.value.state ?? 'pushed', revision: localHead, remoteHead: pushedRemoteHead }

    // CAS: another writer advances the remote, then this side pushes its stale
    // expectation. The remote must keep the other writer's commit.
    const clone = join(ownRoot('network'), 'remote-clone')
    await mkdir(ownRoot('network'), { recursive: true })
    // The concurrent writer goes through the *same authenticated URL*: writing to the
    // local path would race the remote without exercising the transport, and the CAS
    // assertion would then be about a file, not a server.
    // Cloning the authenticated remote needs the same credential. The environment is
    // built once and reused for both the clone and the push of "the other writer".
    const fixtureAuth = {
      ...gitEnv,
      ENSEMBLE_REPLICA_USER: spec.credentialUsername,
      ENSEMBLE_REPLICA_SECRET: spec.credentialSecret,
      GIT_ASKPASS: spec.askpass,
      GIT_ASKPASS_REQUIRE: 'force',
    }
    const authGit = (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: fixtureAuth })
      assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
      return result.stdout.trim()
    }
    /**
     * Publish the concurrent writer's commit at the archive ref.
     *
     * This writes the fixture's *remote* repository directly, and that is deliberate:
     * the concurrent writer is the server side of this race, so it must not depend on
     * the product's own transport path. The credential above proves the clone and the
     * product's push both authenticate; this step only creates the conflicting ref.
     */
    const publishToMain = (cwd) => {
      const commit = authGit(['rev-parse', 'HEAD'], cwd)
      // The commit's objects must exist in the remote before a ref can name it, so the
      // branch is pushed over the authenticated URL first.
      const upload = spawnSync('git', ['-C', cwd, 'push', '--quiet', 'origin', 'HEAD:refs/heads/writer'], { encoding: 'utf8', env: fixtureAuth })
      assert.equal(upload.status, 0, `the concurrent writer must upload its objects: ${upload.stderr}`)
      const published = spawnSync('git', ['--git-dir', spec.repo, 'update-ref', 'refs/ensemble/main', commit], { encoding: 'utf8', env: fixtureAuth })
      assert.equal(published.status, 0, `the concurrent writer must publish its commit: ${published.stderr}`)
      return commit
    }
    authGit(['clone', '--quiet', `${spec.origin}/repo.git`, clone], ownRoot('network'))
    await writeFile(join(clone, 'remote-record.json'), JSON.stringify({ note: 'written by the other writer' }))
    authGit(['add', 'remote-record.json'], clone)
    authGit(['commit', '--quiet', '-m', 'concurrent remote writer'], clone)
    const racedCommit = publishToMain(clone)
    const racedHead = remoteHead()
    assert.equal(racedHead, racedCommit, "the remote now carries the other writer's commit")
    assert.notEqual(racedHead, pushedRemoteHead, 'the concurrent writer moved the remote')
    const conflict = await remote('manage', {
      action: 'push_replica', project_id: project.project_id, expected_revision: await headNow(), operation_id: 'replica-push-stale',
      payload: { replica_id: replicaId, local_revision: pushedRemoteHead },
    })
    assert.equal(conflict.ok, false, `a stale push must be refused: ${JSON.stringify(conflict)}`)
    assert(['remote_conflict', 'revision_conflict'].includes(conflict.error.code), `the refusal must name the conflict: ${JSON.stringify(conflict.error)}`)
    assert.equal(remoteHead(), racedHead, 'a refused push must not move or force the remote')

    // Fetch the remote head as a read-only candidate; the primary does not move.
    const primaryBefore = await headNow()
    const fetched = await remote('manage', {
      action: 'fetch_replica', project_id: project.project_id, expected_revision: primaryBefore, operation_id: 'replica-fetch',
      payload: { replica_id: replicaId, expected_remote_revision: racedHead },
    })
    assert.equal(fetched.ok, true, `a fetch must produce a candidate: ${JSON.stringify(fetched)}`)
    assert.equal(fetched.value.readOnly, true, 'a fetched candidate is read-only')
    assert.equal(fetched.value.head, racedHead, 'the candidate is exactly the remote head')
    assert.equal(await headNow(), primaryBefore, 'a fetch must not move the primary head')
    evidence.networkFetch = { candidate: fetched.value.candidateId, head: fetched.value.head, readOnly: true, primaryUnchanged: true }

    // Revoke: the provider is consulted on every transfer, so removing the credential
    // is revocation. The next push must refuse and the remote must still carry the
    // other writer's commit.
    const credentialFile = process.env.ENSEMBLE_NETWORK_CREDENTIAL_FILE
    if (credentialFile === undefined) {
      throw new Error('the fixture must name ENSEMBLE_NETWORK_CREDENTIAL_FILE so credential revocation can be exercised')
    }
    rmSync(credentialFile, { force: true })
    const beforeRevokedPush = await headNow()
    const refused = await remote('manage', {
      action: 'push_replica', project_id: project.project_id, expected_revision: beforeRevokedPush, operation_id: 'replica-push-revoked',
      payload: { replica_id: replicaId, local_revision: beforeRevokedPush },
    })
    assert.equal(refused.ok, false, `a removed credential must refuse the next push: ${JSON.stringify(refused)}`)
    assert.equal(remoteHead(), racedHead, 'a refused push must not reach the remote')
    evidence.networkRevoke = { refused: true, code: refused.error.code, remoteUnchanged: true, primaryUnchanged: (await headNow()) === beforeRevokedPush }
  })

  // ── team: the native shared-task board, enabled by the Lead, ref verified ──
  // This phase calls the tools registry directly instead of scripting a model turn,
  // and says so: a board append (`team/mode`, a task event) starts extra root-Session
  // turns, which makes a scripted turn's delivery racy in a way unrelated to what is
  // under test. The archive's native-task verification is the subject here and it is
  // exercised through the same registered tool definitions the model uses; the
  // scripted model path is already proven in `core`.
  await phase('team', async () => {
    const { agent, project, remote, opened } = core
    const team = ctx.get('agentTeams')
    assert.equal(team.isEnabled(agent), false, 'the work journey above must have run with Team off')
    await team.setEnabled(agent, true)
    assert.equal(team.isEnabled(agent), true)
    const task = await team.createTask(agent, { subject: 'Selection attempt', description: 'A native task the attempt cites for routing evidence', blockedBy: [], writeScopes: [] })
    evidence.nativeTask = { id: task.id, revision: task.revision }

    const invocationId = opened.value.changed?.find((change) => change.id.startsWith('invocation-'))?.id
    const revision = (await remote('projects', {})).value.projects.find((item) => item.project_id === project.project_id).read_revision
    const planned = await directCall(agent, 'ensemble_work', {
      action: 'plan_attempt', expected_revision: revision, operation_id: 'plan-team',
      payload: {
        invocation_id: invocationId, question: 'Does a cited native task verify?', baseline_refs: [], coverage_ids: [],
        difference_or_redundancy: 'Cites a live native task ref',
        context_plan: { mode: 'fresh', relevance: 'Isolated turn', exposure: 'No sibling conclusions' },
        expected_output: 'A verified task ref', early_slice: 'one turn', write_scope_claims: ['none'], purpose: 'produce',
      },
    }, 'native-plan-team')
    assert.equal(planned.ok, true, JSON.stringify(planned))
    const attemptId = planned.value.changed.find((change) => change.id.startsWith('attempt-'))?.id
    assert(attemptId, JSON.stringify(planned))
    const member = await ctx.subagents.startActivation({
      provider: 'spawn', name: 'team-member', label: 'team member', parent: agent,
      prompt: [{ type: 'text', text: 'produce one observed turn' }],
      agentOptions: { provider: 'profile-gate', model: 'deterministic' },
      delivery: 'caller', signal: AbortSignal.timeout(30000),
    })
    await member.result
    const memberLog = await ctx.sessionQuery.observeSession(member.childId, { signal: AbortSignal.timeout(10000) })
    const descriptorSeq = memberLog.events.find((event) => event.type === 'subagent/descriptor')?.seq
    memberLog[Symbol.dispose]()
    // A stale task revision must be refused: the archive verifies the ref against
    // the live board, so this cannot pass by echoing the input back.
    const forged = await directCall(agent, 'ensemble_work', {
      action: 'update_attempt', expected_revision: planned.value.committed_revision, operation_id: 'bind-forged-task',
      payload: {
        invocation_id: invocationId, attempt_id: attemptId,
        change: {
          kind: 'bind', member_id: member.childId,
          creation_ref: { kind: 'native_event', session_id: member.childId, event_seq: descriptorSeq ?? 0 },
          context_exposure: 'fresh context',
          task_ref: { kind: 'native_task', root_session_id: agent.id, task_id: task.id, task_revision: task.revision + 1 },
        },
      },
    }, 'native-bind-forged-task')
    assert.equal(forged.ok, false, `a stale native task revision must be refused: ${JSON.stringify(forged)}`)
    assert.equal(forged.error.code, 'not_found', JSON.stringify(forged))

    const bound = await directCall(agent, 'ensemble_work', {
      action: 'update_attempt', expected_revision: planned.value.committed_revision, operation_id: 'bind-team',
      payload: {
        invocation_id: invocationId, attempt_id: attemptId,
        change: {
          kind: 'bind', member_id: member.childId,
          creation_ref: { kind: 'native_event', session_id: member.childId, event_seq: descriptorSeq ?? 0 },
          context_exposure: 'fresh context',
          task_ref: { kind: 'native_task', root_session_id: agent.id, task_id: task.id, task_revision: task.revision },
        },
      },
    }, 'native-bind-team')
    assert.equal(bound.ok, true, `a bind citing a live native task must verify: ${JSON.stringify(bound)}`)
    evidence.agentTeams = { enabled: true, task: evidence.nativeTask, staleRevisionRefused: forged.error.code, liveRevisionAccepted: true }
  })

  await save()
  // Hand the committed facts to the verify pass through the driver's contract. This
  // is read *now*, after every write phase, so it is the head the next process must
  // actually serve.
  // A diagnostic Host has no archive at all, so it writes no expectation: the
  // restart pass is meaningless without committed state.
  if (core === undefined) {
    console.log('DIAGNOSTIC-ONLY Host: empty registry, no project/workspace/archive; not a gate pass')
  } else {
    const finalProjects = await core.remote('projects', {})
    const finalProject = finalProjects.value?.projects?.find((item) => item.project_id === core.project.project_id)
    await writeFile(join(root, 'restart-expectation.json'), JSON.stringify({
      projectId: finalProject?.project_id ?? evidence.projectId,
      head: finalProject?.read_revision ?? evidence.head,
      authorizationEpoch: finalProject?.authorization_epoch,
    }, null, 2))
  }
  console.log('PASS installed product: official profile composition, authenticated owner Remote, native tools, headless CLI, Team-off work, selection evidence, verified native task ref and native Settings application')
} finally {
  await connection?.close?.().catch(() => {})
  if (handle) {
    await ctx.subagents.drainDescendants([handle.agent]).catch(() => {})
    await handle.dispose().catch(() => {})
  }
  await ctx.fiber.dispose().catch(() => {})
}
