import { describe, expect, test } from "bun:test";
import { parseArgs, STORE_ACCEPTANCE_CASES } from "./verify-dsh-store-acceptance.ts";

describe("store acceptance command contract",()=>{
 test("requires an explicit runtime, refuses unknown cases and extra arguments",()=>{
  for(const args of [[],["--runtime"],["--install-dir","somewhere"],["--runtime","somewhere","--case","unknown"],["--runtime","somewhere","--ignore","failure"]])expect(()=>parseArgs(args)).toThrow();
  expect(parseArgs(["--runtime",".scratch/rc5-cycle/rc5"]).runtime).toEndWith("/.scratch/rc5-cycle/rc5");
 });
});
const runtime=process.env.DSH_ARCHIVE_SEAM_INSTALL;
const native=runtime?describe:describe.skip;
native("independent storage acceptance / published native providers",()=>{
 for(const [name,run]of Object.entries(STORE_ACCEPTANCE_CASES))test(name,async()=>{await run(runtime!);},120_000);
});
