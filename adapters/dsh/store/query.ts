/** Archive-owned fixed snapshots/cursors/byte pages; business query logic remains pure. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as C from "../../../modules/ensemble/contracts.ts";
import { decodeDomainRecord } from "../../../modules/ensemble/codec.ts";
import { mayReadObject } from "../../../modules/ensemble/policy.ts";
import { canonicalJson } from "../records.ts";
import { ArchiveKernel, StoreFault, decodeUtf8 } from "./kernel.ts";
const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const plain=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
interface Cursor {version:1;archiveId:string;actor:string;query:string;revision:string;epoch:number;offset:number;expires:number}
function queryDigest(query:C.Query):string{const {cursor:_c,revision:_r,...rest}=query as C.Query&{cursor?:string;revision?:string};return digest(canonicalJson(rest));}
export function makeCursor(secret:string,value:Cursor):string{const text=Buffer.from(canonicalJson(value)).toString("base64url");return `${text}.${createHmac("sha256",secret).update(text).digest("hex")}`;}
export function openCursor(secret:string,token:string,expected:Omit<Cursor,"version"|"revision"|"offset"|"expires">):Cursor{
 if(token.length>4096)throw new StoreFault("cursor_expired","cursor exceeds its byte budget");const [text,mac,...rest]=token.split(".");
 if(rest.length||!text||!mac||!/^[0-9a-f]{64}$/.test(mac))throw new StoreFault("cursor_expired","invalid cursor envelope");
 const want=createHmac("sha256",secret).update(text).digest();if(!timingSafeEqual(want,Buffer.from(mac,"hex")))throw new StoreFault("cursor_expired","cursor authentication failed");
 let value:unknown;try{const raw=Buffer.from(text,"base64url");if(raw.toString("base64url")!==text)throw new Error();value=JSON.parse(decodeUtf8(raw));}catch{throw new StoreFault("cursor_expired","invalid cursor bytes");}
 if(!plain(value)||Object.keys(value).some(k=>!["version","archiveId","actor","query","revision","epoch","offset","expires"].includes(k))||value.version!==1||value.archiveId!==expected.archiveId||value.actor!==expected.actor||value.query!==expected.query||value.epoch!==expected.epoch||typeof value.revision!=="string"||!/^[0-9a-f]{40}$/.test(value.revision)||!Number.isSafeInteger(value.offset)||Number(value.offset)<0||!Number.isSafeInteger(value.expires)||Number(value.expires)<=Date.now())throw new StoreFault("cursor_expired","cursor scope, authorization epoch or expiration changed");
 return value as unknown as Cursor;
}
export async function objectVersion(kernel:ArchiveKernel,root:string,snapshot:C.Snapshot,ref:C.ObjectRef,load:(revision:string,signal:AbortSignal)=>Promise<C.Snapshot>,signal:AbortSignal):Promise<C.DomainRecord|undefined>{
 const current=snapshot.objects.find(o=>o.id===ref.object_id&&o.object_revision===ref.object_revision);if(current)return current;
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ref.object_id)||!Number.isSafeInteger(ref.object_revision)||ref.object_revision<1)return undefined;
 const raw=await kernel.read(root,snapshot.revision,`versions/${ref.object_id}/${ref.object_revision}.json`,signal);
 if(raw){let value:unknown;try{value=JSON.parse(decodeUtf8(raw));}catch{throw new StoreFault("archive_corrupt","invalid historical record JSON");}const parsed=decodeDomainRecord(value);if(!parsed.ok||parsed.value.id!==ref.object_id||parsed.value.object_revision!==ref.object_revision||parsed.value.updated_sequence>snapshot.sequence)throw new StoreFault("archive_corrupt","version index does not match its record");return parsed.value;}
 // Early v2 snapshots may predate the rebuildable exact-version index.
 for(const revision of await kernel.history(root,snapshot.revision,signal)){if(revision===snapshot.revision)continue;const old=await load(revision,signal);if(old.archiveId!==snapshot.archiveId)break;const record=old.objects.find(o=>o.id===ref.object_id&&o.object_revision===ref.object_revision);if(record)return record;}
 return undefined;
}
export async function hydrateReferences(kernel:ArchiveKernel,root:string,snapshot:C.Snapshot,input:unknown,load:(revision:string,signal:AbortSignal)=>Promise<C.Snapshot>,signal:AbortSignal):Promise<C.Snapshot>{
 const refs=new Map<string,C.ObjectRef>();const walk=(value:unknown):void=>{if(Array.isArray(value)){for(const v of value)walk(v);return;}if(!plain(value))return;if(value.kind==="object"&&typeof value.object_id==="string"&&Number.isSafeInteger(value.object_revision)){const ref=value as unknown as C.ObjectRef;refs.set(`${ref.object_id}:${ref.object_revision}`,ref);}for(const v of Object.values(value))walk(v);};walk(snapshot.objects);walk(input);
 if(refs.size>10000)throw new StoreFault("budget_exceeded","exact-version reference scan exceeds its budget");
 const history:C.DomainRecord[]=[];for(const ref of refs.values()){if(snapshot.objects.some(o=>o.id===ref.object_id&&o.object_revision===ref.object_revision))continue;const object=await objectVersion(kernel,root,snapshot,ref,load,signal);if(object)history.push(object);}
 return {...snapshot,objectHistory:history};
}
export interface ArchiveQueryOptions {
 kernel:ArchiveKernel;root:string;secret:string;current:C.Snapshot;actor:C.Actor;query:C.Query;limits:C.ArchiveLimits;signal:AbortSignal;
 load:(revision:string,signal:AbortSignal)=>Promise<C.Snapshot>;
 receipt:(operationId:string,signal:AbortSignal)=>Promise<C.Receipt|undefined>;
 queryModule:(snapshot:C.Snapshot,query:C.Query,facts:C.QueryFacts)=>C.Result<C.ReadPage>;
 environment?:(actor:C.Actor,query:Extract<C.Query,{kind:"environment_preferences"}>,signal:AbortSignal)=>Promise<C.Result<C.EnvironmentPreferences>>;
}
export async function readArchiveQuery(o:ArchiveQueryOptions):Promise<C.Result<C.ReadPage>>{
 const {kernel,root,current,actor,query,signal}=o;const qHash=queryDigest(query);
 const scope={archiveId:current.archiveId,actor:C.actorKey(actor),query:qHash,epoch:current.policy.epoch};
 const cursor="cursor"in query&&query.cursor?openCursor(o.secret,query.cursor,scope):undefined;
 const explicit="revision"in query?query.revision:undefined;if(cursor&&explicit&&cursor.revision!==explicit)throw new StoreFault("cursor_expired","cursor revision differs from requested snapshot");
 const revision=cursor?.revision??explicit??current.revision;
 if(!await kernel.isAncestor(root,revision,current.revision,signal))throw new StoreFault("not_found","requested revision is not published archive history");
 const chosen=revision===current.revision?current:await o.load(revision,signal);if(chosen.archiveId!==current.archiveId)throw new StoreFault("not_found","revision belongs to a predecessor archive identity");
 const selected=await hydrateReferences(kernel,root,chosen,query,o.load,signal);
 const snapshot={...selected,policy:current.policy};
 const facts:C.QueryFacts={actor,now:Date.now(),offset:cursor?.offset??0,responseBytes:o.limits.response_bytes,pageItems:o.limits.page_items,nextCursor:offset=>makeCursor(o.secret,{version:1,...scope,revision,offset,expires:Date.now()+15*60*1000}),resolveObject:ref=>snapshot.objects.find(o=>o.id===ref.object_id&&o.object_revision===ref.object_revision)??snapshot.objectHistory?.find(o=>o.id===ref.object_id&&o.object_revision===ref.object_revision)};
 if(query.kind==="receipt"){const receipt=await o.receipt(query.operation_id,signal);if(!receipt)throw new StoreFault("not_found","operation receipt is absent");return o.queryModule(snapshot,query,{...facts,receipt});}
 if(query.kind==="environment_preferences"){if(!o.environment)throw new StoreFault("not_authorized","separate environment read capability is not mounted");const preferences=await o.environment(actor,query,signal);if(!preferences.ok)return preferences;return o.queryModule(snapshot,query,{...facts,environment:preferences.value});}
 if(query.kind==="history"){
  const target="object_id"in query?query.object_id:query.invocation_id;const object=current.objects.find(r=>r.id===target);if(!object||!mayReadObject(current,actor,object,Date.now()))throw new StoreFault("not_found","history target is not authorized");
  const visibleIds=new Set(snapshot.objects.filter(r=>mayReadObject(current,actor,r,Date.now())&&("object_id"in query?r.id===target:r.id===target||"invocation_id"in r.body&&r.body.invocation_id===target)).map(r=>r.id));
  const history:C.HistoryEntry[]=[];
  for(const commit of await kernel.history(root,revision,signal)){const s=await o.load(commit,signal);if(s.archiveId!==current.archiveId)break;const raw=await kernel.read(root,commit,`operations/${String(s.sequence).padStart(12,"0")}.json`,signal);if(!raw)throw new StoreFault("archive_corrupt","published operation record is missing");const op=JSON.parse(decodeUtf8(raw)) as {operationId:string;sequence:number;action:string;actor:C.ActorIdentity;changed:readonly {id:string;object_revision:number}[]};const changed=op.changed.filter(r=>visibleIds.has(r.id)).map(r=>({kind:"object" as const,object_id:r.id,object_revision:r.object_revision}));if(changed.length)history.push({committed_revision:commit,operation_id:op.operationId,sequence:op.sequence,action:op.action,actor:op.actor,changed});}
  return o.queryModule(snapshot,query,{...facts,history});
 }
 if((query.kind==="artifact"||query.kind==="object")&&query.content_mode&&query.content_mode!=="summary"){
  let record=snapshot.objects.find(r=>r.id===query.object_id);if(query.object_revision!==undefined)record=await objectVersion(kernel,root,snapshot,{kind:"object",object_id:query.object_id,object_revision:query.object_revision},o.load,signal);
  if(record?.kind==="artifact"){
   if(!mayReadObject(current,actor,record,Date.now()))throw new StoreFault("not_found","artifact is not currently authorized");const descriptor=record.body.content;
   const bytes=await kernel.read(root,revision,`content/${descriptor.digest}`,signal,o.limits.artifact_bytes);if(!bytes||bytes.length!==descriptor.bytes||digest(bytes)!==descriptor.digest)throw new StoreFault("archive_corrupt","original artifact bytes/digest are inconsistent");
   const offset=facts.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length)throw new StoreFault("cursor_expired","artifact cursor is outside original content");
   if(query.content_mode==="text"){try{decodeUtf8(bytes);}catch{throw new StoreFault("invalid_input","binary content cannot be read as UTF-8; request bytes");}if(offset<bytes.length&&(bytes[offset]!&0xc0)===0x80)throw new StoreFault("cursor_expired","text cursor splits a UTF-8 character");}
   let low=offset,high=Math.min(bytes.length,offset+o.limits.response_bytes),best:C.Result<C.ReadPage>|undefined;
   while(low<=high){const midpoint=Math.floor((low+high)/2);let end=midpoint;if(query.content_mode==="text")while(end>offset&&end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;if(end===offset&&offset<bytes.length){low=midpoint+1;continue;}
    const segment=bytes.subarray(offset,end);const content:C.ArtifactPage={...descriptor,object_ref:{kind:"object",object_id:record.id,object_revision:record.object_revision},offset,...(end<bytes.length?{next_offset:end}:{}),...(query.content_mode==="text"?{text:decodeUtf8(segment)}:{base64:Buffer.from(segment).toString("base64")})};
    const result=o.queryModule(snapshot,query,{...facts,content,resolveObject:ref=>ref.object_id===record!.id&&ref.object_revision===record!.object_revision?record:facts.resolveObject?.(ref)});
    if(result.ok){best=result;low=midpoint+1;}else if(result.error.code==="budget_exceeded")high=midpoint-1;else return result;
   }
   return best??C.failure("budget_exceeded","response cannot contain one complete content byte/character and metadata");
  }
 }
 return o.queryModule(snapshot,query,facts);
}
