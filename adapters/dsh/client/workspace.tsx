import { useEffect, useState, type ReactNode } from "react";
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
// Declares the global slot props this panel consumes (`useWorkspaces`), the same
// declaration-merge the shipped Workspace UI relies on. Without this import the hook
// exists at runtime but not in the types, and casting it would be inventing a contract.
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import { EnvironmentPane, type EnvironmentActions } from "./environment.tsx";
import { WorkspaceController, type Snapshot, type View } from "./controller.ts";
import { accessActions, effectiveFields, formPayload, maintenanceActions, management, type FormField, type ManagementAction } from "./management.ts";
import { en, type LocaleKey, type Translate } from "./locales.ts";
import { record, text, type Fields, type Json, type ProjectCard, type Query } from "./protocol.ts";
import { sourceDescriptor, type WorkspaceChoice } from "./workspaces.ts";

/**
 * The actions the keyed page receives.
 *
 * This is the contract `inject` hands the runtime, so every action the UI calls must
 * be listed: a missing entry is not a cosmetic type error, it means that control has
 * no wiring at all at runtime. `destinations`/`grants` are included for exactly that
 * reason — the replica picker and the revoke helper both depend on them.
 */
export type WorkspaceActions = Pick<WorkspaceController, "approve" | "choose" | "select" | "navigate" | "refreshProjects" | "refreshView" | "read" | "canManage" | "prepare" | "cancelPreview" | "submit" | "receipt" | "readDestinations"> & EnvironmentActions & { readonly grants: () => Promise<void> };
/** Native Workspace rows the Host registry actually holds, so binding never asks for an internal id. */
export interface WorkspaceInjected {
  readonly hooks: { readonly workspace: HostObservable<Snapshot> };
  readonly workspaces: { readonly available: boolean; readonly choices: readonly WorkspaceChoice[] };
  readonly controller: WorkspaceActions;
}
export type WorkspaceProps = PropsRuntime<"main"> & InjectFace<WorkspaceInjected> & PropsLocale<"ensemble.workspace">;
const views: readonly View[] = ["work", "materials", "reading", "lessons", "history", "projects", "maintenance"];
const styles = `.ensemble-workspace{height:100%;overflow:auto;background:var(--dsr-bg,#fafafa);color:var(--dsr-text-0,#202124);padding:24px 28px 48px;padding-inline-start:max(28px,var(--dsh-frame-leading-clearance,0px));font:14px/1.6 system-ui,sans-serif}.ensemble-workspace *{box-sizing:border-box}.ensemble-workspace h1{font-size:26px;margin:0}.ensemble-workspace h2{font-size:20px}.ensemble-workspace h3{font-size:16px;margin:0 0 8px}.ensemble-workspace p{margin:8px 0}.ensemble-workspace header,.ensemble-toolbar,.ensemble-tabs{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.ensemble-workspace header{justify-content:space-between;margin-bottom:20px}.ensemble-tabs{border-bottom:1px solid #8885;margin:18px 0}.ensemble-workspace button,.ensemble-workspace input,.ensemble-workspace select,.ensemble-workspace textarea{font:inherit;border:1px solid #8887;border-radius:8px;padding:8px 12px;color:inherit;background:var(--dsr-bg,#fff)}.ensemble-workspace button{cursor:pointer}.ensemble-workspace button:disabled{opacity:.5;cursor:not-allowed}.ensemble-workspace button[aria-current=page],.ensemble-workspace button[aria-pressed=true]{background:#167a6420;border-color:#167a64}.ensemble-workspace label{display:grid;gap:4px}.ensemble-workspace .ensemble-checkbox{display:flex;align-items:center}.ensemble-workspace textarea{min-height:90px;width:100%}.ensemble-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:16px;margin:18px 0}.ensemble-card{border:1px solid #8885;border-radius:12px;padding:18px;background:var(--dsr-bg,#fff);overflow-wrap:anywhere}.ensemble-muted{color:var(--dsr-text-2,#666)}.ensemble-banner{border-inline-start:4px solid #b77718;background:#b7771812;padding:12px 16px;margin:12px 0;overflow-wrap:anywhere}.ensemble-badge{display:inline-block;padding:2px 8px;border-radius:6px;background:#8882;margin-inline-end:6px}.ensemble-workspace pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;background:#8881;padding:16px;border-radius:8px}.ensemble-workspace dl{display:grid;grid-template-columns:minmax(100px,180px) minmax(0,1fr);gap:6px 14px}.ensemble-workspace dt{color:var(--dsr-text-2,#666)}.ensemble-workspace dd{margin:0;overflow-wrap:anywhere}.ensemble-workspace fieldset{border:0;padding:0;margin:0}.ensemble-workspace details{margin:8px 0}.ensemble-form{display:grid;gap:14px;max-width:780px}.ensemble-workspace :focus-visible{outline:3px solid #167a64;outline-offset:3px}.ensemble-safe-preview{white-space:pre-wrap;overflow-wrap:anywhere}.ensemble-safe-preview p{margin:8px 0}.ensemble-workspace code{overflow-wrap:anywhere}@media(max-width:640px){.ensemble-workspace{padding:16px}.ensemble-workspace dl{grid-template-columns:1fr}.ensemble-workspace header{align-items:flex-start}}`;
function label(key: string, t: Translate): string { return key in en ? t(key as LocaleKey) : key.replaceAll("_", " "); }
function Value({ value, t, onRef }: { value: Json | undefined; t: Translate; onRef?: (ref: Fields) => void }): ReactNode {
  if (value === undefined || value === null) return <span className="ensemble-muted">—</span>;
  if (Array.isArray(value)) return <ul>{value.map((entry, i) => <li key={i}><Value value={entry} t={t} onRef={onRef} /></li>)}</ul>;
  if (typeof value === "object" && value.kind === "object" && typeof value.object_id === "string" && typeof value.object_revision === "number" && onRef) return <button type="button" onClick={() => onRef(value)}>{value.object_id} · {t("revision")} {value.object_revision}</button>;
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, entry]) => <div key={key} style={{ display: "contents" }}><dt>{label(key, t)}</dt><dd><Value value={entry} t={t} onRef={onRef} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}
/** A deliberately small Markdown subset. It never produces HTML, images, links or inline event handlers from content. */
export function SafePreview({ content }: { content: string }): ReactNode {
  return <div className="ensemble-safe-preview">{content.split(/\r?\n/u).map((line, i) => {
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) return <h3 key={i}>{heading[2]}</h3>;
    return <p key={i}>{line || "\u00a0"}</p>;
  })}</div>;
}
function contentBytes(content: Fields): Uint8Array<ArrayBuffer> | undefined {
  if (typeof content.text === "string") return new TextEncoder().encode(content.text);
  if (typeof content.bytes === "string" || typeof content.base64 === "string") {
    try { return Uint8Array.from(atob(String(content.base64 ?? content.bytes)), char => char.charCodeAt(0)); } catch { return undefined; }
  }
  return undefined;
}
function Content({ value, t, onMode }: { value: Json; t: Translate; onMode?: (mode: "text" | "bytes") => void }): ReactNode {
  const [mode, setMode] = useState<"preview" | "original">("preview");
  const content: Fields = typeof value === "string" ? { text: value, media_type: "text/plain" } : record(value) ? value as Fields : {};
  const media = text(content.media_type) ?? "application/octet-stream";
  const string = text(content.text);
  const previewable = string !== undefined && ["text/plain", "text/markdown"].includes(media.split(";")[0]!);
  const download = (): void => {
    const bytes = contentBytes(content); if (!bytes) return;
    // No active media type: downloaded HTML/SVG is never opened in the current origin.
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "ensemble-original-bytes.bin"; link.click();
    URL.revokeObjectURL(url);
  };
  return <section className="ensemble-card"><div className="ensemble-toolbar"><button type="button" aria-pressed={mode === "preview"} onClick={() => { setMode("preview"); onMode?.("text"); }}>{t("preview")}</button><button type="button" aria-pressed={mode === "original"} onClick={() => { setMode("original"); onMode?.("bytes"); }}>{t("original")}</button><button type="button" disabled={!contentBytes(content)} onClick={download}>{t("download")}</button></div>
    <dl>{["digest", "bytes", "offset", "media_type"].filter(key => content[key] !== undefined).map(key => <div key={key} style={{ display: "contents" }}><dt>{label(key, t)}</dt><dd>{String(content[key])}</dd></div>)}</dl>
    {mode === "preview" ? previewable ? <SafePreview content={string} /> : <p>{t("unsafePreview")}</p> : <><p className="ensemble-muted">{t("rawNotice")}</p><pre>{string ?? String(content.base64 ?? "")}</pre></>}
  </section>;
}
function Rows({ items, t, open }: { items: readonly Fields[]; t: Translate; open: (item: Fields) => void }): ReactNode {
  return <div className="ensemble-grid">{items.map((item, i) => {
    if (record(item.lesson)) item = { ...item.lesson as Fields, ...item };
    item = record(item.body) ? { ...item.body as Fields, ...item } : item;
    const id = text(item.id) ?? text(item.object_id) ?? text(item.invocation_id);
    const title = text(item.title) ?? text(item.summary) ?? text(item.statement) ?? id ?? String(i + 1);
    return <article className="ensemble-card" key={`${id ?? i}:${String(item.object_revision ?? i)}`}><h3>{title}</h3><div>{["kind", "status", "state", "disposition", "result", "provenance"].map(key => typeof item[key] === "string" ? <span className="ensemble-badge" key={key}>{label(String(item[key]), t)}</span> : null)}</div>
      {item.applicability === "unknown" && <p className="ensemble-banner">{t("unknown")}</p>}{item.applicability === "mismatch" && <p className="ensemble-banner">{t("mismatch")}</p>}
      {item.kind === "contribution" && <dl><dt>{t("returned")}</dt><dd>{String(item.state ?? "—")}</dd><dt>{t("disposition")}</dt><dd>{String(item.disposition ?? "—")}</dd><dt>{t("checkResult")}</dt><dd>{String(item.check_result ?? "—")}</dd></dl>}
      {item.summary !== title && typeof item.summary === "string" && <p>{item.summary}</p>}
      <Value value={item.limits ?? item.limitations ?? item.applicability} t={t} />
      <details><summary>{t("detail")}</summary><Value value={item} t={t} onRef={open} /></details>
      {id && <button type="button" onClick={() => open(item)}>{t("view")}</button>}
    </article>;
  })}</div>;
}
function Management({ controller, state, t, workspaces }: { controller: WorkspaceActions; state: Snapshot; t: Translate; workspaces: WorkspaceInjected["workspaces"] }): ReactNode {
  const actions = state.view === "projects" ? accessActions : maintenanceActions;
  const [action, setAction] = useState<ManagementAction>(actions[0]!);
  const [values, setValues] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [approvalAction, setApprovalAction] = useState("commit_import"); const [approvalDigest, setApprovalDigest] = useState(""); const [approvalStatement, setApprovalStatement] = useState(""); const [approvalDuration, setApprovalDuration] = useState(60000);
  const [locationKind, setLocationKind] = useState("root"); const [locationPath, setLocationPath] = useState(""); const [world, setWorld] = useState(""); const [destinationKey, setDestinationKey] = useState("");
  const handles = (name: string): readonly string[] | undefined => name === "root_handle" ? state.owner?.root_handles : name === "source_handle" ? state.owner?.source_handles : name === "destination_handle" ? state.owner?.destination_handles : undefined;
  const source = (() => { try { const value: unknown = JSON.parse(values.source_descriptor ?? "{}"); return record(value) ? value : {}; } catch { return {}; } })();
  // A fresh Host has no Workspace, and the archive refuses to initialize until one
  // exists. Say so, and offer the registry's own rows rather than a blank box.
  const chooseWorkspace = (choice: WorkspaceChoice): void => {
    setValues({ ...values, source_descriptor: JSON.stringify(sourceDescriptor(choice, String(source.worldIdentity ?? ""))) });
    controller.cancelPreview();
  };

  useEffect(() => { setAction(actions[0]!); setValues({}); setInvalid([]); }, [state.view, state.selected?.project_id]);
  const selectedAction = actions.includes(action) ? action : actions[0]!;
  // What the form renders and what it submits come from this one value, so the two can
  // never disagree. `initialize` needs at least one grant whose subject is the
  // authenticated owner; the operator should not type that, and must still be free to
  // override or clear it. An earlier version computed such a grant and never used it, so
  // the control showed nothing and the payload omitted it.
  const effective = effectiveFields(selectedAction, values, state.owner?.current_owner);
  return <section><h2>{t("management")}</h2>{state.owner && <details><summary>{t("chooseLocation")}</summary><form className="ensemble-form" onSubmit={event => { event.preventDefault(); void controller.choose(locationKind, { world, ...(locationKind === "replica" ? { destinationKey } : { path: locationPath }) }); }}><label>{t("handleKind")}<select value={locationKind} onChange={event => setLocationKind(event.target.value)}>{["root", "source", "destination", "backup", "replica"].map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label><label>{t("world")}<input required value={world} onChange={event => setWorld(event.target.value)} /></label>
        {locationKind === "replica"
          // A network replica is named by the deployment, not by a path. The options
          // come from the Host's own `destinations` read, so a user picks a declared
          // name instead of guessing one; when this Host declares none the control is
          // disabled with a reason rather than shown empty.
          ? (state.destinationsState === "unconfigured"
            ? <p className="ensemble-banner">{t("noDestinations")}</p>
            : <label>{t("destinationKey")}<select required name="destination_select" value={destinationKey} onChange={event => setDestinationKey(event.target.value)}><option value="">—</option>{(state.destinations ?? []).map(destination => <option key={destination.key} value={destination.key}>{destination.key}</option>)}</select></label>)
          : <label>{t("locationPath")}<input required value={locationPath} onChange={event => setLocationPath(event.target.value)} /></label>}
        {locationKind === "replica" && destinationKey !== "" && (() => { const chosen = (state.destinations ?? []).find(item => item.key === destinationKey); return chosen === undefined ? null : <p className="ensemble-muted">{t("remoteIdentity")}: <code>{chosen.identity}</code></p>; })()}
        <button disabled={!state.connected}>{t("chooseLocation")}</button></form>{state.location && <Value value={state.location} t={t} />}</details>}{state.selected && <details><summary>{t("approve")}</summary><form className="ensemble-form" onSubmit={event => { event.preventDefault(); void controller.approve({ action: approvalAction, target_digest: approvalDigest, statement: approvalStatement, expires_after_ms: approvalDuration }); }}><label>{t("action")}<select value={approvalAction} onChange={event => setApprovalAction(event.target.value)}>{["commit_import", "upgrade", "activate_restore", "relocate", "gc", "purge", "stopped-primary"].map(action => <option key={action} value={action}>{label(action, t)}</option>)}</select></label><label>{t("approvalTarget")}<input required value={approvalDigest} onChange={event => setApprovalDigest(event.target.value)} /></label><label>{t("approvalStatement")}<textarea required value={approvalStatement} onChange={event => setApprovalStatement(event.target.value)} /></label><label>{t("approvalDuration")}<input type="number" required min={1000} max={600000} value={approvalDuration} onChange={event => setApprovalDuration(Number(event.target.value))} /></label><button disabled={!state.connected || !state.watching}>{t("approve")}</button></form>{state.approval && <Value value={state.approval} t={t} />}</details>}<details><summary>{t("grantInventory")}</summary><p className="ensemble-muted">{t("grantInventoryHint")}</p><button type="button" disabled={!controller.canManage("diagnose")} onClick={() => { void controller.grants(); }}>{t("diagnose")}</button>
    {state.grants && (state.grants.length === 0 ? <p>{t("noGrants")}</p> : <ul>{state.grants.map(grant => <li key={String(grant.grant_id)}><code>{String(grant.grant_id)}</code> · {String(grant.scope)} · {Array.isArray(grant.rights) ? grant.rights.join(", ") : ""} {grant.revoked === true ? `· ${t("revoked")}` : ""} {selectedAction === "revoke" && <button type="button" onClick={() => { setValues({ ...values, grant_id: String(grant.grant_id) }); controller.cancelPreview(); }}>{t("useThisGrant")}</button>}</li>)}</ul>)}</details>
  <form className="ensemble-form" onSubmit={event => { event.preventDefault(); try { controller.prepare(selectedAction, formPayload(selectedAction, effective as Record<string, string>)); setInvalid([]); } catch (error) { setInvalid([(error as Error).message]); } }}>
    <label>{t("action")}<select name="action" value={selectedAction} onChange={event => { setAction(event.target.value as ManagementAction); setValues({}); setInvalid([]); controller.cancelPreview(); }}>
      {actions.map(item => <option value={item} key={item}>{t(item)}</option>)}
    </select></label>
    <fieldset disabled={!controller.canManage(selectedAction)} className="ensemble-form">{(management[selectedAction] as readonly FormField[]).map(field => <label key={field.name}>{t(field.label)}{!field.optional ? ` · ${t("required")}` : ""}
      {field.name === "source_descriptor" ? <fieldset className="ensemble-form">{([['worldIdentity','world']] as const).map(([key, label]) => <label key={key}>{t(label)}<input required value={String(source[key] ?? "")} onChange={event => { setValues({ ...values, source_descriptor: JSON.stringify({ ...source, [key]: event.target.value }) }); controller.cancelPreview(); }} /></label>)}
        {!workspaces.available ? <p className="ensemble-banner">{t("workspaceUnavailable")}</p>
          : workspaces.choices.length === 0 ? <p className="ensemble-banner">{t("noWorkspace")}</p>
          : <label>{t("workspace")}<select name="workspace_select" value={String(source.nativeWorkspaceRef ?? "")} onChange={event => { const choice = workspaces.choices.find(item => item.workspace_id === event.target.value); if (choice) chooseWorkspace(choice); }}><option value="">—</option>{workspaces.choices.map(choice => <option key={choice.workspace_id} value={choice.workspace_id}>{choice.title} · {choice.path}</option>)}</select></label>}
        {typeof source.canonicalAddress === "string" && <p className="ensemble-muted">{t("canonicalAddress")}: <code>{String(source.canonicalAddress)}</code> · {t("workspaceRef")}: <code>{String(source.nativeWorkspaceRef ?? "")}</code></p>}
      </fieldset> : handles(field.name) ? <select required={!field.optional} value={effective[field.name] ?? ""} onChange={event => { setValues({ ...values, [field.name]: event.target.value }); controller.cancelPreview(); }}><option value="">—</option>{handles(field.name)!.map(handle => <option key={handle} value={handle}>{handle}</option>)}</select> : field.format === "json" ? <textarea name={field.name} required={!field.optional} value={effective[field.name] ?? ""} onChange={event => { setValues({ ...values, [field.name]: event.target.value }); controller.cancelPreview(); }} /> : <input name={field.name} type={field.format === "number" ? "number" : "text"} required={!field.optional} value={effective[field.name] ?? ""} onChange={event => { setValues({ ...values, [field.name]: event.target.value }); controller.cancelPreview(); }} />}
    </label>)}<button type="submit">{t("prepare")}</button></fieldset>
    {!controller.canManage(selectedAction) && <p>{t("forbidden")}</p>}{invalid.length > 0 && <p role="alert">{t("invalidFields")}{invalid.length === 1 && invalid[0] !== "" ? ` · ${invalid[0]}` : ""}</p>}
  </form>{state.preview && <section className="ensemble-card" aria-label={t("prepare")}><h3>{t("prepare")}</h3><p>{t("impact")}</p><Value value={state.preview.request} t={t} /><div className="ensemble-toolbar"><button type="button" disabled={state.submitting} onClick={() => { void controller.submit(); }}>{t("confirm")}</button><button type="button" onClick={() => controller.cancelPreview()}>{t("cancel")}</button></div></section>}
  {state.result && <section className="ensemble-card" role="status"><h3>{t("saved")}</h3><Value value={state.result} t={t} /></section>}
  </section>;
}
function QueryView({ controller, state, t }: { controller: WorkspaceActions; state: Snapshot; t: Translate }): ReactNode {
  const [domain, setDomain] = useState(""); const [task, setTask] = useState(""); const [search, setSearch] = useState("");
  const [status, setStatus] = useState("supported"); const [drafts, setDrafts] = useState(false);
  const [objectId, setObjectId] = useState(""); const [invocationId, setInvocationId] = useState("");
  const read = (query: Query): void => { void controller.read(query); };
  useEffect(() => {
    if (!state.selected) return;
    if (state.view === "work") read({ kind: "list", object_kind: "invocation" });
    if (state.view === "materials") read({ kind: "list", object_kind: "artifact" });
    if (state.view === "reading") read({ kind: "list", object_kind: "domain" });
  }, [state.selected?.project_id, state.view]);
  const open = (item: Fields): void => {
    const id = text(item.id) ?? text(item.object_id) ?? text(item.invocation_id);
    if (!id) return;
    if (item.kind === "invocation" || state.query?.kind === "list" && state.query.object_kind === "invocation") { setInvocationId(id); read({ kind: "checkpoint", invocation_id: id, revision: state.page!.read_revision }); }
    else if (item.kind === "domain" || state.query?.kind === "list" && state.query.object_kind === "domain") { setDomain(id); read({ kind: "reading", domain_id: id, include_drafts: drafts, revision: state.page!.read_revision }); }
    else { setObjectId(id); read({ kind: "object", object_id: id, revision: state.page!.read_revision, ...(typeof item.object_revision === "number" ? { object_revision: item.object_revision } : {}), content_mode: "text" }); }
  };
  return <section><p className="ensemble-muted">{t("readOnly")}</p>
    {state.view === "work" && <div className="ensemble-toolbar">{(["invocation", "attempt", "contribution", "check"] as const).map(kind => <button type="button" key={kind} onClick={() => read({ kind: "list", object_kind: kind, ...(invocationId && kind !== "invocation" ? { invocation_id: invocationId } : {}) })}>{t(kind === "invocation" ? "work" : kind === "attempt" ? "attempts" : kind === "check" ? "checks" : "contributions")}</button>)}</div>}
    {state.view === "reading" && <form className="ensemble-toolbar" onSubmit={event => { event.preventDefault(); read({ kind: "reading", domain_id: domain, include_drafts: drafts }); }}><label>{t("domain")}<input required value={domain} onChange={event => setDomain(event.target.value)} /></label><label className="ensemble-checkbox"><input type="checkbox" checked={drafts} onChange={event => setDrafts(event.target.checked)} />{t("drafts")}</label><button>{t("query")}</button></form>}
    {state.view === "lessons" && <form className="ensemble-toolbar" onSubmit={event => { event.preventDefault(); read({ kind: "lessons", task_context: { task_types: task.split(",").map(x => x.trim()).filter(Boolean), interface_versions: [], required_capabilities: [] }, status: status as "supported" | "proposed" | "contested" | "retired", ...(search ? { text: search } : {}), ...(domain ? { domain_id: domain } : {}) }); }}><label>{t("taskContext")}<input required value={task} onChange={event => setTask(event.target.value)} /></label><label>{t("domain")}<input value={domain} onChange={event => setDomain(event.target.value)} /></label><label>{t("search")}<input value={search} onChange={event => setSearch(event.target.value)} /></label><label>{t("status")}<select value={status} onChange={event => setStatus(event.target.value)}>{(["supported", "proposed", "contested", "retired"] as const).map(item => <option key={item} value={item}>{t(item)}</option>)}</select></label><button>{t("query")}</button></form>}
    {(state.view === "history" || state.view === "materials") && <form className="ensemble-toolbar" onSubmit={event => { event.preventDefault(); read(state.view === "history" ? { kind: "history", ...(objectId ? { object_id: objectId } : { invocation_id: invocationId }) } : { kind: "artifact", object_id: objectId, content_mode: "text" }); }}><label>{t("objectId")}<input required={state.view === "materials" || !invocationId} value={objectId} onChange={event => setObjectId(event.target.value)} /></label>{state.view === "history" && <label>{t("invocationId")}<input disabled={!!objectId} required={!objectId} value={invocationId} onChange={event => setInvocationId(event.target.value)} /></label>}<button>{t("query")}</button></form>}
    {state.loading && <p role="status">{t("loading")}</p>}
    {state.page && <><p className="ensemble-muted"><span>{t("snapshot")}: </span><code>{state.page.read_revision}</code> · {t(state.page.completeness === "partial" ? "partial" : "complete")}</p>{state.page.completeness === "partial" && <p className="ensemble-banner">{state.page.reason ?? t("partial")}</p>}
      {state.page.items.length ? <><Rows items={state.page.items.filter(item => typeof item.text !== "string" && typeof item.base64 !== "string")} t={t} open={open} />{state.page.items.filter(item => typeof item.text === "string" || typeof item.base64 === "string").map((item, i) => <Content key={`${state.page!.read_revision}:${String(state.query && "object_id" in state.query ? state.query.object_id : i)}`} value={item} t={t} onMode={state.query && (state.query.kind === "artifact" || state.query.kind === "object") ? mode => { if (state.query && (state.query.kind === "artifact" || state.query.kind === "object")) { const { cursor: _cursor, ...base } = state.query; read({ ...base, revision: state.page!.read_revision, content_mode: mode }); } } : undefined} />)}</> : state.page.content === undefined && <p>{t("empty")}</p>}
      {state.page.content !== undefined && (typeof state.page.content === "string" || record(state.page.content) && ("text" in state.page.content || "bytes" in state.page.content || "base64" in state.page.content) ? <Content key={`${state.page.read_revision}:${String(state.query && "object_id" in state.query ? state.query.object_id : "")}`} value={state.page.content} t={t} /> : <section className="ensemble-card"><Value value={state.page.content} t={t} /></section>)}
      {state.page.next_cursor && <button type="button" disabled={state.loading} onClick={() => { if (state.query) void controller.read(state.query, true); }}>{t("more")}</button>}
    </>}
  </section>;
}
/**
 * The native keyed main slot supplies localization; the controller owns all wire-derived
 * state.
 *
 * The Workspace picker reads the native registry through the slot's own `useWorkspaces`
 * hook rather than from a value captured in the slot's `inject()` thunk. That thunk is
 * evaluated once per registration, so a registry created *after* the panel mounted (the
 * fresh-Host journey: create a Workspace, then come back to initialize) would never
 * re-render the picker. `useWorkspaces` is the runtime's subscription hook over the same
 * observable the shipped sidebar uses, so an arrival, list change or removal re-renders
 * this panel exactly as it re-renders theirs.
 */
export function Workspace({ controller, useWorkspace, t, workspaces }: Pick<WorkspaceProps, "controller" | "useWorkspace" | "t"> & { workspaces: WorkspaceInjected["workspaces"] }): ReactNode {
  const state = useWorkspace((snapshot: Snapshot) => snapshot);
  // The registry rows the seam last published, or the inject-time value when it has not
  // reported yet. Reading live state (rather than the one-shot slot prop) is what makes a
  // Workspace created after this panel mounted appear here without a reload.
  const live = state.workspaces ?? workspaces;
  // The Client's own state, published as data attributes on the root.
  //
  // The owner form is disabled unless the controller considers a management action
  // possible, and from the outside that is indistinguishable from "the button does
  // nothing". These attributes are the same facts the component already uses, so a
  // reader (or an acceptance gate) can tell *why* without instrumenting the bundle.
  const stateAttributes = {
    "data-connection": state.connected ? "connected" : "disconnected",
    "data-status": state.status,
    "data-watching": state.watching ? "yes" : "no",
    "data-selected": state.selected?.project_id ?? "",
    "data-epoch": state.selected?.authorization_epoch ?? "",
    "data-view": state.view,
  };
  return <main className="ensemble-workspace" aria-label={t("title")} {...stateAttributes}><style>{styles}</style><header><div><h1>{t("title")}</h1><p className="ensemble-muted">{t("subtitle")}</p></div><div className="ensemble-toolbar"><label>{t("project")}<select value={state.selected?.project_id ?? ""} disabled={!state.connected} onChange={event => controller.select(event.target.value)}><option value="">{t("chooseProject")}</option>{state.projects.map((project: ProjectCard) => <option key={project.project_id} value={project.project_id}>{project.title}</option>)}</select></label><button type="button" disabled={!state.connected} onClick={() => { void controller.refreshProjects(); }}>{t("refresh")}</button></div></header>
    <nav className="ensemble-tabs" aria-label={t("title")}>{views.map(view => <button type="button" key={view} aria-current={view === state.view ? "page" : undefined} onClick={() => controller.navigate(view)}>{t(view)}</button>)}</nav>
    {!state.connected && <p className="ensemble-banner" role="status">{t("disconnected")}</p>}{state.status === "denied" && <p className="ensemble-banner" role="alert">{t("denied")}</p>}{state.status === "loading" && <p role="status">{t("loading")}</p>}{state.status === "ready" && !state.projects.length && <p>{t("emptyProjects")}</p>}
    {state.error && <section role="alert" className="ensemble-banner"><strong>{state.error.code}</strong><p>{state.error.message}</p>{["revision_conflict", "object_changed", "preview_expired"].includes(state.error.code) && <p>{t("conflict")}</p>}</section>}
    {state.uncertain_operation && <section className="ensemble-banner" role="status" data-recovery={state.recovery ?? "awaiting"}><p>{t("uncertain")}</p><code>{state.uncertain_operation}</code><button type="button" disabled={!state.connected || state.recovery === "revalidating"} onClick={() => { void controller.receipt(); }}>{t("receipt")}</button>{state.recoveryError && <p className="ensemble-muted">{state.recoveryError.message}</p>}</section>}
    {!state.selected && state.owner && state.view === "projects" && <Management key="initialize" controller={controller} state={state} t={t} workspaces={live} />}
    {state.owner && state.view === "maintenance" && <EnvironmentPane actions={controller} state={state} t={t} />}
    {state.selected && <><div className="ensemble-toolbar"><span>{t("epoch")}: {state.selected.authorization_epoch}</span><span>{t("snapshot")}: <code>{state.selected.read_revision}</code></span>{state.selected.paused && <span className="ensemble-badge">{t("paused")}</span>}<button type="button" onClick={() => { void controller.refreshView(); }}>{t("refreshView")}</button></div>{state.newer_revision && <p className="ensemble-banner">{t("newRevision")}</p>}
      {state.view === "projects" || state.view === "maintenance" ? <Management key={`${state.selected.project_id}:${state.view}`} controller={controller} state={state} t={t} workspaces={live} /> : <QueryView key={state.selected.project_id} controller={controller} state={state} t={t} />}
    </>}
  </main>;
}
export function EnsembleIcon(): ReactNode { return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 4h6v6H3zm8 0h6v6h-6zM3 12h6v4H3zm8 0h6v4h-6z" stroke="currentColor" strokeWidth="1.5" /></svg>; }
