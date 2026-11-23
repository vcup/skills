import { expect, test } from "bun:test";
import { safeMarkdown, projection, publicationState, renderViews } from "./projection.ts";
test("untrusted prose renders as text without active HTML, links, or external images", () => {
    const original = '<script>alert(1)</script>\n![tracking](https://example.test/pixel)\n[x](javascript:alert(1))\n<img src=x onerror=alert(2)>\n`literal` & 中文';
    const html = Bun.markdown.html(safeMarkdown(original));
    expect(html).not.toMatch(/<(script|img|a)\b/i);
    expect(html).toContain("中文");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("https");
});
import { ARCHIVE_FORMAT, type Snapshot, type DomainRecord, type RecordOf } from "./contracts.ts";
const identity = { kind: "session" as const, sessionId: "lead", rootSessionId: "root" };
const envelope = { format: ARCHIVE_FORMAT, object_revision: 1, created_sequence: 1, updated_sequence: 1, author: identity };
const invocation: DomainRecord = { ...envelope, kind: "invocation", id: "work", body: { title: "Async delivery", goal: "Deliver evidence", deliverable: "Checked result", subject: "Native tools", constraints: "Do not equate receipt and completion", exclusions: "No model effectiveness guarantee", frame_revision: 1, lead: identity, lifecycle: "completed", coverage_ids: [], criterion_ids: [], next: { invocation_id: "work", action: "delivered", intended_result: "User can inspect", blockers: [] }, lifecycle_history: [] } };
const check: DomainRecord = { ...envelope, kind: "check", id: "check", body: { invocation_id: "work", frame_revision: 1, provenance: "reported", check: { kind: "execution", target: { kind: "object", object_id: "work", object_revision: 1 }, criterion_ids: [], method: "Trace two events", action: "Observe completion", result: "unavailable", evidence_refs: [], limits: "Native event access was unavailable; result is unknown" } } };
const snapshot: Snapshot = { archiveId: "archive", projectId: "project", title: "Project", revision: "fixed-revision", sequence: 1, formatVersion: 2, rendererVersion: "1", policy: { epoch: 1, paused: false, grants: [] }, bindings: [], objects: [invocation, check] };
test("checkpoint preserves closed work, scope, next action and reported unavailable observations", () => {
    const [view] = projection.render(snapshot, [{ kind: "checkpoint", invocation_id: "work" }]);
    expect(view!.selection).toEqual({ kind: "checkpoint", invocation_id: "work" });
    const rendered = Bun.markdown.html(view!.text);
    for (const expected of ["fixed-revision", "No model effectiveness guarantee", "Do not equate receipt and completion", "completed", "delivered", "reported", "unavailable", "Native event access was unavailable; result is unknown"]) {
        expect(rendered).toContain(expected);
    }
    expect(rendered).not.toContain('provenance: observed');
    expect(snapshot.objects).toEqual([invocation, check]);
});

test('evidence challenges propagate through exact references and corrections preserve original history',()=>{
 const draft:RecordOf<'reflection'>={...envelope,kind:'reflection',id:'draft',body:{invocation_id:'work',domain_id:'domain',title:'Conclusion',problem:'Uncertain observation',actions_and_evidence:'Read exact check',judgment_change:'Narrow the claim',limits:'Only this case',next_test:'Another case',fact_refs:[{object_revision:1,object_id:'check',kind:'object'}],retrospective:false,status:'draft'}};
 const publication:RecordOf<'publication'>={...envelope,kind:'publication',id:'pub',body:{invocation_id:'work',domain_id:'domain',proposal_ref:{kind:'object',object_id:'draft',object_revision:1},review_refs:[],sequence:1,status:'current'}};
 const challenge:RecordOf<'challenge'>={...envelope,kind:'challenge',id:'private-challenge',body:{invocation_id:'private',target:{object_id:'check',kind:'object',object_revision:1},statement:'PRIVATE EVIDENCE',contradicting_refs:[],impact:'PRIVATE IMPACT'}};
 const correction:RecordOf<'publication'>={...publication,id:'correction',body:{...publication.body,sequence:2,supersedes:{kind:'object',object_id:'pub',object_revision:1}}};
 const full={...snapshot,objects:[...snapshot.objects,draft,publication,challenge,correction]};
 expect(publicationState(full,publication)).toMatchObject({status:'corrected',contested:true,current_ref:{kind:'object',object_id:'correction',object_revision:1}});
 const visible={...full,objects:full.objects.filter(r=>r.id!=='private-challenge')};
 const [view]=renderViews(visible,[{kind:'object',object_id:'pub'}],full);
 expect(view!.text).toContain('**contested**: true');expect(view!.text).not.toContain('PRIVATE');expect(view!.text).not.toContain('private&#45;challenge');
 expect(full.objects.find(r=>r.id==='pub')).toEqual(publication);
});
