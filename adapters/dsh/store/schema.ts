/** Closed persisted metadata. Corruption is refused before any authorization or replay uses it.
 * The same declaration validates creation, read-back, replay and recovery: a stored value this
 * file cannot decode is `archive_corrupt` - never silently absent, never a partially trusted object.
 */
import * as C from "../../../modules/ensemble/contracts.ts";
import { decodeSnapshot } from "../../../modules/ensemble/codec.ts";
import * as V from "../../../modules/ensemble/validation.ts";
import { StoreFault } from "./kernel.ts";
const id=V.str(1,128,"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"),text=V.str(),oid=V.str(40,40,"^[0-9a-f]{40}$"),sha=V.str(64,64,"^[0-9a-f]{64}$"),positive=V.integer(1);
// Domain mapping keys are plain keys or qualified keys such as `criterion:source`.
const mapKey=V.str(1,160,"^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$");
const identity=V.union(V.object({kind:V.literal("owner"),ownerId:text,hostAuthorityId:text}),V.object({kind:V.literal("session"),sessionId:text,rootSessionId:text}));
const actor=V.union(V.object({kind:V.literal("owner"),ownerId:text,hostAuthorityId:text,channel:V.literal("authenticated-remote")}),V.object({kind:V.literal("session"),sessionId:text,rootSessionId:text,workspaceRef:text,callId:text}));
const limits=V.object({inline_input_bytes:V.integer(1,1073741824),response_bytes:V.integer(1,1073741824),artifact_bytes:V.integer(1,1073741824),upload_chunk_bytes:V.integer(1,1073741824),upload_total_bytes:V.integer(1,1073741824),concurrent_uploads:V.integer(1,1024),page_items:V.integer(1,100)});
export const entrySchema=V.object({archiveId:id,projectId:id,title:text,readOnly:V.bool,limits},{directoryId:id,storagePath:text});
const view=V.union(V.object({kind:V.literal("checkpoint"),invocation_id:id}),V.object({kind:V.literal("reading"),domain_id:id}),V.object({kind:V.literal("overview")}),V.object({kind:V.literal("object"),object_id:id}));
const changed=V.array(V.object({id,object_revision:positive}));
const activationResult=V.object({archiveId:id,projectId:id,revision:oid,readOnly:V.bool,registered:V.bool});
const disposal=V.object({head:oid,completed:V.bool});
const plain=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function error(message:string):never{throw new StoreFault("archive_corrupt",message);}
function schema<T>(value:unknown,shape:V.Schema):T {const result=V.decode<T>(value,shape,{},64*1024*1024);if(!result.ok)error(result.error.field?`${result.error.field}: ${result.error.message}`:result.error.message);return result.value;}
function fields(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{if(!plain(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))error("stored metadata has missing or unknown fields");return value;}
function list(value:unknown):unknown[]{if(!Array.isArray(value)||value.length>100000)error("stored metadata list is invalid or exceeds budget");return value;}
function uniqueChanged(rows:unknown,description:string):void{const items=rows as {id:string}[];if(new Set(items.map(v=>v.id)).size!==items.length)error(`${description} changed object ids are duplicated`);}
export function validateLimits(value:unknown):void {const limitsValue=schema<C.ArchiveLimits>(value,limits);if(limitsValue.upload_chunk_bytes>limitsValue.artifact_bytes||limitsValue.artifact_bytes>limitsValue.upload_total_bytes)error("stored archive limits are inconsistent");}
export function validateEntry(value:unknown):void{const e=schema<{limits:C.ArchiveLimits}>(value,entrySchema);validateLimits(e.limits);}
/** `C.SemanticResult` with a closed field set; `ids` values are archive object ids. */
function semanticResult(value:unknown):C.SemanticResult{
 const result=fields(value,[],["id","object_revision","invocation_id","ids","status","message"]);const {ids,...rest}=result;
 schema(rest,V.object({},{id,object_revision:positive,invocation_id:id,status:text,message:text}));
 if(ids!==undefined){if(!plain(ids)||Object.keys(ids).length>10000)error("semantic ids map is invalid");for(const [key,value]of Object.entries(ids)){schema(key,mapKey);schema(value,id);}}
 return result as unknown as C.SemanticResult;
}
export interface StoredReceipt {format:"ensemble-receipt/v2";actor:C.ActorIdentity;operationId:string;digest:string;sequence:number;action:string;changed:readonly {id:string;object_revision:number}[];documents:readonly C.ViewSelection[];result:C.SemanticResult}
/** The persisted operation record and per-actor receipt. Written by the publisher, replayed verbatim. */
export function decodeStoredReceipt(value:unknown):StoredReceipt{
 const r=fields(value,["format","actor","operationId","digest","sequence","action","changed","documents","result"]);
 const {result:_result,...rest}=r;
 schema(rest,V.object({format:V.literal("ensemble-receipt/v2"),actor:identity,operationId:V.str(1,128),digest:sha,sequence:positive,action:V.str(1,128),changed,documents:V.array(view)}));
 semanticResult(r.result);uniqueChanged(r.changed,"receipt");
 return r as unknown as StoredReceipt;
}
/** A committed receipt stored inside a recovery journal; the same shape replay answers with. */
export function decodeCommittedReceipt(value:unknown):C.Receipt{
 const r=fields(value,["status","operation_id","committed_revision","head_revision","sequence","changed","documents","result"]);
 const {result:_result,...rest}=r;
 schema(rest,V.object({status:V.literal("committed"),operation_id:V.str(1,128),committed_revision:oid,head_revision:oid,sequence:positive,changed,documents:V.array(view)}));
 semanticResult(r.result);uniqueChanged(r.changed,"committed receipt");
 return r as unknown as C.Receipt;
}
function pending(value:unknown):void {const p=fields(value,["key","digest","entry","snapshot","actor","operationId"]);const {entry,snapshot,...rest}=p;schema(rest,V.object({key:sha,digest:sha,actor,operationId:V.str(1,128)}));validateEntry(entry);const decoded=decodeSnapshot(snapshot);if(!decoded.ok)error(decoded.error.message);if(decoded.value.archiveId!==(entry as {archiveId:string}).archiveId||decoded.value.projectId!==(entry as {projectId:string}).projectId)error("initialization journal identity differs");}
function activation(value:unknown):void{const a=fields(value,["key","actor","operationId","digest","entry","sourceProjectId","sourceArchiveId","sourceHead"],["businessDigest","retiredRoot","retiredHead","disposal","result","receipt"]);const {entry,receipt,result:activationOutcome,...rest}=a;schema(rest,V.object({key:sha,actor:text,operationId:V.str(1,128),digest:sha,sourceProjectId:id,sourceArchiveId:id,sourceHead:oid},{businessDigest:sha,retiredRoot:text,retiredHead:oid,disposal,result:activationResult}));validateEntry(entry);if(receipt!==undefined)decodeCommittedReceipt(receipt);if(activationOutcome!==undefined)schema(activationOutcome,activationResult);}
function relocation(value:unknown):void{const r=fields(value,["key","digest","entry","destination","oldHead"],["disposal","receipt","result"]);const {entry,receipt,...rest}=r;schema(rest,V.object({key:sha,digest:sha,destination:text,oldHead:oid},{disposal,result:activationResult}));validateEntry(entry);if(receipt!==undefined)decodeCommittedReceipt(receipt);}
export function validateRegistry(value:unknown,hostAuthorityId:string):void{
 const r=fields(value,["format","hostAuthorityId","secret","entries","pending"],["activations","relocations","retiredArchiveIds"]);schema({format:r.format,hostAuthorityId:r.hostAuthorityId,secret:r.secret},V.object({format:V.literal("ensemble-registry/v2"),hostAuthorityId:V.literal(hostAuthorityId),secret:sha}));
 const entries=list(r.entries);for(const e of entries)validateEntry(e);for(const p of list(r.pending))pending(p);if(r.activations!==undefined)for(const a of list(r.activations))activation(a);if(r.relocations!==undefined)for(const m of list(r.relocations))relocation(m);if(r.retiredArchiveIds!==undefined)schema(r.retiredArchiveIds,V.array(id));
 const unique=(items:unknown[],key:string)=>new Set(items.map(v=>(v as Record<string,unknown>)[key])).size===items.length;
 if(!unique(entries,"archiveId")||!unique(entries,"projectId")||!unique(list(r.pending),"key")||r.activations&&!unique(list(r.activations),"key")||r.relocations&&!unique(list(r.relocations),"key"))error("registry identities or journal keys are duplicated");
}

/** Independent environment ledger: own lineage, identical closed-persistence rule. */
export interface LedgerReceipt {format:"ensemble-ledger-receipt/v1";actor:string;operationId:string;digest:string;sequence:number;result:unknown}
function ledgerReceiptFields(value:unknown):LedgerReceipt{
 const r=fields(value,["format","actor","operationId","digest","sequence","result"]);
 if(r.format!=="ensemble-ledger-receipt/v1"||typeof r.actor!=="string"||typeof r.operationId!=="string"||typeof r.digest!=="string"||!/^[0-9a-f]{64}$/.test(r.digest)||!Number.isSafeInteger(r.sequence)||Number(r.sequence)<1)error("ledger receipt envelope is invalid");
 const bytes=new TextEncoder().encode(JSON.stringify(r.result)).length;if(bytes>8*1024*1024)error("ledger receipt result exceeds its budget");
 return r as unknown as LedgerReceipt;
}
export function decodeLedgerReceipt(value:unknown,expectedActor:string,expectedOperationId:string):LedgerReceipt{
 const r=ledgerReceiptFields(value);if(r.actor!==expectedActor)error("stored ledger receipt belongs to a different actor");if(r.operationId!==expectedOperationId)error("stored ledger receipt belongs to a different operation key");return r;
}
export interface LedgerOperationRecord extends LedgerReceipt {identity:C.ActorIdentity}
export function decodeLedgerOperationRecord(value:unknown):LedgerOperationRecord{
 const r=fields(value,["format","actor","operationId","digest","sequence","result","identity"]);
 const receipt=ledgerReceiptFields({format:r.format,actor:r.actor,operationId:r.operationId,digest:r.digest,sequence:r.sequence,result:r.result});
 return {...receipt,identity:schema<C.ActorIdentity>(r.identity,identity)};
}
export function decodeLedgerState(value:unknown,format:string):{sequence:number;state:unknown}{
 const r=fields(value,["format","sequence","state"]);schema({format:r.format,sequence:r.sequence},V.object({format:V.literal(format),sequence:positive}));return {sequence:Number(r.sequence),state:r.state};
}
export interface LedgerMarker {format:"ensemble-ledger-owner/v1";ledgerId:string;hostAuthorityId:string;stateFormat:string;restoring?:unknown}
export function decodeLedgerMarker(value:unknown,hostAuthorityId:string,format:string):LedgerMarker{
 const r=fields(value,["format","ledgerId","hostAuthorityId","stateFormat"],["restoring"]);
 schema({format:r.format,ledgerId:r.ledgerId,hostAuthorityId:r.hostAuthorityId,stateFormat:r.stateFormat},V.object({format:V.literal("ensemble-ledger-owner/v1"),ledgerId:V.str(5,64,"^ledger-[a-z0-9-]+$"),hostAuthorityId:V.literal(hostAuthorityId),stateFormat:V.literal(format)}));
 if(r.restoring!==undefined){if(!plain(r.restoring))error("ledger recovery journal is invalid");const {actor,operationId,digest}=r.restoring as Record<string,unknown>;if(typeof actor!=="string"||typeof operationId!=="string"||typeof digest!=="string"||!/^[0-9a-f]{64}$/.test(digest))error("ledger recovery journal intent is invalid");}
 return r as unknown as LedgerMarker;
}
