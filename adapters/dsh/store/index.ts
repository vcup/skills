/** Durable multi-project archive. All public calls cross the same authorization/transaction seam. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readArchiveQuery, hydrateReferences } from "./query.ts";
import { publishAtomic } from "./transaction.ts";
import * as C from "../../../modules/ensemble/contracts.ts";
import { decodeAdminEnvelope, decodeDomainRecord, decodeLearnCommand, decodePolicySnapshot, decodeProjectBinding, decodeQuery, decodeSnapshot, decodeWorkCommand } from "../../../modules/ensemble/codec.ts";
import { authorizeCommand, hasRight, isLead, isCurrentMember, mayReadObject } from "../../../modules/ensemble/policy.ts";
import { canonicalJson } from "../records.ts";
import { validateArchiveRoot } from "../archive.ts";
import { ArchiveKernel, StoreFault, asFailure, assertOid, decodeUtf8, durableFile, privateDirectory, syncDirectory, type KernelOptions } from "./kernel.ts";
import { decodeCommittedReceipt, decodeStoredReceipt, validateRegistry, type StoredReceipt } from "./schema.ts";

const encoder=new TextEncoder();
const ZERO="0".repeat(40);
/** Marker for an owner-addressed archive with no active binding yet (e.g. after a rebuild). */
const UNBOUND_BINDING="unbound";
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST=/^[0-9a-f]{64}$/;
export const DEFAULT_LIMITS:C.ArchiveLimits={inline_input_bytes:256*1024,response_bytes:32*1024,artifact_bytes:64*1024*1024,upload_chunk_bytes:1024*1024,upload_total_bytes:256*1024*1024,concurrent_uploads:4,page_items:50};
const json=(value:unknown)=>encoder.encode(`${canonicalJson(value)}\n`);
const digest=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
function requireResult<T>(result:C.Result<T>):T {if(!result.ok)throw new StoreFault(result.error.code,result.error.message);return result.value;}
function parse(bytes:Uint8Array):unknown {try{return JSON.parse(decodeUtf8(bytes));}catch(e){if(e instanceof StoreFault)throw e;throw new StoreFault("archive_corrupt","stored JSON is invalid");}}
function plain(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}
function operationId(value:string):void {if(typeof value!=="string"||value.trim()===""||encoder.encode(value).length>128||/[\u0000-\u001f]/.test(value))throw new StoreFault("invalid_input","operation_id must be nonempty text of at most 128 UTF-8 bytes");}
function id(value:string):string {if(!ID.test(value))throw new StoreFault("invalid_input","invalid opaque archive identity");return value;}
function receiptPath(actor:C.Actor|C.ActorIdentity,key:string):string{return `receipts/${digest(C.actorKey(actor))}/${digest(key)}.json`;}
function requestDigest(command:unknown):string{return digest(canonicalJson(command));}
function withoutRevision(snapshot:C.Snapshot):Omit<C.Snapshot,"revision"|"objectHistory">{const {revision:_r,objectHistory:_h,...stored}=snapshot;return stored;}
function ensureSize(value:unknown,limit:number):void{if(encoder.encode(JSON.stringify(value)).length>limit)throw new StoreFault("budget_exceeded","complete request/response exceeds the configured UTF-8 byte budget");}

interface Entry {archiveId:string;projectId:string;title:string;readOnly:boolean;limits:C.ArchiveLimits;directoryId?:string;storagePath?:string}
interface Pending {key:string;digest:string;entry:Entry;snapshot:C.Snapshot;actor:C.Actor;operationId:string}
interface Registry {format:"ensemble-registry/v2";hostAuthorityId:string;secret:string;entries:Entry[];pending:Pending[];activations?:ActivationJournal[];retiredArchiveIds?:string[];relocations?:RelocationJournal[]}
export interface ActivationRequest {readonly candidateRoot:string;readonly mode:"read-only"|"same-id"|"new-id";readonly operationId:string;readonly source?:C.SourceDescriptor;readonly grants?:readonly C.GrantRequest[];readonly finalProof?:{readonly archiveId:string;readonly head:string;readonly previousWriterStopped:true;readonly receiptContinuity:true};readonly discardHistory?:boolean;readonly expectedOriginalRevision?:string;readonly businessDigest?:string}
export interface ActivationResult {readonly archiveId:string;readonly projectId:string;readonly revision:string;readonly readOnly:boolean;readonly registered:boolean}
interface ActivationJournal {key:string;actor:string;operationId:string;digest:string;entry:Entry;sourceProjectId:string;sourceArchiveId:string;sourceHead:string;businessDigest?:string;retiredRoot?:string;retiredHead?:string;disposal?:{head:string;completed:boolean};result?:ActivationResult;receipt?:C.Receipt}
export interface RelocationRequest {readonly destination:string;readonly expectedRevision:string;readonly operationId:string;readonly source?:C.SourceDescriptor;readonly grants?:readonly C.GrantRequest[]}
interface RelocationJournal {key:string;digest:string;entry:Entry;destination:string;oldHead:string;disposal?:{head:string;completed:boolean};receipt?:C.Receipt;result?:ActivationResult}
export interface TrustedWorkspace {worldIdentity:string;nativeWorkspaceRef:string;canonicalAddress?:string;sessionId?:string;rootSessionId?:string}
export interface ArchiveChange {archiveId:string;revision:string;authorizationEpoch:number}
export interface OwnerCommit {readonly expectedRevision:string;readonly operationId:string;readonly action:string;readonly digest:string}
/** A repository location that is only meaningful while its lease is held.
 *  It is a value, not an authority: it names the current on-disk repository (honouring a
 *  `storagePath` override or a completed relocation) and carries the head the lease observed, so a
 *  caller can refuse a stale handle. It never escapes to a model or a Remote. */
export interface LeasedRepository {
 readonly path:string;
 /** The revision this lease observed; compare it before acting on the path. */
 readonly head:string;
 /** Whether the current location is the registry default or the result of a relocation. */
 readonly origin:"registry"|"relocated";
}
export interface OwnerLease {readonly snapshot:C.Snapshot;readonly root:string;/** `root` expressed as a lease-scoped repository handle. */readonly repository:LeasedRepository;readonly kernel:ArchiveKernel;readonly limits:C.ArchiveLimits;readonly signal:AbortSignal;configuration(name:string):unknown;saveConfiguration(name:string,value:unknown):void;commit(plan:C.MutationPlan,request:OwnerCommit):Promise<C.Result<C.Receipt>>}
export interface UploadAccess {kind:"upload";invocationId:string;action:string}
export interface RegistryOptions extends KernelOptions {
 readonly root:string; readonly hostAuthorityId:string; readonly worldIdentity:string; readonly rootHandle?:string;
 readonly reducer:C.Reducer; readonly projection?:C.Projection;
 readonly query?:(snapshot:C.Snapshot,query:C.Query,facts:C.QueryFacts)=>C.Result<C.ReadPage>;
 readonly prepareFacts?:(actor:C.Actor,snapshot:C.Snapshot,command:C.DomainCommand,signal:AbortSignal)=>Promise<Partial<Pick<C.TrustedFacts,"nativeMembers"|"approvals"|"observedEventRefs"|"reviewerReassignments"|"nativeTaskRefs">>>;
 readonly resolveSealed?:(actor:C.Actor,archiveId:string,invocationId:string,uploadId:string,digest:string)=>Promise<C.Result<{bytes:Uint8Array;media_type:string}>>|C.Result<{bytes:Uint8Array;media_type:string}>;
 readonly validateSource?:(source:C.SourceDescriptor,signal:AbortSignal)=>Promise<C.Result<C.SourceDescriptor>>;
 readonly environmentRead?:(actor:C.Actor,query:Extract<C.Query,{kind:"environment_preferences"}>,signal:AbortSignal)=>Promise<C.Result<C.EnvironmentPreferences>>;
 readonly nativeIdentity?:(sessionId:string)=>C.ActorIdentity|undefined;
 readonly fault?:(stage:"after_objects"|"before_publish"|"after_publish"|"before_response"|"after_initialize"|"after_register",archiveId:string)=>void|Promise<void>;
}

export class ArchiveRegistry implements C.ArchiveInterface {
 readonly #options:RegistryOptions; readonly #root:string; readonly #kernel:ArchiveKernel;
 readonly #listeners=new Set<(change:ArchiveChange)=>void>();
 constructor(options:RegistryOptions){this.#options=options;this.#root=options.root;this.#kernel=new ArchiveKernel(options);}
 dispose():void{this.#kernel.dispose();this.#listeners.clear();}
 subscribe(listener:(change:ArchiveChange)=>void):()=>void{this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
 #notify(snapshot:C.Snapshot):void{for(const listener of this.#listeners){try{listener({archiveId:snapshot.archiveId,revision:snapshot.revision,authorizationEpoch:snapshot.policy.epoch});}catch{/* Observers cannot turn a committed write into a failure. */}}}
 #owner(actor:C.Actor):void{if(actor.kind!=="owner"||actor.channel!=="authenticated-remote"||actor.hostAuthorityId!==this.#options.hostAuthorityId)throw new StoreFault("not_authorized","authenticated owner of this Host is required");}
 #path(entry:Entry):string{return entry.storagePath??join(this.#root,"archives",id(entry.directoryId??entry.archiveId));}
 async #registry<T>(signal:AbortSignal,run:(registry:Registry,signal:AbortSignal)=>Promise<T>,initialize=false):Promise<T>{
  if(!initialize&&!existsSync(join(this.#root,"registry.json")))throw new StoreFault("binding_required","owner must initialize the external archive registry");
  privateDirectory(this.#root);
  // A storage root we refuse to adopt must stay byte-identical, so admission is decided before the
  // lock file is created rather than after it.
  const registered=existsSync(join(this.#root,"registry.json"));
  return this.#kernel.withLock(this.#root,signal,async(signal)=>{
   const path=join(this.#root,"registry.json");let registry:Registry;
   if(!existsSync(path)){
    const foreign=readdirSync(this.#root).filter(name=>name!==".ensemble-writer.lock");
    if(foreign.length)throw new StoreFault("unsupported_version","nonempty unregistered storage root: legacy/foreign archives require explicit isolated migration");
    registry={format:"ensemble-registry/v2",hostAuthorityId:this.#options.hostAuthorityId,secret:randomBytes(32).toString("hex"),entries:[],pending:[]};this.#saveRegistry(registry);
   }else{
    const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new StoreFault("archive_corrupt","unsafe registry file");
    const value=parse(readFileSync(path));
    if(!plain(value)||Object.keys(value).some(k=>!["format","hostAuthorityId","secret","entries","pending","activations","retiredArchiveIds","relocations"].includes(k))||value.format!=="ensemble-registry/v2"||value.hostAuthorityId!==this.#options.hostAuthorityId||typeof value.secret!=="string"||!DIGEST.test(value.secret)||!Array.isArray(value.entries)||!Array.isArray(value.pending))throw new StoreFault("archive_corrupt","invalid registry schema or Host identity");
    registry=value as unknown as Registry;
    for(const e of registry.entries){if(!plain(e)||Object.keys(e).some(k=>!["archiveId","projectId","title","readOnly","limits","directoryId","storagePath"].includes(k))||typeof e.archiveId!=="string"||typeof e.projectId!=="string"||typeof e.title!=="string"||typeof e.readOnly!=="boolean"||!plain(e.limits))throw new StoreFault("archive_corrupt","invalid registry entry");id(e.archiveId);id(e.projectId);if(e.directoryId!==undefined)id(e.directoryId);if(e.storagePath!==undefined&&(!isAbsolute(e.storagePath)||resolve(e.storagePath)!==e.storagePath))throw new StoreFault("archive_corrupt","invalid registered storage path");}
    if(new Set(registry.entries.map(e=>e.archiveId)).size!==registry.entries.length||new Set(registry.entries.map(e=>e.projectId)).size!==registry.entries.length)throw new StoreFault("archive_corrupt","duplicate registry identity");
    for(const p of registry.pending){if(!plain(p)||typeof p.key!=="string"||!DIGEST.test(p.key)||typeof p.digest!=="string"||!DIGEST.test(p.digest)||!plain(p.entry)||!plain(p.snapshot)||!plain(p.actor)||typeof p.operationId!=="string")throw new StoreFault("archive_corrupt","invalid initialization journal");requireResult(decodeSnapshot(p.snapshot));}
   }
   privateDirectory(join(this.#root,"archives"));privateDirectory(join(this.#root,"creating"));
   return run(registry,signal);
  },"writer",entries=>{
   if(registered)return;
   // `archives`/`creating` are created by us only after a registration exists.
   const foreign=entries.filter(name=>!new Set([".ensemble-writer.lock","archives","creating"]).has(name));
   if(foreign.length)throw new StoreFault("unsupported_version","nonempty unregistered storage root: legacy/foreign archives require explicit isolated migration; nothing was written");
  });
 }
 #saveRegistry(registry:Registry):void{const temp=join(this.#root,`.registry-${randomUUID()}`);durableFile(temp,json(registry));renameSync(temp,join(this.#root,"registry.json"));syncDirectory(this.#root);}
 async #entry(archiveId:string,signal:AbortSignal):Promise<Entry>{return this.#registry(signal,async r=>{const entry=r.entries.find(e=>e.archiveId===archiveId);if(!entry)throw new StoreFault("not_found","archive is not registered");return entry;});}
 async #snapshot(root:string,revision:string,signal:AbortSignal):Promise<C.Snapshot>{
  const bytes=await this.#kernel.read(root,revision,"snapshot.json",signal);if(!bytes)throw new StoreFault("unsupported_version","archive has no v2 snapshot; legacy archives are read-only until explicit migration");
  const value=parse(bytes);if(!plain(value))throw new StoreFault("archive_corrupt","snapshot must be an object");
  const decoded=decodeSnapshot({...value,revision});if(!decoded.ok)throw new StoreFault("archive_corrupt",decoded.error.message);return decoded.value;
 }
 async #current(entry:Entry,signal:AbortSignal,allowRetired=false):Promise<C.Snapshot>{
  const root=this.#path(entry);privateDirectory(root);if(!allowRetired&&existsSync(join(root,"ensemble-retired.json")))throw new StoreFault("not_authorized","this physical writer was retired; resolve the current registry again");
  const marker=parse(readFileSync(join(root,"ensemble-archive.json")));
  if(!plain(marker)||marker.format!==C.ARCHIVE_FORMAT||marker.archiveId!==entry.archiveId||marker.projectId!==entry.projectId)throw new StoreFault("archive_corrupt","archive ownership identity does not match registry");
  const head=await this.#kernel.head(root,signal);if(!head)throw new StoreFault("archive_corrupt","registered archive has no published head");
  const snapshot=await this.#snapshot(root,head,signal);if(snapshot.archiveId!==entry.archiveId||snapshot.projectId!==entry.projectId)throw new StoreFault("archive_corrupt","published identity does not match registry");return snapshot;
 }
 #admit(actor:C.Actor,snapshot:C.Snapshot):void{
  if(actor.kind==="owner"){this.#owner(actor);return;}
  const matches=snapshot.bindings.filter(b=>b.active&&b.nativeWorkspaceRef===actor.workspaceRef&&(!b.nativeSessionRef||b.nativeSessionRef===actor.sessionId||b.nativeSessionRef===actor.rootSessionId));
  if(matches.length!==1)throw new StoreFault(matches.length?"binding_ambiguous":"binding_required","trusted Session does not resolve a unique current project binding");
 }
 #readAllowed(actor:C.Actor,current:C.Snapshot):void {if(actor.kind==="owner")this.#owner(actor);if(actor.kind!=="owner"&&!hasRight(current,actor,"read",{kind:"project"},Date.now())&&!current.objects.some(o=>mayReadObject(current,actor,o,Date.now())))throw new StoreFault("not_authorized","current read grant is required");}
 async resolve(actor:C.Actor,workspace:TrustedWorkspace,signal:AbortSignal=new AbortController().signal):Promise<C.Result<C.BoundTarget>>{
  try{
   if(actor.kind!=="session"||actor.workspaceRef!==workspace.nativeWorkspaceRef||workspace.sessionId&&workspace.sessionId!==actor.sessionId||workspace.rootSessionId&&workspace.rootSessionId!==actor.rootSessionId)throw new StoreFault("not_authorized","binding lookup needs matching trusted Session facts");
   const entries=await this.#registry(signal,async r=>r.entries.slice());const matches:C.BoundTarget[]=[];
   for(const entry of entries){await this.#kernel.withLock(this.#path(entry),signal,async(signal)=>{const s=await this.#current(entry,signal);for(const b of s.bindings)if(b.active&&b.worldIdentity===workspace.worldIdentity&&b.nativeWorkspaceRef===workspace.nativeWorkspaceRef&&(!b.nativeSessionRef||b.nativeSessionRef===actor.sessionId||b.nativeSessionRef===actor.rootSessionId))matches.push({archiveId:s.archiveId,projectId:s.projectId,bindingId:b.bindingId});});}
   if(matches.length!==1)return C.failure(matches.length?"binding_ambiguous":"binding_required","owner must establish exactly one trusted project binding");return C.success(matches[0]!);
  }catch(e){return asFailure(e);}
 }
 async #source(source:C.SourceDescriptor,signal:AbortSignal):Promise<C.SourceDescriptor>{
  if(!isAbsolute(source.canonicalAddress)||resolve(source.canonicalAddress)!==source.canonicalAddress)throw new StoreFault("invalid_input","source address must be absolute and canonical in its declared world");
  if(this.#options.validateSource)source=requireResult(await this.#options.validateSource(source,signal));
  else if(source.worldIdentity!==this.#options.worldIdentity)throw new StoreFault("binding_required","cross-world binding requires a trusted deployment mapping validator");
  if(source.worldIdentity===this.#options.worldIdentity){const verdict=validateArchiveRoot(this.#root,[source.canonicalAddress]);if(!verdict.ok)throw new StoreFault("invalid_input",verdict.reason);}
  return source;
 }
 /** A durable receipt is decoded by the closed persisted schema before it can authorize a replay. */
 async #receipt(root:string,head:string,actor:C.Actor,key:string,signal:AbortSignal):Promise<StoredReceipt|undefined>{
  const bytes=await this.#kernel.read(root,head,receiptPath(actor,key),signal);if(!bytes)return undefined;
  const stored=decodeStoredReceipt(parse(bytes));
  if(stored.operationId!==key)throw new StoreFault("archive_corrupt","durable receipt belongs to a different operation key");
  if(C.actorKey(stored.actor)!==C.actorKey(actor))throw new StoreFault("archive_corrupt","durable receipt belongs to a different actor");
  return stored;
 }
 /** The stored operation record at one revision; its identity - not a sequence number - pins a commit. */
 async #operationAt(root:string,revision:string,sequence:number,signal:AbortSignal):Promise<StoredReceipt|undefined>{
  const bytes=await this.#kernel.read(root,revision,`operations/${String(sequence).padStart(12,"0")}.json`,signal);if(!bytes)return undefined;
  return decodeStoredReceipt(parse(bytes));
 }
 /** Replay answers with the stored business result; its commit is pinned by operation identity.
  * A sequence number alone is not evidence: a restored or relocated lineage can contain more than
  * one commit carrying the same sequence, so the operation record at that revision must agree. */
 async #answer(root:string,head:string,stored:StoredReceipt,signal:AbortSignal):Promise<C.Receipt>{
  const matches:string[]=[];
  for(const revision of await this.#kernel.history(root,head,signal)){
   const snapshot=await this.#snapshot(root,revision,signal);if(snapshot.sequence!==stored.sequence)continue;
   const record=await this.#operationAt(root,revision,stored.sequence,signal);
   if(record===undefined)continue;
   if(record.operationId===stored.operationId&&record.digest===stored.digest&&C.actorKey(record.actor)===C.actorKey(stored.actor)){matches.push(revision);continue;}
   throw new StoreFault("archive_corrupt","operation record disagrees with its receipt at the recorded sequence");
  }
  if(matches.length===0)throw new StoreFault("archive_corrupt","receipt initial commit is absent from first-parent history");
  if(matches.length>1)throw new StoreFault("archive_corrupt","receipt identity is ambiguous across first-parent history");
  return {status:"committed",operation_id:stored.operationId,committed_revision:matches[0]!,head_revision:head,sequence:stored.sequence,changed:stored.changed,documents:stored.documents,result:stored.result};
 }
 async #publish(entry:Entry,root:string,before:C.Snapshot|null,next:C.Snapshot,actor:C.Actor,key:string,payloadDigest:string,action:string,plan:C.MutationPlan,signal:AbortSignal,resetReceipts=false):Promise<C.Receipt>{
  ensureSize(C.success({status:"committed",operation_id:key,committed_revision:ZERO,head_revision:ZERO,sequence:next.sequence,changed:plan.upserts.map(o=>({id:o.id,object_revision:o.object_revision})),documents:plan.views,result:plan.result}),entry.limits.response_bytes);
  const entries=new Map((before?await this.#kernel.entries(root,before.revision,signal):[]).map(e=>[e.path,e.oid]));
  if(resetReceipts)for(const path of entries.keys())if(path.startsWith("receipts/")||path.startsWith("operations/"))entries.delete(path);
  const put=async(path:string,bytes:Uint8Array)=>entries.set(path,await this.#kernel.hash(root,bytes,signal));
  requireResult(decodeSnapshot({...next,revision:before?.revision??ZERO}));
  for(const record of plan.upserts){requireResult(decodeDomainRecord(record));const oid=await this.#kernel.hash(root,json(record),signal);entries.set(`records/${record.kind}/${id(record.id)}.json`,oid);entries.set(`versions/${id(record.id)}/${record.object_revision}.json`,oid);}
  for(const content of plan.content){let bytes:Uint8Array;if(content.kind==="inline")bytes=content.bytes;else {if(!this.#options.resolveSealed)throw new StoreFault("storage_unavailable","sealed upload resolver is not mounted");const invocation=plan.upserts.find(o=>o.kind==="artifact");if(!invocation||invocation.kind!=="artifact")throw new StoreFault("invalid_input","sealed content requires its artifact invocation");bytes=requireResult(await this.#options.resolveSealed(actor,entry.archiveId,invocation.body.invocation_id,content.handle,content.digest)).bytes;}
   if(bytes.length>entry.limits.artifact_bytes||digest(bytes)!==content.digest)throw new StoreFault(bytes.length>entry.limits.artifact_bytes?"budget_exceeded":"invalid_input","content size/digest does not match accepted bytes");await put(`content/${content.digest}`,bytes);
  }
  await put("snapshot.json",json(withoutRevision(next)));
  for(const view of this.#options.projection?.render(next,plan.views)??[])await put(`views/${digest(canonicalJson(view.selection))}.md`,encoder.encode(view.text));
  const stored:StoredReceipt={format:"ensemble-receipt/v2",actor:C.actorIdentity(actor),operationId:key,digest:payloadDigest,sequence:next.sequence,action,changed:plan.upserts.map(o=>({id:o.id,object_revision:o.object_revision})),documents:plan.views,result:plan.result};
  await put(`operations/${String(next.sequence).padStart(12,"0")}.json`,json(stored));await put(receiptPath(actor,key),json(stored));
  await this.#options.fault?.("after_objects",entry.archiveId);
  const result=await publishAtomic<C.Receipt>({kernel:this.#kernel,root,expected:before?.revision??null,sequence:next.sequence,entries:[...entries].map(([path,oid])=>({path,oid})),signal,
   beforePublish:()=>this.#options.fault?.("before_publish",entry.archiveId),afterPublish:()=>this.#options.fault?.("after_publish",entry.archiveId),
   // A root swapped mid-publication cannot be reconciled by path: the bytes went to the pinned
   // inode, so a path-based receipt lookup would describe a different archive. Fail closed.
   afterPublishIdentity:()=>this.#kernel.assertPublishIdentity(root),
   reconcile:async(head,probe)=>{const receipt=await this.#receipt(root,head,actor,key,probe);return receipt?.digest===payloadDigest?this.#answer(root,head,receipt,probe):undefined;},
   committed:(revision,head)=>({status:"committed",operation_id:key,committed_revision:revision,head_revision:head,sequence:next.sequence,changed:stored.changed,documents:stored.documents,result:stored.result})});
  this.#notify({...next,revision:result.head_revision});await this.#options.fault?.("before_response",entry.archiveId);ensureSize(C.success(result),entry.limits.response_bytes);return result;
 }
 async #facts(actor:C.Actor,snapshot:C.Snapshot,command:C.DomainCommand,signal:AbortSignal):Promise<C.TrustedFacts>{
  const contents:NonNullable<C.TrustedFacts["contents"]>[number][]=[];
  const visit=async(value:unknown):Promise<void>=>{if(Array.isArray(value)){for(const v of value)await visit(v);return;}if(!plain(value))return;
   if(value.kind==="text"&&typeof value.text==="string"&&typeof value.media_type==="string"){const input=value as unknown as C.ArtifactContent;const bytes=encoder.encode(value.text);if(decodeUtf8(bytes)!==value.text)throw new StoreFault("invalid_input","text is not lossless UTF-8");const d=digest(bytes);contents.push({input,write:{kind:"inline",bytes,digest:d,media_type:value.media_type},bytes:bytes.length,digest:d,media_type:value.media_type});return;}
   if(value.kind==="upload"&&typeof value.upload_id==="string"&&typeof value.digest==="string"){if(!this.#options.resolveSealed||!("invocation_id"in command.payload))throw new StoreFault("storage_unavailable","sealed upload resolver is required");const resolved=requireResult(await this.#options.resolveSealed(actor,snapshot.archiveId,command.payload.invocation_id,value.upload_id,value.digest));if(digest(resolved.bytes)!==value.digest)throw new StoreFault("invalid_input","sealed upload digest mismatch");contents.push({input:value as unknown as C.ArtifactContent,write:{kind:"inline",bytes:resolved.bytes,digest:value.digest,media_type:resolved.media_type},bytes:resolved.bytes.length,digest:value.digest,media_type:resolved.media_type});return;}
   for(const v of Object.values(value))await visit(v);
  };await visit(command.payload);
  return {...await this.#options.prepareFacts?.(actor,snapshot,command,signal),actor,now:Date.now(),newId:kind=>`${kind}-${randomUUID()}`,contents};
 }
 async execute(actor:C.Actor,request:C.TransactionRequest,signal:AbortSignal):Promise<C.Result<C.Receipt>>{
  try{
   operationId(request.operationId);assertOid(request.expectedRevision);
   const commandResult=decodeWorkCommand(request.command);const command=commandResult.ok?commandResult.value:requireResult(decodeLearnCommand(request.command));
   const entry=await this.#entry(request.archiveId,signal);if(entry.readOnly)throw new StoreFault("not_authorized","archive is registered read-only");ensureSize(request,entry.limits.inline_input_bytes);
   return await this.#kernel.withLock(this.#path(entry),signal,async(signal)=>{
    const current=await hydrateReferences(this.#kernel,this.#path(entry),await this.#current(entry,signal),command,(revision,signal)=>this.#snapshot(this.#path(entry),revision,signal),signal);this.#admit(actor,current);
    requireResult(authorizeCommand(current,command,{actor,now:Date.now(),newId:()=>{throw new Error("authorization cannot allocate ids");}}));
    const hash=requestDigest(command),receipt=await this.#receipt(this.#path(entry),current.revision,actor,request.operationId,signal);
    if(receipt){if(receipt.digest!==hash)throw new StoreFault("operation_key_conflict","operation key already names different business content");return C.success(await this.#answer(this.#path(entry),current.revision,receipt,signal));}
    if(request.expectedRevision!==current.revision)return C.failure("revision_conflict","expected revision differs from current archive head");
    const facts=await this.#facts(actor,current,command,signal);const plan=requireResult(this.#options.reducer(current,command,facts));
    const objects=new Map(current.objects.map(o=>[o.id,o]));for(const object of plan.upserts){const old=objects.get(object.id);if(object.object_revision!==(old?.object_revision??0)+1||object.updated_sequence!==current.sequence+1||object.created_sequence!==(old?.created_sequence??current.sequence+1))throw new StoreFault("invalid_input","reducer returned inconsistent object revisions");objects.set(object.id,object);}
    const next:C.Snapshot={...current,sequence:current.sequence+1,objects:[...objects.values()],policy:plan.policy??current.policy};
    return C.success(await this.#publish(entry,this.#path(entry),current,next,actor,request.operationId,hash,command.action,plan,signal));
   });
  }catch(e){return asFailure(e);}
 }
 async admin(actor:C.Actor,input:C.AdminEnvelope,signal:AbortSignal):Promise<C.Result<C.Receipt>>{
  try{
   this.#owner(actor);const request=requireResult(decodeAdminEnvelope(input));operationId(request.operation_id);
   if(request.action==="initialize")return C.success(await this.#initialize(actor,request,signal));
   const entry=await this.#registry(signal,async r=>{const e=r.entries.find(e=>e.projectId===request.project_id);if(!e)throw new StoreFault("not_found","project is not registered");return e;});
   return await this.#kernel.withLock(this.#path(entry),signal,async(signal)=>{
    const current=await this.#current(entry,signal),hash=requestDigest({action:request.action,payload:request.payload});
    const prior=await this.#receipt(this.#path(entry),current.revision,actor,request.operation_id,signal);if(prior){if(prior.digest!==hash)throw new StoreFault("operation_key_conflict","operation key already names different content");return C.success(await this.#answer(this.#path(entry),current.revision,prior,signal));}
    if(request.expected_revision!==current.revision)throw new StoreFault("revision_conflict","expected revision differs from current head");
    let policy=current.policy,bindings=current.bindings;const upserts:C.DomainRecord[]=[];
    switch(request.action){
     case "pause":case "resume":policy={...policy,paused:request.action==="pause",epoch:policy.epoch+1};break;
     case "grant":{const {reason:_reason,...requested}=request.payload;const grant:C.Grant={...requested,id:`grant-${randomUUID()}`,revoked:false};policy={...policy,epoch:policy.epoch+1,grants:[...policy.grants,grant]};break;}
     case "revoke":{if(!policy.grants.some(g=>g.id===request.payload.grant_id))throw new StoreFault("not_found","grant is absent");policy={...policy,epoch:policy.epoch+1,grants:policy.grants.map(g=>g.id===request.payload.grant_id?{...g,revoked:true}:g)};break;}
     case "bind":case "rebind":{const source=await this.#source(request.payload.source_descriptor,signal);bindings=[...bindings.map(b=>({...b,active:false})),{...source,bindingId:`binding-${randomUUID()}`,active:true}];policy={...policy,epoch:policy.epoch+1};break;}
     case "takeover":{const record=current.objects.find(o=>o.id===request.payload.invocation_id&&o.kind==="invocation");if(!record||record.kind!=="invocation")throw new StoreFault("not_found","invocation is absent");const identity=this.#options.nativeIdentity?.(request.payload.new_lead_session_id);if(!identity||identity.kind!=="session")throw new StoreFault("binding_required","new lead must resolve a trusted native Session");upserts.push({...record,object_revision:record.object_revision+1,updated_sequence:current.sequence+1,body:{...record.body,lead:identity}});policy={...policy,epoch:policy.epoch+1,grants:[...policy.grants,{id:`grant-${randomUUID()}`,subject:identity,rights:["read","lead"],scope:{kind:"invocation",invocation_id:record.id},revoked:false}]};break;}
     case "assign_reviewer":{const target=current.objects.find(o=>o.id===request.payload.proposal_ref.object_id&&o.object_revision===request.payload.proposal_ref.object_revision);const reviewer=this.#options.nativeIdentity?.(request.payload.reviewer_session_id);if(!target||!reviewer||reviewer.kind!=="session")throw new StoreFault("binding_required","proposal and native reviewer must be current");if(C.actorKey(target.author)===C.actorKey(reviewer))throw new StoreFault("not_authorized","author cannot independently review own proposal");policy={...policy,epoch:policy.epoch+1,grants:[...policy.grants,{id:`grant-${randomUUID()}`,subject:reviewer,rights:request.payload.delegated_rights,scope:{kind:"proposal",proposal_ref:request.payload.proposal_ref},revoked:false}]};break;}
     default:throw new StoreFault("invalid_input","maintenance action must use its authenticated maintenance executor");
    }
    requireResult(decodePolicySnapshot(policy));const next:C.Snapshot={...current,sequence:current.sequence+1,policy,bindings,objects:current.objects.map(o=>upserts.find(n=>n.id===o.id)??o)};
    const plan:C.MutationPlan={upserts,content:[],views:[{kind:"overview"}],result:{status:request.action},policy};return C.success(await this.#publish(entry,this.#path(entry),current,next,actor,request.operation_id,hash,request.action,plan,signal));
   });
  }catch(e){return asFailure(e);}
 }
 async #initialize(actor:C.Actor,request:Extract<C.AdminEnvelope,{action:"initialize"}>,signal:AbortSignal):Promise<C.Receipt>{
  if(request.payload.root_handle!==(this.#options.rootHandle??"default"))throw new StoreFault("not_authorized","unknown deployment root handle");
  const source=await this.#source(request.payload.source_descriptor,signal);
  return this.#registry(signal,async (registry,signal)=>{
   const key=digest(`${C.actorKey(actor)}\0${request.operation_id}`),hash=requestDigest({action:request.action,payload:request.payload});let pending=registry.pending.find(p=>p.key===key);
   if(pending&&pending.digest!==hash)throw new StoreFault("operation_key_conflict","initialization key names different content");
   if(!pending){const archiveId=`archive-${randomUUID()}`,projectId=`project-${randomUUID()}`;const limits=request.payload.limits;for(const [name,value]of Object.entries(limits)){if(!Number.isSafeInteger(value)||value<1||value>1024*1024*1024)throw new StoreFault("invalid_input",`invalid limit ${name}`);}if(limits.page_items>100||limits.upload_chunk_bytes>limits.artifact_bytes||limits.artifact_bytes>limits.upload_total_bytes)throw new StoreFault("invalid_input","inconsistent archive limits");const entry:Entry={archiveId,projectId,title:source.nativeWorkspaceRef,readOnly:false,limits};
    const grants=request.payload.initial_grants.map(g=>({...g,id:`grant-${randomUUID()}`,revoked:false}));const snapshot:C.Snapshot={archiveId,projectId,title:entry.title,revision:ZERO,sequence:1,formatVersion:2,rendererVersion:"ensemble/v2",policy:{epoch:1,grants,paused:false},bindings:[{...source,bindingId:`binding-${randomUUID()}`,active:true}],objects:[]};requireResult(decodeSnapshot(snapshot));pending={key,digest:hash,entry,snapshot,actor,operationId:request.operation_id};registry.pending.push(pending);this.#saveRegistry(registry);
   }
   if(registry.retiredArchiveIds?.includes(pending.entry.archiveId))throw new StoreFault("not_authorized","this initialization belongs to a retired archive identity");
   const entry=registry.entries.find(e=>e.archiveId===pending!.entry.archiveId)??pending.entry;const final=this.#path(entry),stage=join(this.#root,"creating",entry.archiveId);let root=existsSync(final)?final:stage;privateDirectory(root);
   const markerPath=join(root,"ensemble-archive.json");if(!existsSync(markerPath))durableFile(markerPath,json({format:C.ARCHIVE_FORMAT,archiveId:entry.archiveId,projectId:entry.projectId}));
   await this.#kernel.initialize(root,signal);await this.#options.fault?.("after_initialize",entry.archiveId);
   let head=await this.#kernel.head(root,signal);let receipt:C.Receipt;
   if(head){const stored=await this.#receipt(root,head,actor,request.operation_id,signal);if(!stored||stored.digest!==hash)throw new StoreFault("archive_corrupt","initialization journal does not match published repository");receipt=await this.#answer(root,head,stored,signal);}
   else receipt=await this.#publish(entry,root,null,pending.snapshot,actor,request.operation_id,hash,"initialize",{upserts:[],content:[],views:[{kind:"overview"}],result:{id:entry.projectId,status:"initialized"}},signal);
   if(root!==final){renameSync(root,final);syncDirectory(join(this.#root,"archives"));syncDirectory(join(this.#root,"creating"));root=final;}
   if(!registry.entries.some(e=>e.archiveId===entry.archiveId)){registry.entries.push(entry);this.#saveRegistry(registry);}await this.#options.fault?.("after_register",entry.archiveId);return receipt;
  },true);
 }
 authenticateOwner(actor:C.Actor):C.Result<true>{try{this.#owner(actor);return C.success(true);}catch(e){return asFailure(e);}}
 /** Trusted maintenance capability: finalProof has already been verified outside the wire decoder. */
 async activateRestored(actor:C.Actor,request:ActivationRequest,signal:AbortSignal):Promise<C.Result<ActivationResult>>{
  try{
   this.#owner(actor);operationId(request.operationId);if(request.businessDigest&&!DIGEST.test(request.businessDigest))throw new StoreFault("invalid_input","invalid activation business digest");privateDirectory(request.candidateRoot);
   const sourceHead=await this.#kernel.head(request.candidateRoot,signal);if(!sourceHead)throw new StoreFault("archive_corrupt","restore candidate has no published head");await this.#kernel.fsck(request.candidateRoot,signal);
   const sourceSnapshot=await this.#snapshot(request.candidateRoot,sourceHead,signal);
   const source=request.source?await this.#source(request.source,signal):undefined;
   let mode=request.mode;
   if(mode==="same-id"&&(!request.finalProof||request.finalProof.archiveId!==sourceSnapshot.archiveId||request.finalProof.head!==sourceHead||request.finalProof.previousWriterStopped!==true||request.finalProof.receiptContinuity!==true))mode="read-only";
   if(request.discardHistory&&mode!=="new-id")throw new StoreFault("invalid_input","history discard always creates a new archive identity");
   if(!source&&(request.grants?.length??0)>0)throw new StoreFault("binding_required","fresh grants require a confirmed source mapping");
   if(mode!=="read-only"&&!source&&!request.discardHistory)throw new StoreFault("binding_required","writable restore requires fresh trusted source binding");
   const hash=requestDigest({mode,sourceHead,sourceArchiveId:sourceSnapshot.archiveId,source:source??null,grants:request.grants??[],discardHistory:request.discardHistory??false,expectedOriginalRevision:request.expectedOriginalRevision??null});
   return await this.#registry(signal,async(registry,signal)=>{
    const key=digest(`${sourceSnapshot.archiveId}\0${C.actorKey(actor)}\0${request.operationId}`);registry.activations??=[];let journal=registry.activations.find(j=>j.key===key);
    if(journal&&journal.digest!==hash)throw new StoreFault("operation_key_conflict","restore operation changed");if(journal?.result)return C.success(journal.result);
    const original=registry.entries.find(e=>e.archiveId===sourceSnapshot.archiveId);
    if(mode==="read-only"&&original)return C.success({archiveId:sourceSnapshot.archiveId,projectId:sourceSnapshot.projectId,revision:sourceHead,readOnly:true,registered:false});
    const run=async(signal:AbortSignal):Promise<C.Result<ActivationResult>>=>{
     if(original){const current=await this.#current(original,signal,Boolean(journal?.receipt));if(!current.policy.paused)throw new StoreFault("not_authorized","previous primary must be paused before replacement");if(!request.expectedOriginalRevision||current.revision!==request.expectedOriginalRevision)throw new StoreFault("revision_conflict","replacement requires the exact latest stopped primary revision");if(mode==="same-id"&&current.revision!==sourceHead)throw new StoreFault("revision_conflict","same-id restore is not the final authoritative head");}
     if(!journal){const archiveId=mode==="new-id"?`archive-${randomUUID()}`:sourceSnapshot.archiveId;const projectId=mode==="new-id"?`project-${randomUUID()}`:sourceSnapshot.projectId;const entry:Entry={archiveId,projectId,title:sourceSnapshot.title,readOnly:mode==="read-only",limits:original?.limits??DEFAULT_LIMITS,directoryId:`storage-${randomUUID()}`};journal={key,actor:C.actorKey(actor),operationId:request.operationId,digest:hash,entry,sourceProjectId:sourceSnapshot.projectId,sourceArchiveId:sourceSnapshot.archiveId,sourceHead,...(request.businessDigest?{businessDigest:request.businessDigest}:{}),...(original?{retiredRoot:this.#path(original),retiredHead:request.expectedOriginalRevision!}:{})};registry.activations!.push(journal);this.#saveRegistry(registry);}
     const entry=journal.entry,final=this.#path(entry),stage=join(this.#root,"creating",entry.directoryId!);const root=existsSync(final)?final:stage;privateDirectory(root);
     if(!journal.receipt){
      if(!existsSync(join(root,"HEAD"))||await this.#kernel.head(root,signal)===null){if(request.discardHistory)await this.#kernel.initialize(root,signal);else{const backup=await this.#kernel.backup(request.candidateRoot,sourceHead,signal);await this.#kernel.restoreBundle(backup,root,signal);}}
      const marker=join(root,"ensemble-archive.json");if(!existsSync(marker))durableFile(marker,json({format:C.ARCHIVE_FORMAT,archiveId:entry.archiveId,projectId:entry.projectId}));
      const stagedHead=await this.#kernel.head(root,signal);if(!stagedHead&&!request.discardHistory)throw new StoreFault("archive_corrupt","staged restore lost its head");
      const found=stagedHead?await this.#receipt(root,stagedHead,actor,request.operationId,signal):undefined;
      if(found&&found.digest===hash)journal.receipt=await this.#answer(root,stagedHead!,found,signal);
      else {
       if(found&&mode!=="new-id")throw new StoreFault("operation_key_conflict","restore key already exists in same-id history");
       const grants=mode==="read-only"?[]:(request.grants??[]).map(g=>({...g,id:`grant-${randomUUID()}`,revoked:false}));
       const next:C.Snapshot={...sourceSnapshot,archiveId:entry.archiveId,projectId:entry.projectId,sequence:sourceSnapshot.sequence+1,policy:{epoch:sourceSnapshot.policy.epoch+1,grants,paused:true},bindings:source?[{...source,bindingId:`binding-${randomUUID()}`,active:true}]:[]};
       let published=next;let upserts:readonly C.DomainRecord[]=[];const content:C.ContentWrite[]=[];
       if(request.discardHistory){upserts=sourceSnapshot.objects.map(o=>({...o,created_sequence:1,updated_sequence:1}));published={...next,sequence:1,objects:upserts,policy:{...next.policy,epoch:1}};const retained=new Set<string>();for(const object of upserts){if(object.kind!=="artifact"||retained.has(object.body.content.digest))continue;retained.add(object.body.content.digest);const bytes=await this.#kernel.read(request.candidateRoot,sourceHead,`content/${object.body.content.digest}`,signal,entry.limits.artifact_bytes);if(!bytes||digest(bytes)!==object.body.content.digest)throw new StoreFault("archive_corrupt","rebuild candidate lacks retained original bytes");content.push({kind:"inline",bytes,digest:object.body.content.digest,media_type:object.body.content.media_type});}}
       const plan:C.MutationPlan={upserts,content,views:[{kind:"overview"}],result:{id:entry.projectId,status:request.discardHistory?"rebuilt-paused":"restored-paused"},policy:published.policy};
       journal.receipt=await this.#publish(entry,root,request.discardHistory?null:sourceSnapshot,published,actor,request.operationId,hash,"restore",plan,signal,mode==="new-id");
      }
      this.#saveRegistry(registry);
     }
     if(root!==final){renameSync(root,final);syncDirectory(join(this.#root,"archives"));syncDirectory(join(this.#root,"creating"));}
     if(original&&this.#path(original)!==final){const retired=join(this.#path(original),"ensemble-retired.json");if(!existsSync(retired))durableFile(retired,json({format:"ensemble-retired/v1",replacement:entry.archiveId,directoryId:entry.directoryId,operationId:request.operationId}));syncDirectory(this.#path(original));registry.entries=registry.entries.filter(e=>e.archiveId!==original.archiveId);if(original.archiveId!==entry.archiveId){registry.retiredArchiveIds??=[];registry.retiredArchiveIds.push(original.archiveId);}}
     registry.entries=registry.entries.filter(e=>e.archiveId!==entry.archiveId);registry.entries.push(entry);journal.result={archiveId:entry.archiveId,projectId:entry.projectId,revision:journal.receipt!.committed_revision,readOnly:entry.readOnly,registered:true};this.#saveRegistry(registry);return C.success(journal.result);
    };
    return original?this.#kernel.withLock(this.#path(original),signal,run):run(signal);
   },true);
  }catch(e){return asFailure(e);}
 }
 async relocate(actor:C.Actor,archiveId:string,request:RelocationRequest,signal:AbortSignal):Promise<C.Result<ActivationResult>>{
  try{this.#owner(actor);operationId(request.operationId);assertOid(request.expectedRevision);const source=request.source?await this.#source(request.source,signal):undefined;if(!source&&(request.grants?.length??0)>0)throw new StoreFault("binding_required","relocation grants require a fresh confirmed source");
   const hash=requestDigest({archiveId,destination:request.destination,source:source??null,grants:request.grants??[],expectedRevision:request.expectedRevision});
   return await this.#registry(signal,async(registry,signal)=>{
    registry.relocations??=[];const key=digest(`${archiveId}\0${C.actorKey(actor)}\0${request.operationId}`);let journal=registry.relocations.find(j=>j.key===key);if(journal&&journal.digest!==hash)throw new StoreFault("operation_key_conflict","relocation key names different content");if(journal?.result)return C.success(journal.result);
    const entry=journal?.entry??registry.entries.find(e=>e.archiveId===archiveId);if(!entry)throw new StoreFault("not_found","archive is not registered");
    return this.#kernel.withLock(this.#path(entry),signal,async signal=>{
     const current=await this.#current(entry,signal,Boolean(journal?.receipt));if(!current.policy.paused)throw new StoreFault("not_authorized","pause the primary before relocating it");if(current.revision!==request.expectedRevision)throw new StoreFault("revision_conflict","relocation expected head changed");
     const safe=validateArchiveRoot(request.destination,[this.#path(entry),...current.bindings.filter(b=>b.worldIdentity===this.#options.worldIdentity).map(b=>b.canonicalAddress),...(source?.worldIdentity===this.#options.worldIdentity?[source.canonicalAddress]:[])]);if(!safe.ok)throw new StoreFault("invalid_input",safe.reason);
     if(!journal){if(existsSync(request.destination)&&readdirSync(request.destination).length)throw new StoreFault("invalid_input","relocation destination must be absent or empty");journal={key,digest:hash,entry:{...entry},destination:request.destination,oldHead:current.revision};registry.relocations!.push(journal);this.#saveRegistry(registry);}
     privateDirectory(request.destination);
     if(!journal.receipt){
      if(!existsSync(join(request.destination,"HEAD"))||await this.#kernel.head(request.destination,signal)===null){const bundle=await this.#kernel.backup(this.#path(entry),current.revision,signal);await this.#kernel.restoreBundle(bundle,request.destination,signal);}
      const marker=join(request.destination,"ensemble-archive.json");if(!existsSync(marker))durableFile(marker,json({format:C.ARCHIVE_FORMAT,archiveId:entry.archiveId,projectId:entry.projectId}));
      const head=await this.#kernel.head(request.destination,signal);if(!head)throw new StoreFault("archive_corrupt","relocated candidate has no head");const prior=await this.#receipt(request.destination,head,actor,request.operationId,signal);
      if(prior){if(prior.digest!==hash)throw new StoreFault("operation_key_conflict","relocation operation key conflicts with history");journal.receipt=await this.#answer(request.destination,head,prior,signal);}
      else{const grants=(request.grants??[]).map(g=>({...g,id:`grant-${randomUUID()}`,revoked:false}));const next:C.Snapshot={...current,sequence:current.sequence+1,policy:{epoch:current.policy.epoch+1,grants,paused:true},bindings:source?[{...source,bindingId:`binding-${randomUUID()}`,active:true}]:[]};journal.receipt=await this.#publish(entry,request.destination,current,next,actor,request.operationId,hash,"relocate",{upserts:[],content:[],views:[{kind:"overview"}],result:{status:"relocated-paused"},policy:next.policy},signal);}
      const config=join(this.#path(entry),"owner-configuration.json");if(existsSync(config)&&!existsSync(join(request.destination,"owner-configuration.json")))durableFile(join(request.destination,"owner-configuration.json"),readFileSync(config));syncDirectory(request.destination);this.#saveRegistry(registry);
     }
     const retired=join(this.#path(entry),"ensemble-retired.json");if(!existsSync(retired))durableFile(retired,json({format:"ensemble-retired/v1",replacement:entry.archiveId,operationId:request.operationId}));syncDirectory(this.#path(entry));
     registry.entries=registry.entries.map(e=>e.archiveId===archiveId?{...e,storagePath:request.destination}:e);journal.result={archiveId:entry.archiveId,projectId:entry.projectId,revision:journal.receipt!.committed_revision,readOnly:entry.readOnly,registered:true};this.#saveRegistry(registry);return C.success(journal.result);
    });
   });
  }catch(e){return asFailure(e);}
 }
 /** Looks up a completed activation/restore journal entry by its operation key.
  * `scope` disambiguates a key reused across projects and is expressed in the **source**
  * (pre-replacement) identities the caller already holds: `archiveId` matches the journal's
  * `sourceArchiveId` and `projectId` its `sourceProjectId` - the originals, not the new ones. */
 async activationResult(actor:C.Actor,operationIdValue:string,signal:AbortSignal,scope?:{archiveId?:string;projectId?:string}):Promise<C.Result<ActivationResult&{sourceArchiveId:string;sourceHead:string;expectedOldHead?:string;digest:string;businessDigest?:string;disposed:boolean}>>{
  try{this.#owner(actor);operationId(operationIdValue);return await this.#registry(signal,async registry=>{const matches=(registry.activations??[]).filter(j=>j.actor===C.actorKey(actor)&&j.operationId===operationIdValue&&(!scope?.archiveId||j.sourceArchiveId===scope.archiveId)&&(!scope?.projectId||j.sourceProjectId===scope.projectId));if(matches.length>1)throw new StoreFault("binding_ambiguous","operation key exists in multiple projects; provide the original project scope");const journal=matches[0];if(!journal)throw new StoreFault("not_found","activation receipt is absent");if(!journal.result)throw new StoreFault("outcome_unknown","activation has a pending recovery journal; resume that operation");return C.success({...journal.result,sourceArchiveId:journal.sourceArchiveId,sourceHead:journal.sourceHead,...(journal.retiredHead?{expectedOldHead:journal.retiredHead}:{}),digest:journal.digest,...(journal.businessDigest?{businessDigest:journal.businessDigest}:{}),disposed:journal.disposal?.completed??false});});}catch(e){return asFailure(e);}
 }
 #family(registry:Registry,archiveId:string):Set<string>{const family=new Set([archiveId]);let changed=true;while(changed){changed=false;for(const j of registry.activations??[])if(j.result&&family.has(j.entry.archiveId)&&!family.has(j.sourceArchiveId)){family.add(j.sourceArchiveId);changed=true;}}return family;}
 #copyId(registry:Registry,root:string):string{return `copy-${createHmac("sha256",registry.secret).update(root).digest("hex")}`;}
 async knownCopies(actor:C.Actor,archiveId:string,signal:AbortSignal):Promise<C.Result<readonly {copyId:string;archiveId:string;revision:string;kind:"retired-primary"|"relocated-primary";state:"retained"|"disposed"|"missing"}[]>>{
  try{this.#owner(actor);return await this.#registry(signal,async registry=>{const family=this.#family(registry,archiveId);const copies:{copyId:string;archiveId:string;revision:string;kind:"retired-primary"|"relocated-primary";state:"retained"|"disposed"|"missing"}[]=[];
   for(const j of registry.activations??[])if(j.result&&j.retiredRoot&&j.retiredHead&&family.has(j.sourceArchiveId))copies.push({copyId:this.#copyId(registry,j.retiredRoot),archiveId:j.sourceArchiveId,revision:j.retiredHead,kind:"retired-primary",state:j.disposal?.completed?"disposed":existsSync(j.retiredRoot)?"retained":"missing"});
   for(const j of registry.relocations??[])if(j.result&&family.has(j.entry.archiveId))copies.push({copyId:this.#copyId(registry,this.#path(j.entry)),archiveId:j.entry.archiveId,revision:j.oldHead,kind:"relocated-primary",state:j.disposal?.completed?"disposed":existsSync(this.#path(j.entry))?"retained":"missing"});return C.success(copies);
  });}catch(e){return asFailure(e);}
 }
 async #disposeCopy(registry:Registry,copy:{root:string;archiveId:string;head:string;markerReplacement:string;journal:{disposal?:{head:string;completed:boolean}}},replacementArchiveId:string,signal:AbortSignal):Promise<void>{
  const replacement=registry.entries.find(e=>e.archiveId===replacementArchiveId);if(!replacement)throw new StoreFault("not_authorized","replacement is not currently registered");
  if(!this.#family(registry,replacementArchiveId).has(copy.archiveId))throw new StoreFault("not_authorized","retired copy is not in the replacement's recorded lineage");
  const target=resolve(copy.root);if(target!==copy.root||target===this.#root||target===join(this.#root,"archives")||target===join(this.#root,"creating")||registry.entries.some(e=>this.#path(e)===target||this.#path(e).startsWith(target+sep)))throw new StoreFault("not_authorized","retired location still contains a registered writer");
  if(copy.journal.disposal?.completed)return;
  await this.#kernel.withLock(this.#path(replacement),signal,async signal=>{await this.#current(replacement,signal);});
  if(!existsSync(target)){if(!copy.journal.disposal)throw new StoreFault("archive_corrupt","retired repository disappeared before disposal authorization");copy.journal.disposal.completed=true;this.#saveRegistry(registry);return;}
  if(realpathSync(target)!==target)throw new StoreFault("not_authorized","retired location is no longer its canonical directory");privateDirectory(target);
  await this.#kernel.withLock(target,signal,async signal=>{
   if(!copy.journal.disposal){const marker=parse(readFileSync(join(target,"ensemble-retired.json")));if(!plain(marker)||marker.format!=="ensemble-retired/v1"||marker.replacement!==copy.markerReplacement)throw new StoreFault("not_authorized","old writer does not carry the matching retirement marker");const head=await this.#kernel.head(target,signal);if(head!==copy.head)throw new StoreFault("revision_conflict","retired writer head changed");const snapshot=await this.#snapshot(target,head,signal);if(snapshot.archiveId!==copy.archiveId)throw new StoreFault("archive_corrupt","retired archive identity differs");const safe=validateArchiveRoot(target,snapshot.bindings.filter(b=>b.worldIdentity===this.#options.worldIdentity).map(b=>b.canonicalAddress));if(!safe.ok)throw new StoreFault("not_authorized",safe.reason);copy.journal.disposal={head,completed:false};this.#saveRegistry(registry);}
   signal.throwIfAborted();
   // The target is the exact canonical journaled archive, checked above. Child symlinks are unlinked, not followed.
   rmSync(target,{recursive:true,force:false});syncDirectory(resolve(target,".."));copy.journal.disposal.completed=true;this.#saveRegistry(registry);
  });
 }
 /** Only exact journaled retired locations can be disposed; neither API accepts a caller path. */
 async disposeRetired(actor:C.Actor,request:{oldArchiveId:string;replacementArchiveId:string;expectedOldHead:string},signal:AbortSignal):Promise<C.Result<{disposed:true;archiveId:string}>>{
  try{this.#owner(actor);assertOid(request.expectedOldHead);return await this.#registry(signal,async(registry,signal)=>{const journal=registry.activations?.find(j=>j.sourceArchiveId===request.oldArchiveId&&j.entry.archiveId===request.replacementArchiveId&&j.retiredHead===request.expectedOldHead&&j.result?.registered);if(!journal?.retiredRoot)throw new StoreFault("not_found","no completed replacement matches this disposal request");await this.#disposeCopy(registry,{root:journal.retiredRoot,archiveId:journal.sourceArchiveId,head:journal.retiredHead!,markerReplacement:journal.entry.archiveId,journal},request.replacementArchiveId,signal);return C.success({disposed:true,archiveId:request.oldArchiveId});});}catch(e){return asFailure(e);}
 }
 async disposeKnownCopy(actor:C.Actor,request:{copyId:string;replacementArchiveId:string;expectedHead:string},signal:AbortSignal):Promise<C.Result<{disposed:true;copyId:string}>>{
  try{this.#owner(actor);assertOid(request.expectedHead);return await this.#registry(signal,async(registry,signal)=>{
   const relocated=registry.relocations?.find(j=>j.result&&this.#copyId(registry,this.#path(j.entry))===request.copyId&&j.oldHead===request.expectedHead);
   const activated=registry.activations?.find(j=>j.result&&j.retiredRoot&&this.#copyId(registry,j.retiredRoot)===request.copyId&&j.retiredHead===request.expectedHead);
   if(relocated)await this.#disposeCopy(registry,{root:this.#path(relocated.entry),archiveId:relocated.entry.archiveId,head:relocated.oldHead,markerReplacement:relocated.entry.archiveId,journal:relocated},request.replacementArchiveId,signal);
   else if(activated)await this.#disposeCopy(registry,{root:activated.retiredRoot!,archiveId:activated.sourceArchiveId,head:activated.retiredHead!,markerReplacement:activated.entry.archiveId,journal:activated},request.replacementArchiveId,signal);
   else throw new StoreFault("not_found","no retired copy matches the approved identity and head");return C.success({disposed:true,copyId:request.copyId});
  });}catch(e){return asFailure(e);}
 }
 async withOwner<T>(actor:C.Actor,archiveId:string,signal:AbortSignal,run:(lease:OwnerLease)=>Promise<C.Result<T>>):Promise<C.Result<T>>{
  try{this.#owner(actor);const entry=await this.#entry(archiveId,signal);return await this.#kernel.withLock(this.#path(entry),signal,async(signal)=>{const snapshot=await this.#current(entry,signal);return run({snapshot,root:this.#path(entry),repository:{path:this.#path(entry),head:snapshot.revision,origin:entry.storagePath?"relocated":"registry"},kernel:this.#kernel,limits:entry.limits,signal,configuration:name=>this.#configuration(this.#path(entry),name),saveConfiguration:(name,value)=>{this.#configuration(this.#path(entry),name,value);},commit:async(plan,request)=>{
     try{operationId(request.operationId);if(!DIGEST.test(request.digest))throw new StoreFault("invalid_input","maintenance digest is invalid");const current=await this.#current(entry,signal);const prior=await this.#receipt(this.#path(entry),current.revision,actor,request.operationId,signal);if(prior){if(prior.digest!==request.digest)throw new StoreFault("operation_key_conflict","maintenance operation changed");return C.success(await this.#answer(this.#path(entry),current.revision,prior,signal));}if(request.expectedRevision!==current.revision)throw new StoreFault("revision_conflict","maintenance expected revision changed");const objects=new Map(current.objects.map(o=>[o.id,o]));for(const record of plan.upserts){requireResult(decodeDomainRecord(record));const old=objects.get(record.id);if(record.object_revision!==(old?.object_revision??0)+1||record.updated_sequence!==current.sequence+1)throw new StoreFault("invalid_input","maintenance object revision is invalid");objects.set(record.id,record);}const next:C.Snapshot={...current,sequence:current.sequence+1,objects:[...objects.values()],policy:plan.policy??current.policy};return C.success(await this.#publish(entry,this.#path(entry),current,next,actor,request.operationId,request.digest,request.action,plan,signal));}catch(e){return asFailure(e);}
    }});});}catch(e){return asFailure(e);}
 }
 async withAccess<T>(actor:C.Actor,archiveId:string,access:UploadAccess,signal:AbortSignal,run:(snapshot:C.Snapshot)=>Promise<C.Result<T>>):Promise<C.Result<T>>{
  try{const entry=await this.#entry(archiveId,signal);return await this.#kernel.withLock(this.#path(entry),signal,async(signal)=>{const s=await this.#current(entry,signal);this.#admit(actor,s);if(s.policy.paused)throw new StoreFault("not_authorized","archive is paused");if(!s.objects.some(o=>o.kind==="invocation"&&o.id===access.invocationId)||(actor.kind!=="owner"&&!isLead(s,actor,access.invocationId,Date.now())&&!isCurrentMember(s,actor,access.invocationId,Date.now())))throw new StoreFault("not_authorized","current invocation upload rights are required");return run(s);});}catch(e){return asFailure(e);}
 }
 async context(actor:C.Actor,signal:AbortSignal):Promise<C.Result<C.OwnerContext>>{
  try{
   // `#owner` validates the actor and the narrowing below reads `current_owner` from that
   // authenticated principal - never from a request body, and never a hardcoded subject.
   if(actor.kind!=="owner")throw new StoreFault("not_authorized","authenticated owner of this Host is required");
   this.#owner(actor);
   const current_owner:Extract<C.ActorIdentity,{kind:"owner"}>={
    kind:"owner",ownerId:actor.ownerId,hostAuthorityId:actor.hostAuthorityId,
   };
   const entries=existsSync(join(this.#root,"registry.json"))?await this.#registry(signal,async r=>r.entries.slice()):[];const projects:C.ProjectSummary[]=[];for(const e of entries)await this.#kernel.withLock(this.#path(e),signal,async(signal)=>{const s=await this.#current(e,signal);projects.push({project_id:s.projectId,title:s.title,read_revision:s.revision,authorization_epoch:s.policy.epoch,capabilities:["read","write","owner"],...(s.bindings.find(b=>b.active)?{binding_id:s.bindings.find(b=>b.active)!.bindingId}:{})});});return C.success({capabilities:["archive","work","learn","read"],root_handles:[this.#options.rootHandle??"default"],source_handles:[],destination_handles:[],current_owner,projects});}catch(e){return asFailure(e);}
 }
 #configuration(root:string,name:string,value?:unknown):unknown {
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(name))throw new StoreFault("invalid_input","invalid owner configuration namespace");
  const path=join(root,"owner-configuration.json");const document=existsSync(path)?parse(readFileSync(path)):{format:"ensemble-owner-configuration/v1",values:{}};
  if(!plain(document)||document.format!=="ensemble-owner-configuration/v1"||!plain(document.values))throw new StoreFault("archive_corrupt","invalid owner configuration");
  if(value===undefined)return document.values[name];
  ensureSize(value,256*1024);document.values[name]=value;const temp=join(root,`.owner-configuration-${randomUUID()}`);durableFile(temp,json(document));renameSync(temp,path);syncDirectory(root);return value;
 }
 async projects(actor:C.Actor,_query:C.Query,signal:AbortSignal):Promise<C.Result<C.ReadPage>> {
  try{if(actor.kind==="owner")this.#owner(actor);const entries=await this.#registry(signal,async r=>r.entries.slice());const items:C.ProjectSummary[]=[];
   for(const entry of entries)await this.#kernel.withLock(this.#path(entry),signal,async signal=>{const s=await this.#current(entry,signal);try{this.#readAllowed(actor,s);}catch(e){if(e instanceof StoreFault&&e.code==="not_authorized")return;throw e;}items.push({project_id:s.projectId,title:s.title,read_revision:s.revision,authorization_epoch:s.policy.epoch,capabilities:entry.readOnly?["read"]:["read","write"],...(s.bindings.find(b=>b.active)?{binding_id:s.bindings.find(b=>b.active)!.bindingId}:{})});});
   // A catalog is explicitly a collection of per-project snapshots, never a fabricated Git commit.
   const page:C.ReadPage={project_id:"catalog",read_revision:`catalog:${digest(canonicalJson(items))}`,authorization_epoch:0,items,completeness:"complete"};ensureSize(C.success(page),DEFAULT_LIMITS.response_bytes);return C.success(page);
  }catch(e){return asFailure(e);}
 }
 /** Resolves a project the caller named explicitly.
  * Zero active bindings and several active bindings are different problems. A rebuild (purge or
  * lossy activation) deliberately publishes `bindings: []` so the new archive inherits no mapping;
  * requiring a binding before `bind` made that state unreachable for its own owner, because `bind`
  * is the call that creates the first one. The owner names the archive by project id, so nothing is
  * matched here - but the target carries an unbound marker and every reader that needs a mapping
  * still refuses. Several active bindings remain a genuine ambiguity. */
 async readTarget(actor:C.Actor,projectId:string,signal:AbortSignal):Promise<C.Result<C.BoundTarget>> {
  try{const entry=await this.#registry(signal,async r=>{const e=r.entries.find(e=>e.projectId===projectId);if(!e)throw new StoreFault("not_found","project is not registered");return e;});return await this.#kernel.withLock(this.#path(entry),signal,async signal=>{const s=await this.#current(entry,signal);this.#readAllowed(actor,s);const active=s.bindings.filter(b=>b.active);
   if(active.length===1)return C.success({archiveId:s.archiveId,projectId:s.projectId,bindingId:active[0]!.bindingId});
   if(active.length===0){
    // Only the owner may address an unmapped archive, and only to establish the mapping.
    if(actor.kind==="owner")return C.success({archiveId:s.archiveId,projectId:s.projectId,bindingId:UNBOUND_BINDING});
    throw new StoreFault("binding_required","trusted Session has no current project binding");
   }
   throw new StoreFault("binding_ambiguous","project has more than one active source binding");
  });}catch(e){return asFailure(e);}
 }
 async resolveProject(actor:C.Actor,projectId:string,signal:AbortSignal):Promise<C.Result<C.BoundTarget>> {return this.readTarget(actor,projectId,signal);}
 async query(actor:C.Actor,target:C.BoundTarget,input:C.Query,signal:AbortSignal):Promise<C.Result<C.ReadPage>>{
  try{const query=requireResult(decodeQuery(input));const {entry,secret}=await this.#registry(signal,async r=>{const entry=r.entries.find(e=>e.archiveId===target.archiveId);if(!entry)throw new StoreFault("not_found","archive is not registered");return {entry,secret:r.secret};});
   if(entry.projectId!==target.projectId||query.project_id&&query.project_id!==entry.projectId)throw new StoreFault("not_authorized","query target differs from trusted binding");
   return await this.#kernel.withLock(this.#path(entry),signal,async signal=>{
    const current=await this.#current(entry,signal);this.#readAllowed(actor,current);if(!(actor.kind==="owner"&&entry.readOnly)&&!current.bindings.some(b=>b.bindingId===target.bindingId&&b.active))throw new StoreFault("binding_required",target.bindingId===UNBOUND_BINDING?"archive has no active source binding; the owner must bind it before reading":"target binding is no longer active");
    if(!this.#options.query)throw new StoreFault("storage_unavailable","pure query module is not mounted");
    const result=await readArchiveQuery({kernel:this.#kernel,root:this.#path(entry),secret,current,actor,query,limits:entry.limits,signal,load:(revision,signal)=>this.#snapshot(this.#path(entry),revision,signal),receipt:async(key,signal)=>{const r=await this.#receipt(this.#path(entry),current.revision,actor,key,signal);return r?this.#answer(this.#path(entry),current.revision,r,signal):undefined;},queryModule:this.#options.query,...(this.#options.environmentRead?{environment:this.#options.environmentRead}:{})});
    this.#readAllowed(actor,current);if(result.ok)ensureSize(result,entry.limits.response_bytes);return result;
   });
  }catch(e){return asFailure(e);}
 }

}
export function createArchiveRegistry(options:RegistryOptions):ArchiveRegistry{return new ArchiveRegistry(options);}
export { ArchiveKernel, StoreFault } from "./kernel.ts";
