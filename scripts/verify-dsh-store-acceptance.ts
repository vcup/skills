/** Independent acceptance at public storage seams, never an authenticated Remote claim.
 * Run in a writable development container. Runtimes are only imported, never modified.
 * All destructive fixtures live below .scratch/production-cycle on the project filesystem.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createArchiveRegistry, DEFAULT_LIMITS, type RegistryOptions } from "../adapters/dsh/store/index.ts";
import { ArchiveKernel, StoreFault } from "../adapters/dsh/store/kernel.ts";
import { createVersionedLedger } from "../adapters/dsh/store/ledger.ts";
import { createUploadManager, digestBytes } from "../adapters/dsh/uploads/index.ts";
import { createLocationHandles, localSourceReader } from "../adapters/dsh/maintenance/handles.ts";
import { publishDirectory } from "../adapters/dsh/maintenance/files.ts";
import { applyCoordination } from "../modules/ensemble/coordination.ts";
import { querySnapshot } from "../modules/ensemble/query.ts";
import { projection } from "../modules/ensemble/projection.ts";
import * as C from "../modules/ensemble/contracts.ts";

export const OWNER:C.Actor={kind:"owner",ownerId:"acceptance-owner",hostAuthorityId:"store-review-host",channel:"authenticated-remote"};
type Session=Extract<C.Actor,{kind:"session"}>;
export const ALICE:Session={kind:"session",sessionId:"alice",rootSessionId:"alice-root",workspaceRef:"review-source",callId:"first-call"};
export const BOB:Session={kind:"session",sessionId:"bob",rootSessionId:"bob-root",workspaceRef:"review-source",callId:"bob-call"};
const signal=()=>new AbortController().signal;
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export function value<T>(result:C.Result<T>):T {if(!result.ok)throw new Error(`${result.error.code}: ${result.error.message}`);return result.value;}
function denied<T>(result:C.Result<T>,code?:string):void {assert.equal(result.ok,false,`request must fail, got ${JSON.stringify(result)}`);if(!result.ok&&code)assert.equal(result.error.code,code);}
export const OPEN_COMMAND:Extract<C.WorkCommand,{action:"open"}>={action:"open",payload:{title:"Independent store acceptance",goal:"Keep authoritative state and source intact",deliverable:"A reproducible acceptance result",subject:"storage transaction",constraints:"Do not alter source",exclusions:"No live user data",coverage:[{key:"source",title:"Source",requirement:"no side effects",required:true,authority_refs:[]}],criteria:[{key:"independent",coverage_targets:[{kind:"request_key",key:"source"}],statement:"Independent real-kernel checks pass",critical:true,method:"real Git and filesystem"}]}};

/** Every move/corruption target is verified before a test touches it. No shared runtime paths. */
function fixturePath(base:string,path:string):string {const absolute=resolve(path);assert.equal(path,absolute);assert.ok(absolute.startsWith(realpathSync(base)+sep),"mutation escaped exclusive fixture");assert.equal(realpathSync(dirname(path)),dirname(path),"mutation parent was replaced");return absolute;}
function moveInside(base:string,from:string,to:string):void {fixturePath(base,from);fixturePath(base,to);assert.ok(!lstatSync(from).isSymbolicLink());assert.ok(!existsSync(to));renameSync(from,to);}
function overwriteFixture(base:string,path:string,bytes:Uint8Array|string):void {fixturePath(base,path);assert.ok(lstatSync(path).isFile());assert.ok(!lstatSync(path).isSymbolicLink());readFileSync(path);writeFileSync(path,bytes);}
function sourceFingerprint(source:string):string {return sha(JSON.stringify(readdirSync(source).sort().map(name=>{const path=join(source,name),st=lstatSync(path);return [name,st.mode,st.isFile()?sha(readFileSync(path)):st.isDirectory()?"directory":"link"]; })));}

export async function nativeOptions(runtime:string):Promise<Pick<RegistryOptions,"context"|"factories">> {
 const root=realpathSync(resolve(runtime));
 const load=(name:string)=>import(pathToFileURL(join(root,"node_modules/@deepseek-ai",name,"lib/index.js")).href);
 const [{Context},{LocalSubprocessRuntime},{LocalSandboxProvider}]=await Promise.all([load("cordis"),load("dsh-subprocess-local"),load("dsh-sandbox-local")]);
 return {context:new Context(),factories:{subprocess:c=>new LocalSubprocessRuntime(c),sandbox:c=>new LocalSandboxProvider(c,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000})}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function fixture(runtime:string,overrides:Partial<RegistryOptions>={}) {
 const parent=resolve(".scratch/production-cycle");mkdirSync(parent,{recursive:true});
 const base=mkdtempSync(join(parent,"store-review-"));const source=join(base,"source");mkdirSync(source,{mode:0o700});writeFileSync(join(source,"original.bin"),Buffer.from([0,255,128,65,10]),{mode:0o600});
 const options:RegistryOptions={...await nativeOptions(runtime),root:join(base,"registry"),hostAuthorityId:"store-review-host",worldIdentity:"host",reducer:(s,c,f)=>applyCoordination(s,c as C.WorkCommand,f),query:querySnapshot,projection,...overrides};
 const registry=createArchiveRegistry(options);const kernel=new ArchiveKernel(options);
 const initial=value(await registry.admin(OWNER,{action:"initialize",expected_revision:"absent",operation_id:"init",payload:{root_handle:"default",source_descriptor:{worldIdentity:"host",canonicalAddress:source,nativeWorkspaceRef:ALICE.workspaceRef},initial_grants:[ALICE,BOB].map(actor=>({subject:C.actorIdentity(actor),rights:["read","open"],scope:{kind:"project"}})),limits:DEFAULT_LIMITS}},signal()));
 const target=value(await registry.resolve(ALICE,{worldIdentity:"host",nativeWorkspaceRef:ALICE.workspaceRef,canonicalAddress:source},signal()));
 const root=value(await registry.withOwner(OWNER,target.archiveId,signal(),async lease=>C.success(lease.root)));
 return {base,source,options,registry,kernel,initial,target,root,close(){registry.dispose();kernel.dispose();}};
}
async function current(f:Fixture):Promise<C.Snapshot>{return value(await f.registry.withOwner(OWNER,f.target.archiveId,signal(),async lease=>C.success(lease.snapshot)));}
function request(f:Fixture,key:string,expected=f.initial.committed_revision,command:C.DomainCommand=OPEN_COMMAND):C.TransactionRequest{return {archiveId:f.target.archiveId,expectedRevision:expected,operationId:key,command};}

async function archiveSymlink(runtime:string){
 const f=await fixture(runtime);try{
  const before=sourceFingerprint(f.source);moveInside(f.base,f.root,`${f.root}-saved`);symlinkSync(f.source,fixturePath(f.base,f.root),"dir");
  const outcome=await f.registry.execute(ALICE,request(f,"must-refuse"),signal());denied(outcome);
  assert.equal(sourceFingerprint(f.source),before,"rejected archive symlink must not create a writer-lock file in the source");
  return {fixture:f.base,result:outcome,sourceUnchanged:true};
 }finally{f.close();}
}
async function corruptRef(runtime:string){
 const f=await fixture(runtime);try{
  overwriteFixture(f.base,join(f.root,"refs/ensemble/main"),"not-an-object-id\n");
  let rejected=false;let observed:unknown;try{observed=await f.kernel.head(f.root,signal());}catch(error){rejected=error instanceof StoreFault;observed=error instanceof Error?error.message:String(error);}
  assert.ok(rejected,`a broken existing authoritative ref must not become absent; observed ${JSON.stringify(observed)}`);
  const result=await f.registry.context(OWNER,signal());denied(result);return {fixture:f.base,rejected:true,result};
 }finally{f.close();}
}

/** Deliberately publish malformed persisted data through the real fixed Git kernel.
 * This is a corruption fixture, not a supported product mutation or a mocked read.
 */
async function corruptTree(f:Fixture,path:string,change:(old:unknown)=>unknown):Promise<string>{
 return f.kernel.withLock(f.root,signal(),async leaseSignal=>{
  const head=await f.kernel.head(f.root,leaseSignal);assert.ok(head);
  const old=await f.kernel.read(f.root,head,path,leaseSignal);assert.ok(old);
  const entries=await f.kernel.entries(f.root,head,leaseSignal);
  const replacement=await f.kernel.hash(f.root,Buffer.from(JSON.stringify(change(JSON.parse(Buffer.from(old).toString("utf8"))))),leaseSignal);
  const tree=await f.kernel.tree(f.root,entries.map(e=>e.path===path?{...e,oid:replacement}:e),leaseSignal);
  const revision=await f.kernel.commit(f.root,tree,head,999,leaseSignal);await f.kernel.publish(f.root,revision,head,leaseSignal);return revision;
 });
}
async function corruptReceipt(runtime:string){
 const f=await fixture(runtime);try{
  const key="receipt-corruption";value(await f.registry.execute(ALICE,request(f,key),signal()));
  const path=`receipts/${sha(C.actorKey(ALICE))}/${sha(key)}.json`;
  const head=await corruptTree(f,path,old=>({...old as object,changed:[null]}));
  const replay=await f.registry.execute(ALICE,request(f,key),signal());denied(replay,"archive_corrupt");
  assert.equal(await f.kernel.head(f.root,signal()),head);return {fixture:f.base,head,result:replay};
 }finally{f.close();}
}
async function receiptAuthority(runtime:string){
 const f=await fixture(runtime);try{
  const sourceBefore=sourceFingerprint(f.source);const req=request(f,"same-key");
  const first=value(await f.registry.execute(ALICE,req,signal()));
  denied(await f.registry.execute(BOB,req,signal()),"revision_conflict");
  denied(await f.registry.query(BOB,f.target,{kind:"receipt",operation_id:req.operationId},signal()),"not_found");
  const own=value(await f.registry.execute(BOB,{...req,expectedRevision:first.committed_revision},signal()));
  assert.notEqual(own.result.id,first.result.id);assert.equal(own.sequence,first.sequence+1);
  const replay=value(await f.registry.execute({...ALICE,callId:"retry-transport"},req,signal()));
  assert.equal(replay.committed_revision,first.committed_revision);assert.equal(replay.head_revision,own.committed_revision);
  denied(await f.registry.execute(ALICE,{...req,command:{...OPEN_COMMAND,payload:{...OPEN_COMMAND.payload,title:"changed"}}},signal()),"operation_key_conflict");
  const rebound=value(await f.registry.admin(OWNER,{action:"rebind",project_id:f.target.projectId,expected_revision:own.committed_revision,operation_id:"rebind",payload:{source_descriptor:{worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:"new-workspace"},mapping_evidence:[{kind:"reported",statement:"independent acceptance rebind",source_label:"store-acceptance",supporting_refs:[]}],reason:"explicit owner mapping changed"}},signal()));
  denied(await f.registry.execute(ALICE,req,signal()),"binding_required");
  const reboundAlice={...ALICE,workspaceRef:"new-workspace"};
  assert.equal(value(await f.registry.execute(reboundAlice,req,signal())).committed_revision,first.committed_revision);
  const snapshot=await current(f);const grant=snapshot.policy.grants.find(g=>C.actorKey(g.subject)===C.actorKey(ALICE));assert.ok(grant);
  const revoked=value(await f.registry.admin(OWNER,{action:"revoke",project_id:f.target.projectId,expected_revision:rebound.committed_revision,operation_id:"revoke",payload:{grant_id:grant.id,reason:"current permission removed"}},signal()));
  denied(await f.registry.execute(reboundAlice,req,signal()),"not_authorized");
  denied(await f.registry.query(reboundAlice,f.target,{kind:"receipt",operation_id:req.operationId},signal()),"not_authorized");
  assert.equal((await current(f)).revision,revoked.committed_revision);assert.equal(sourceFingerprint(f.source),sourceBefore);
  return {fixture:f.base,first:first.committed_revision,otherActor:own.committed_revision,final:revoked.committed_revision,sourceUnchanged:true};
 }finally{f.close();}
}
async function cursorAuthority(runtime:string){
 const f=await fixture(runtime);try{
  const opened=value(await f.registry.execute(ALICE,request(f,"open"),signal()));
  const text="原文😀\n".repeat(10000);
  const command:C.WorkCommand={action:"put_artifact",payload:{invocation_id:opened.result.invocation_id!,change:{action:"create",kind:"research",title:"Private cursor",content:{kind:"text",text,media_type:"text/plain"},refs:[]}}};
  const artifact=value(await f.registry.execute(ALICE,request(f,"artifact",opened.committed_revision,command),signal()));
  const query:C.Query={kind:"artifact",object_id:artifact.result.id!,content_mode:"text"};
  const page=value(await f.registry.query(ALICE,f.target,query,signal()));assert.ok(page.next_cursor);
  denied(await f.registry.query(BOB,f.target,{...query,cursor:page.next_cursor},signal()),"cursor_expired");
  const changedRoot={...ALICE,rootSessionId:"foreign-root"};denied(await f.registry.query(changedRoot,f.target,{...query,cursor:page.next_cursor},signal()),"not_authorized");
  const continued=value(await f.registry.query({...ALICE,callId:"another-transport-call"},f.target,{...query,cursor:page.next_cursor},signal()));assert.equal(continued.read_revision,artifact.committed_revision);
  assert.equal((await current(f)).revision,artifact.committed_revision);return {fixture:f.base,head:artifact.committed_revision,actorAndRootPinned:true};
 }finally{f.close();}
}
async function corruptSnapshot(runtime:string){
 const f=await fixture(runtime);try{
  const head=await corruptTree(f,"snapshot.json",old=>({...old as object,policy:{epoch:1,grants:[{subject:null}],paused:false}}));
  denied(await f.registry.context(OWNER,signal()),"archive_corrupt");
  denied(await f.registry.execute(ALICE,request(f,"not-an-empty-archive",head),signal()),"archive_corrupt");
  assert.equal(await f.kernel.head(f.root,signal()),head);return {fixture:f.base,head,refUnchanged:true};
 }finally{f.close();}
}
/** Independent registry constructor shared with the killed-child fixture (same standard options). */
export async function openRegistry(runtime:string,root:string,overrides:Partial<RegistryOptions>={}):Promise<ReturnType<typeof createArchiveRegistry>>{
 const options:RegistryOptions={...await nativeOptions(runtime),root,hostAuthorityId:"store-review-host",worldIdentity:"host",reducer:(s,c,f)=>applyCoordination(s,c as C.WorkCommand,f),query:querySnapshot,projection,...overrides};
 return createArchiveRegistry(options);
}

/** Fault-injected response loss (in-process hook), explicitly NOT a real process kill. */
async function responseLost(runtime:string){
 const f=await fixture(runtime);
 const faulty=await openRegistry(runtime,f.options.root,{fault:(stage)=>{if(stage==="before_response")throw new Error("injected: response lost after publication");}});
 try{
  const req=request(f,"response-lost");
  const first=await faulty.execute(ALICE,req,signal());
  assert.ok(!first.ok,`the injected post-publication response loss must surface to the caller, got ${JSON.stringify(first)}`);
  const replay=value(await f.registry.execute({...ALICE,callId:"retry-transport"},req,signal()));
  assert.notEqual(replay.committed_revision,f.initial.committed_revision,"the injected loss happened after publication, so the retry must answer the durable receipt");
  assert.equal(replay.head_revision,replay.committed_revision);
  assert.equal((await current(f)).sequence,f.initial.sequence+1);
  return {fixture:f.base,injection:"in-process fault hook at before_response on a second registry instance",firstError:first.ok?null:first.error,replay};
 }finally{faulty.dispose();f.close();}
}

/** Real SIGKILL of a separate Bun process between publication and its response, then independent reconciliation. */
async function killRestart(runtime:string){
 const f=await fixture(runtime);try{
  const childPath=join(f.base,"kill-child.ts");
  writeFileSync(childPath,[
   `const [parentPath,runtime,registryRoot,source,workspaceRef,expected,key]=process.argv.slice(2);`,
   `const {ALICE,value,openRegistry,OPEN_COMMAND}=await import(parentPath);`,
   `const registry=await openRegistry(runtime,registryRoot,{fault:(stage)=>{if(stage==="after_publish"){process.stdout.write("COMMITTED\\n");setInterval(()=>{},1<<30);}}});`,
   `const target=value(await registry.resolve(ALICE,{worldIdentity:"host",nativeWorkspaceRef:workspaceRef,canonicalAddress:source},new AbortController().signal));`,
   `const receipt=value(await registry.execute(ALICE,{archiveId:target.archiveId,expectedRevision:expected,operationId:key,command:OPEN_COMMAND},new AbortController().signal));`,
   `process.stdout.write("RESPONSE "+receipt.committed_revision+"\\n");`,
   `setTimeout(()=>process.exit(0),60_000);`,
  ].join("\n"));
  const parentPath=pathToFileURL(join(import.meta.dir,"verify-dsh-store-acceptance.ts")).href;
  const child=Bun.spawn([process.execPath,childPath,parentPath,resolve(runtime),f.options.root,f.source,ALICE.workspaceRef,f.initial.committed_revision,"kill-restart-op"],{stdout:"pipe",stderr:"pipe"});
  const killed=await new Promise<boolean>(async resolveSeen=>{
   const decoder=new TextDecoder();let buffer="";
   const timeout=setTimeout(()=>resolveSeen(false),120_000);
   // Incremental read through the stream's own reader: the child is killed on the marker and never
   // exits by itself, so buffering the whole stream first (Response.text()) would deadlock.
   const reader=child.stdout.getReader();
   try{
    while(true){
     const {done,value}=await reader.read();
     if(done)break;
     buffer+=decoder.decode(value,{stream:true});
     if(buffer.includes("COMMITTED")){clearTimeout(timeout);child.kill("SIGKILL");resolveSeen(true);return;}
    }
   }finally{reader.releaseLock();}
  });
  assert.ok(killed,"the child process never reached publication inside the kill window");
  const exit=await child.exited;const stderr=await new Response(child.stderr).text();
  assert.ok(child.signalCode==="SIGKILL"||exit===null,`the child must die from the SIGKILL mid-transaction, observed signal ${String(child.signalCode)} exit ${String(exit)} stderr ${stderr.slice(0,400)}`);
  const replay=value(await f.registry.execute(ALICE,request(f,"kill-restart-op",f.initial.committed_revision),signal()));
  assert.notEqual(replay.committed_revision,f.initial.committed_revision,"a killed process's published commit must survive and answer its durable receipt");
  assert.equal(replay.head_revision,replay.committed_revision);
  const fresh=await openRegistry(runtime,f.options.root);try{
   const context=value(await fresh.context(OWNER,signal()));
   const project=context.projects.find(p=>p.project_id===f.target.projectId);
   assert.ok(project);assert.equal(project.read_revision,replay.committed_revision,"a brand-new registry instance must observe the killed process's commit");
  }finally{fresh.dispose();}
  assert.equal((await current(f)).sequence,f.initial.sequence+1);
  return {fixture:f.base,kill:"real SIGKILL of a separate bun process after publication, before its response",childSignal:child.signalCode??null,replay};
 }finally{f.close();}
}

/** Two independent registry instances racing through the real OS lock and CAS. */
async function concurrentWriters(runtime:string){
 const f=await fixture(runtime);try{
  const second=await openRegistry(runtime,f.options.root);try{
   const same=request(f,"same-key-two-instances");
   const [a,b]=await Promise.all([f.registry.execute(ALICE,same,signal()),second.execute({...ALICE,callId:"second-instance"},same,signal())]);
   assert.ok(a.ok&&b.ok,`same-key writers across independent instances must serialize to one commit, got ${JSON.stringify([a,b])}`);
   assert.equal(value(b).committed_revision,value(a).committed_revision);
   const head=value(a).committed_revision;
   const [x,y]=await Promise.all([f.registry.execute(ALICE,request(f,"race-a",head),signal()),second.execute({...ALICE,callId:"y"},request(f,"race-b",head),signal())]);
   assert.equal(Number(x.ok)+Number(y.ok),1,`exactly one of two distinct same-revision writers may win the CAS, got ${JSON.stringify([x,y])}`);
   const loser=x.ok?y:x;if(loser.ok)throw new Error("unreachable");
   const winner=(x.ok?x:y) as {ok:true;value:{committed_revision:string}};
   const context=value(await second.context(OWNER,signal()));assert.ok(context.projects.length>=1);
   assert.equal((await current(f)).revision,winner.value.committed_revision);
   return {fixture:f.base,sameKey:[value(a).committed_revision,value(b).committed_revision],casWinner:winner.value.committed_revision,casLoserCode:loser.error.code};
  }finally{second.dispose();}
 }finally{f.close();}
}

/** Random archive identity, initialization replay, retired identity refusal and registry corruption. */
async function identityGrants(runtime:string){
 const f=await fixture(runtime);try{
  const initPayload:C.AdminPayloads["initialize"]={root_handle:"default",source_descriptor:{worldIdentity:"host",canonicalAddress:f.source,nativeWorkspaceRef:"second-source"},initial_grants:[{subject:C.actorIdentity(ALICE),rights:["read"],scope:{kind:"project"}}],limits:DEFAULT_LIMITS};
  const second=value(await f.registry.admin(OWNER,{action:"initialize",expected_revision:"absent",operation_id:"init-second",payload:initPayload},signal()));
  assert.notEqual(second.result.id,f.target.projectId,"a distinct initialization key must mint a fresh random project identity");
  const replay=value(await f.registry.admin(OWNER,{action:"initialize",expected_revision:"absent",operation_id:"init-second",payload:initPayload},signal()));
  assert.equal(replay.result.id,second.result.id,"the same initialization key must replay the original identity");
  const registryPath=join(f.options.root,"registry.json");const document=JSON.parse(readFileSync(registryPath,"utf8"));
  const secondEntry=document.entries.find((e:Record<string,unknown>)=>e.projectId===second.result.id) as {archiveId:string};
  writeFileSync(registryPath,JSON.stringify({...document,retiredArchiveIds:[secondEntry.archiveId]}));
  denied(await f.registry.admin(OWNER,{action:"initialize",expected_revision:"absent",operation_id:"init-second",payload:initPayload},signal()),"not_authorized");
  writeFileSync(registryPath,"{broken");
  denied(await f.registry.context(OWNER,signal()),"archive_corrupt");
  return {fixture:f.base,freshProject:second.result.id,replayedProject:replay.result.id,retiredIdentityRefused:true,corruptRegistryCode:"archive_corrupt"};
 }finally{f.close();}
}

/** Hostile ambient git environment must be stripped from every archive git child. */
async function ambientEnvironment(runtime:string){
 const keys=["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM","GIT_CONFIG_COUNT","GIT_CONFIG_KEY_0","GIT_CONFIG_VALUE_0"];
 const saved=new Map(keys.map(key=>[key,process.env[key]]));
 try{
  process.env.GIT_DIR="/nonexistent/ensemble-escape";process.env.GIT_WORK_TREE="/nonexistent";process.env.GIT_INDEX_FILE="/nonexistent/.index";
  process.env.GIT_CONFIG_GLOBAL="/nonexistent/gitconfig";process.env.GIT_CONFIG_SYSTEM="/nonexistent/gitconfig";
  process.env.GIT_CONFIG_COUNT="1";process.env.GIT_CONFIG_KEY_0="user.name";process.env.GIT_CONFIG_VALUE_0="ambient-leak";
  const f=await fixture(runtime);try{
   const committed=value(await f.registry.execute(ALICE,request(f,"ambient-env"),signal()));
   const query=value(await f.registry.query(ALICE,f.target,{kind:"context"},signal()));
   denied(await f.registry.execute(BOB,request(f,"ambient-env-bob",f.initial.committed_revision),signal()),"revision_conflict");
   assert.equal((await current(f)).revision,committed.committed_revision);
   return {fixture:f.base,committed:committed.committed_revision,historyItems:query.items.length,hostileEnvIgnored:true};
  }finally{f.close();}
 }finally{for(const [key,previous]of saved){if(previous===undefined)delete process.env[key];else process.env[key]=previous;}}
}
export const STORE_ACCEPTANCE_CASES={"archive-symlink":archiveSymlink,"corrupt-ref":corruptRef,"corrupt-receipt":corruptReceipt,"receipt-authority":receiptAuthority,"cursor-authority":cursorAuthority,"corrupt-snapshot":corruptSnapshot,"response-lost":responseLost,"kill-restart":killRestart,"concurrent-writers":concurrentWriters,"identity-grants":identityGrants,"ambient-environment":ambientEnvironment} as const;
export type AcceptanceCase=keyof typeof STORE_ACCEPTANCE_CASES;
export function parseArgs(args:readonly string[]):{runtime:string;only?:AcceptanceCase}{
 if(args.length!==2&&args.length!==4||args[0]!=="--runtime"||!args[1]||!isAbsolute(resolve(args[1])))throw new Error("Usage: bun scripts/verify-dsh-store-acceptance.ts --runtime <isolated rc4/rc5 install> [--case <case-name>]");
 if(args.length===4&&(args[2]!=="--case"||!Object.hasOwn(STORE_ACCEPTANCE_CASES,args[3]!)))throw new Error(`Unknown case; choose ${Object.keys(STORE_ACCEPTANCE_CASES).join(", ")}`);
 return {runtime:resolve(args[1]),...(args[3]?{only:args[3] as AcceptanceCase}:{})};
}
export async function verifyStoreAcceptance(runtime:string,only?:AcceptanceCase){
 const parent=resolve(".scratch/production-cycle");mkdirSync(parent,{recursive:true});const filesystem=statfsSync(parent).type===0x9123683e?"btrfs":String(statfsSync(parent).type);
 const results:{name:string;status:"PASS"|"FAIL";evidence?:unknown;error?:string}[]=[];
 for(const [name,run]of Object.entries(STORE_ACCEPTANCE_CASES)){if(only&&name!==only)continue;try{results.push({name,status:"PASS",evidence:await run(runtime)});}catch(error){results.push({name,status:"FAIL",error:error instanceof Error?error.message:String(error)});}}
 return {status:results.every(r=>r.status==="PASS")?"PASS":"FAIL",runtime:resolve(runtime),filesystem,fixtureParent:parent,boundary:"Real published Cordis/local subprocess/sandbox + Git; fixture Actor injection, not Remote authentication; not power-loss durability",results};
}
if(import.meta.main){let args:ReturnType<typeof parseArgs>|undefined;try{args=parseArgs(process.argv.slice(2));}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=2;}if(args){const report=await verifyStoreAcceptance(args.runtime,args.only);console.log(JSON.stringify(report,null,2));process.exitCode=report.status==="PASS"?0:1;}}
