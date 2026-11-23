import { actorKey, type DomainRecord, type HistoryEntry, type ObjectRef, type Projection, type RecordOf, type RenderedView, type Snapshot, type ViewSelection } from "./contracts.ts";
import { objectAt, sameRef } from "./policy.ts";
import { deriveLessonStatus } from "./learning.ts";
/** Literal prose for generated Markdown. Raw originals remain in their records.
 * Escape syntax before Markdown parsing; do not depend on a renderer allowing HTML
 * or on a URL sanitizer to prevent automatic external resource loading.
 */
export function safeMarkdown(text: string): string {
    return text.replace(/[&<>\\`*_{}\[\]()#+\-.!|~:]/g, (character) => `&#${character.codePointAt(0)};`);
}
function reference(record: DomainRecord): ObjectRef { return { kind: "object", object_id: record.id, object_revision: record.object_revision }; }
function refs(value: unknown): ObjectRef[] {
    if (!value || typeof value !== "object")
        return [];
    if (Array.isArray(value))
        return value.flatMap(refs);
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "object" && typeof candidate.object_id === "string" && typeof candidate.object_revision === "number")
        return [candidate as ObjectRef];
    return Object.values(candidate).flatMap(refs);
}
/** Primary ownership is a separate mapping; moving a publication cannot mutate reviewed prose. */
export function primaryDomain(snapshot: Snapshot, publication: RecordOf<"publication">): string | undefined {
    const explicit = snapshot.objects.filter((r): r is RecordOf<"domain"> => r.kind === "domain" && r.body.primary_publication_ids?.includes(publication.id) === true);
    if (explicit.length === 1)
        return explicit[0]!.id;
    if (explicit.length > 1)
        return undefined;
    const original = snapshot.objects.find(r => r.kind === "domain" && r.id === publication.body.domain_id);
    return original?.kind === "domain" && original.body.primary_publication_ids === undefined && !original.body.retired ? original.id : undefined;
}
export function publicationState(snapshot: Snapshot, publication: RecordOf<"publication">): {
    status: "current" | "corrected" | "withdrawn";
    current_ref: ObjectRef;
    contested: boolean;
    challenge_refs: readonly ObjectRef[];
} {
    let latest = publication;
    const visited = new Set<string>();
    while (!visited.has(latest.id)) {
        visited.add(latest.id);
        const next = snapshot.objects.find((r): r is RecordOf<"publication"> => r.kind === "publication" && !!r.body.supersedes && sameRef(r.body.supersedes, reference(latest)));
        if (!next)
            break;
        latest = next;
    }
    const key = (ref: ObjectRef) => JSON.stringify([ref.object_id, ref.object_revision]);
    const dependencies = new Set<string>(), pending = [reference(publication)];
    while (pending.length) {
        const ref = pending.pop()!, id = key(ref);
        if (dependencies.has(id))
            continue;
        dependencies.add(id);
        const target = objectAt(snapshot, ref);
        if (target)
            for (const child of refs(target.body))
                pending.push(child);
    }
    const challenges = snapshot.objects.filter((r): r is RecordOf<"challenge"> => r.kind === "challenge" && dependencies.has(key(r.body.target)) && (!r.body.resolution || r.body.resolution.resolution === "upheld"));
    return { status: latest.body.status === "withdrawn" ? "withdrawn" : latest.id !== publication.id ? "corrected" : "current", current_ref: reference(latest), contested: challenges.length > 0, challenge_refs: challenges.map(reference) };
}
function valueLines(value: unknown, depth = 0): string[] {
    const pad = "  ".repeat(depth);
    if (Array.isArray(value))
        return value.length ? value.flatMap((item, index) => [`${pad}- ${index + 1}:`, ...valueLines(item, depth + 1)]) : [`${pad}- []`];
    if (value && typeof value === "object")
        return Object.entries(value).flatMap(([key, item]) => typeof item === "object" && item !== null ? [`${pad}- **${safeMarkdown(key)}**:`, ...valueLines(item, depth + 1)] : [`${pad}- **${safeMarkdown(key)}**: ${safeMarkdown(String(item)).replace(/\n/g, `\n${pad}  `)}`]);
    return [`${pad}${safeMarkdown(String(value))}`];
}
export function renderObject(snapshot: Snapshot, record: DomainRecord, stateSnapshot: Snapshot = snapshot): string {
    const lines = [`## ${safeMarkdown(record.kind)} ${safeMarkdown(record.id)} · revision ${record.object_revision}`, `Actor: ${safeMarkdown(actorKey(record.author))}`, `Created sequence: ${record.created_sequence}; updated sequence: ${record.updated_sequence}`];
    if (record.kind === "lesson")
        lines.push(`Derived status: ${deriveLessonStatus(stateSnapshot, record)}`, "Evidence describes the recorded application; publication is not proof of transfer.");
    if (record.kind === "application") {
        const current = snapshot.objects.find(r => r.kind === "lesson" && r.id === record.body.lesson_ref.object_id);
        if (current && current.object_revision !== record.body.lesson_ref.object_revision)
            lines.push("Historical lesson application: current and retired states are unchanged. Assess potential impact with an explicit challenge or new application.", ...valueLines({ possibly_affected_current_lesson: reference(current) }));
    }
    if (record.kind === "reflection")
        lines.push(`Publication state: ${snapshot.objects.some(r => r.kind === "publication" && sameRef(r.body.proposal_ref, reference(record))) ? "published" : "draft"}`);
    if (record.kind === "publication") {
        const state = publicationState(stateSnapshot, record);
        const visibleState = { ...state, current_ref: objectAt(snapshot, state.current_ref) ? state.current_ref : "unavailable under current read grant", challenge_refs: state.challenge_refs.filter(ref => objectAt(snapshot, ref) !== undefined) };
        lines.push(...valueLines({ publication_state: visibleState, primary_domain: primaryDomain(snapshot, record) ?? "unknown" }));
        const draft = objectAt(snapshot, record.body.proposal_ref);
        lines.push(draft?.kind === "reflection" ? `### Reviewed prose\n\n${valueLines(draft.body).join("\n")}` : "Reviewed prose unavailable at this exact revision; retrieve the original proposal reference.");
    }
    return [...lines, "### Recorded content (derived state is shown above)", ...valueLines(record.body)].join("\n\n");
}
function renderSelection(snapshot: Snapshot, selection: ViewSelection, stateSnapshot: Snapshot): RenderedView {
    let objects: DomainRecord[] = [];
    switch (selection.kind) {
        case "checkpoint":
            objects = snapshot.objects.filter(r => r.id === selection.invocation_id || "invocation_id" in r.body && r.body.invocation_id === selection.invocation_id);
            break;
        case "object":
            objects = snapshot.objects.filter(r => r.id === selection.object_id);
            break;
        case "reading":
            objects = snapshot.objects.filter(r => r.kind === "domain" && r.id === selection.domain_id || r.kind === "publication" && primaryDomain(snapshot, r) === selection.domain_id).sort((a, b) => a.kind === "domain" ? -1 : b.kind === "domain" ? 1 : a.kind === "publication" && b.kind === "publication" ? a.body.sequence - b.body.sequence : a.id.localeCompare(b.id));
            break;
        case "overview":
            objects = snapshot.objects.filter(r => r.kind === "domain" || r.kind === "lesson");
            break;
    }
    const text = [`# Ensemble ${selection.kind}`, `Project: ${safeMarkdown(snapshot.projectId)} · read revision: ${safeMarkdown(snapshot.revision)}`, "This view preserves recorded claims and limitations. Native activity and unseen exposure remain unknown unless supplied as evidence.", ...objects.map(r => renderObject(snapshot, r, stateSnapshot)), ...(objects.length ? [] : ["No matching records in this snapshot."])].join("\n\n");
    return { selection, media_type: "text/markdown", text, renderer_version: snapshot.rendererVersion };
}
/** Queries pass a readable snapshot plus full-state facts: hidden counterevidence cannot become a positive claim. */
export function renderViews(snapshot: Snapshot, selections: readonly ViewSelection[], stateSnapshot: Snapshot = snapshot): readonly RenderedView[] { return selections.map(selection => renderSelection(snapshot, selection, stateSnapshot)); }
export const projection: Projection = { render: renderViews };
/** History is an IO fact, not inferred from current objects or timestamp ordering. */
export function renderHistory(snapshot: Snapshot, entries: readonly HistoryEntry[]): string { return [`# Ensemble history`, `Read revision: ${safeMarkdown(snapshot.revision)}`, ...entries.map(entry => valueLines(entry).join("\n"))].join("\n\n"); }
