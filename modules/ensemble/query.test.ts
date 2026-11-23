import { expect, test } from "bun:test";
import { ARCHIVE_FORMAT, actorIdentity, type Actor, type DomainRecord, type QueryFacts, type Snapshot, type RecordOf } from "./contracts.ts";
import { querySnapshot } from "./query.ts";
const actor: Actor = { kind: "session", sessionId: "reader", rootSessionId: "root", workspaceRef: "workspace", callId: "call" };
const envelope = { format: ARCHIVE_FORMAT, object_revision: 1, created_sequence: 1, updated_sequence: 1, author: actorIdentity(actor) };
function lesson(id: string): RecordOf<'lesson'> { return { ...envelope, kind: 'lesson', id, body: { invocation_id: 'work', title: `Événement ${id}`, trigger: 'Async task', action: 'Wait for completion', supporting_refs: [], counterexamples: 'Synchronous calls already completed', applicability: { task_types: ['async'], interface_versions: ['v1'], required_capabilities: ['events'] }, invalidation_condition: 'Synchronous results invalidate the recommendation' } }; }
function state(objects: DomainRecord[] = []): Snapshot { return { archiveId: 'archive', projectId: 'project', title: 'Project', revision: 'f'.repeat(40), sequence: 1, formatVersion: 2, rendererVersion: '1', policy: { epoch: 7, paused: false, grants: [{ id: 'read', subject: actorIdentity(actor), rights: ['read', 'open'], scope: { kind: 'project' }, revoked: false }] }, bindings: [], objects }; }
const facts: QueryFacts = { actor, now: 100, nextCursor: offset => `signed:fixed:epoch7:${offset}` };
test('whole-record pages include cursor and metadata in their UTF-8 budget', () => {
    const snapshot = state([lesson('a'), lesson('b'), lesson('c')]);
    const full = querySnapshot(snapshot, { kind: 'list', object_kind: 'lesson' }, { ...facts, pageItems: 1 });
    expect(full.ok).toBe(true);
    if (!full.ok)
        return;
    expect(full.value.items).toHaveLength(1);
    expect(full.value.completeness).toBe('partial');
    const bytes = new TextEncoder().encode(JSON.stringify(full)).byteLength;
    const exact = querySnapshot(snapshot, { kind: 'list', object_kind: 'lesson' }, { ...facts, pageItems: 1, responseBytes: bytes });
    expect(exact).toEqual(full);
    const short = querySnapshot(snapshot, { kind: 'list', object_kind: 'lesson' }, { ...facts, pageItems: 1, responseBytes: bytes - 1 });
    expect(short.ok ? undefined : short.error.code).toBe('budget_exceeded');
    const second = querySnapshot(snapshot, { kind: 'list', object_kind: 'lesson', revision: 'f'.repeat(40), cursor: full.value.next_cursor }, { ...facts, pageItems: 1, offset: 1 });
    expect(second.ok && 'id' in second.value.items[0]! && second.value.items[0].id).toBe('b');
    const wrong = querySnapshot({ ...snapshot, revision: 'a'.repeat(40) }, { kind: 'list', object_kind: 'lesson', revision: 'f'.repeat(40), cursor: full.value.next_cursor }, { ...facts, offset: 1 });
    expect(wrong.ok ? undefined : wrong.error.code).toBe('revision_conflict');
});
test('all typed read surfaces preserve exact objects and require real IO facts', () => {
    const old = lesson('versioned'), current = { ...old, object_revision: 2, body: { ...old.body, title: 'Changed' } };
    const invocation: RecordOf<'invocation'> = { ...envelope, kind: 'invocation', id: 'work', body: { title: 'Work', goal: 'Evidence', deliverable: 'Result', subject: 'Async', constraints: 'No shortcuts', exclusions: 'No causal claims', frame_revision: 1, lead: actorIdentity(actor), lifecycle: 'active', coverage_ids: [], criterion_ids: [], lifecycle_history: [] } };
    const artifact: RecordOf<'artifact'> = { ...envelope, kind: 'artifact', id: 'raw', body: { invocation_id: 'work', kind: 'note', title: '原文', content: { digest: 'digest', bytes: 6, media_type: 'text/plain' }, refs: [], domains: [], status: 'current', editors: [] } };
    const snapshot = { ...state([current, invocation, artifact]), objectHistory: [old] };
    for (const kind of ['context', 'projects', 'invocation', 'checkpoint'] as const) {
        const result = querySnapshot(snapshot, kind === 'invocation' || kind === 'checkpoint' ? { kind, invocation_id: 'work' } : { kind }, facts);
        expect(result.ok).toBe(true);
    }
    const exact = querySnapshot(snapshot, { kind: 'object', object_id: 'versioned', object_revision: 1 }, facts);
    expect(exact.ok && exact.value.items[0]).toEqual(old);
    const conflict = querySnapshot(snapshot, { kind: 'object', object_id: 'versioned', object_revision: 1, revision: 'f'.repeat(40) }, facts);
    expect(conflict.ok ? undefined : conflict.error.code).toBe('object_changed');
    const missing = querySnapshot(snapshot, { kind: 'artifact', object_id: 'raw', content_mode: 'text' }, facts);
    expect(missing.ok ? undefined : missing.error.code).toBe('storage_unavailable');
    const first = querySnapshot(snapshot, { kind: 'artifact', object_id: 'raw', content_mode: 'text' }, { ...facts, content: { ...artifact.body.content, object_ref: { kind: 'object', object_id: 'raw', object_revision: 1 }, offset: 0, next_offset: 3, text: '原' } });
    expect(first.ok && first.value.completeness).toBe('partial');
    expect(first.ok && first.value.next_cursor).toBe('signed:fixed:epoch7:3');
    const last = querySnapshot(snapshot, { kind: 'artifact', object_id: 'raw', content_mode: 'text', cursor: 'trusted' }, { ...facts, offset: 3, content: { ...artifact.body.content, object_ref: { kind: 'object', object_id: 'raw', object_revision: 1 }, offset: 3, text: '文' } });
    expect(last.ok && last.value.completeness).toBe('complete');
    const history = querySnapshot(snapshot, { kind: 'history', object_id: 'versioned' }, { ...facts, history: [{ committed_revision: 'old', operation_id: 'op1', sequence: 1, action: 'propose_lesson', actor: actorIdentity(actor), changed: [{ kind: 'object', object_id: 'versioned', object_revision: 1 }] }] });
    expect(history.ok && history.value.items).toHaveLength(1);
    const receipt = { status: 'committed' as const, operation_id: 'op1', committed_revision: 'old', head_revision: 'f'.repeat(40), sequence: 1, changed: [], documents: [], result: {} };
    expect(querySnapshot(snapshot, { kind: 'receipt', operation_id: 'op1' }, { ...facts, receipt }).ok).toBe(true);
    const absent = querySnapshot(snapshot, { kind: 'receipt', operation_id: 'missing' }, facts);
    expect(absent.ok ? undefined : absent.error.code).toBe('not_found');
    const environment = { role: 'reviewer', desired_revision: 'env-1', applied_status: 'unknown' as const, candidates: [] };
    expect(querySnapshot(snapshot, { kind: 'environment_preferences', role: 'reviewer', task_context: { task_types: [], interface_versions: [], required_capabilities: [] } }, { ...facts, environment }).ok).toBe(true);
    expect(querySnapshot(snapshot, { kind: 'environment_preferences', role: 'reviewer', task_context: { task_types: [], interface_versions: [], required_capabilities: [] } }, facts).ok).toBe(false);
});
test('lesson search is literal Unicode, preserves restrictions and separates unknown applicability', () => {
    const matched = lesson('a'), unknown = { ...lesson('b'), body: { ...lesson('b').body, applicability: { task_types: ['async'], interface_versions: [], required_capabilities: [] } } };
    const snapshot = state([matched, unknown]);
    const query = { kind: 'lessons' as const, status: 'proposed' as const, task_context: { task_types: ['async'], interface_versions: ['v1'], required_capabilities: ['events'] }, text: 'Événement' };
    // A decomposed accent followed by literal text; never a regular expression.
    // Use an independently written actual decomposed Unicode spelling.
    const found = querySnapshot(snapshot, { ...query, text: 'ÉVÉNEMENT' }, facts);
    expect(found.ok && found.value.items).toHaveLength(2);
    if (found.ok)
        for (const item of found.value.items) {
            expect('lesson' in item && item.lesson.body.invalidation_condition).toBe('Synchronous results invalidate the recommendation');
        }
    const unknowns = querySnapshot(snapshot, { ...query, text: 'Événement', task_context: { task_types: ['async'], interface_versions: [], required_capabilities: [] } }, facts);
    expect(unknowns.ok && unknowns.value.items.map(item => 'applicability' in item ? item.applicability : undefined)).toEqual(['matched', 'unknown']);
    const literal = querySnapshot(snapshot, { ...query, text: '.*' }, facts);
    expect(literal.ok && literal.value.items).toHaveLength(0);
    const scan = querySnapshot(snapshot, { ...query, text: 'no match' }, { ...facts, searchScanObjects: 1 });
    expect(scan.ok && scan.value.completeness).toBe('partial');
    expect(scan.ok && scan.value.next_cursor).toBe('signed:fixed:epoch7:1');
    const emptyDefault = querySnapshot(snapshot, { kind: 'lessons', task_context: query.task_context }, facts);
    expect(emptyDefault.ok && emptyDefault.value.items).toHaveLength(0);
});
test('reading follows moved primary ownership and includes reviewed limitations, never drafts by default', () => {
    const draft: RecordOf<'reflection'> = { ...envelope, kind: 'reflection', id: 'draft', body: { invocation_id: 'work', domain_id: 'old-domain', title: 'Evidence', problem: 'Receipt ambiguity', actions_and_evidence: 'Compare events', judgment_change: 'Wait for final output', limits: 'Only asynchronous operations', next_test: 'Cancellation after receipt', fact_refs: [], retrospective: false, status: 'draft' } };
    const pub: RecordOf<'publication'> = { ...envelope, kind: 'publication', id: 'pub', body: { invocation_id: 'work', domain_id: 'old-domain', sequence: 1, proposal_ref: { kind: 'object', object_id: 'draft', object_revision: 1 }, review_refs: [], status: 'current' } };
    const domain: RecordOf<'domain'> = { ...envelope, kind: 'domain', id: 'new-domain', body: { invocation_id: 'work', title: 'Moved', questions: 'What completed?', audience: 'Maintainers', overview: 'Evidence', retired: false, primary_publication_ids: ['pub'] } };
    const unpublished = { ...draft, id: 'unpublished', body: { ...draft.body, domain_id: 'new-domain', title: 'Unreviewed' } };
    const snapshot = state([draft, pub, domain, unpublished]);
    const read = querySnapshot(snapshot, { kind: 'reading', domain_id: 'new-domain' }, facts);
    expect(read.ok && read.value.items).toHaveLength(2);
    if (read.ok) {
        const view = read.value.items[1]!;
        expect('text' in view && Bun.markdown.html(view.text!)).toContain('Only asynchronous operations');
    }
    const withDraft = querySnapshot(snapshot, { kind: 'reading', domain_id: 'new-domain', include_drafts: true }, facts);
    expect(withDraft.ok && withDraft.value.items).toHaveLength(3);
    const filtered = querySnapshot(snapshot, { kind: 'list', object_kind: 'publication', domain_id: 'new-domain' }, facts);
    expect(filtered.ok && filtered.value.items).toEqual([pub]);
});
test('accepted oversized structured content reads back losslessly through bounded byte pages', () => {
    const object = { ...lesson('long'), body: { ...lesson('long').body, counterexamples: '必须保留的限制😀'.repeat(6000) } };
    const snapshot = state([object]), parts: Uint8Array[] = [];
    let offset = 0, rounds = 0;
    do {
        const result = querySnapshot(snapshot, { kind: 'object', object_id: 'long', content_mode: 'bytes', ...(offset ? { cursor: 'authenticated' } : {}) }, { ...facts, responseBytes: 2048, offset });
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(2048);
        const item = result.value.items[0]!;
        expect('kind' in item && item.kind).toBe('object_content');
        if (!('kind' in item) || item.kind !== 'object_content')
            throw Error('not a structured content page');
        expect(item.generated).toBe(true);
        parts.push(Uint8Array.from(Buffer.from(item.base64!, 'base64')));
        expect(item.offset).toBe(offset);
        offset = item.next_offset ?? 0;
        rounds++;
        if (!offset)
            expect(result.value.completeness).toBe('complete');
        else
            expect(result.value.next_cursor).toBe(`signed:fixed:epoch7:${offset}`);
    } while (offset && rounds < 500);
    expect(offset).toBe(0);
    expect(rounds).toBeGreaterThan(1);
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    expect(decoded).toEqual(object);
});
test('unreadable counterevidence still removes a lesson recommendation without leaking its text', () => {
    const advice = lesson('advice'), target = { kind: 'object' as const, object_id: 'advice', object_revision: 1 };
    const assessment: RecordOf<'assessment'> = { ...envelope, kind: 'assessment', id: 'assessed', body: { invocation_id: 'work', lesson_ref: target, assessment: { kind: 'decision', status: 'supported', reason: 'Public review', application_refs: [], review_ref: { kind: 'object', object_id: 'check', object_revision: 1 } } } };
    const contrary: RecordOf<'application'> = { ...envelope, kind: 'application', id: 'private-counterexample', updated_sequence: 2, body: { invocation_id: 'private-work', lesson_ref: target, assessment: { kind: 'application', invocation_id: 'private-work', attempt_id: 'private-attempt', context: 'PRIVATE SECRET', action_taken: 'Private action', result: 'contradicts', check_refs: [], limits: 'PRIVATE LIMIT' } } };
    let snapshot = state([advice, assessment, contrary]);
    snapshot = { ...snapshot, policy: { ...snapshot.policy, grants: [{ id: 'scoped-read', subject: actorIdentity(actor), scope: { kind: 'invocation', invocation_id: 'work' }, rights: ['read'], revoked: false }] } };
    const query = { kind: 'lessons' as const, task_context: advice.body.applicability };
    const recommended = querySnapshot(snapshot, query, facts);
    expect(recommended.ok && recommended.value.items).toHaveLength(0);
    const contested = querySnapshot(snapshot, { ...query, status: 'contested' }, facts);
    expect(contested.ok && contested.value.items).toHaveLength(1);
    expect(JSON.stringify(contested)).not.toContain('PRIVATE');
    const revoked = querySnapshot({ ...snapshot, policy: { ...snapshot.policy, grants: [] } }, { kind: 'object', object_id: 'advice' }, facts);
    expect(revoked.ok ? undefined : revoked.error.code).toBe('not_authorized');
});
test('raw content cannot falsely claim completeness or change digest and historical permission is current', () => {
    const artifact: RecordOf<'artifact'> = { ...envelope, kind: 'artifact', id: 'raw', body: { invocation_id: 'work', kind: 'attachment', title: 'binary', content: { digest: 'known', bytes: 4, media_type: 'application/octet-stream' }, refs: [], domains: [], status: 'current', editors: [] } };
    const snapshot = state([artifact]);
    const content = { ...artifact.body.content, object_ref: { kind: 'object' as const, object_id: 'raw', object_revision: 1 }, offset: 0, base64: 'AAE=' };
    for (const changed of [content, { ...content, digest: 'different', next_offset: 2 }, { ...content, next_offset: 1 }]) {
        const result = querySnapshot(snapshot, { kind: 'artifact', object_id: 'raw', content_mode: 'bytes' }, { ...facts, content: changed });
        expect(result.ok ? undefined : result.error.code).toBe('archive_corrupt');
    }
    const valid = querySnapshot(snapshot, { kind: 'artifact', object_id: 'raw', content_mode: 'bytes' }, { ...facts, content: { ...content, next_offset: 2 } });
    expect(valid.ok && valid.value.completeness).toBe('partial');
    const hugeCursor = querySnapshot(state([lesson('a'), lesson('b')]), { kind: 'list', object_kind: 'lesson' }, { ...facts, pageItems: 1, responseBytes: 1000, nextCursor: () => 'x'.repeat(5000) });
    expect(hugeCursor.ok ? undefined : hugeCursor.error.code).toBe('budget_exceeded');
    const prior = lesson('past'), historyOnly = { ...state([{ ...prior, object_revision: 2 }]), objectHistory: [prior], policy: { epoch: 8, paused: false, grants: [{ id: 'exact-read', subject: actorIdentity(actor), rights: ['read' as const], scope: { kind: 'proposal' as const, proposal_ref: { kind: 'object' as const, object_id: 'past', object_revision: 1 } }, revoked: false }] } };
    expect(querySnapshot(historyOnly, { kind: 'object', object_id: 'past', object_revision: 1 }, facts).ok).toBe(true);
    expect(querySnapshot(historyOnly, { kind: 'object', object_id: 'past', object_revision: 2 }, facts).ok).toBe(false);
});

test('generated Markdown text pages keep every UTF-8 character and reject interior byte cursors',()=>{
 const object={...lesson('text'),body:{...lesson('text').body,counterexamples:'中文😀反例'.repeat(150)}};
 const snapshot=state([object]);let offset=0,joined='',rounds=0;
 do{
  const result=querySnapshot(snapshot,{kind:'object',object_id:'text',content_mode:'text',...(offset?{cursor:'authenticated'}:{})},{...facts,responseBytes:1200,offset});
  expect(result.ok).toBe(true);if(!result.ok)return;
  const item=result.value.items[0]!;if(!('kind' in item)||item.kind!=='object_content')throw Error();
  expect(item.text).not.toContain('\uFFFD');expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(1200);
  joined+=item.text;offset=item.next_offset??0;rounds++;
 }while(offset&&rounds<100);
 expect(offset).toBe(0);expect(joined).toContain(object.body.counterexamples);
 const bytes=new TextEncoder().encode(joined),interior=bytes.findIndex(byte=>(byte&0xc0)===0x80);
 const bad=querySnapshot(snapshot,{kind:'object',object_id:'text',content_mode:'text',cursor:'authenticated'},{...facts,offset:interior});
 expect(bad.ok?undefined:bad.error.code).toBe('cursor_expired');
});
