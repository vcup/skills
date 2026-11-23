/** Shared publication protocol for project archives and the independent environment ledger. */
import { ArchiveKernel, StoreFault, type TreeEntry } from "./kernel.ts";
export interface AtomicPublication<T> {
 readonly kernel:ArchiveKernel;readonly root:string;readonly expected:string|null;readonly sequence:number;
 readonly entries:readonly TreeEntry[];readonly signal:AbortSignal;
 readonly beforePublish?:()=>void|Promise<void>;readonly afterPublish?:()=>void|Promise<void>;
 /** Reads the durable receipt under current authority; returns its original committed result. */
 readonly reconcile:(head:string,signal:AbortSignal)=>Promise<T|undefined>;
 /** Re-checks that the root still names the directory the commit was written into. Runs after the
  * publication attempt and BEFORE any path-based head read, so a swapped path can never be
  * reconciled as if it were this archive. Must throw to withhold a result. */
 readonly afterPublishIdentity?:()=>void;
 readonly committed:(revision:string,head:string)=>T;
}
/** Objects are prepared before this call; only a verified ref/receipt publishes an operation. */
export async function publishAtomic<T>(options:AtomicPublication<T>):Promise<T>{
 const {kernel,root,expected,signal}=options;
 const tree=await kernel.tree(root,options.entries,signal);
 const candidate=await kernel.commit(root,tree,expected,options.sequence,signal);
 await options.beforePublish?.();
 try{
  await kernel.publish(root,candidate,expected,signal);
  await options.afterPublish?.();
 }catch{/* Never infer no commit from a failed or lost publication acknowledgement. */}
 // The identity recheck runs outside the swallowed block and before any path-based read: once the
 // path names a different directory, reading "the head" would describe someone else's archive.
 options.afterPublishIdentity?.();
 try{
  const head=await kernel.head(root,signal);
  if(head===candidate)return options.committed(candidate,head);
 }catch{/* A failed confirmation is not evidence of failure; reconciliation below decides. */}
 const probe=AbortSignal.timeout(10_000);
 let head:string|null;
 try{
  head=await kernel.head(root,probe);
  if(head){const answer=await options.reconcile(head,probe);if(answer!==undefined)return answer;}
 }catch{throw new StoreFault("outcome_unknown","publication may have completed; look up the durable operation receipt before retrying");}
 if(head!==expected)throw new StoreFault("revision_conflict","archive head changed without this operation's receipt");
 // Head is unchanged, so this operation is definitely not published. Preserve that distinction.
 throw new StoreFault("storage_unavailable","publication did not move the authoritative ref; retry with the same operation key");
}
