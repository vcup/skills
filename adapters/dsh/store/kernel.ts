/** Byte-preserving Host-local Git and OS locks. Callers never supply argv. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { buildIsolatedGroup, gitEnvironment, type IsolatedContext, type ProviderFactories, type SandboxLike } from "../archive.ts";
import { failure, type FailureCode, type Result } from "../../../modules/ensemble/contracts.ts";

export const MAIN_REF = "refs/ensemble/main";
const OID = /^[0-9a-f]{40}$/;
const LOCK_PROGRAM = "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
const enc = new TextEncoder();
const strictText = new TextDecoder("utf-8", { fatal: true });
export class StoreFault extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); this.name = "StoreFault"; }
}
export function asFailure(error: unknown): Result<never> {
  return error instanceof StoreFault ? failure(error.code, error.message) : failure("storage_unavailable", error instanceof Error ? error.message : "storage operation failed");
}
export function assertOid(value: string): string {
  if (!OID.test(value)) throw new StoreFault("invalid_input", "expected a concrete SHA-1 commit/object identity");
  return value;
}
export function safeTreePath(path: string): string {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split("/").some(x => x === "" || x === "." || x === "..")) throw new StoreFault("invalid_input", "invalid internal archive path");
  return path;
}
export function decodeUtf8(bytes: Uint8Array): string {
  try { return strictText.decode(bytes); } catch { throw new StoreFault("archive_corrupt", "stored text is not valid UTF-8"); }
}
export function privateDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new StoreFault("invalid_input", "deployment storage root must be canonical and absolute");
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new StoreFault("storage_unavailable", "storage directory must be owned by this user, canonical, and private (0700)");
}
export function durableFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
interface ProcessHandle {
  readonly stdin?: Writable; readonly stdout?: Readable; readonly stderr?: Readable;
  readonly done: Promise<{ exitCode: number | null; signal?: string | null }>;
  terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean>;
}
interface ByteProcesses {
  spawn(spec: { argv: readonly string[]; cwd: string; stdio: { stdin: "ignore"|"pipe"; stdout:"pipe"; stderr:"pipe" }; graceMs:number; signal?:AbortSignal; env:Record<string,string|undefined> }): ProcessHandle;
}
export interface ProcessResult { readonly code:number|null; readonly stdout:Uint8Array; readonly stderr:string }
export interface KernelOptions { readonly context:IsolatedContext; readonly factories:ProviderFactories; readonly deadlineMs?:number; readonly outputBytes?:number;readonly backupBytes?:number }
export interface TreeEntry { readonly path:string; readonly oid:string }

export class ArchiveKernel {
  readonly #sandbox: SandboxLike;
  readonly #processes: ByteProcesses;
  readonly #deadlineMs:number;
  readonly #outputBytes:number;
  readonly #backupBytes:number;
  readonly #lifetime = new AbortController();
  /** Open directory handles pinned for the duration of a lock. The descriptor - not the path - is
   * what children are confined to, so a path swapped mid-lock cannot redirect a write. */
  readonly #pins = new Map<string,{dev:number;ino:number;fd:number;pinPath:string;depth:number}>();
  constructor(options:KernelOptions) {
    const group=buildIsolatedGroup(options.context,options.factories);
    this.#sandbox=group.sandbox;
    this.#processes=group.subprocess as unknown as ByteProcesses;
    this.#deadlineMs=options.deadlineMs??60_000;
    this.#outputBytes=options.outputBytes??64*1024*1024;this.#backupBytes=options.backupBytes??512*1024*1024;
  }
  /** Pins the canonical private directory a lock is held on: the handle is opened O_NOFOLLOW so the
   * identity is captured once, and every later child is confined through that exact inode. */
  #pin(root:string):void {
    const existing=this.#pins.get(root);if(existing){existing.depth+=1;return;}
    const st=lstatSync(root);
    if(st.isSymbolicLink()||!st.isDirectory()||realpathSync(root)!==root||(st.mode&0o077)!==0) throw new StoreFault("not_authorized","archive root must be a canonical private directory before locking");
    const fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    let opened;try{opened=fstatSync(fd);}catch(error){closeSync(fd);throw error;}
    // The descriptor must still name the directory just inspected, or we pinned the wrong thing.
    if(opened.dev!==st.dev||opened.ino!==st.ino){closeSync(fd);throw new StoreFault("not_authorized","archive root changed while it was being pinned");}
    this.#pins.set(root,{dev:st.dev,ino:st.ino,fd,pinPath:`/proc/self/fd/${fd}`,depth:1});
  }
  #unpin(root:string):void {
    const pinned=this.#pins.get(root);if(!pinned)return;
    pinned.depth-=1;if(pinned.depth>0)return;
    this.#pins.delete(root);
    try{closeSync(pinned.fd);}catch{/* A released descriptor never fails a committed transaction. */}
  }
  /** The descriptor-backed location a child is confined to. Always preferred over the caller's path. */
  #pinned(root:string):string {const pinned=this.#pins.get(root);return pinned?pinned.pinPath:root;}
  /** Recheck used by the publication protocol after update-ref: the caller's path must still name the
   * inode this transaction wrote into. After a swap the bytes sit in a directory the caller can no
   * longer reach by name, so the outcome cannot be stated and must never be reported as committed. */
  assertPublishIdentity(root:string):void {
    try{this.#assertPin(root);}
    catch{
      throw new StoreFault("outcome_unknown","archive path identity changed during publication; the commit went to the pinned directory and receipt reconciliation by path cannot recover it; diagnose and retire this location");
    }
  }
  /** Strict: the path must still name the pinned directory, so a child never writes elsewhere.
   * Relaxed: the path may be gone (a deliberate retirement deletes it inside its own lock) but it
   * must never name a different directory - that swap is exactly what this guard refuses. */
  #assertPin(root:string,relaxed=false):void {
    const pinned=this.#pins.get(root);if(pinned===undefined)return;
    let st;try{st=lstatSync(root);}catch(error){
      if(relaxed&&(error as NodeJS.ErrnoException).code==="ENOENT")return;
      throw new StoreFault("not_authorized","archive root disappeared while its lock was held");
    }
    if(st.isSymbolicLink()||!st.isDirectory()||st.dev!==pinned.dev||st.ino!==pinned.ino) throw new StoreFault("not_authorized","archive root identity changed while its lock was held; refusing to write through a replaced directory");
  }
  dispose():void { this.#lifetime.abort(new Error("archive plugin unloaded")); }
  #signal(signal:AbortSignal):AbortSignal { return AbortSignal.any([signal,this.#lifetime.signal,AbortSignal.timeout(this.#deadlineMs)]); }
  /** The only place an archive child is created. Both the sandbox rule and the child's cwd name the
   * pinned descriptor, so a path swapped after the identity check still resolves to the original
   * directory; the identity check additionally refuses such a swap outright. */
  async #spawn(root:string,argv:readonly string[],signal:AbortSignal,extraRoots:readonly string[]=[]):Promise<ProcessHandle> {
    signal.throwIfAborted();this.#assertPin(root);
    const pinned=this.#pinned(root);
    try {
      // Additional writable roots are destinations this module does not own (a replica location),
      // and the sandbox only accepts a physical path there - a descriptor is rejected as symlinked.
      // The descriptor is therefore used for the owned root (workspaceRoot/cwd) only; the extra root
      // keeps its canonical path and is re-validated here.
      const extraPaths:string[]=[];
      for(const extra of extraRoots) {
        if(!isAbsolute(extra)||resolve(extra)!==extra||realpathSync(extra)!==extra)throw new StoreFault("invalid_input","additional writable root must be an existing canonical directory");
        const st=lstatSync(extra);
        if(!st.isDirectory()||st.isSymbolicLink())throw new StoreFault("invalid_input","additional writable root must be a real directory, not a link");
        extraPaths.push(extra);
      }
      const policy={mode:"workspace-write" as const,workspaceRoot:pinned,additionalWritableRoots:extraPaths};
      const wrap=await this.#sandbox.confine(argv,policy);
      signal.throwIfAborted();
      if(!wrap.enforcement||wrap.enforcement==="none"||wrap.argv[0]===argv[0]) throw new StoreFault("storage_unavailable","archive commands require an enforced local sandbox");
      const env:Record<string,string|undefined>=Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined]));
      // HOME/TMPDIR are what git would otherwise use to reach outside its working directory.
      Object.assign(env,gitEnvironment(pinned)); env.TMPDIR=pinned;
      this.#assertPin(root);
      return this.#processes.spawn({argv:wrap.argv,cwd:pinned,stdio:{stdin:"pipe",stdout:"pipe",stderr:"pipe"},graceMs:1000,signal,env});
    } finally {/* No transient descriptors are held: extra roots are passed as re-validated paths. */}
  }
  async #collect(stream:Readable|undefined,limit:number,handle:ProcessHandle):Promise<Uint8Array> {
    if(!stream) throw new StoreFault("storage_unavailable","local provider did not expose raw bytes");
    const parts:Buffer[]=[]; let size=0;
    for await(const chunk of stream) { const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
      if(size>limit){handle.terminate();throw new StoreFault("budget_exceeded","archive byte output exceeds its limit; no partial result was accepted");} parts.push(bytes); }
    return Buffer.concat(parts,size);
  }
  async #run(root:string,argv:readonly string[],input:Uint8Array|undefined,signal:AbortSignal,maxBytes=this.#outputBytes,extraRoots:readonly string[]=[]):Promise<ProcessResult> {
    const bounded=this.#signal(signal); const handle=await this.#spawn(root,argv,bounded,extraRoots);
    const stdout=this.#collect(handle.stdout,maxBytes,handle),stderr=this.#collect(handle.stderr,64*1024,handle);
    const stdin=new Promise<void>((resolve,reject)=>{ if(!handle.stdin){reject(new StoreFault("storage_unavailable","local provider has no stdin pipe"));return;}handle.stdin.on("error",reject);handle.stdin.end(input??new Uint8Array(),()=>resolve()); });
    try {
      const [out,err,done]=await Promise.all([stdout,stderr,handle.done,stdin]);
      if(!await handle.waitForExit(AbortSignal.timeout(2000))) {handle.terminate();throw new StoreFault("storage_unavailable","archive process range did not settle");}
      bounded.throwIfAborted();return {code:done.exitCode,stdout:out,stderr:decodeUtf8(err)};
    } catch(error) {handle.terminate();await Promise.allSettled([stdout,stderr,handle.done,stdin]);throw error;}
  }
  #argv(args:readonly string[]):string[] { return ["git","-c","core.hooksPath=/dev/null","-c","core.fsync=loose-object,reference","-c","core.fsyncMethod=fsync","-c","core.logAllRefUpdates=false","-c","user.name=ensemble-archive","-c","user.email=ensemble-archive@invalid",...args]; }
  async #git(root:string,args:readonly string[],input:Uint8Array|undefined,signal:AbortSignal,maxBytes?:number,extraRoots:readonly string[]=[]):Promise<ProcessResult> { return this.#run(root,this.#argv(args),input,signal,maxBytes,extraRoots); }
  #require(result:ProcessResult,description:string):Uint8Array {if(result.code!==0) throw new StoreFault("storage_unavailable",`${description} failed (${result.code??"signal"}): ${result.stderr.trim().slice(0,1000)}`);return result.stdout;}
  /** Serializes writers on `root`.
   * `admit` runs before the lock file is created, so a root we refuse to adopt stays byte-identical:
   * refusing must not leave our lock behind in someone else's directory. */
  async withLock<T>(root:string,signal:AbortSignal,body:(signal:AbortSignal)=>Promise<T>,lockKind:"writer"|"effect"="writer",admit?:(entries:readonly string[])=>void):Promise<T> {
    privateDirectory(root);
    if(admit)admit(readdirSync(root));
    this.#pin(root);
    const bounded=this.#signal(signal);bounded.throwIfAborted();const path=join(root,`.ensemble-${lockKind}.lock`);
    try{const fd=openSync(path,"wx",0o600);closeSync(fd);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
    const st=lstatSync(path);if(st.isSymbolicLink()||!st.isFile()||(st.mode&0o077)!==0)throw new StoreFault("storage_unavailable","writer lock file is unsafe");
    const holder=new AbortController(); const cancelAcquire=()=>holder.abort(bounded.reason); bounded.addEventListener("abort",cancelAcquire,{once:true});
    const handle=await this.#spawn(root,["flock","--exclusive","--timeout","5","--",path,"node","-e",LOCK_PROGRAM],holder.signal);
    const errors=this.#collect(handle.stderr,4096,handle);
    const first=handle.stdout?once(handle.stdout,"data"):Promise.reject(new StoreFault("storage_unavailable","lock holder has no stdout"));
    try {
      const acquired=await Promise.race([first.then(([b])=>Buffer.from(b).toString()),handle.done.then(async d=>{throw new StoreFault(d.exitCode===1?"lock_busy":"storage_unavailable",`OS lock holder exited before acquisition: ${decodeUtf8(await errors)}`);})]);
      if(acquired!=="LOCKED\n")throw new StoreFault("storage_unavailable","OS lock protocol mismatch");
      bounded.throwIfAborted();bounded.removeEventListener("abort",cancelAcquire);
      const lease=new AbortController(); const leaseSignal=AbortSignal.any([bounded,lease.signal]);let finished=false;
      void handle.done.finally(()=>{if(!finished)lease.abort(new Error("archive OS lock holder was lost"));}).catch(()=>{});
      try{this.#assertPin(root);const answer=await body(leaseSignal);this.#assertPin(root,true);return answer;}finally{finished=true;}
    } finally {bounded.removeEventListener("abort",cancelAcquire);this.#unpin(root);handle.stdin?.end();await handle.done.catch(()=>{});await errors.catch(()=>{});if(!await handle.waitForExit(AbortSignal.timeout(2000)))handle.terminate();}
  }
  async initialize(root:string,signal:AbortSignal):Promise<void> {this.#require(await this.#git(root,["init","--bare","--quiet","--template=","--object-format=sha1","."],undefined,signal),"initialize archive");}
  /** Reads the published head, distinguishing absent from corrupt by public Git semantics rather
   * than by `for-each-ref` stderr wording: that command exits 0 even for a broken ref, and it
   * reports a directory placeholder exactly like an absent ref. Absence is declared only after a
   * positive check that nothing declares the ref; every other state is corruption. */
  async head(root:string,signal:AbortSignal):Promise<string|null> {
    const refFile=join(root,"refs/ensemble/main");
    // An in-flight or interrupted update-ref leaves a lock, so absence is not provable while it exists.
    if(existsSync(`${refFile}.lock`))throw new StoreFault("outcome_unknown","an update-ref lock is present for the published archive ref; the head cannot be classified as absent");
    const resolved=await this.#git(root,["rev-parse","--verify","--quiet",MAIN_REF],undefined,signal);
    const revParse=decodeUtf8(resolved.stdout).trim();
    if(resolved.code===0&&revParse)return this.#requireCommit(root,assertOid(revParse),signal);
    if(resolved.code!==0&&resolved.code!==1){
      // A non-zero, non-"no such ref" exit means Git could not inspect the repository at all.
      // Damaged repository state is corruption; a permission or device failure is not, and must stay
      // retryable instead of being reported as damage.
      const detail=resolved.stderr.trim().slice(0,500);
      if(/permission denied|read-only file system|no space left|input\/output error|operation not permitted|cannot open/i.test(detail))
        throw new StoreFault("storage_unavailable",`archive ref could not be inspected (${resolved.code??"signal"}): ${detail}`);
      throw new StoreFault("archive_corrupt",`archive ref could not be inspected (${resolved.code??"signal"}): ${detail}`);
    }
    // Exit 1 means only "no resolvable ref": a broken ref, a directory placeholder and a malformed
    // loose file all look identical here, so absence needs the positive checks below.
    const stderr=resolved.stderr.trim();
    if(stderr&&!/^warning: ignoring broken ref/m.test(stderr))throw new StoreFault("archive_corrupt",`archive ref inspection reported an error: ${stderr.slice(0,500)}`);
    if(existsSync(refFile)||this.#packedHasRef(root))throw new StoreFault("archive_corrupt","the published archive ref is declared but does not resolve to a commit");
    return null;
  }
  /** A ref that resolves must name a commit; a missing object, blob, tree or tag is corruption.
   * `#require` is not reused here: it would report deliberate corruption as storage_unavailable. */
  async #requireCommit(root:string,oid:string,signal:AbortSignal):Promise<string> {
    const kind=await this.#git(root,["cat-file","-t",oid],undefined,signal);
    if(kind.code!==0)throw new StoreFault("archive_corrupt",`published archive ref does not name a readable object: ${kind.stderr.trim().slice(0,500)}`);
    if(decodeUtf8(kind.stdout).trim()!=="commit")throw new StoreFault("archive_corrupt","published archive ref is not a commit");
    return oid;
  }
  /** Exact-line match in packed-refs; a duplicate declaration of our ref is itself corruption. */
  #packedHasRef(root:string):boolean {
    const path=join(root,"packed-refs");if(!existsSync(path))return false;
    let text;try{text=readFileSync(path,"utf8");}catch{throw new StoreFault("storage_unavailable","packed-refs could not be read");}
    let seen=0;
    for(const line of text.split("\n")){
      if(line===""||line.startsWith("#")||line.startsWith("^"))continue;
      const m=/^([0-9a-f]{40}) (.+)$/.exec(line);
      if(!m)throw new StoreFault("archive_corrupt","packed-refs contains a malformed line");
      if(m[2]===MAIN_REF)seen+=1;
    }
    if(seen>1)throw new StoreFault("archive_corrupt","packed-refs declares the published archive ref more than once");
    return seen===1;
  }
  async entries(root:string,revision:string,signal:AbortSignal):Promise<TreeEntry[]> {
    const raw=this.#require(await this.#git(root,["ls-tree","-r","-z",assertOid(revision)],undefined,signal),"read archive tree");
    return decodeUtf8(raw).split("\0").filter(Boolean).map(row=>{const m=/^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(row);if(!m)throw new StoreFault("archive_corrupt","unsupported archive tree entry");return {oid:assertOid(m[1]!),path:safeTreePath(m[2]!)};});
  }
  async blob(root:string,oid:string,signal:AbortSignal,maxBytes?:number):Promise<Uint8Array> {return this.#require(await this.#git(root,["cat-file","blob",assertOid(oid)],undefined,signal,maxBytes),"read archive blob");}
  async read(root:string,revision:string,path:string,signal:AbortSignal,maxBytes?:number):Promise<Uint8Array|null> {safeTreePath(path);const row=(await this.entries(root,revision,signal)).find(e=>e.path===path);return row?this.blob(root,row.oid,signal,maxBytes):null;}
  async hash(root:string,bytes:Uint8Array,signal:AbortSignal):Promise<string> {return assertOid(decodeUtf8(this.#require(await this.#git(root,["hash-object","-w","--stdin"],bytes,signal),"write archive blob")).trim());}
  async tree(root:string,entries:readonly TreeEntry[],signal:AbortSignal):Promise<string> {
    type Node={files:Map<string,string>;dirs:Map<string,Node>};const top:Node={files:new Map(),dirs:new Map()};
    for(const e of entries){const parts=safeTreePath(e.path).split("/");let n=top;for(const p of parts.slice(0,-1)){if(n.files.has(p))throw new StoreFault("archive_corrupt","tree collision");let sub=n.dirs.get(p);if(!sub){sub={files:new Map(),dirs:new Map()};n.dirs.set(p,sub);}n=sub;}const leaf=parts.at(-1)!;if(n.dirs.has(leaf)||n.files.has(leaf))throw new StoreFault("archive_corrupt","duplicate tree path");n.files.set(leaf,assertOid(e.oid));}
    const emit=async(n:Node):Promise<string>=>{const rows:string[]=[];for(const [name,oid]of n.files)rows.push(`100644 blob ${oid}\t${name}\0`);for(const [name,dir]of n.dirs)rows.push(`040000 tree ${await emit(dir)}\t${name}\0`);rows.sort();return assertOid(decodeUtf8(this.#require(await this.#git(root,["mktree","-z"],enc.encode(rows.join("")),signal),"write archive tree")).trim());};return emit(top);
  }
  async commit(root:string,tree:string,parent:string|null,sequence:number,signal:AbortSignal):Promise<string> {const args=["commit-tree",assertOid(tree),...(parent?["-p",assertOid(parent)]:[]),"-m",`ensemble sequence ${sequence}`];return assertOid(decodeUtf8(this.#require(await this.#git(root,args,undefined,signal),"write archive commit")).trim());}
  async publish(root:string,revision:string,expected:string|null,signal:AbortSignal):Promise<void> {this.#require(await this.#git(root,["update-ref",MAIN_REF,assertOid(revision),expected===null?"":assertOid(expected)],undefined,signal),"publish archive commit");}
  async history(root:string,revision:string,signal:AbortSignal):Promise<string[]> {return decodeUtf8(this.#require(await this.#git(root,["rev-list","--first-parent",assertOid(revision)],undefined,signal),"read archive history")).trim().split("\n").filter(Boolean).map(assertOid);}
  async isAncestor(root:string,older:string,newer:string,signal:AbortSignal):Promise<boolean> {const r=await this.#git(root,["merge-base","--is-ancestor",assertOid(older),assertOid(newer)],undefined,signal);if(r.code===0)return true;if(r.code===1)return false;this.#require(r,"verify archive ancestry");return false;}
  async fsck(root:string,signal:AbortSignal):Promise<void>{this.#require(await this.#git(root,["fsck","--full","--no-reflogs"],undefined,signal),"verify archive integrity");}
  async backup(root:string,revision:string,signal:AbortSignal):Promise<Uint8Array>{if(await this.head(root,signal)!==assertOid(revision))throw new StoreFault("revision_conflict","backup revision must equal locked archive head");return this.#require(await this.#git(root,["bundle","create","-","--all"],undefined,signal,this.#backupBytes),"create archive backup");}
  async verifyBundle(root:string,bytes:Uint8Array,signal:AbortSignal):Promise<void>{const path=join(root,`.bundle-${randomUUID()}`);durableFile(path,bytes);try{this.#require(await this.#git(root,["bundle","verify",path],undefined,signal),"verify archive backup");}finally{unlinkSync(path);}}
  async restoreBundle(bytes:Uint8Array,isolatedRoot:string,signal:AbortSignal):Promise<Record<string,string>> {
    privateDirectory(isolatedRoot);
    await this.initialize(isolatedRoot,signal);
    if(await this.head(isolatedRoot,signal)!==null)throw new StoreFault("revision_conflict","restore target already has a published archive");
    const path=join(isolatedRoot,`.restore-${randomUUID()}`);durableFile(path,bytes);
    try {
      this.#require(await this.#git(isolatedRoot,["bundle","verify",path],undefined,signal),"verify isolated backup");
      const text=decodeUtf8(this.#require(await this.#git(isolatedRoot,["bundle","unbundle",path],undefined,signal),"restore isolated backup"));
      const refs:Record<string,string>={};
      for(const row of text.trim().split("\n")){const m=/^([0-9a-f]{40}) (refs\/[A-Za-z0-9_./-]+)$/.exec(row);if(!m)throw new StoreFault("archive_corrupt","backup ref manifest is invalid");refs[m[2]!]=assertOid(m[1]!);}
      const head=refs[MAIN_REF];if(!head)throw new StoreFault("archive_corrupt","backup has no archive business ref");
      for(const name of Object.keys(refs))this.#refName(name);await this.fsck(isolatedRoot,signal);const transaction="start\n"+Object.entries(refs).map(([name,oid])=>`create ${name} ${oid}\n`).join("")+"prepare\ncommit\n";this.#require(await this.#git(isolatedRoot,["update-ref","--stdin"],enc.encode(transaction),signal),"restore all backup refs atomically");syncDirectory(isolatedRoot);return refs;
    } finally {unlinkSync(path);}
  }
  #refName(name:string):void {if(!/^refs\/[A-Za-z0-9_./-]+$/.test(name)||name.includes("..")||name.split("/").some(p=>!p||p.startsWith(".")||p.endsWith(".lock")))throw new StoreFault("archive_corrupt","invalid backup ref name");}
  #localDestination(path:string):string {if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path||!lstatSync(path).isDirectory()||!lstatSync(join(path,"objects")).isDirectory()||!lstatSync(join(path,"HEAD")).isFile())throw new StoreFault("invalid_input","replica handle must resolve to an existing canonical bare repository");return path;}
  async refs(root:string,signal:AbortSignal):Promise<Record<string,string>> {const text=decodeUtf8(this.#require(await this.#git(root,["for-each-ref","--format=%(refname) %(objectname)"],undefined,signal),"read backup refs"));const refs:Record<string,string>={};for(const row of text.trim().split("\n").filter(Boolean)){const [name,oid]=row.split(" ");this.#refName(name!);refs[name!]=assertOid(oid!);}return refs;}
  async remoteHead(root:string,destination:string,signal:AbortSignal):Promise<string|null> {destination=this.#localDestination(destination);const text=decodeUtf8(this.#require(await this.#git(root,["ls-remote","--refs",destination,MAIN_REF],undefined,signal),"read replica head"));if(!text.trim())return null;const m=/^([0-9a-f]{40})\trefs\/ensemble\/main\n?$/.exec(text);if(!m)throw new StoreFault("archive_corrupt","replica returned an invalid ref");return assertOid(m[1]!);}
  async pushLease(root:string,destination:string,revision:string,expected:string|null,signal:AbortSignal):Promise<void>{
    destination=this.#localDestination(destination);assertOid(revision);if(expected!==null)assertOid(expected);
    const observed=await this.remoteHead(root,destination,signal);if(observed!==expected)throw new StoreFault("revision_conflict","replica head changed before push");
    if(expected!==null&&!await this.isAncestor(root,expected,revision,signal))throw new StoreFault("revision_conflict","replica push must preserve fast-forward history");
    const result=await this.#git(root,["push","--porcelain",`--force-with-lease=${MAIN_REF}:${expected??""}`,destination,`${revision}:${MAIN_REF}`],undefined,signal,undefined,[destination]);
    if(result.code!==0){const head=await this.remoteHead(root,destination,new AbortController().signal);if(head===revision)return;if(head!==expected)throw new StoreFault("revision_conflict","replica CAS rejected a concurrent head");this.#require(result,"push replica");}
    if(await this.remoteHead(root,destination,signal)!==revision)throw new StoreFault("outcome_unknown","replica push acknowledgement could not be verified");
  }
  async fetchQuarantine(destination:string,isolatedRoot:string,expected:string,signal:AbortSignal):Promise<string>{
    destination=this.#localDestination(destination);assertOid(expected);privateDirectory(isolatedRoot);await this.initialize(isolatedRoot,signal);
    if(await this.head(isolatedRoot,signal)!==null)throw new StoreFault("revision_conflict","quarantine is not empty");
    this.#require(await this.#git(isolatedRoot,["fetch","--no-tags","--no-write-fetch-head",destination,`${MAIN_REF}:${MAIN_REF}`],undefined,signal),"fetch replica into quarantine");
    const actual=await this.head(isolatedRoot,signal);if(actual!==expected)throw new StoreFault("revision_conflict","replica changed during fetch; quarantine is not activated");await this.fsck(isolatedRoot,signal);return actual;
  }

  async objectStats(root:string,signal:AbortSignal):Promise<Record<string,number>> {const text=decodeUtf8(this.#require(await this.#git(root,["count-objects","-v"],undefined,signal),"inspect archive capacity"));const stats:Record<string,number>={};for(const row of text.trim().split("\n")){const m=/^([a-z-]+): (\d+)$/.exec(row);if(m)stats[m[1]!]=Number(m[2]);}return stats;}
  async gc(root:string,signal:AbortSignal):Promise<void>{this.#require(await this.#git(root,["gc","--prune=never"],undefined,signal),"maintain archive objects without pruning history");}

}

