/** Independent versioned state (environment), sharing project publication/lock semantics. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { actorKey, actorIdentity, failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import { canonicalJson } from "../records.ts";
import { ArchiveKernel, StoreFault, asFailure, assertOid, decodeUtf8, durableFile, privateDirectory, syncDirectory, type KernelOptions } from "./kernel.ts";
import { publishAtomic } from "./transaction.ts";
import { decodeLedgerMarker, decodeLedgerReceipt, decodeLedgerState } from "./schema.ts";
const enc=new TextEncoder();
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const bytes=(value:unknown)=>enc.encode(`${canonicalJson(value)}\n`);
const plain=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw new StoreFault(r.error.code,r.error.message);return r.value;}
function json(data:Uint8Array):unknown{try{return JSON.parse(decodeUtf8(data));}catch{throw new StoreFault("archive_corrupt","invalid ledger JSON");}}
export interface LedgerOptions<State> extends Partial<KernelOptions> {
 readonly root:string;readonly hostAuthorityId:string;readonly kernel?:ArchiveKernel;
 readonly format:string;readonly decodeState:(value:unknown)=>Result<State>;
 /** The consumer's closed decoder for its own business result. A ledger receipt's `result` is opaque
  * to this module, so whoever produced it must re-validate it before any replay hands it back:
  * an untyped payload is exactly what a tampered receipt would exploit. */
 readonly decodeResult:(value:unknown)=>Result<unknown>;
 readonly authorize:(actor:Actor,current:State|undefined,mode:"read"|"write")=>Result<true>;
 readonly inputBytes?:number;readonly responseBytes?:number;
 readonly fault?:(stage:"before_publish"|"after_publish"|"before_response")=>void|Promise<void>;
}
export interface LedgerReading<State>{readonly revision:string;readonly sequence:number;readonly state:State}
export interface LedgerAnswer<State> extends LedgerReading<State>{readonly head_revision:string;readonly result:unknown;readonly replayed:boolean}
export interface LedgerRequest<Command>{readonly operationId:string;readonly expectedRevision:"absent"|string;readonly command:Command}
export interface LedgerLease<State>{readonly root:string;readonly kernel:ArchiveKernel;readonly signal:AbortSignal;readonly current:LedgerReading<State>|undefined}
interface StateFile<State>{format:string;sequence:number;state:State}
interface Operation {format:"ensemble-ledger-receipt/v1";actor:string;operationId:string;digest:string;sequence:number;result:unknown}
export class VersionedLedger<State>{
 readonly #options:LedgerOptions<State>;readonly #kernel:ArchiveKernel;#ledgerId="";
 constructor(options:LedgerOptions<State>){this.#options=options;if(options.kernel)this.#kernel=options.kernel;else {if(!options.context||!options.factories)throw new StoreFault("storage_unavailable","ledger requires the private Host-local process group");this.#kernel=new ArchiveKernel({...options,context:options.context,factories:options.factories});}}
 dispose():void{if(!this.#options.kernel)this.#kernel.dispose();}
 #authorize(actor:Actor,state:State|undefined,mode:"read"|"write"):void{if(actor.kind==="owner"&&(actor.hostAuthorityId!==this.#options.hostAuthorityId||actor.channel!=="authenticated-remote"))throw new StoreFault("not_authorized","owner belongs to a different Host");unwrap(this.#options.authorize(actor,state,mode));}
 #limit(value:unknown):void{if(bytes(value).length>(this.#options.responseBytes??32*1024))throw new StoreFault("budget_exceeded","complete ledger response exceeds its byte budget");}
 async #locked<T>(actor:Actor,mode:"read"|"write",signal:AbortSignal,run:(current:LedgerReading<State>|undefined,signal:AbortSignal)=>Promise<T>):Promise<T>{
  const root=this.#options.root;privateDirectory(root);
  // Admission is decided before the lock file exists, so refusing leaves a foreign root untouched.
  const markerPresent=existsSync(join(root,"ensemble-ledger.json"));
  return this.#kernel.withLock(root,signal,async signal=>{
   const markerPath=join(root,"ensemble-ledger.json");let current:LedgerReading<State>|undefined;
   if(!existsSync(markerPath)){
    this.#authorize(actor,undefined,mode);
    if(mode==="read")throw new StoreFault("not_found","environment ledger has not been initialized");
    if(readdirSync(root).some(n=>n!==".ensemble-writer.lock"&&n!==".ensemble-effect.lock"))throw new StoreFault("archive_corrupt","refusing to adopt a foreign ledger root");
    durableFile(markerPath,bytes({format:"ensemble-ledger-owner/v1",ledgerId:`ledger-${randomUUID()}`,hostAuthorityId:this.#options.hostAuthorityId,stateFormat:this.#options.format}));
   }
   // A marker that names another owner or format is unsupported; a malformed one is corrupt.
   const marker=readFileSync(markerPath);let identity:ReturnType<typeof decodeLedgerMarker>;
   try{identity=decodeLedgerMarker(json(marker),this.#options.hostAuthorityId,this.#options.format);}catch(error){
    if(error instanceof StoreFault&&error.code==="archive_corrupt"&&plain(json(marker))&&(json(marker) as Record<string,unknown>).format==="ensemble-ledger-owner/v1")throw new StoreFault("unsupported_version","ledger identity or format differs from its owner");
    throw error;
   }
   this.#ledgerId=identity.ledgerId;if(identity.restoring)throw new StoreFault("storage_unavailable","ledger restoration must complete before reads or writes");
   // Our marker makes an interrupted init distinguishable from a foreign bare repository.
   if(!existsSync(join(root,"HEAD")))await this.#kernel.initialize(root,signal);
   const head=await this.#kernel.head(root,signal);if(head)current=await this.#at(head,signal);
   this.#authorize(actor,current?.state,mode);return run(current,signal);
  },"writer",entries=>{
   if(markerPresent)return;
   const foreign=entries.filter(name=>name!==".ensemble-writer.lock"&&name!==".ensemble-effect.lock");
   if(foreign.length)throw new StoreFault("archive_corrupt","refusing to adopt a foreign ledger root; nothing was written");
  });
 }
 async #at(revision:string,signal:AbortSignal):Promise<LedgerReading<State>>{
  const raw=await this.#kernel.read(this.#options.root,revision,"ledger.json",signal);if(!raw)throw new StoreFault("archive_corrupt","ledger commit has no state");const value=json(raw);
  const envelope=decodeLedgerState(value,this.#options.format);
  return {revision,sequence:envelope.sequence,state:unwrap(this.#options.decodeState(envelope.state))};
 }
 #receiptPath(actor:Actor,key:string):string{if(!this.#ledgerId)throw new StoreFault("archive_corrupt","ledger identity is unavailable");return `receipts/${this.#ledgerId}/${sha(actorKey(actor))}/${sha(key)}.json`;}
 async #operation(actor:Actor,key:string,head:string,signal:AbortSignal):Promise<Operation|undefined>{
  const raw=await this.#kernel.read(this.#options.root,head,this.#receiptPath(actor,key),signal);if(!raw)return undefined;
  const receipt=decodeLedgerReceipt(json(raw),actorKey(actor),key) as unknown as Operation;
  // Closed re-validation of the business result happens before this receipt can authorize a replay.
  const result=this.#options.decodeResult(receipt.result);
  if(!result.ok)throw new StoreFault("archive_corrupt",`stored ledger result is not a valid ${this.#options.format} result: ${result.error.message}`);
  return receipt;
 }
 async #answer(operation:Operation,head:string,signal:AbortSignal):Promise<LedgerAnswer<State>>{
  for(const revision of await this.#kernel.history(this.#options.root,head,signal)){const at=await this.#at(revision,signal);if(at.sequence===operation.sequence){const answer={...at,head_revision:head,result:operation.result,replayed:true};this.#limit(answer);return answer;}}
  throw new StoreFault("archive_corrupt","ledger receipt lost its initial commit");
 }
 async read(actor:Actor,revision:string|undefined,signal:AbortSignal):Promise<Result<LedgerReading<State>>>{
  try{return await this.#locked(actor,"read",signal,async(current,signal)=>{if(!current)throw new StoreFault("not_found","ledger is empty");if(revision&&!await this.#kernel.isAncestor(this.#options.root,assertOid(revision),current.revision,signal))throw new StoreFault("not_found","revision is not published ledger history");const result=revision?await this.#at(revision,signal):current;this.#limit(result);return success(result);});}catch(e){return asFailure(e);}
 }
 async revisionAt(actor:Actor,sequence:number,signal:AbortSignal):Promise<Result<string>>{
  try{return await this.#locked(actor,"read",signal,async(current,signal)=>{if(!Number.isSafeInteger(sequence)||sequence<1||!current||sequence>current.sequence)throw new StoreFault("not_found","ledger sequence is not published");for(const revision of await this.#kernel.history(this.#options.root,current.revision,signal)){if((await this.#at(revision,signal)).sequence===sequence)return success(revision);}throw new StoreFault("archive_corrupt","ledger sequence is missing from history");});}catch(e){return asFailure(e);}
 }
 async receipt(actor:Actor,key:string,signal:AbortSignal):Promise<Result<LedgerAnswer<State>>>{
  try{return await this.#locked(actor,"read",signal,async(current,signal)=>{if(!current)throw new StoreFault("not_found","ledger is empty");const operation=await this.#operation(actor,key,current.revision,signal);if(!operation)throw new StoreFault("not_found","ledger receipt is absent");return success(await this.#answer(operation,current.revision,signal));});}catch(e){return asFailure(e);}
 }
 async transact<Command>(actor:Actor,request:LedgerRequest<Command>,reduce:(state:State|undefined,command:Command,context:{sequence:number;revision?:string})=>Result<{state:State;result:unknown}>,signal:AbortSignal):Promise<Result<LedgerAnswer<State>>>{
  try{
   if(typeof request.operationId!=="string"||!request.operationId.trim()||enc.encode(request.operationId).length>128||/[\u0000-\u001f]/.test(request.operationId))throw new StoreFault("invalid_input","invalid ledger operation key");
   if(request.expectedRevision!=="absent")assertOid(request.expectedRevision);if(bytes(request).length>(this.#options.inputBytes??256*1024))throw new StoreFault("budget_exceeded","ledger command exceeds the input budget");
   const requestDigest=sha(canonicalJson(request.command));
   return await this.#locked(actor,"write",signal,async(current,signal)=>{
    if(current){const prior=await this.#operation(actor,request.operationId,current.revision,signal);if(prior){if(prior.digest!==requestDigest)throw new StoreFault("operation_key_conflict","ledger key names different business content");return success(await this.#answer(prior,current.revision,signal));}}
    if(request.expectedRevision!==(current?.revision??"absent"))throw new StoreFault("revision_conflict","ledger expected revision differs from current head");
    const sequence=(current?.sequence??0)+1;const reduced=unwrap(reduce(current?.state,request.command,{sequence,...(current?{revision:current.revision}:{})}));const state=unwrap(this.#options.decodeState(reduced.state));
    this.#limit({revision:"0".repeat(40),head_revision:"0".repeat(40),sequence,state,result:reduced.result,replayed:false});
    const root=this.#options.root,entries=new Map((current?await this.#kernel.entries(root,current.revision,signal):[]).map(e=>[e.path,e.oid]));
    const put=async(path:string,value:unknown)=>entries.set(path,await this.#kernel.hash(root,bytes(value),signal));
    const acceptedResult=this.#options.decodeResult(reduced.result);
    if(!acceptedResult.ok)throw new StoreFault("invalid_input",`reducer result is not a valid ${this.#options.format} result: ${acceptedResult.error.message}`);
    const operation:Operation={format:"ensemble-ledger-receipt/v1",actor:actorKey(actor),operationId:request.operationId,digest:requestDigest,sequence,result:reduced.result};
    const stored:StateFile<State>={format:this.#options.format,sequence,state};await put("ledger.json",stored);await put(this.#receiptPath(actor,request.operationId),operation);await put(`operations/${String(sequence).padStart(12,"0")}.json`,{...operation,identity:actorIdentity(actor)});
    const result=await publishAtomic<LedgerAnswer<State>>({kernel:this.#kernel,root,expected:current?.revision??null,sequence,entries:[...entries].map(([path,oid])=>({path,oid})),signal,beforePublish:()=>this.#options.fault?.("before_publish"),afterPublish:()=>this.#options.fault?.("after_publish"),afterPublishIdentity:()=>this.#kernel.assertPublishIdentity(root),reconcile:async(head,probe)=>{const prior=await this.#operation(actor,request.operationId,head,probe);return prior?.digest===requestDigest?this.#answer(prior,head,probe):undefined;},committed:(revision,head_revision)=>({revision,head_revision,sequence,state,result:reduced.result,replayed:false})});
    await this.#options.fault?.("before_response");return success(result);
   });
  }catch(e){return asFailure(e);}
 }
 /** Restores into an empty independent ledger; old grants/effects are never admitted before sanitize commits. */
 async restore(actor:Actor,request:{bytes:Uint8Array;expectedHead:string;operationId:string},sanitize:(state:State,context:{sequence:number;revision:string})=>Result<{state:State;result:unknown}>,signal:AbortSignal):Promise<Result<LedgerAnswer<State>>>{
  try{
   if(actor.kind!=="owner")throw new StoreFault("not_authorized","ledger restore requires owner management");this.#authorize(actor,undefined,"write");assertOid(request.expectedHead);if(!request.operationId.trim()||enc.encode(request.operationId).length>128)throw new StoreFault("invalid_input","invalid restore operation key");if(request.bytes.length>(this.#options.backupBytes??512*1024*1024))throw new StoreFault("budget_exceeded","ledger backup exceeds its binary transfer budget");
   const hash=sha(canonicalJson({action:"restore",expectedHead:request.expectedHead,backupDigest:createHash("sha256").update(request.bytes).digest("hex")}));const root=this.#options.root;privateDirectory(root);
   return await this.#kernel.withLock(root,signal,async signal=>{
    const markerPath=join(root,"ensemble-ledger.json");let marker:Record<string,unknown>;
    if(existsSync(markerPath)){const parsed=json(readFileSync(markerPath));if(!plain(parsed)||parsed.format!=="ensemble-ledger-owner/v1"||parsed.hostAuthorityId!==this.#options.hostAuthorityId||parsed.stateFormat!==this.#options.format||typeof parsed.ledgerId!=="string")throw new StoreFault("archive_corrupt","restore target is not this owner's ledger");marker=parsed;}
    else{if(readdirSync(root).some(n=>n!==".ensemble-writer.lock"&&n!==".ensemble-effect.lock"))throw new StoreFault("archive_corrupt","restore target is not empty");marker={format:"ensemble-ledger-owner/v1",ledgerId:`ledger-${randomUUID()}`,hostAuthorityId:this.#options.hostAuthorityId,stateFormat:this.#options.format};}
    this.#ledgerId=String(marker.ledgerId);const expectedIntent={actor:actorKey(actor),operationId:request.operationId,digest:hash};
    if(marker.restoring&&canonicalJson(marker.restoring)!==canonicalJson(expectedIntent))throw new StoreFault("operation_key_conflict","another restore owns the recovery journal");
    let head=existsSync(join(root,"HEAD"))?await this.#kernel.head(root,signal):null;
    if(!marker.restoring&&head){const current=await this.#at(head,signal);this.#authorize(actor,current.state,"write");const prior=await this.#operation(actor,request.operationId,head,signal);if(!prior||prior.digest!==hash)throw new StoreFault("revision_conflict","restore requires an empty independent ledger root");return success(await this.#answer(prior,head,signal));}
    const saveMarker=()=>{const temp=join(root,`.ledger-identity-${randomUUID()}`);durableFile(temp,bytes(marker));renameSync(temp,markerPath);syncDirectory(root);};
    marker.restoring=expectedIntent;saveMarker();
    if(!head){await this.#kernel.restoreBundle(request.bytes,root,signal);head=await this.#kernel.head(root,signal);}
    if(!head)throw new StoreFault("archive_corrupt","restored ledger has no authoritative head");
    const already=await this.#operation(actor,request.operationId,head,signal);
    let answer:LedgerAnswer<State>;
    if(already){if(already.digest!==hash)throw new StoreFault("operation_key_conflict","restore key names different content");answer=await this.#answer(already,head,signal);}
    else{
     if(head!==request.expectedHead)throw new StoreFault("archive_corrupt","backup differs from the verified expected ledger head");const old=await this.#at(head,signal);const sequence=old.sequence+1;const sanitized=unwrap(sanitize(old.state,{sequence,revision:head}));const state=unwrap(this.#options.decodeState(sanitized.state));this.#limit({revision:head,head_revision:head,sequence,state,result:sanitized.result,replayed:false});
     const entries=new Map((await this.#kernel.entries(root,head,signal)).filter(e=>!e.path.startsWith("receipts/")&&!e.path.startsWith("operations/")).map(e=>[e.path,e.oid]));const put=async(path:string,value:unknown)=>entries.set(path,await this.#kernel.hash(root,bytes(value),signal));
     const operation:Operation={format:"ensemble-ledger-receipt/v1",actor:actorKey(actor),operationId:request.operationId,digest:hash,sequence,result:sanitized.result};await put("ledger.json",{format:this.#options.format,sequence,state});await put(this.#receiptPath(actor,request.operationId),operation);await put(`operations/${String(sequence).padStart(12,"0")}.json`,operation);
     answer=await publishAtomic<LedgerAnswer<State>>({kernel:this.#kernel,root,expected:head,sequence,entries:[...entries].map(([path,oid])=>({path,oid})),signal,beforePublish:()=>this.#options.fault?.("before_publish"),afterPublish:()=>this.#options.fault?.("after_publish"),afterPublishIdentity:()=>this.#kernel.assertPublishIdentity(root),reconcile:async(head,probe)=>{const prior=await this.#operation(actor,request.operationId,head,probe);return prior?.digest===hash?this.#answer(prior,head,probe):undefined;},committed:(revision,head_revision)=>({revision,head_revision,sequence,state,result:sanitized.result,replayed:false})});
    }
    delete marker.restoring;saveMarker();await this.#options.fault?.("before_response");return success(answer);
   });
  }catch(e){return asFailure(e);}
 }
 /** Serialize intent/native effect/reconciliation across processes; nested state transactions use the writer lock. */
 async withEffectLock<T>(actor:Actor,signal:AbortSignal,run:(signal:AbortSignal)=>Promise<Result<T>>):Promise<Result<T>>{
  try{if(actor.kind!=="owner"||actor.channel!=="authenticated-remote"||actor.hostAuthorityId!==this.#options.hostAuthorityId)throw new StoreFault("not_authorized","environment effects require this Host owner");privateDirectory(this.#options.root);return await this.#kernel.withLock(this.#options.root,signal,run,"effect");}catch(e){return asFailure(e);}
 }
 async withOwner<T>(actor:Actor,signal:AbortSignal,run:(lease:LedgerLease<State>)=>Promise<Result<T>>):Promise<Result<T>>{try{if(actor.kind!=="owner")throw new StoreFault("not_authorized","owner management is required");return await this.#locked(actor,"write",signal,async(current,signal)=>run({root:this.#options.root,kernel:this.#kernel,signal,current}));}catch(e){return asFailure(e);}}
}
export function createVersionedLedger<State>(options:LedgerOptions<State>):VersionedLedger<State>{return new VersionedLedger(options);}
