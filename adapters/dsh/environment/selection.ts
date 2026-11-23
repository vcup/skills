/**
 * Native selection evidence, kept separate from route authorization.
 *
 * Three stages are recorded for one learning application, never merged:
 * `requested` is the route the Lead recorded on the attempt (a trusted archive
 * fact supplied by the caller, never wire input), `created` is the route the
 * native delegation descriptor actually created, and `actual` is the route an
 * observed native model request/response used. A stage that the published
 * events do not establish is `unknown`; a stage the Host could not read is
 * `unavailable`. Nothing here derives a value from a catalog, a model's own
 * report, or a neighbouring stage, and no message body or prompt is retained.
 *
 * Only already-authorized native observations cross this seam: callers pass the
 * detached event log they obtained from `ctx.sessionQuery.observeSession`.
 */
import { failure, success, type Result } from "../../../modules/ensemble/contracts.ts";
import { decode, object, str, type Schema } from "../../../modules/ensemble/validation.ts";
import type { RouteEvidence, SelectionEvidence } from "../../../modules/ensemble/environment.ts";

/** The published `.events` shape of a Session observation, narrowed to what is read. */
export interface NativeEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}
export interface NativeSessionLog {
  readonly session_id: string;
  /** First child-owned seq; fork-inherited prefix events never describe this attempt. */
  readonly inherited_event_count: number;
  readonly events: readonly NativeEvent[];
  /** When set, the log is still readable only until the caller releases it. */
  readonly release?: () => void;
}
/** One detached native observation source; the Host supplies the live session query. */
export interface SelectionSource {
  observe(sessionId: string, signal: AbortSignal): Promise<NativeSessionLog | undefined>;
}
export interface RequestedRoute {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly preset?: string;
}
export interface SelectionRequest {
  readonly attempt_id: string;
  readonly evidence_id: string;
  /** The bound attempt member; its own log carries created/actual evidence. */
  readonly member_session_id: string;
  /** Exact attempt record fact. Model tool input must never supply this object. */
  readonly requested: RequestedRoute;
}

const id = str(1, 128, "^[A-Za-z0-9][A-Za-z0-9_.:-]*$");
const name = str(1, 256, "^[^\\u0000-\\u001f]+$");
const requestedSchema: Schema = object({}, { provider: name, model: name, reasoning_effort: name, preset: name });
const requestSchema: Schema = object({ attempt_id: id, evidence_id: id, member_session_id: id, requested: requestedSchema });
const MAX_EVENTS = 100_000;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}
function route(data: Record<string, unknown>, keys: readonly [string, string, string]): RequestedRoute {
  const provider = text(data[keys[0]], 256), model = text(data[keys[1]], 256), effort = text(data[keys[2]], 256);
  return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { reasoning_effort: effort }) };
}
/** Own events only; a fork prefix describes the parent attempt, not this one. */
function own(log: NativeSessionLog): readonly NativeEvent[] {
  return log.events.filter(event => Number.isSafeInteger(event.seq) && event.seq >= log.inherited_event_count);
}
/**
 * The delegation descriptor that actually created this member. A prepared
 * request header or a model's claim is not creation evidence.
 */
function created(log: NativeSessionLog): RouteEvidence {
  let found: { seq: number; route: RequestedRoute } | undefined;
  for (const event of own(log)) {
    if (event.type !== "subagent/descriptor" || !plain(event.data) || event.data.mode !== "continuable") continue;
    found = { seq: event.seq, route: route(event.data, ["agentProvider", "agentModel", "agentReasoningEffort"]) };
  }
  if (found === undefined) return { status: "unknown", reason: "No native continuation descriptor in this member Session's own events." };
  if (found.route.provider === undefined || found.route.model === undefined) return { status: "unknown", reason: "The native descriptor did not record an exact created provider/model route." };
  return { status: "observed", session_id: log.session_id, event_seq: found.seq, provider: found.route.provider, model: found.route.model,
    ...(found.route.reasoning_effort === undefined ? {} : { reasoning_effort: found.route.reasoning_effort }) };
}
/**
 * The route an observed model response actually used, paired with the request
 * header that prepared it. Effort is copied only from that matching header and
 * only when the adapter did not materialize its own default.
 */
function actual(log: NativeSessionLog): RouteEvidence {
  let header: { config: Record<string, unknown>; adapterDefaultEffort: boolean } | undefined;
  let response: { seq: number; config: Record<string, unknown>; route: RequestedRoute } | undefined;
  for (const event of own(log)) {
    if (!plain(event.data)) continue;
    if (event.type === "request/header" && plain(event.data.header) && plain(event.data.header.config)) {
      header = { config: event.data.header.config, adapterDefaultEffort: plain(event.data.header.adapterDefaults) && event.data.header.adapterDefaults.reasoningEffort === true };
    }
    if (event.type !== "assistant/message" || !plain(event.data.message) || !plain(event.data.message.source)) continue;
    const source = event.data.message.source;
    if (source.kind !== "model") continue;
    response = { seq: event.seq, config: header?.config ?? {}, route: route(source, ["provider", "model", "__absent"]) };
  }
  if (response === undefined) return { status: "unknown", reason: "No native model response is recorded for this member yet." };
  if (response.route.provider === undefined || response.route.model === undefined) return { status: "unknown", reason: "The native model response did not record its provider/model." };
  const matching = response.config.provider === response.route.provider && response.config.model === response.route.model;
  const effort = matching && header?.adapterDefaultEffort === false ? text(response.config.reasoningEffort, 256) : undefined;
  return { status: "observed", session_id: log.session_id, event_seq: response.seq, provider: response.route.provider, model: response.route.model,
    ...(effort === undefined ? {} : { reasoning_effort: effort }) };
}
/** Pure assembly: the request fact and each observed stage stay separately attributable. */
export function buildSelectionEvidence(request: SelectionRequest, log: NativeSessionLog): SelectionEvidence {
  return { evidence_id: request.evidence_id, attempt_id: request.attempt_id, requested: { ...request.requested }, created: created(log), actual: actual(log) };
}
/**
 * Read one member's own log and assemble evidence. An unreadable log does not
 * invent creation or use; it records the requested route and marks both observed
 * stages unavailable, so the learning record shows a gap instead of a guess.
 */
export async function collectSelectionEvidence(source: SelectionSource, input: unknown, signal: AbortSignal): Promise<Result<SelectionEvidence>> {
  const decoded = decode<SelectionRequest>(input, requestSchema, {}, 64 * 1024);
  if (!decoded.ok) return decoded;
  const request = decoded.value;
  const requested = request.requested;
  if ((requested.provider === undefined) !== (requested.model === undefined)) return failure("invalid_input", "A requested selection must pair provider and model.");
  if (requested.reasoning_effort !== undefined && requested.provider === undefined) return failure("invalid_input", "A requested effort requires an explicit requested route.");
  signal.throwIfAborted();
  let log: NativeSessionLog | undefined;
  try { log = await source.observe(request.member_session_id, signal); }
  catch { log = undefined; }
  try {
    signal.throwIfAborted();
    if (log === undefined) return success({ evidence_id: request.evidence_id, attempt_id: request.attempt_id, requested: { ...requested },
      created: { status: "unavailable", reason: "The Host could not read this member Session's native log." },
      actual: { status: "unavailable", reason: "The Host could not read this member Session's native log." } });
    if (log.session_id !== request.member_session_id) return failure("invalid_input", "The observed log belongs to a different Session than the bound attempt member.");
    if (log.events.length > MAX_EVENTS) return failure("budget_exceeded", "Native log exceeds the selection-evidence budget; record the stage gap instead of scanning it.");
    return success(buildSelectionEvidence(request, log));
  } finally { log?.release?.(); }
}
