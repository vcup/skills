import { useState, type ReactNode } from "react";
import type { Snapshot, WorkspaceController } from "./controller.ts";
import type { Translate } from "./locales.ts";
import { json, record, type Fields, type Json } from "./protocol.ts";
export type EnvironmentActions = Pick<WorkspaceController, "readEnvironment" | "prepareEnvironment" | "submitEnvironment" | "cancelEnvironment">;
function Details({ value }: { value: Json | undefined }): ReactNode {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return <ul>{value.map((item, i) => <li key={i}><Details value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, item]) => <div key={key} style={{ display: "contents" }}><dt>{key.replaceAll("_", " ")}</dt><dd><Details value={item} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}
/** Environment revisions are separate from the selected project's archive revision. */
export function EnvironmentPane({ actions, state, t }: { actions: EnvironmentActions; state: Snapshot; t: Translate }): ReactNode {
  const [preferences, setPreferences] = useState('{"roles":[]}');
  const [historical, setHistorical] = useState(""); const [grants, setGrants] = useState("[]"); const [invalid, setInvalid] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const environment = state.environment;
  const targets = Array.isArray(environment?.native_targets) ? environment.native_targets.filter((item): item is string => typeof item === "string") : [];
  const applications = Array.isArray(environment?.applications) ? environment.applications.filter(record) as Fields[] : [];
  const preview = state.environmentPreview;
  const prepareJson = (action: string, field: string, value: string): void => {
    try { actions.prepareEnvironment({ action, [field]: json(JSON.parse(value)) }); setInvalid(false); } catch { setInvalid(true); }
  };
  return <section className="ensemble-card"><h2>{t("environmentTitle")}</h2><p>{t("environmentSeparate")}</p>
    <div className="ensemble-toolbar"><button disabled={!state.connected || state.environmentBusy} onClick={() => { void actions.readEnvironment(); }}>{t("environment_read")}</button>
    {environment && <button disabled={state.environmentBusy} onClick={() => { void actions.readEnvironment({ action: "environment_history", revision: environment.read_revision! }); }}>{t("history")}</button>}</div>
    {environment && <><dl><dt>{t("snapshot")}</dt><dd>{String(environment.read_revision)}</dd><dt>{t("desired")}</dt><dd>{String(environment.desired_revision)}</dd></dl><p>{String(environment.native_effect ?? "")}</p><h3>{t("savedPreferences")}</h3><Details value={environment.preferences} /></>}
    <details><summary>{t("environment_set")}</summary><form className="ensemble-form" onSubmit={event => { event.preventDefault(); prepareJson("environment_set", "preferences", preferences); }}><label>{t("preferences")}<textarea required value={preferences} onChange={event => { setPreferences(event.target.value); actions.cancelEnvironment(); }} /></label><div className="ensemble-toolbar"><button type="button" disabled={!environment} onClick={() => setPreferences(JSON.stringify(environment?.preferences, null, 2))}>{t("useSaved")}</button><button disabled={!state.connected || state.environmentBusy}>{t("prepare")}</button></div></form></details>
    {environment && <><h3>{t("environment_apply")}</h3><fieldset disabled={state.environmentBusy || !state.connected}>{targets.map(target => <label className="ensemble-checkbox" key={target}><input type="checkbox" checked={selected.includes(target)} onChange={event => { setSelected(event.target.checked ? [...selected, target] : selected.filter(item => item !== target)); actions.cancelEnvironment(); }} />{target}</label>)}<button disabled={!selected.length} onClick={() => { void actions.readEnvironment({ action: "environment_preview", desired_revision: environment.desired_revision!, target_ids: selected }); }}>{t("previewNative")}</button></fieldset>
    <details><summary>{t("environment_restore")}</summary><form className="ensemble-form" onSubmit={event => { event.preventDefault(); actions.prepareEnvironment({ action: "environment_restore", historical_revision: historical }); }}><label>{t("historical")}<input required value={historical} onChange={event => { setHistorical(event.target.value); actions.cancelEnvironment(); }} /></label><button disabled={state.environmentBusy}>{t("prepare")}</button></form></details>
    <details><summary>{t("environmentGrant")}</summary><form className="ensemble-form" onSubmit={event => { event.preventDefault(); prepareJson("environment_grant_read", "grants", grants); }}><label>{t("grants")}<textarea required value={grants} onChange={event => { setGrants(event.target.value); actions.cancelEnvironment(); }} /></label><button disabled={state.environmentBusy}>{t("prepare")}</button></form></details>
    <h3>{t("environment_reconcile")}</h3>{applications.map(application => <article className="ensemble-card" key={String(application.operation_id)}><Details value={application} /><button disabled={state.environmentBusy} onClick={() => actions.prepareEnvironment({ action: "environment_reconcile", application_id: application.operation_id! })}>{t("environment_reconcile")}</button></article>)}</>}
    {state.environmentUncertain && <p className="ensemble-banner">{t("uncertain")} <code>{state.environmentUncertain}</code></p>}
    {invalid && <p role="alert">{t("invalidFields")}</p>}
    {preview && <section className="ensemble-card"><h3>{t("preview")}</h3><Details value={preview} />{Array.isArray(preview.targets) && typeof preview.desired_revision === "string" && <button disabled={state.environmentBusy} onClick={() => actions.prepareEnvironment({ action: "environment_apply", desired_revision: preview.desired_revision!, targets: (preview.targets as Fields[]).map(target => ({ target_id: target.target_id!, expected_native_revision: target.expected_native_revision! })) })}>{t("prepare")}</button>}{typeof preview.next_offset === "number" && <button onClick={() => { void actions.readEnvironment({ action: "environment_history", revision: preview.read_revision!, offset: preview.next_offset! }); }}>{t("more")}</button>}</section>}
    {state.environmentPending && <section className="ensemble-card"><h3>{t("prepare")}</h3><p>{t("impact")}</p><Details value={state.environmentPending} /><div className="ensemble-toolbar"><button disabled={state.environmentBusy || !state.connected} onClick={() => { void actions.submitEnvironment(); }}>{t("confirm")}</button><button onClick={() => actions.cancelEnvironment()}>{t("cancel")}</button></div></section>}
    {state.environmentResult && <section role="status"><h3>{t("saved")}</h3><Details value={state.environmentResult} /></section>}
  </section>;
}
