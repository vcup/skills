import { describe, expect, test } from "bun:test";

describe("replica acceptance command contract", () => {
  test("requires an explicit runtime, refuses unknown cases and extra arguments", () => {
    const { parseArgs, REPLICA_ACCEPTANCE_CASES } = require("./verify-dsh-replica-acceptance.ts");
    for (const args of [[], ["--runtime"], ["--install-dir", "somewhere"], ["--runtime", "somewhere", "--case", "unknown"], ["--runtime", "somewhere", "--ignore", "failure"]]) {
      expect(() => parseArgs(args)).toThrow();
    }
    expect(parseArgs(["--runtime", ".scratch/rc5-cycle/rc5"]).runtime).toEndWith("/.scratch/rc5-cycle/rc5");
    expect(Object.keys(REPLICA_ACCEPTANCE_CASES).length).toBeGreaterThanOrEqual(7);
  });
});

// Real-runtime acceptance runs only when the harness points at the frozen rc4/rc5 installs.
const runtime = process.env.DSH_REPLICA_SEAM_INSTALL;
const native = runtime ? describe : describe.skip;
native("independent replica acceptance / loopback git daemon", () => {
  for (const [name, run] of Object.entries(require("./verify-dsh-replica-acceptance.ts").REPLICA_ACCEPTANCE_CASES) as readonly [string, (runtime: string) => Promise<unknown>][]) {
    test(name, async () => { await run(runtime!); }, 180_000);
  }
});
