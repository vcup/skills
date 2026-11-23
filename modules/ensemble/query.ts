import { failure, success, type Applicability, type DomainRecord, type LessonMatch, type RecordOf, type ObjectRef, type ProjectSummary, type Query, type QueryFacts, type QueryItem, type ReadPage, type Result, type Snapshot, type StructuredContentPage } from "./contracts.ts";
import { decodeQuery } from "./codec.ts";
import { hasRight, isLead, mayReadObject, objectAt, sameRef } from "./policy.ts";
import { deriveLessonStatus } from "./learning.ts";
import { primaryDomain, renderViews, renderObject } from "./projection.ts";
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function response(snapshot: Snapshot, items: readonly QueryItem[], next: number | undefined, facts: QueryFacts, reason = "More complete records are available"): Result<ReadPage> {
    if (next !== undefined && !facts.nextCursor)
        return failure("budget_exceeded", "Pagination requires an Archive-issued snapshot cursor; narrow the query");
    const page: ReadPage = { project_id: snapshot.projectId, read_revision: snapshot.revision, authorization_epoch: snapshot.policy.epoch, items, completeness: next === undefined ? "complete" : "partial", ...(next === undefined ? {} : { partial_reason: reason, next_cursor: facts.nextCursor!(next) }) };
    const result = success(page);
    return byteLength(result) > (facts.responseBytes ?? 32768) ? failure("budget_exceeded", "A complete item and response metadata exceed the response budget; narrow the query or request content pages") : result;
}
function page(snapshot: Snapshot, items: readonly QueryItem[], query: Query, facts: QueryFacts): Result<ReadPage> {
    const start = facts.offset ?? 0, limit = "page_size" in query && query.page_size !== undefined ? query.page_size : facts.pageItems ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(start) || start < 0 || start > items.length)
        return failure("invalid_input", "Invalid page size or position");
    const picked: QueryItem[] = [];
    let result: Result<ReadPage> | undefined;
    for (let index = start; index < items.length && picked.length < limit; index++) {
        const next = index + 1 < items.length ? index + 1 : undefined;
        const candidate = response(snapshot, [...picked, items[index]!], next, facts);
        if (!candidate.ok)
            return picked.length ? result! : candidate;
        picked.push(items[index]!);
        result = candidate;
    }
    return result ?? response(snapshot, [], undefined, facts);
}
function inDomain(snapshot: Snapshot, record: DomainRecord, domainId: string, seen = new Set<string>()): boolean {
    if (seen.has(record.id))
        return false;
    seen.add(record.id);
    if (record.kind === "domain")
        return record.id === domainId;
    if (record.kind === "publication")
        return primaryDomain(snapshot, record) === domainId;
    if (record.kind === "reflection")
        return record.body.domain_id === domainId;
    if (record.kind === "artifact")
        return record.body.domains.includes(domainId);
    if (record.kind === "lesson")
        return record.body.supporting_refs.some(ref => { if (ref.kind !== "object")
            return false; const target = objectAt(snapshot, ref); return !!target && inDomain(snapshot, target, domainId, new Set(seen)); });
    return false;
}
function fold(text: string): string {
    // Per-code-point expansion handles sharp-s, Greek variants and ligatures;
    // dotless i keeps its distinct default (non-Turkic) Unicode equivalence class.
    return Array.from(text.normalize("NFKC"), character => character === "ı" ? character : character.toUpperCase().toLowerCase()).join("").replace(/ß/g, "ss").normalize("NFKC");
}
function applicability(required: Applicability, context: Applicability): Pick<LessonMatch, "applicability" | "reasons"> {
    let unknown = false, mismatch = false;
    const reasons: string[] = [];
    for (const key of ["task_types", "interface_versions", "required_capabilities"] as const) {
        const expected = required[key].map(fold), actual = context[key].map(fold);
        if (!expected.length) {
            reasons.push(`${key}: no restriction recorded`);
            continue;
        }
        if (!actual.length) {
            unknown = true;
            reasons.push(`${key}: context is unknown; not a positive recommendation`);
            continue;
        }
        const matches = key === "required_capabilities" ? expected.every(value => actual.includes(value)) : expected.some(value => actual.includes(value));
        if (!matches)
            mismatch = true;
        reasons.push(`${key}: ${matches ? "matches recorded condition" : "does not match recorded condition"}`);
    }
    return { applicability: mismatch ? "mismatch" : unknown ? "unknown" : "matched", reasons };
}
function searchLessons(snapshot: Snapshot, visible: Snapshot, query: Extract<Query, {
    kind: "lessons";
}>, facts: QueryFacts): Result<ReadPage> {
    const candidates = visible.objects.filter((r): r is RecordOf<"lesson"> => r.kind === "lesson").sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const start = facts.offset ?? 0, scanLimit = facts.searchScanObjects ?? 10000, pageLimit = query.page_size ?? facts.pageItems ?? 50;
    if (!Number.isSafeInteger(start) || start < 0 || start > candidates.length || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100)
        return failure("invalid_input", "Invalid search scan, page size or cursor position");
    const terms = fold(query.text ?? "").split(/\s+/u).filter(Boolean), items: LessonMatch[] = [];
    let index = start, scanned = 0;
    const ordered = () => [...items].sort((a, b) => (a.applicability === "unknown" ? 1 : 0) - (b.applicability === "unknown" ? 1 : 0));
    while (index < candidates.length && scanned < scanLimit && items.length < pageLimit) {
        const lesson = candidates[index]!, position = index++;
        scanned++;
        if (query.domain_id && !inDomain(visible, lesson, query.domain_id))
            continue;
        const status = deriveLessonStatus(snapshot, lesson);
        if (status !== (query.status ?? "supported"))
            continue;
        const match = applicability(lesson.body.applicability, query.task_context);
        if (match.applicability === "mismatch")
            continue;
        const searchable = fold([lesson.body.title, lesson.body.trigger, lesson.body.action, lesson.body.counterexamples, lesson.body.invalidation_condition, ...Object.values(lesson.body.applicability).flat()].join("\n"));
        if (!terms.every(term => searchable.includes(term)))
            continue;
        const first = terms[0];
        const snippet = [lesson.body.title, lesson.body.trigger, lesson.body.action, lesson.body.counterexamples, lesson.body.invalidation_condition].find(text => first !== undefined && fold(text).includes(first)) ?? lesson.body.trigger;
        const item: LessonMatch = { lesson, status, ...match, snippet };
        items.push(item);
        const probe = response(snapshot, ordered(), index < candidates.length ? index : undefined, facts);
        if (!probe.ok) {
            items.pop();
            return items.length ? response(snapshot, ordered(), position, facts) : probe;
        }
    }
    return response(snapshot, ordered(), index < candidates.length ? index : undefined, facts, scanned >= scanLimit ? "Search scan budget reached; continue this snapshot before interpreting an empty result" : "More whole lessons are available; unknown applicability is not a recommendation");
}
function structuredContent(snapshot: Snapshot, record: DomainRecord, mode: "text" | "bytes", facts: QueryFacts, stateSnapshot: Snapshot = snapshot): Result<ReadPage> {
    const content = new TextEncoder().encode(mode === "text" ? renderObject(snapshot, record, stateSnapshot) : JSON.stringify(record));
    const offset = facts.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length || mode === "text" && offset < content.length && (content[offset]! & 0xc0) === 0x80)
        return failure("cursor_expired", "Generated content cursor is not a valid byte boundary");
    let low = offset, high = Math.min(content.length, offset + (facts.responseBytes ?? 32768)), best: Result<ReadPage> | undefined;
    while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        let end = midpoint;
        if (mode === "text")
            while (end > offset && end < content.length && (content[end]! & 0xc0) === 0x80)
                end--;
        if (end === offset && offset < content.length) {
            low = midpoint + 1;
            continue;
        }
        const bytes = content.subarray(offset, end), next = end < content.length ? end : undefined;
        const item: StructuredContentPage = { kind: "object_content", generated: true, object_ref: { kind: "object", object_id: record.id, object_revision: record.object_revision }, media_type: mode === "text" ? "text/markdown" : "application/json", total_bytes: content.length, offset, ...(next === undefined ? {} : { next_offset: next }), ...(mode === "text" ? { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) } : { base64: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")) }) };
        const result = response(snapshot, [item], next, facts, "More generated object content is available; retain all pages before interpreting the complete scope and limitations");
        if (result.ok) {
            best = result;
            low = midpoint + 1;
        }
        else
            high = midpoint - 1;
    }
    return best ?? failure("budget_exceeded", "Response metadata and one complete character exceed the budget");
}
/** Archive authenticates cursor/epoch and supplies a pinned snapshot and already-authorized IO facts. */
export function querySnapshot(snapshot: Snapshot, query: Query, facts: QueryFacts): Result<ReadPage> {
    const decoded = decodeQuery(query);
    if (!decoded.ok)
        return decoded;
    query = decoded.value;
    if (query.project_id !== undefined && query.project_id !== snapshot.projectId)
        return failure("not_authorized", "Project selection does not grant access");
    if (!hasRight(snapshot, facts.actor, "read", { kind: "project" }, facts.now) && !snapshot.policy.grants.some(g => hasRight(snapshot, facts.actor, "read", g.scope, facts.now)))
        return failure("not_authorized", "Current read authorization is required");
    if ("revision" in query && query.revision !== undefined && query.revision !== snapshot.revision)
        return failure("revision_conflict", "Archive must supply the requested fixed snapshot");
    if ("cursor" in query && query.cursor !== undefined && facts.offset === undefined)
        return failure("cursor_expired", "Archive must validate the cursor before querying");
    if (!Number.isSafeInteger(facts.responseBytes ?? 32768) || (facts.responseBytes ?? 32768) < 1)
        return failure("invalid_input", "Response budget must be a positive integer");
    const objects = snapshot.objects.filter(r => mayReadObject(snapshot, facts.actor, r, facts.now));
    const visible: Snapshot = { ...snapshot, objects, objectHistory: snapshot.objectHistory?.filter(r => mayReadObject(snapshot, facts.actor, r, facts.now)) };
    const lookup = (ref: ObjectRef) => { const r = objectAt(visible, ref) ?? facts.resolveObject?.(ref); return r && sameRef(ref, { kind: "object", object_id: r.id, object_revision: r.object_revision }) && mayReadObject(snapshot, facts.actor, r, facts.now) ? r : undefined; };
    switch (query.kind) {
        case "context":
        case "projects": {
            const capabilities = [...(["read", "open", "organize"] as const).filter(right => hasRight(snapshot, facts.actor, right, { kind: "project" }, facts.now)), ...objects.filter(r => r.kind === "invocation" && isLead(snapshot, facts.actor, r.id, facts.now)).map(r => `lead:${r.id}`)];
            const project: ProjectSummary = { project_id: snapshot.projectId, title: snapshot.title, read_revision: snapshot.revision, authorization_epoch: snapshot.policy.epoch, capabilities, ...(snapshot.bindings.find(b => b.active && facts.actor.kind === "session" && b.nativeWorkspaceRef === facts.actor.workspaceRef) ? { binding_id: snapshot.bindings.find(b => b.active && facts.actor.kind === "session" && b.nativeWorkspaceRef === facts.actor.workspaceRef)!.bindingId } : {}) };
            return response(snapshot, query.kind === "projects" ? facts.projects ?? [project] : [project], undefined, facts);
        }
        case "invocation":
        case "checkpoint": {
            const invocation = objects.find(r => r.kind === "invocation" && r.id === query.invocation_id);
            if (!invocation)
                return failure("not_found", "Invocation not found");
            return response(snapshot, query.kind === "invocation" ? [invocation] : renderViews(visible, [{ kind: "checkpoint", invocation_id: invocation.id }], snapshot), undefined, facts);
        }
        case "object":
        case "artifact": {
            let record = objects.find(r => r.id === query.object_id);
            if (query.object_revision !== undefined) {
                if (query.revision !== undefined && record?.object_revision !== query.object_revision)
                    return failure("object_changed", "Object revision is not current at the explicitly selected archive revision");
                record = lookup({ kind: "object", object_id: query.object_id, object_revision: query.object_revision });
            }
            if (!record || query.kind === "artifact" && record.kind !== "artifact")
                return failure("not_found", "Object not found at this exact version");
            if (!query.content_mode || query.content_mode === "summary")
                return response(snapshot, [record], undefined, facts);
            if (record.kind !== "artifact")
                return structuredContent({ ...visible, objects: [...visible.objects.filter(r => r.id !== record!.id), record] }, record, query.content_mode, facts, snapshot);
            const content = facts.content;
            if (!content)
                return failure("storage_unavailable", "Archive must supply authorized exact content bytes");
            if (!sameRef(content.object_ref, { kind: "object", object_id: record.id, object_revision: record.object_revision }) || content.digest !== record.body.content.digest || content.bytes !== record.body.content.bytes || content.media_type !== record.body.content.media_type)
                return failure("archive_corrupt", "Content descriptor differs from the exact artifact");
            if (content.offset !== (facts.offset ?? 0) || content.offset < 0 || !Number.isSafeInteger(content.offset))
                return failure("cursor_expired", "Content offset does not match the authenticated cursor");
            let length: number;
            if (query.content_mode === "text") {
                if (content.text === undefined || content.base64 !== undefined || /[\uD800-\uDFFF]/u.test(content.text))
                    return failure("archive_corrupt", "Text page must contain intact UTF-8 text only");
                length = new TextEncoder().encode(content.text).byteLength;
            }
            else {
                if (content.base64 === undefined || content.text !== undefined || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.base64))
                    return failure("archive_corrupt", "Byte page must contain canonical base64 only");
                if (btoa(atob(content.base64)) !== content.base64)
                    return failure("archive_corrupt", "Byte page base64 has noncanonical padding bits");
                length = content.base64.length / 4 * 3 - (content.base64.endsWith("==") ? 2 : content.base64.endsWith("=") ? 1 : 0);
            }
            const end = content.offset + length;
            if (end > content.bytes || content.next_offset !== undefined && (content.next_offset !== end || end >= content.bytes || length === 0) || content.next_offset === undefined && end !== content.bytes)
                return failure("archive_corrupt", "Content page must cover its declared range without false completeness");
            return response(snapshot, [content], content.next_offset, facts, "More original content bytes are available");
        }
        case "history": {
            const target = "object_id" in query ? objects.find(r => r.id === query.object_id) : objects.find(r => r.kind === "invocation" && r.id === query.invocation_id);
            if (!target)
                return failure("not_found", "History target not found");
            if (facts.history === undefined)
                return failure("storage_unavailable", "Archive must supply authorized history entries");
            return page(snapshot, facts.history, query, facts);
        }
        case "receipt": return facts.receipt?.operation_id === query.operation_id ? response(snapshot, [facts.receipt], undefined, facts) : failure("not_found", "Receipt not found for this actor and operation");
        case "environment_preferences": return facts.environment?.role === query.role ? response(snapshot, [facts.environment], undefined, facts) : failure("not_authorized", "A separately authorized environment read is required");
        case "list": return page(snapshot, objects.filter(r => r.kind === query.object_kind && (!query.domain_id || inDomain(visible, r, query.domain_id)) && (!query.invocation_id || (r.kind === "invocation" ? r.id === query.invocation_id : "invocation_id" in r.body && r.body.invocation_id === query.invocation_id)) && (!query.status || (r.kind === "lesson" ? deriveLessonStatus(snapshot, r) : "status" in r.body ? r.body.status : r.kind === "invocation" ? r.body.lifecycle : r.kind === "attempt" ? r.body.progress : undefined) === query.status)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), query, facts);
        case "reading": {
            const domain = objects.find(r => r.kind === "domain" && r.id === query.domain_id);
            if (!domain)
                return failure("not_found", "Reading domain not found");
            const publications = objects.filter((r): r is RecordOf<"publication"> => r.kind === "publication" && primaryDomain(visible, r) === query.domain_id).sort((a, b) => a.body.sequence - b.body.sequence || a.id.localeCompare(b.id));
            const drafts = query.include_drafts ? objects.filter(r => r.kind === "reflection" && r.body.domain_id === query.domain_id && !objects.some(p => p.kind === "publication" && p.body.proposal_ref.object_id === r.id)).sort((a, b) => a.id.localeCompare(b.id)) : [];
            const hydrated: DomainRecord[] = [];
            for (const publication of publications) {
                const draft = lookup(publication.body.proposal_ref);
                if (!draft || draft.kind !== "reflection")
                    return failure("storage_unavailable", "Exact reviewed prose is unavailable; refusing an incomplete reading page");
                hydrated.push(draft);
            }
            const readingSnapshot = { ...visible, objectHistory: [...(visible.objectHistory ?? []), ...hydrated] };
            return page(snapshot, [domain, ...[...publications, ...drafts].map(record => ({ selection: { kind: "object" as const, object_id: record.id }, media_type: "text/markdown" as const, renderer_version: snapshot.rendererVersion, text: renderObject(readingSnapshot, record, snapshot) }))], query, facts);
        }
        case "lessons": return searchLessons(snapshot, visible, query, facts);
        default: return failure("invalid_input", "Unknown query kind");
    }
}
