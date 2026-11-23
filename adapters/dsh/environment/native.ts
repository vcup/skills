/** Only public native Settings and LLM metadata cross this seam. No configuration-file IO. */
import { failure, success, type Result } from "../../../modules/ensemble/contracts.ts";
import { decodePreferences, type EnvironmentCatalog, type Preferences, type Route } from "../../../modules/ensemble/environment.ts";

export interface NativePreferenceState { readonly target_id: string; readonly revision: number; readonly preferences: Preferences }
export interface NativePreferences {
  readonly targets: readonly string[];
  read(targetId: string, signal: AbortSignal): Promise<Result<NativePreferenceState>>;
  apply(targetId: string, preferences: Preferences, expectedRevision: number, signal: AbortSignal): Promise<Result<true>>;
}
/** Shape of the published ctx.settings face; all response reads explicitly request redaction. */
export interface SettingsFace {
  describe(options: { redactSecrets: true }): readonly { readonly ns: string; readonly revision: number; readonly value: unknown }[];
  update(ns: string, patch: object, expectedRevision: number): Promise<void>;
}
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** targetIds are the actual active Ensemble plugin entry ids, supplied by deployment, never wire input. */
export function createNativePreferences(settings: SettingsFace, targetIds: readonly string[]): NativePreferences {
  const targets = [...new Set(targetIds)];
  const read = async (targetId: string, signal: AbortSignal): Promise<Result<NativePreferenceState>> => {
    if (!targets.includes(targetId)) return failure("not_authorized", "Target is not a registered Ensemble Settings instance.");
    try {
      signal.throwIfAborted();
      const matches = settings.describe({ redactSecrets: true }).filter(d => d.ns === targetId);
      if (matches.length !== 1) return failure("storage_unavailable", "The registered native Settings instance is not uniquely active.");
      const row = matches[0]!;
      if (!Number.isSafeInteger(row.revision) || row.revision < 0 || !plain(row.value)) return failure("storage_unavailable", "Native Settings descriptor is invalid.");
      const decoded = decodePreferences(row.value.rolePreferences);
      if (!decoded.ok) return failure("storage_unavailable", "Native rolePreferences do not match the closed preference schema.");
      return success({ target_id: targetId, revision: row.revision, preferences: structuredClone(decoded.value) });
    } catch { return failure("storage_unavailable", "Native Settings read failed; no configuration or exception body was retained."); }
  };
  return { targets, read, async apply(targetId, preferences, expectedRevision, signal) {
    if (!targets.includes(targetId)) return failure("not_authorized", "Target is not a registered Ensemble Settings instance.");
    const parsed = decodePreferences(preferences); if (!parsed.ok) return parsed;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return failure("invalid_input", "A concrete native revision is required.");
    try {
      signal.throwIfAborted();
      // update merges only our nonsecret field, preserving native authorization, credentials and unrelated settings.
      await settings.update(targetId, { rolePreferences: structuredClone(parsed.value) }, expectedRevision);
      return success(true);
    } catch (error) {
      if ((plain(error) || error instanceof Error) && "code" in error && error.code === "SETTINGS_CONFLICT") return failure("revision_conflict", "Native Settings changed; read the current revision and preview again.");
      return failure("outcome_unknown", "Native apply did not return a confirmed outcome; read back before any new write.");
    }
  } };
}

export interface NativeModelInfo { readonly id: string; readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] } }
export interface LlmCatalogFace {
  listProviders(): readonly { readonly id: string }[];
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<NativeModelInfo>;
  resolveCallConfig(config: { provider: string; model: string; reasoningEffort?: string }, signal?: AbortSignal): Promise<unknown>;
}
export interface CatalogAccess {
  readonly sessionId: string;
  /** Captured native projection. Missing policy permits only the effective parent route. */
  readonly policy?: readonly Route[];
  readonly parent?: Route & { readonly reasoning_effort?: string };
  readonly selectionEnabled: boolean;
  readonly inheritanceKnown?: boolean;
  readonly allowedPresets: readonly string[];
  readonly llm?: LlmCatalogFace;
  readonly presets?: { list(): Promise<readonly { readonly id: string; readonly broken?: string }[]> };
  /** Revalidate exact live caller after asynchronous catalog work. */
  validate(): boolean;
}
/** Resolves only already-authorized routes. Metadata is not proof of successful model execution. */
export async function discoverEnvironmentCatalog(access: CatalogAccess, signal: AbortSignal): Promise<Result<EnvironmentCatalog>> {
  if (!access.validate()) return failure("not_authorized", "Current live native Session is required for environment discovery.");
  const authorized = access.policy ?? (access.parent ? [{ provider: access.parent.provider, model: access.parent.model }] : []);
  if (authorized.length > 256 || access.allowedPresets.length > 64) return failure("budget_exceeded", "Native catalog exceeds the bounded discovery budget.");
  const routes: EnvironmentCatalog["routes"][number][] = [];
  let registered: readonly { id: string }[] | undefined;
  try { registered = access.llm?.listProviders(); } catch { /* Only this metadata is unknown. */ }
  for (const route of authorized) {
    signal.throwIfAborted();
    if (!access.llm || registered === undefined) { routes.push({ ...route, availability: "unknown" }); continue; }
    if (!registered.some(p => p.id === route.provider)) { routes.push({ ...route, availability: "unavailable" }); continue; }
    try {
      const info = await access.llm.resolveModelInfo(route.provider, route.model, signal);
      await access.llm.resolveCallConfig(route, signal);
      routes.push({ ...route, availability: "available", efforts: info.reasoning?.efforts.map(e => e.id) ?? [] });
    } catch {
      // Provider outages and unsupported models need not share an error taxonomy.
      routes.push({ ...route, availability: "unknown" });
    }
  }
  let roster: readonly { id: string; broken?: string }[] | undefined;
  try { roster = await access.presets?.list(); } catch { /* Preserve preset uncertainty. */ }
  const presets = access.allowedPresets.map(id => {
    const row = roster?.find(p => p.id === id);
    return { id, availability: roster === undefined ? "unknown" as const : !row || row.broken !== undefined ? "unavailable" as const : "available" as const };
  });
  signal.throwIfAborted();
  if (!access.validate()) return failure("not_authorized", "Native caller changed while discovering permitted routes.");
  return success({ session_id: access.sessionId, authorized_routes: authorized.map(r => ({ provider: r.provider, model: r.model })),
    selection_enabled: access.selectionEnabled, inheritance_known: access.inheritanceKnown === true, ...(access.parent ? { parent: access.parent } : {}), routes, presets,
    allowed_presets: [...access.allowedPresets], observed_at: Date.now() });
}
