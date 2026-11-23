/**
 * Trusted run context handed to a journey module that must not own the Host.
 *
 * `scripts/verify-dsh-product.ts` installs the pinned distribution and boots the
 * **official** profile composition; a journey module (for example
 * `verify-learning.mjs`, owned by the learning-journey author) must then drive
 * *that* Host rather than build a second one. This module is the contract between
 * them, so the seam is one object instead of a set of conventions:
 *
 * - the journey gets the live Context, the real root Agent handle and the real
 *   owner Remote caller — nothing it could mistake for a fixture;
 * - every tool call goes through `call()`/`modelCall()`, which use the real
 *   registered tool definitions and the real executor. A journey that called the
 *   pure reducer or the registry directly would not be testing the installed
 *   product, so those are deliberately absent from this object;
 * - identity is never passed in: `actorFacts()` returns what the Host itself
 *   believes about the caller, and a journey that needs a second actor asks the
 *   Host for a real member (`spawnMember`) instead of inventing one;
 * - `evidence` is a plain object the journey may add keys to; the driver writes it
 *   to `evidence.json` after every phase, so a red journey still leaves its
 *   measurements behind.
 *
 * A journey owns its assertions and its own project/archive isolation. It must not
 * touch the Client's live serve fixture, so it asks for a fresh gate root through
 * `ownRoot()` and the driver hands out a directory it created and will remove.
 *
 * @module adapters/dsh/native/verify-product-context
 */
import { join } from "node:path";

/**
 * Build the context one journey module receives.
 *
 * @param {object} input - the driver's live objects.
 * @param {object} input.ctx - the booted real profile context.
 * @param {object} input.root - `{agent, workspace, project, source}` from the booted Host.
 * @param {(method: string, request: unknown) => Promise<any>} input.remote - authenticated owner Remote caller.
 * @param {(name: string, args: unknown, id: string) => Promise<any>} input.call - one registered tool call, no model turn.
 * @param {(name: string, args: unknown, id: string) => Promise<any>} input.modelCall - one tool call driven through the real AgentLoop.
 * @param {(name: string, body: () => Promise<any>) => Promise<any>} input.phase - run one named, recorded, bounded phase.
 * @param {Record<string, unknown>} input.evidence - the driver's evidence object.
 * @param {() => Promise<string>} input.head - current archive head, read over the Remote.
 * @param {(label: string) => Promise<{agent: any, childId: string, events: Array<{seq:number,type:string}>, dispose: () => Promise<void>}>} input.spawnMember - spawn a real continuable native member and return its own log.
 * @param {(label: string) => string} input.ownRoot - a fresh gate root path the driver owns and cleans up.
 * @returns {object} the frozen context described above.
 */
export function productRunContext(input) {
  // Both spellings are accepted: the driver passes the live objects it has, and a
  // journey author reads the flat names it asked for. One builder means the seam
  // cannot drift between the two.
  const ctx = input.ctx;
  const remote = input.remote;
  const agent = input.agent ?? input.root?.agent;
  const workspace = input.workspace ?? input.root?.workspace;
  const project = input.project ?? input.root?.project;
  const source = input.source ?? input.root?.source;
  const call = input.call;
  const modelCall = input.modelCall ?? input.nativeCall;
  const phase = input.phase;
  const evidence = input.evidence;
  const spawnMember = input.spawnMember;
  const ownRoot = input.ownRoot;
  const headOf = input.head;
  for (const [name, value] of Object.entries({
    ctx, remote, agent, workspace, project, call, modelCall, phase, evidence, spawnMember, ownRoot,
  })) {
    if (value === undefined) throw new Error(`productRunContext: ${name} is required`);
  }
  const projectId = project.project_id;
  return Object.freeze({
    /** The booted, real profile context: services for reading, not composition. */
    ctx,
    /** The live root Agent. The driver disposes it only after every journey returns. */
    agent,
    /** The native Workspace bound to the archive. */
    workspace,
    /** `{project_id, …}` for the bound project. */
    project,
    projectId,
    /** Absolute canonical source directory bound to the archive. */
    source,
    /** The deterministic LLM route the driver registered, for member child sessions. */
    selection: input.selection ?? { provider: "profile-gate", model: "deterministic" },
    /** Authenticated owner Remote: returns the plain `{ok, …}` Result. */
    remote,
    /** One registered tool call via the real executor; no scripted assistant turn. */
    call,
    /** One tool call through the real AgentLoop (scripted assistant turn). */
    modelCall,
    /** Run one named recorded step. */
    phase,
    /** The driver's evidence object; a journey may add its own keys. */
    evidence,
    /** Spawn a real continuable native member; returns it with its own Session log. */
    spawnMember,
    /** Where a journey logs; the driver passes `console.log`. */
    log: input.log ?? console.log,
    /** Bound for a journey's own internal waits. */
    timeoutMs: input.timeoutMs ?? 120_000,

    /** Current archive head, read from the Host. Never cached by the journey. */
    head: async () => {
      if (headOf !== undefined) return headOf();
      const projects = await remote("projects", {});
      if (!projects?.ok) throw new Error(`projects failed: ${JSON.stringify(projects?.error)}`);
      const found = projects.value.projects.find((item) => item.project_id === projectId);
      if (!found) throw new Error("the bound project is missing from projects");
      return found.read_revision;
    },
    /** What the Host believes about the current caller: identity is derived. */
    actorFacts: async () => {
      const projects = await remote("projects", {});
      if (!projects?.ok) return { ok: false, code: projects?.error?.code };
      const found = projects.value.projects.find((item) => item.project_id === projectId);
      return {
        ok: true,
        projectId: found?.project_id,
        authorizationEpoch: found?.authorization_epoch,
        readRevision: found?.read_revision,
        rootSessionId: agent.id,
      };
    },
    /**
     * A fresh root the driver creates and removes, so a journey cannot disturb this
     * gate's archive or the Client's live serve fixture.
     */
    ownRoot: (label) => ownRoot(label),
    /** A path inside that root for a journey's own files. */
    scratch: (label) => join(ownRoot(label), "scratch"),
  });
}
