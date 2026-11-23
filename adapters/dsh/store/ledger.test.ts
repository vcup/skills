import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { success, failure, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import { createVersionedLedger } from "./ledger.ts";
import { decodeLedgerMarker, decodeLedgerOperationRecord, decodeLedgerReceipt, decodeLedgerState } from "./schema.ts";
const install = process.env.DSH_ARCHIVE_SEAM_INSTALL;
const native = install ? describe : describe.skip;
const OWNER: Actor = { kind: "owner", ownerId: "ledger-owner", hostAuthorityId: "ledger-host", channel: "authenticated-remote" };
const FORMAT = "ensemble-ledger-test/v1";
interface State { readonly value: number }
const decodeState = (v: unknown): Result<State> =>
  v !== null && typeof v === "object" && typeof (v as State).value === "number" ? success(v as State) : failure("archive_corrupt", "bad test state");
const signal = () => new AbortController().signal;
const good = <T,>(r: Result<T>): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value; };
const attempt = (run: () => unknown): string => { try { run(); return "ok"; } catch (error) { return `threw: ${(error as Error).message}`; } };
async function options(root: string) {
  const base = resolve(install!);
  const load = (n: string) => import(join(base, "node_modules/@deepseek-ai", n, "lib/index.js"));
  const [{ Context }, { LocalSubprocessRuntime }, { LocalSandboxProvider }] = await Promise.all([
    load("cordis"), load("dsh-subprocess-local"), load("dsh-sandbox-local")]);
  return {
    root, hostAuthorityId: "ledger-host", format: FORMAT,
    context: new Context(),
    factories: { subprocess: (s: unknown) => new LocalSubprocessRuntime(s as never), sandbox: (s: unknown) => new LocalSandboxProvider(s as never, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }) },
    decodeState, authorize: () => success(true) as Result<true>,
    // The consumer's own closed result decoder; the store never guesses a domain payload shape.
    decodeResult: (v: unknown): Result<unknown> => {
      if (v === null || typeof v !== "object") return failure("archive_corrupt", "result must be an object");
      const keys = Object.keys(v as object);
      if (keys.some((k) => k !== "sequence" && k !== "value")) return failure("archive_corrupt", "result has unknown fields");
      const { sequence, value } = v as { sequence?: unknown; value?: unknown };
      if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return failure("archive_corrupt", "result sequence is invalid");
      if (typeof value !== "number") return failure("archive_corrupt", "result value is invalid");
      return success(v);
    },
  };
}
const reduce = (state: State | undefined, command: { delta: number }, context: { sequence: number }) => {
  const value = (state?.value ?? 0) + command.delta;
  return success({ state: { value }, result: { sequence: context.sequence, value } });
};
function fixture() { const dir = resolve(".scratch/production-cycle"); mkdirSync(dir, { recursive: true }); return mkdtempSync(join(dir, "ledger-test-")); }

describe("ledger persisted-record schemas", () => {
  test("closed ledger records refuse malformed shapes and foreign identities", () => {
    const receipt = { format: "ensemble-ledger-receipt/v1", actor: "actor-key", operationId: "op", digest: "a".repeat(64), sequence: 1, result: { value: 1 } };
    expect(attempt(() => decodeLedgerReceipt(receipt, "actor-key", "op"))).toBe("ok");
    for (const broken of [{ ...receipt, format: "other" }, { ...receipt, digest: "short" }, { ...receipt, sequence: 0 }, { ...receipt, unknown: true }])
      expect(() => decodeLedgerReceipt(broken, "actor-key", "op")).toThrow();
    // A receipt is bound to the actor and operation key it was written for.
    expect(() => decodeLedgerReceipt(receipt, "another-actor", "op")).toThrow();
    expect(() => decodeLedgerReceipt(receipt, "actor-key", "another-op")).toThrow();
    expect(attempt(() => decodeLedgerOperationRecord({ ...receipt, identity: { kind: "owner", ownerId: "o", hostAuthorityId: "h" } }))).toBe("ok");
    expect(() => decodeLedgerOperationRecord({ ...receipt, identity: null })).toThrow();
    expect(attempt(() => decodeLedgerState({ format: FORMAT, sequence: 2, state: { value: 2 } }, FORMAT))).toBe("ok");
    expect(() => decodeLedgerState({ format: FORMAT, sequence: 0, state: {} }, FORMAT)).toThrow();
    expect(() => decodeLedgerState({ format: "other", sequence: 1, state: {} }, FORMAT)).toThrow();
    const marker = { format: "ensemble-ledger-owner/v1", ledgerId: "ledger-abc", hostAuthorityId: "ledger-host", stateFormat: FORMAT };
    expect(attempt(() => decodeLedgerMarker(marker, "ledger-host", FORMAT))).toBe("ok");
    // Identity, format and recovery-intent are all closed: a foreign host cannot be adopted.
    expect(() => decodeLedgerMarker({ ...marker, hostAuthorityId: "other-host" }, "ledger-host", FORMAT)).toThrow();
    expect(() => decodeLedgerMarker({ ...marker, stateFormat: "other" }, "ledger-host", FORMAT)).toThrow();
    expect(() => decodeLedgerMarker({ ...marker, ledgerId: "nope" }, "ledger-host", FORMAT)).toThrow();
    expect(() => decodeLedgerMarker({ ...marker, restoring: { actor: 1 } }, "ledger-host", FORMAT)).toThrow();
  });
});

native("independent environment ledger / published native providers", () => {
  test("restart replays the durable receipt; a reused key with new content conflicts", async () => {
    const root = fixture(); const first = createVersionedLedger<State>(await options(root));
    const written = good(await first.transact(OWNER, { expectedRevision: "absent", operationId: "one", command: { delta: 3 } }, reduce, signal()));
    expect(written.sequence).toBe(1); expect(written.replayed).toBe(false);
    first.dispose();
    const restarted = createVersionedLedger<State>(await options(root));
    try {
      // Same key, same business content: the durable receipt answers, nothing is re-applied.
      const replay = good(await restarted.transact(OWNER, { expectedRevision: "absent", operationId: "one", command: { delta: 3 } }, reduce, signal()));
      expect(replay.replayed).toBe(true);
      expect(replay.revision).toBe(written.revision);
      expect(replay.result).toEqual(written.result);
      const conflicting = await restarted.transact(OWNER, { expectedRevision: "absent", operationId: "one", command: { delta: 4 } }, reduce, signal());
      expect(conflicting.ok).toBe(false); if (!conflicting.ok) expect(conflicting.error.code).toBe("operation_key_conflict");
      expect(good(await restarted.transact(OWNER, { expectedRevision: written.revision, operationId: "two", command: { delta: 1 } }, reduce, signal())).sequence).toBe(2);
      const stale = await restarted.transact(OWNER, { expectedRevision: "absent", operationId: "three", command: { delta: 1 } }, reduce, signal());
      expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
      expect(good(await restarted.read(OWNER, undefined, signal())).state.value).toBe(4);
      expect(good(await restarted.receipt(OWNER, "one", signal())).result).toEqual(written.result);
      expect((await restarted.receipt(OWNER, "absent-key", signal())).ok).toBe(false);
    } finally { restarted.dispose(); }
  }, 30000);

  test("a corrupt persisted ledger state is refused rather than read as an empty ledger", async () => {
    const root = fixture(); const first = createVersionedLedger<State>(await options(root));
    good(await first.transact(OWNER, { expectedRevision: "absent", operationId: "one", command: { delta: 1 } }, reduce, signal()));
    first.dispose();
    const { ArchiveKernel } = await import("./kernel.ts");
    const kernel = new ArchiveKernel(await options(root) as never);
    try {
      await kernel.withLock(root, signal(), async (lease) => {
        const head = await kernel.head(root, lease); expect(head).not.toBeNull();
        const old = JSON.parse(Buffer.from((await kernel.read(root, head!, "ledger.json", lease))!).toString("utf8"));
        // `sequence: 0` is legal JSON but an impossible persisted sequence.
        const replacement = await kernel.hash(root, Buffer.from(JSON.stringify({ ...old, sequence: 0 })), lease);
        const entries = await kernel.entries(root, head!, lease);
        const tree = await kernel.tree(root, entries.map((e) => e.path === "ledger.json" ? { ...e, oid: replacement } : e), lease);
        const revision = await kernel.commit(root, tree, head, 9, lease);
        await kernel.publish(root, revision, head, lease);
      });
    } finally { kernel.dispose(); }
    const reopened = createVersionedLedger<State>(await options(root));
    try {
      const read = await reopened.read(OWNER, undefined, signal());
      expect(read.ok).toBe(false); if (!read.ok) expect(read.error.code).toBe("archive_corrupt");
      // The corrupt ledger is not silently re-initialized by a write either.
      const write = await reopened.transact(OWNER, { expectedRevision: "absent", operationId: "two", command: { delta: 1 } }, reduce, signal());
      expect(write.ok).toBe(false); if (!write.ok) expect(write.error.code).toBe("archive_corrupt");
    } finally { reopened.dispose(); }
  }, 30000);

  test("a corrupted durable ledger receipt refuses replay instead of re-applying the command", async () => {
    const root = fixture(); const first = createVersionedLedger<State>(await options(root));
    const written = good(await first.transact(OWNER, { expectedRevision: "absent", operationId: "one", command: { delta: 3 } }, reduce, signal()));
    first.dispose();
    const { ArchiveKernel } = await import("./kernel.ts");
    const kernel = new ArchiveKernel(await options(root) as never);
    try {
      await kernel.withLock(root, signal(), async (lease) => {
        const head = await kernel.head(root, lease);
        const entries = await kernel.entries(root, head!, lease);
        // The receipt path is derived from the actor key and operation key, never from caller input.
        const found = entries.find((e) => e.path.startsWith("receipts/") && e.path.endsWith(".json"));
        expect(found).toBeDefined();
        const target = found!.path;
        const old = JSON.parse(Buffer.from((await kernel.read(root, head!, target, lease))!).toString("utf8"));
        // Corrupt ONLY the receipt's actor binding, leaving ledger.json valid so the state read
        // still succeeds. The stored actor is not derivable from anything else on disk, so only
        // the receipt decoder can refuse this: without it the foreign receipt replays as the answer.
        const replacement = await kernel.hash(root, Buffer.from(JSON.stringify({ ...old, actor: JSON.stringify(["owner", "another-host", "another-owner"]) })), lease);
        const tree = await kernel.tree(root, entries.map((e) => e.path === target ? { ...e, oid: replacement } : e), lease);
        const revision = await kernel.commit(root, tree, head, 11, lease);
        await kernel.publish(root, revision, head, lease);
      });
    } finally { kernel.dispose(); }
    const reopened = createVersionedLedger<State>(await options(root));
    try {
      // The same key must not be answered from a receipt belonging to another actor.
      const replay = await reopened.transact(OWNER, { expectedRevision: written.revision, operationId: "one", command: { delta: 3 } }, reduce, signal());
      expect(replay.ok).toBe(false); if (!replay.ok) expect(replay.error.code).toBe("archive_corrupt");
      const receipt = await reopened.receipt(OWNER, "one", signal());
      expect(receipt.ok).toBe(false); if (!receipt.ok) expect(receipt.error.code).toBe("archive_corrupt");
      // The authoritative state itself is intact and still readable: only the receipt is corrupt,
      // and a state read that does not consult the receipt is unaffected.
      const read = good(await reopened.read(OWNER, undefined, signal()));
      expect(read.state.value).toBe(3);
      /*
       * KNOWN GAP - reported rather than hidden: a ledger receipt's `result` payload is opaque to
       * the store (it is whatever the domain reducer returned), so a mutated *field inside*
       * `result` is not detectable here; only the envelope is closed. Closing it needs a per-domain
       * result decoder supplied by the consumer (e.g. the environment service). See STORE-FINAL.md.
       */
    } finally { reopened.dispose(); }
  }, 30000);

  test("a foreign root is never adopted and a mismatched marker is refused", async () => {
    const root = fixture();
    writeFileSync(join(root, "foreign.txt"), "someone else's data");
    const ledger = createVersionedLedger<State>(await options(root));
    try {
      const write = await ledger.transact(OWNER, { expectedRevision: "absent", operationId: "one", command: { delta: 1 } }, reduce, signal());
      expect(write.ok).toBe(false); if (!write.ok) expect(write.error.code).toBe("archive_corrupt");
      // Admission is decided before the lock exists, so refusing leaves the root byte-identical:
      // no lock file, no marker, no repository.
      expect(readdirSync(root).sort()).toEqual(["foreign.txt"]);
      expect(readFileSync(join(root, "foreign.txt"), "utf8")).toBe("someone else's data");
      expect(existsSync(join(root, "ensemble-ledger.json"))).toBe(false);
      expect(existsSync(join(root, "HEAD"))).toBe(false);
      expect(existsSync(join(root, "ledger.json"))).toBe(false);
    } finally { ledger.dispose(); }
  }, 30000);
});

native("consumer per-domain result decoder closes the receipt result",()=>{
 /** Uses the environment service's real decoder, not a test stand-in: a receipt whose `result`
  * field is rewritten in Git must be refused at replay because the consumer re-validates it. */
 test("the real environment decoder rejects a rewritten result at replay",async()=>{
  const { decodeEnvironmentResult } = await import("../environment/service.ts");
  const { ArchiveKernel } = await import("./kernel.ts");
  const root=fixture();
  const withRealDecoder=async()=>({...(await options(root)),decodeResult:decodeEnvironmentResult});
  // This reducer emits a shape the real environment domain really produces, so the commit passes;
  // the hostile rewrite later is what must fail.
  const environmentShaped=(state:State|undefined,command:{delta:number},context:{sequence:number})=>
    success({state:{value:(state?.value??0)+command.delta},result:{action:"set",desired_sequence:context.sequence}});
  const first=createVersionedLedger<State>(await withRealDecoder() as never);
  const written=good(await first.transact(OWNER,{expectedRevision:"absent",operationId:"one",command:{delta:3}},environmentShaped,signal()));
  first.dispose();
  const kernel=new ArchiveKernel(await withRealDecoder() as never);
  try{
   await kernel.withLock(root,signal(),async(lease)=>{
    const head=await kernel.head(root,lease);expect(head).not.toBeNull();
    const entries=await kernel.entries(root,head!,lease);
    const target=entries.find(e=>e.path.startsWith("receipts/")&&e.path.endsWith(".json"));
    expect(target).toBeDefined();
    const old=JSON.parse(Buffer.from((await kernel.read(root,head!,target!.path,lease))!).toString("utf8"));
    // Rewrite the business result into a shape the environment domain never produces.
    const forged=Buffer.from(JSON.stringify({...old,result:{action:"set",granted:["root"]}}));
    const replacement=await kernel.hash(root,forged,lease);
    const tree=await kernel.tree(root,entries.map(e=>e.path===target!.path?{...e,oid:replacement}:e),lease);
    const revision=await kernel.commit(root,tree,head,11,lease);
    await kernel.publish(root,revision,head,lease);
   });
  }finally{kernel.dispose();}
  const reopened=createVersionedLedger<State>(await withRealDecoder() as never);
  try{
   const replay=await reopened.transact(OWNER,{expectedRevision:written.revision,operationId:"one",command:{delta:3}},environmentShaped,signal());
   expect(replay.ok).toBe(false);
   if(!replay.ok)expect(replay.error.code).toBe("archive_corrupt");
   // A test-shaped result is valid for the fixture decoder but refused by the real one, proving the
   // check is the consumer's own schema rather than a generic object test.
   expect(decodeEnvironmentResult({sequence:1,value:4}).ok).toBe(false);
  }finally{reopened.dispose();}
 },30000);
});

native("nested locks do not self-conflict",()=>{
 /** `withEffectLock` holds one lock kind for the whole effect, so the state transaction it wraps
  * must acquire a *different* kind on the same root. Routing both through the same lock file made
  * every apply time out with lock_busy, so this pins the nesting contract. */
 test("a write transaction inside an effect lock acquires instead of timing out",async()=>{
  const root=fixture();const ledger=createVersionedLedger<State>(await options(root));
  try{
   const seed=good(await ledger.transact(OWNER,{expectedRevision:"absent",operationId:"seed",command:{delta:1}},reduce,signal()));
   const outcome=await ledger.withEffectLock(OWNER,signal(),async(effectSignal)=>{
    // Reads inside the effect must not queue behind the held effect lock.
    good(await ledger.read(OWNER,undefined,effectSignal));
    good(await ledger.receipt(OWNER,"seed",effectSignal));
    // The nested writer transaction must acquire its own lock kind and commit.
    const applied=good(await ledger.transact(OWNER,{expectedRevision:seed.revision,operationId:"apply",command:{delta:2}},reduce,effectSignal));
    expect(applied.sequence).toBe(seed.sequence+1);
    return success(true);
   });
   expect(outcome.ok).toBe(true);
   expect(good(await ledger.read(OWNER,undefined,signal())).state.value).toBe(3);
  }finally{ledger.dispose();}
 },40000);
});
