import { describe, test, expect } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ArchiveKernel, StoreFault, privateDirectory } from "./kernel.ts";
const codeOf=async(promise:Promise<unknown>):Promise<string>=>{try{await promise;}catch(error){if(error instanceof StoreFault)return error.code;throw error;}return "no-error";};
const install=process.env.DSH_ARCHIVE_SEAM_INSTALL;
const native=install?describe:describe.skip;
async function kernel(){
  const root=resolve(install!);
  const {Context}=await import(join(root,"node_modules/@deepseek-ai/cordis/lib/index.js"));
  const {LocalSubprocessRuntime}=await import(join(root,"node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js"));
  const {LocalSandboxProvider}=await import(join(root,"node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js"));
  return new ArchiveKernel({context:new Context(),factories:{subprocess:s=>new LocalSubprocessRuntime(s),sandbox:s=>new LocalSandboxProvider(s,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000})}});
}
function fixture(){const base=resolve(".scratch/production-cycle");mkdirSync(base,{recursive:true});return mkdtempSync(join(base,"runtime-store-"));}
native("archive kernel / real published local providers on persistent project mount",()=>{
 test("raw binary roundtrip, commit CAS, real fsync and corruption is not absent",async()=>{
  const k=await kernel(),root=fixture(),signal=new AbortController().signal;privateDirectory(root);
  await k.withLock(root,signal,async()=>{
   await k.initialize(root,signal);expect(await k.head(root,signal)).toBeNull();
   const bytes=new Uint8Array([0,255,128,10,13,0,200]);const oid=await k.hash(root,bytes,signal);
   const tree=await k.tree(root,[{path:"content/raw",oid}],signal);const commit=await k.commit(root,tree,null,1,signal);
   await k.publish(root,commit,null,signal);expect(await k.head(root,signal)).toBe(commit);
   expect(await k.read(root,commit,"content/raw",signal)).toEqual(bytes);
   await k.fsck(root,signal);
   await expect(k.publish(root,commit,null,signal)).rejects.toThrow();
  });
  writeFileSync(join(root,"config"),"not a git config\n");await expect(k.head(root,signal)).rejects.toThrow();k.dispose();
 },15000);
 test("independent kernel instances serialize through the OS lock",async()=>{
  const a=await kernel(),b=await kernel(),root=fixture(),signal=new AbortController().signal;privateDirectory(root);
  const order:string[]=[];let release!:()=>void;const held=new Promise<void>(r=>release=r);let acquired!:()=>void;const ready=new Promise<void>(r=>acquired=r);
  const first=a.withLock(root,signal,async()=>{order.push("a-in");acquired();await held;order.push("a-out");});
  await ready;const second=b.withLock(root,signal,async()=>{order.push("b-in");});release();await Promise.all([first,second]);expect(order).toEqual(["a-in","a-out","b-in"]);a.dispose();b.dispose();
 },15000);
});

native("archive kernel / directory identity and cross-process exclusion",()=>{
 test("a root replaced by a symlink mid-lock is refused before any child writes",async()=>{
  const k=await kernel(),root=fixture(),signal=new AbortController().signal;privateDirectory(root);
  const base=dirname(root),source=join(base,`source-${Date.now()}`);mkdirSync(source,{mode:0o700});writeFileSync(join(source,"keep.txt"),"original");
  await k.withLock(root,signal,async(inner)=>{
   await k.initialize(root,inner);
   const oid=await k.hash(root,new TextEncoder().encode("payload"),inner);
   const tree=await k.tree(root,[{path:"records/x.json",oid}],inner);
   const commit=await k.commit(root,tree,null,1,inner);await k.publish(root,commit,null,inner);
   expect(await k.head(root,inner)).toBe(commit);
   renameSync(root,`${root}-moved`);symlinkSync(source,root,"dir");
   await expect(k.hash(root,new TextEncoder().encode("poison"),inner)).rejects.toThrow(/identity changed/);
   expect(readdirSync(source)).toEqual(["keep.txt"]);
   expect(readFileSync(join(source,"keep.txt"),"utf8")).toBe("original");
   unlinkSync(root);renameSync(`${root}-moved`,root);
  });
  k.dispose();
 },20000);
 test("distinct OS processes serialize through the real flock, not a kernel instance",async()=>{
  const root=fixture();privateDirectory(root);const installRoot=resolve(install!);
  const script=join(root,"..",`race-${Date.now()}.ts`);
  writeFileSync(script,[
   `import { ArchiveKernel, privateDirectory } from ${JSON.stringify(join(process.cwd(),"adapters/dsh/store/kernel.ts"))};`,
   `const [installRoot,root,label]=process.argv.slice(2);const r=installRoot;`,
   `const load=(n)=>import(new URL("node_modules/@deepseek-ai/"+n+"/lib/index.js","file://"+r+"/").href);`,
   `const [{Context},{LocalSubprocessRuntime},{LocalSandboxProvider}]=await Promise.all([load("cordis"),load("dsh-subprocess-local"),load("dsh-sandbox-local")]);`,
   `const k=new ArchiveKernel({context:new Context(),factories:{subprocess:c=>new LocalSubprocessRuntime(c),sandbox:c=>new LocalSandboxProvider(c,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000})}});`,
   `const fs=await import("node:fs");`,
   `await k.withLock(root,new AbortController().signal,async()=>{fs.appendFileSync(root+"/order.log",label+"-in\\n");await new Promise(r=>setTimeout(r,150));fs.appendFileSync(root+"/order.log",label+"-out\\n");});`,
   `k.dispose();`,
  ].join("\n"));
  const spawn=(label:string)=>Bun.spawn([process.execPath,script,installRoot,root,label],{stdout:"pipe",stderr:"pipe"});
  const a=spawn("a"),b=spawn("b");
  const [ea,eb]=await Promise.all([a.exited,b.exited]);
  const errA=await new Response(a.stderr).text(),errB=await new Response(b.stderr).text();
  expect({ea,eb,errA:errA.slice(0,300),errB:errB.slice(0,300)}).toEqual({ea:0,eb:0,errA:"",errB:""});
  const order=readFileSync(join(root,"order.log"),"utf8").trim().split("\n");
  // Serialization means the two critical sections never interleave, whichever process won.
  expect(order).toHaveLength(4);
  const [first,second,third,fourth]=order as [string,string,string,string];
  // Whoever entered first must also leave first, and the second entrant must be the other process.
  expect(first.endsWith("-in")).toBe(true);
  expect(second).toBe(`${first.slice(0,-3)}-out`);
  expect(third.endsWith("-in")).toBe(true);
  expect(fourth).toBe(`${third.slice(0,-3)}-out`);
  expect(first.slice(0,1)).not.toBe(third.slice(0,1));
 },30000);
});

native("lock-end identity check keeps both sides of the contract",()=>{
 test("deliberate self-deletion inside the lock is allowed, but a swap to a different directory is refused",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  // Side 1, the legitimate case: a retirement deletes its own locked root, exactly as disposal does.
  const retiring=fixture();privateDirectory(retiring);
  await k.withLock(retiring,signal,async(inner)=>{
   await k.initialize(retiring,inner);
   rmSync(retiring,{recursive:true,force:false});
   expect(()=>lstatSync(retiring)).toThrow();
  });
  // Side 2, the attack: the path is replaced by a different directory and must still be refused.
  const base=fixture(),swapped=join(base,"archive");mkdirSync(swapped,{mode:0o700});
  await expect(k.withLock(swapped,signal,async(inner)=>{
   await k.initialize(swapped,inner);
   renameSync(swapped,`${swapped}-moved`);mkdirSync(swapped,{mode:0o700});
  })).rejects.toThrow(/identity changed/);
  k.dispose();
 },20000);
 test("a directory that reappears at the same path after deletion is not accepted as the old one",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  const base=fixture(),target=join(base,"archive");mkdirSync(target,{mode:0o700});
  await expect(k.withLock(target,signal,async()=>{
   renameSync(target,`${target}-moved`);mkdirSync(target,{mode:0o700});  // same path, new inode
  })).rejects.toThrow(/identity changed/);
  k.dispose();
 },20000);
});

native("descriptor pin closes the check-to-spawn substitution",()=>{
 /** The real attack through the module's own spawn path: swap the archive root for a symlink to a
  * victim directory that the sandbox would otherwise consider writable, then attempt a write.
  * The confined child must write through the pinned descriptor, never into the victim. */
 test("a mid-transaction symlink swap cannot redirect a write into the victim directory",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  const base=fixture();
  const victim=join(base,"victim");mkdirSync(victim,{mode:0o700});writeFileSync(join(victim,"keep.txt"),"VICTIM");
  const archive=join(base,"archive");mkdirSync(archive,{mode:0o700});privateDirectory(archive);
  await k.withLock(archive,signal,async(inner)=>{
   // Baseline: ordinary writes work through the pin, so a later refusal is not "everything fails".
   await k.initialize(archive,inner);
   expect(await k.hash(archive,new TextEncoder().encode("first"),inner)).toMatch(/^[0-9a-f]{40}$/);
   // Swap: the path now names the victim, the pinned descriptor still names the archive inode.
   renameSync(archive,`${archive}-moved`);symlinkSync(victim,archive,"dir");
   await expect(k.hash(archive,new TextEncoder().encode("poison"),inner)).rejects.toThrow(/identity changed/);
   expect(readdirSync(victim)).toEqual(["keep.txt"]);
   expect(readFileSync(join(victim,"keep.txt"),"utf8")).toBe("VICTIM");
   unlinkSync(archive);renameSync(`${archive}-moved`,archive);
  });
  k.dispose();
 },25000);
 /** Same pathname, different real directory (not a symlink): the pin must still refuse, and the
  * decoy that inherited the path must never receive an archive write. */
 test("writes stay confined to the pinned inode when the path is reused by another real directory",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  const base=fixture();
  const archive=join(base,"archive");mkdirSync(archive,{mode:0o700});privateDirectory(archive);
  await expect(k.withLock(archive,signal,async(inner)=>{
   await k.initialize(archive,inner);
   renameSync(archive,`${archive}-moved`);mkdirSync(archive,{mode:0o700});
   await k.hash(archive,new TextEncoder().encode("poison"),inner);
  })).rejects.toThrow(/identity changed/);
  expect(readdirSync(archive)).toEqual([]);
  k.dispose();
 },25000);
});

native("published ref inspection distinguishes absent from corrupt",()=>{
 /** `for-each-ref` exits 0 even for a broken ref, and its stderr wording is not an interface.
  * Absence must be positively established; every other state is corruption. */
 test("a ref directory placeholder is corruption, not absence",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  const base=fixture(),root=join(base,"archive");mkdirSync(root,{mode:0o700});privateDirectory(root);
  await k.withLock(root,signal,async(inner)=>{
   await k.initialize(root,inner);
   expect(await k.head(root,inner)).toBeNull();           // genuinely absent
   // A directory at the ref path is indistinguishable from absent via for-each-ref/rev-parse.
   mkdirSync(join(root,"refs/ensemble/main"),{recursive:true});
   expect(await codeOf(k.head(root,inner))).toBe("archive_corrupt");
   rmSync(join(root,"refs/ensemble/main"),{recursive:true,force:true});
  });
  k.dispose();
 },25000);
 test("a ref pointing at a missing object or a non-commit is corruption, not absence",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  const base=fixture(),root=join(base,"archive");mkdirSync(root,{mode:0o700});privateDirectory(root);
  await k.withLock(root,signal,async(inner)=>{
   await k.initialize(root,inner);
   mkdirSync(join(root,"refs/ensemble"),{recursive:true});
   // Valid-shaped oid with no object behind it: for-each-ref reports it happily.
   writeFileSync(join(root,"refs/ensemble/main"),"1".repeat(40)+"\n");
   // A dangling object is corruption, not a storage outage: nothing may retry into "absent".
   expect(await codeOf(k.head(root,inner))).toBe("archive_corrupt");
   // A real object that is not a commit.
   const blob=await k.hash(root,new TextEncoder().encode("blob"),inner);
   writeFileSync(join(root,"refs/ensemble/main"),`${blob}\n`);
   expect(await codeOf(k.head(root,inner))).toBe("archive_corrupt");
  });
  k.dispose();
 },25000);
 test("a leftover update-ref lock makes the head unknown rather than absent",async()=>{
  const k=await kernel(),signal=new AbortController().signal;
  const base=fixture(),root=join(base,"archive");mkdirSync(root,{mode:0o700});privateDirectory(root);
  await k.withLock(root,signal,async(inner)=>{
   await k.initialize(root,inner);
   expect(await k.head(root,inner)).toBeNull();
   // An in-flight or interrupted update-ref leaves this, so absence is not provable.
   mkdirSync(join(root,"refs/ensemble"),{recursive:true});
   writeFileSync(join(root,"refs/ensemble/main.lock"),"");
   // Unknown is not absent: the caller must reconcile rather than conclude the archive is empty.
   expect(await codeOf(k.head(root,inner))).toBe("outcome_unknown");
  });
  k.dispose();
 },25000);
});
