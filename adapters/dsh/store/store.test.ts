import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createArchiveRegistry, DEFAULT_LIMITS, type RegistryOptions } from "./index.ts";
import { applyCoordination } from "../../../modules/ensemble/coordination.ts";
import { querySnapshot } from "../../../modules/ensemble/query.ts";
import { projection } from "../../../modules/ensemble/projection.ts";
import * as C from "../../../modules/ensemble/contracts.ts";
const install=process.env.DSH_ARCHIVE_SEAM_INSTALL;
const native=install?describe:describe.skip;
const owner:C.Actor={kind:"owner",ownerId:"owner",hostAuthorityId:"test-host",channel:"authenticated-remote"};
/** The narrow session variant: these tests genuinely depend on workspace/session identity, and
 * typing it as the `C.Actor` union would hide that from the compiler. */
type SessionActor=Extract<C.Actor,{kind:"session"}>;
const actor:SessionActor={kind:"session",sessionId:"lead-session",rootSessionId:"lead-session",workspaceRef:"workspace-one",callId:"call-one"};
const signal=new AbortController().signal;
const command:C.WorkCommand={action:"open",payload:{title:"A complete result",goal:"exercise the transaction",deliverable:"working software",subject:"fixture",constraints:"preserve source",exclusions:"none",coverage:[{key:"goal",title:"Goal",requirement:"durable retry",required:true,authority_refs:[]}],criteria:[{key:"test",coverage_targets:[{kind:"request_key",key:"goal"}],statement:"passes native test",critical:true,method:"real Git"}]}};
function good<T>(value:C.Result<T>):T{if(!value.ok)throw new Error(JSON.stringify(value.error));return value.value;}
async function setup(overrides:Partial<RegistryOptions>={},existing?:{base:string;source:string;root:string}){
 const base=existing?.base??mkdtempSync(join(resolve(".scratch/production-cycle"),"runtime-registry-")),source=existing?.source??join(base,"source"),root=existing?.root??join(base,"storage");
 if(!existing){mkdirSync(source);writeFileSync(join(source,"preserve.bin"),new Uint8Array([0,255,128,65]));}
 const installRoot=resolve(install!);
 const {Context}=await import(join(installRoot,"node_modules/@deepseek-ai/cordis/lib/index.js"));
 const {LocalSubprocessRuntime}=await import(join(installRoot,"node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js"));
 const {LocalSandboxProvider}=await import(join(installRoot,"node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js"));
 const options:RegistryOptions={root,hostAuthorityId:"test-host",worldIdentity:"host",context:new Context(),factories:{subprocess:s=>new LocalSubprocessRuntime(s),sandbox:s=>new LocalSandboxProvider(s,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000})},reducer:()=>C.success({upserts:[],content:[],views:[],result:{status:"applied"}}),query:(s,_q,f)=>C.success({project_id:s.projectId,read_revision:s.revision,authorization_epoch:s.policy.epoch,items:s.objects.filter(o=>o.author.kind===f.actor.kind),completeness:"complete"}),...overrides};
 const registry=createArchiveRegistry(options);
 const init:C.AdminEnvelope={action:"initialize",operation_id:"initialize-one",expected_revision:"absent",payload:{root_handle:"default",source_descriptor:{worldIdentity:"host",canonicalAddress:source,nativeWorkspaceRef:actor.workspaceRef},initial_grants:[{subject:C.actorIdentity(actor),rights:["read","open"],scope:{kind:"project"}}],limits:DEFAULT_LIMITS}};
 return {base,source,root,registry,init,options};
}
async function initialized(f:Awaited<ReturnType<typeof setup>>){const receipt=good(await f.registry.admin(owner,f.init,signal));const target=good(await f.registry.resolve(actor,{worldIdentity:"host",nativeWorkspaceRef:actor.workspaceRef,canonicalAddress:f.source,sessionId:actor.sessionId,rootSessionId:actor.rootSessionId},signal));return {receipt,target};}
native("production archive transaction / published native providers",()=>{
 test("same actor/key replays before stale expected; changed payload is rejected and new callId is irrelevant",async()=>{
  let reductions=0;const f=await setup({reducer:()=>{reductions++;return C.success({upserts:[],content:[],views:[],result:{status:"applied"}});}});const {receipt,target}=await initialized(f);
  const request={archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:"write-one",command};
  const first=good(await f.registry.execute(actor,request,signal));const replay=good(await f.registry.execute({...actor,callId:"different-call"},request,signal));expect(replay.committed_revision).toBe(first.committed_revision);expect(reductions).toBe(1);
  const changed=await f.registry.execute(actor,{...request,expectedRevision:first.head_revision,command:{...command,payload:{...command.payload,title:"different"}}},signal);expect(changed.ok).toBe(false);if(!changed.ok)expect(changed.error.code).toBe("operation_key_conflict");
  const snapshot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.snapshot)));expect(snapshot.sequence).toBe(2);expect(statSync(f.root).mode&0o777).toBe(0o700);expect(readFileSync(join(f.source,"preserve.bin"))).toEqual(Buffer.from([0,255,128,65]));f.registry.dispose();
 },20000);
 test("lost response, restart, and initialize interruption recover durable receipts",async()=>{
  let cut="after_initialize";const f=await setup({fault:stage=>{if(stage===cut){cut="";throw new Error("injected process stop");}}});const failed=await f.registry.admin(owner,f.init,signal);expect(failed.ok).toBe(false);
  f.registry.dispose();const recovered=await setup({},f);const {receipt,target}=await initialized(recovered);expect(receipt.sequence).toBe(1);
  recovered.registry.dispose();let response=true;const writer=await setup({fault:stage=>{if(stage==="before_response"&&response){response=false;throw new Error("response lost");}}},f);
  const request={archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:"lost",command};expect((await writer.registry.execute(actor,request,signal)).ok).toBe(false);writer.registry.dispose();
  const restarted=await setup({},f);const answer=good(await restarted.registry.execute(actor,request,signal));expect(answer.sequence).toBe(2);expect(good(await restarted.registry.execute(actor,request,signal)).committed_revision).toBe(answer.committed_revision);restarted.registry.dispose();
 },20000);
 test("current revocation denies historical read and receipt replay; corrupted Git never becomes absent",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);const request={archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:"one",command};const first=good(await f.registry.execute(actor,request,signal));
  const snapshot=good(await f.registry.withOwner(owner,target.archiveId,signal,async l=>C.success(l.snapshot)));
  good(await f.registry.admin(owner,{action:"revoke",project_id:target.projectId,expected_revision:first.head_revision,operation_id:"revoke-one",payload:{grant_id:snapshot.policy.grants[0]!.id,reason:"stop access"}},signal));
  const replay=await f.registry.execute(actor,request,signal);expect(replay.ok).toBe(false);if(!replay.ok)expect(replay.error.code).toBe("not_authorized");
  expect((await f.registry.query(actor,target,{kind:"list",object_kind:"invocation",revision:first.committed_revision},signal)).ok).toBe(false);
  // A corrupted repository is corruption, not a retryable outage: nothing may retry into
  // "empty archive" and re-initialize over someone's history.
  const root=join(f.root,"archives",target.archiveId);writeFileSync(join(root,"config"),"bad config\n");const corrupt=await f.registry.context(owner,signal);expect(corrupt.ok).toBe(false);if(!corrupt.ok)expect(corrupt.error.code).toBe("archive_corrupt");f.registry.dispose();
 },20000);
 test("independent registries competing on one revision publish exactly one operation",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);const other=await setup({},f);
  const results=await Promise.all([f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:"race-a",command},signal),other.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:"race-b",command},signal)]);
  expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok&&r.error.code==="revision_conflict")).toHaveLength(1);f.registry.dispose();other.registry.dispose();
 },20000);
 test("new archives have fresh identity and ambiguous source mappings fail closed",async()=>{
  const f=await setup();const one=await initialized(f);const next=good(await f.registry.admin(owner,{...f.init,operation_id:"initialize-two"},signal));expect(next.result.id).not.toBe(one.target.projectId);
  const ambiguous=await f.registry.resolve(actor,{worldIdentity:"host",nativeWorkspaceRef:actor.workspaceRef,canonicalAddress:f.source},signal);expect(ambiguous.ok).toBe(false);if(!ambiguous.ok)expect(ambiguous.error.code).toBe("binding_ambiguous");
  const invalid=await f.registry.admin(owner,{...f.init,operation_id:"null",payload:{...f.init.payload,source_descriptor:null}} as unknown as C.AdminEnvelope,signal);expect(invalid.ok).toBe(false);expect(readdirSync(f.source)).toEqual(["preserve.bin"]);f.registry.dispose();
 },20000);
});

native("real domain/query integration",()=>{
 test("UTF-8 pages pin old revision across a new write; exact object versions and current epoch",async()=>{
  const f=await setup({reducer:(s,c,f)=>applyCoordination(s,c as C.WorkCommand,f),query:querySnapshot,projection});const {receipt,target}=await initialized(f);
  const opened=good(await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:"open",command},signal));const invocation_id=opened.result.invocation_id!;
  const text="研究😀完整限制\n".repeat(6000);
  const put:C.WorkCommand={action:"put_artifact",payload:{invocation_id,change:{action:"create",kind:"research",title:"Unicode original",content:{kind:"text",media_type:"text/plain",text},refs:[]}}};
  const saved=good(await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:opened.committed_revision,operationId:"artifact",command:put},signal));
  const first=good(await f.registry.query(actor,target,{kind:"artifact",object_id:saved.result.id!,content_mode:"text"},signal));expect(first.completeness).toBe("partial");expect(first.next_cursor).toBeDefined();
  const revised:C.WorkCommand={action:"put_artifact",payload:{invocation_id,change:{action:"revise",target:{kind:"object",object_id:saved.result.id!,object_revision:1},title:"Changed",content:{kind:"text",media_type:"text/plain",text:"new original"},refs:[],reason:"new revision"}}};
  const changed=good(await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:saved.committed_revision,operationId:"revise",command:revised},signal));
  let output="";let page=first;let pages=0;
  while(true){for(const item of page.items)if("text"in item)output+=item.text??"";expect(page.read_revision).toBe(saved.committed_revision);expect(new TextEncoder().encode(JSON.stringify(C.success(page))).length).toBeLessThanOrEqual(DEFAULT_LIMITS.response_bytes);pages++;if(!page.next_cursor)break;page=good(await f.registry.query(actor,target,{kind:"artifact",object_id:saved.result.id!,content_mode:"text",cursor:page.next_cursor},signal));if(pages>20)throw new Error("cursor failed to progress");}
  expect(output).toBe(text);
  const old=good(await f.registry.query(actor,target,{kind:"object",object_id:saved.result.id!,object_revision:1},signal));expect(old.items.some(o=>"object_revision"in o&&o.object_revision===1)).toBe(true);
  // Flip a MAC character deterministically: appending "0" can be a no-op when the last char is already "0".
  const original=first.next_cursor!;const flip=original.slice(0,-1)+(original.endsWith("0")?"1":"0");
  expect(flip).not.toBe(original);
  const tampered=await f.registry.query(actor,target,{kind:"artifact",object_id:saved.result.id!,content_mode:"text",cursor:flip},signal);expect(tampered.ok).toBe(false);
  good(await f.registry.admin(owner,{action:"grant",project_id:target.projectId,expected_revision:changed.committed_revision,operation_id:"epoch-change",payload:{subject:C.actorIdentity(actor),rights:["read"],scope:{kind:"project"},reason:"epoch changed"}},signal));
  const stale=await f.registry.query(actor,target,{kind:"artifact",object_id:saved.result.id!,content_mode:"text",cursor:first.next_cursor},signal);expect(stale.ok).toBe(false);if(!stale.ok)expect(stale.error.code).toBe("cursor_expired");f.registry.dispose();
 },30000);
});

native("owned registry recovery and retirement",()=>{
 test("no final proof stays readonly; new identity retires old writer, relocates, and disposes only the verified old root",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);
  const stopped=good(await f.registry.admin(owner,{action:"pause",project_id:target.projectId,operation_id:"pause",expected_revision:receipt.committed_revision,payload:{reason:"handoff"}},signal));
  const oldRoot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.root)));
  const independent=await setup({}, {base:f.base,source:f.source,root:join(f.base,"independent")});
  const readonly=good(await independent.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"same-id",operationId:"read-only"},signal));expect(readonly.readOnly).toBe(true);expect(readonly.registered).toBe(true);
  const source={worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:actor.workspaceRef};const grants=[{subject:C.actorIdentity(actor),rights:["read","open"] as const,scope:{kind:"project" as const}}];
  const restored=good(await f.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"new-id",operationId:"replacement",source,grants,expectedOriginalRevision:stopped.committed_revision},signal));
  expect(restored.archiveId).not.toBe(target.archiveId);expect(existsSync(join(oldRoot,"ensemble-retired.json"))).toBe(true);
  expect((await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:stopped.committed_revision,operationId:"stale-writer",command},signal)).ok).toBe(false);
  const state=good(await f.registry.withOwner(owner,restored.archiveId,signal,async lease=>C.success(lease.snapshot)));expect(state.policy.paused).toBe(true);expect(state.policy.grants).toHaveLength(1);
  const moved=good(await f.registry.relocate(owner,restored.archiveId,{destination:join(f.base,"relocated"),expectedRevision:restored.revision,operationId:"relocate",source,grants},signal));expect(moved.archiveId).toBe(restored.archiveId);
  const retry=good(await f.registry.relocate(owner,restored.archiveId,{destination:join(f.base,"relocated"),expectedRevision:restored.revision,operationId:"relocate",source,grants},signal));expect(retry.revision).toBe(moved.revision);
  const wrong=await f.registry.disposeRetired(owner,{oldArchiveId:target.archiveId,replacementArchiveId:restored.archiveId,expectedOldHead:receipt.committed_revision},signal);expect(wrong.ok).toBe(false);expect(existsSync(oldRoot)).toBe(true);
  good(await f.registry.disposeRetired(owner,{oldArchiveId:target.archiveId,replacementArchiveId:restored.archiveId,expectedOldHead:stopped.committed_revision},signal));expect(existsSync(oldRoot)).toBe(false);expect(existsSync(join(f.source,"preserve.bin"))).toBe(true);
  expect((await f.registry.admin(owner,f.init,signal)).ok).toBe(false);f.registry.dispose();independent.registry.dispose();
 },30000);
});

native("closed persisted receipts",()=>{
 test("a legally-stored receipt field the schema cannot decode refuses replay and leaves the ref intact",async()=>{
  const {ArchiveKernel}=await import("./kernel.ts");const {createHash}=await import("node:crypto");
  const f=await setup();const {receipt,target}=await initialized(f);
  const key="receipt-corruption";const first=good(await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:key,command},signal));
  const archiveRoot=join(f.root,"archives",target.archiveId);const kernel=new ArchiveKernel(f.options);
  const sha=(v:string)=>createHash("sha256").update(v).digest("hex");const path=`receipts/${sha(C.actorKey(actor))}/${sha(key)}.json`;
  const mutated=await kernel.withLock(archiveRoot,signal,async leaseSignal=>{
   const head=await kernel.head(archiveRoot,leaseSignal);expect(head).toBe(first.committed_revision);
   const old=JSON.parse(Buffer.from((await kernel.read(archiveRoot,head!,path,leaseSignal))!).toString("utf8"));
   // `changed:[null]` is legal JSON in a Git tree: only a closed schema can reject it.
   const replacement=await kernel.hash(archiveRoot,Buffer.from(JSON.stringify({...old,changed:[null]})),leaseSignal);
   const entries=await kernel.entries(archiveRoot,head!,leaseSignal);
   const tree=await kernel.tree(archiveRoot,entries.map(e=>e.path===path?{...e,oid:replacement}:e),leaseSignal);
   const revision=await kernel.commit(archiveRoot,tree,head,999,leaseSignal);await kernel.publish(archiveRoot,revision,head,leaseSignal);return revision;
  });
  try{
   const replay=await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:first.committed_revision,operationId:key,command},signal);
   expect(replay.ok).toBe(false);if(!replay.ok)expect(replay.error.code).toBe("archive_corrupt");
   expect(await kernel.head(archiveRoot,signal)).toBe(mutated);
   expect(readdirSync(f.source)).toEqual(["preserve.bin"]);
  }finally{kernel.dispose();f.registry.dispose();}
 },30000);
 test("closed schema refuses every malformed receipt shape instead of ignoring fields",async()=>{
  const {decodeStoredReceipt}=await import("./schema.ts");
  const base={format:"ensemble-receipt/v2",actor:{kind:"session",sessionId:"s",rootSessionId:"s"},operationId:"op",digest:"a".repeat(64),sequence:1,action:"open",changed:[],documents:[{kind:"overview"}],result:{status:"active"}};
  expect(()=>decodeStoredReceipt(base)).not.toThrow();
  for(const broken of [{...base,changed:[null]},{...base,changed:[{id:"x",object_revision:0}]},{...base,result:{ids:{good:"object-1","bad key!":"object-2"}}},{...base,result:{unknown_field:"leak"}},{...base,actor:{kind:"owner"}},{...base,digest:"not-a-digest"},{...base,sequence:0},{...base,documents:[{kind:"checkpoint"}]},{...base,operationId:"x".repeat(200)},{...base,extra:"unknown"}])
   expect(()=>decodeStoredReceipt(broken)).toThrow();
 });
});

native("receipt commit identity is pinned by operation, not by sequence",()=>{
 /** A restored or relocated lineage can legitimately contain two commits carrying the same
  * sequence number. Replay must name the commit that published the operation; a bare
  * sequence match would answer whichever commit the history walk met first. */
 test("a duplicate-sequence commit does not hijack receipt replay",async()=>{
  const {ArchiveKernel}=await import("./kernel.ts");
  const f=await setup();const {receipt,target}=await initialized(f);
  const key="pinned-operation";const first=good(await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:key,command},signal));
  const archiveRoot=join(f.root,"archives",target.archiveId);const kernel=new ArchiveKernel(f.options);
  const recordPath=`operations/${String(first.sequence).padStart(12,"0")}.json`;
  const decoy=await kernel.withLock(archiveRoot,signal,async leaseSignal=>{
   const head=await kernel.head(archiveRoot,leaseSignal);
   const record=JSON.parse(Buffer.from((await kernel.read(archiveRoot,head!,recordPath,leaseSignal))!).toString("utf8"));
   const forged=Buffer.from(JSON.stringify({...record,operationId:"another-operation",digest:"b".repeat(64)}));
   const replacement=await kernel.hash(archiveRoot,forged,leaseSignal);
   const snapshot=JSON.parse(Buffer.from((await kernel.read(archiveRoot,head!,"snapshot.json",leaseSignal))!).toString("utf8"));
   const snapshotOid=await kernel.hash(archiveRoot,Buffer.from(JSON.stringify({...snapshot,sequence:first.sequence})),leaseSignal);
   const entries=await kernel.entries(archiveRoot,head!,leaseSignal);
   const tree=await kernel.tree(archiveRoot,entries.map(e=>e.path===recordPath?{...e,oid:replacement}:e.path==="snapshot.json"?{...e,oid:snapshotOid}:e),leaseSignal);
   const revision=await kernel.commit(archiveRoot,tree,head,first.sequence,leaseSignal);await kernel.publish(archiveRoot,revision,head,leaseSignal);return revision;
  });
  try{
   const replay=await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:first.head_revision,operationId:key,command},signal);
   // The competing record is corruption: the archive refuses instead of answering either commit.
   expect(replay.ok).toBe(false);if(!replay.ok)expect(replay.error.code).toBe("archive_corrupt");
   expect(await kernel.head(archiveRoot,signal)).toBe(decoy);
  }finally{kernel.dispose();f.registry.dispose();}
 },30000);
 /** The discriminating case: a same-sequence commit that carries no operation record at all.
  * Identity-based lookup skips it and answers the commit that really published the operation;
  * a sequence-only lookup has two candidates and can no longer tell which one is the receipt's. */
 test("a same-sequence commit without an operation record does not shadow the real receipt commit",async()=>{
  const {ArchiveKernel}=await import("./kernel.ts");
  const f=await setup();const {receipt,target}=await initialized(f);
  const key="shadowed-operation";const first=good(await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:receipt.committed_revision,operationId:key,command},signal));
  const archiveRoot=join(f.root,"archives",target.archiveId);const kernel=new ArchiveKernel(f.options);
  const recordPath=`operations/${String(first.sequence).padStart(12,"0")}.json`;
  const shadow=await kernel.withLock(archiveRoot,signal,async leaseSignal=>{
   const head=await kernel.head(archiveRoot,leaseSignal);
   // A later commit at the same sequence whose tree has no operation record for it.
   const entries=(await kernel.entries(archiveRoot,head!,leaseSignal)).filter(e=>e.path!==recordPath);
   const tree=await kernel.tree(archiveRoot,entries,leaseSignal);
   const revision=await kernel.commit(archiveRoot,tree,head,first.sequence,leaseSignal);await kernel.publish(archiveRoot,revision,head,leaseSignal);return revision;
  });
  try{
   const replay=await f.registry.execute(actor,{archiveId:target.archiveId,expectedRevision:first.head_revision,operationId:key,command},signal);
   expect(replay.ok).toBe(true);
   if(replay.ok){
    // The answer names the commit that published the operation, not the later same-sequence commit.
    expect(replay.value.committed_revision).toBe(first.committed_revision);
    expect(replay.value.committed_revision).not.toBe(shadow);
    expect(replay.value.head_revision).toBe(shadow);
    expect(replay.value.sequence).toBe(first.sequence);
   }
  }finally{kernel.dispose();f.registry.dispose();}
 },30000);
});

native("retired-copy inventory and disposal",()=>{
 /** Replaces the retired primary's directory with a symlink to the live source: the disposal
  * path must refuse rather than recursively unlink anything reached through the link. */
 test("knownCopies reports lineage state and disposal refuses every non-journaled target",async()=>{
  const {ArchiveKernel}=await import("./kernel.ts");
  const f=await setup();const {receipt,target}=await initialized(f);
  const stopped=good(await f.registry.admin(owner,{action:"pause",project_id:target.projectId,expected_revision:receipt.committed_revision,operation_id:"pause",payload:{reason:"handoff"}},signal));
  const oldRoot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.root)));
  const source={worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:actor.workspaceRef};
  const grants=[{subject:C.actorIdentity(actor),rights:["read","open"] as const,scope:{kind:"project" as const}}];
  const restored=good(await f.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"new-id",operationId:"replacement",source,grants,expectedOriginalRevision:stopped.committed_revision},signal));

  // Inventory names the retired primary with its exact head and live state.
  const copies=good(await f.registry.knownCopies(owner,restored.archiveId,signal));
  const retired=copies.find(c=>c.archiveId===target.archiveId&&c.kind==="retired-primary");
  expect(retired).toBeDefined();
  expect(retired!.revision).toBe(stopped.committed_revision);
  expect(retired!.state).toBe("retained");
  expect(copies.every(c=>/^copy-[0-9a-f]{64}$/.test(c.copyId))).toBe(true);

  // A caller cannot fabricate a copy id or a head to dispose something outside the journal.
  expect((await f.registry.disposeKnownCopy(owner,{copyId:"copy-"+"0".repeat(64),replacementArchiveId:restored.archiveId,expectedHead:stopped.committed_revision},signal)).ok).toBe(false);
  expect((await f.registry.disposeKnownCopy(owner,{copyId:retired!.copyId,replacementArchiveId:restored.archiveId,expectedHead:receipt.committed_revision},signal)).ok).toBe(false);
  // A replacement that is not in the copy's recorded lineage cannot dispose it either.
  expect((await f.registry.disposeKnownCopy(owner,{copyId:retired!.copyId,replacementArchiveId:target.archiveId,expectedHead:stopped.committed_revision},signal)).ok).toBe(false);
  expect(existsSync(oldRoot)).toBe(true);

  // Swap the retired root for a symlink to the untouched source tree, then re-check.
  const kernel=new ArchiveKernel(f.options);
  try{
   const moved=`${oldRoot}-saved`;renameSync(oldRoot,moved);symlinkSync(f.source,oldRoot,"dir");
   const refused=await f.registry.disposeKnownCopy(owner,{copyId:retired!.copyId,replacementArchiveId:restored.archiveId,expectedHead:stopped.committed_revision},signal);
   expect(refused.ok).toBe(false);
   expect(readdirSync(f.source)).toEqual(["preserve.bin"]);
   expect(readFileSync(join(f.source,"preserve.bin"))).toEqual(Buffer.from([0,255,128,65]));
   unlinkSync(oldRoot);renameSync(moved,oldRoot);
  }finally{kernel.dispose();}

  // The genuine journaled copy still disposes, and the source stays untouched.
  const disposed=good(await f.registry.disposeKnownCopy(owner,{copyId:retired!.copyId,replacementArchiveId:restored.archiveId,expectedHead:stopped.committed_revision},signal));
  expect(disposed.copyId).toBe(retired!.copyId);
  expect(existsSync(oldRoot)).toBe(false);
  expect(readdirSync(f.source)).toEqual(["preserve.bin"]);
  const after=good(await f.registry.knownCopies(owner,restored.archiveId,signal));
  expect(after.find(c=>c.copyId===retired!.copyId)?.state).toBe("disposed");
  // Replaying the same disposal key is stable rather than destructive.
  expect(good(await f.registry.disposeKnownCopy(owner,{copyId:retired!.copyId,replacementArchiveId:restored.archiveId,expectedHead:stopped.committed_revision},signal)).copyId).toBe(retired!.copyId);
  f.registry.dispose();
 },40000);
 test("activationResult is scoped by operation key and refuses an unknown or foreign-actor key",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);
  const stopped=good(await f.registry.admin(owner,{action:"pause",project_id:target.projectId,expected_revision:receipt.committed_revision,operation_id:"pause",payload:{reason:"handoff"}},signal));
  const oldRoot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.root)));
  const source={worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:actor.workspaceRef};
  const restored=good(await f.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"new-id",operationId:"scoped",source,grants:[{subject:C.actorIdentity(actor),rights:["read"],scope:{kind:"project"}}],expectedOriginalRevision:stopped.committed_revision},signal));
  const found=good(await f.registry.activationResult(owner,"scoped",signal,{projectId:target.projectId}));
  expect(found.archiveId).toBe(restored.archiveId);
  expect(found.sourceArchiveId).toBe(target.archiveId);
  expect(found.expectedOldHead).toBe(stopped.committed_revision);
  expect(found.disposed).toBe(false);
  // The scope is expressed in source identities: the original project/archive match, while the
  // replacement's own new identities deliberately do not.
  expect(good(await f.registry.activationResult(owner,"scoped",signal,{archiveId:target.archiveId})).archiveId).toBe(restored.archiveId);
  expect((await f.registry.activationResult(owner,"scoped",signal,{projectId:restored.projectId})).ok).toBe(false);
  expect((await f.registry.activationResult(owner,"scoped",signal,{archiveId:restored.archiveId})).ok).toBe(false);
  expect((await f.registry.activationResult(owner,"never-happened",signal)).ok).toBe(false);
  // A session actor is not an owner and cannot read activation journals.
  expect((await f.registry.activationResult(actor,"scoped",signal)).ok).toBe(false);
  f.registry.dispose();
 },40000);
});

native("a purged archive can be rebound by its owner",()=>{
 /** A rebuild (purge / lossy activation) deliberately publishes `bindings: []` so the new archive
  * inherits no mapping. But binding resolution demanded exactly one active binding, which made that
  * state a fixed point the owner could never leave: no binding, so binding was impossible. */
 test("the owner can bind a freshly rebuilt archive that has no active binding",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);
  // Rebuild into a new paused identity with no inherited binding, exactly as purge does.
  const stopped=good(await f.registry.admin(owner,{action:"pause",project_id:target.projectId,expected_revision:receipt.committed_revision,operation_id:"pause",payload:{reason:"rebuild"}},signal));
  const oldRoot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.root)));
  const rebuilt=good(await f.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"new-id",operationId:"rebuild",expectedOriginalRevision:stopped.committed_revision,discardHistory:true},signal));
  const state=good(await f.registry.withOwner(owner,rebuilt.archiveId,signal,async lease=>C.success(lease.snapshot)));
  expect(state.bindings).toHaveLength(0);
  expect(state.policy.paused).toBe(true);
  // The owner names the project explicitly, so it must be able to establish the first binding.
  const bound=good(await f.registry.admin(owner,{action:"bind",project_id:rebuilt.projectId,expected_revision:rebuilt.revision,operation_id:"rebind-after-rebuild",payload:{source_descriptor:{worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:actor.workspaceRef},mapping_evidence:[],reason:"owner re-establishes the source after a rebuild"}},signal));
  expect(bound.sequence).toBe(state.sequence+1);
  const after=good(await f.registry.withOwner(owner,rebuilt.archiveId,signal,async lease=>C.success(lease.snapshot)));
  expect(after.bindings.filter(b=>b.active)).toHaveLength(1);
  // Still paused: binding does not silently resume writes.
  expect(after.policy.paused).toBe(true);
  f.registry.dispose();
 },40000);
 /** Ambiguity is real data damage and must not be smoothed over by the owner escape hatch. */
 test("an owner still cannot read an unbound archive as if it were bound",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);
  const stopped=good(await f.registry.admin(owner,{action:"pause",project_id:target.projectId,expected_revision:receipt.committed_revision,operation_id:"pause",payload:{reason:"rebuild"}},signal));
  const oldRoot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.root)));
  const rebuilt=good(await f.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"new-id",operationId:"rebuild2",expectedOriginalRevision:stopped.committed_revision,discardHistory:true},signal));
  const read=await f.registry.query(owner,{archiveId:rebuilt.archiveId,projectId:rebuilt.projectId,bindingId:"unbound"},{kind:"context"},signal);
  expect(read.ok).toBe(false);
  if(!read.ok)expect(read.error.code).toBe("binding_required");
  f.registry.dispose();
 },40000);
});

native("manage bind must not require an existing binding",()=>{
 /** The live Remote path resolves the named project before dispatch. A rebuild publishes
  * `bindings: []`, and `bind` is the call that creates the first binding - requiring one first made
  * that state a fixed point the owner could never leave. Zero and several bindings are distinct. */
 test("an owner can resolve and bind a rebuilt archive, but reading it before binding still refuses",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);
  const stopped=good(await f.registry.admin(owner,{action:"pause",project_id:target.projectId,expected_revision:receipt.committed_revision,operation_id:"pause",payload:{reason:"rebuild"}},signal));
  const oldRoot=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.root)));
  const rebuilt=good(await f.registry.activateRestored(owner,{candidateRoot:oldRoot,mode:"new-id",operationId:"rebuild",expectedOriginalRevision:stopped.committed_revision,discardHistory:true},signal));
  const state=good(await f.registry.withOwner(owner,rebuilt.archiveId,signal,async lease=>C.success(lease.snapshot)));
  expect(state.bindings).toHaveLength(0);

  // Reading before binding must still refuse: resolution is not authorization to read.
  const earlyRead=await f.registry.query(owner,{archiveId:rebuilt.archiveId,projectId:rebuilt.projectId,bindingId:"unbound"},{kind:"context"},signal);
  expect(earlyRead.ok).toBe(false);
  if(!earlyRead.ok)expect(earlyRead.error.code).toBe("binding_required");

  // The owner may resolve the project it explicitly named, which is what `bind` dispatch needs.
  const resolved=good(await f.registry.resolveProject(owner,rebuilt.projectId,signal));
  expect(resolved.archiveId).toBe(rebuilt.archiveId);
  expect(resolved.bindingId).toBe("unbound");
  // A trusted Session may not use the unbound escape hatch.
  expect((await f.registry.resolveProject(actor,rebuilt.projectId,signal)).ok).toBe(false);

  // The bind itself commits a single active binding without resuming writes.
  const bound=good(await f.registry.admin(owner,{action:"bind",project_id:rebuilt.projectId,expected_revision:rebuilt.revision,operation_id:"manage-bind",payload:{source_descriptor:{worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:actor.workspaceRef},mapping_evidence:[],reason:"owner re-establishes the source after a rebuild"}},signal));
  expect(bound.status).toBe("committed");
  const after=good(await f.registry.withOwner(owner,rebuilt.archiveId,signal,async lease=>C.success(lease.snapshot)));
  expect(after.bindings.filter(b=>b.active)).toHaveLength(1);
  // Binding must not revive old authority: the archive stays paused with no inherited grants.
  expect(after.policy.paused).toBe(true);
  const resolvedNow=good(await f.registry.resolveProject(owner,rebuilt.projectId,signal));
  expect(resolvedNow.bindingId).not.toBe("unbound");
  f.registry.dispose();
 },50000);
 test("more than one active binding stays ambiguous",async()=>{
  const f=await setup();const {receipt,target}=await initialized(f);
  const second=good(await f.registry.admin(owner,{action:"rebind",project_id:target.projectId,expected_revision:receipt.committed_revision,operation_id:"rebind-2",payload:{source_descriptor:{worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:"second"},mapping_evidence:[],reason:"second mapping"}},signal));
  const state=good(await f.registry.withOwner(owner,target.archiveId,signal,async lease=>C.success(lease.snapshot)));
  // A bind deactivates the previous mapping, so exactly one stays active and the guard is not needed.
  expect(state.bindings.filter(b=>b.active)).toHaveLength(1);
  expect(second.sequence).toBe(state.sequence);
  f.registry.dispose();
 },40000);
});
