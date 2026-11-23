import { describe, expect, test } from "bun:test";

describe("native acceptance command contract", () => {
  test("requires an explicit runtime argument", () => {
    // The module exits with code 2 on usage errors; exercise parse through a child run.
    const proc = Bun.spawnSync([process.execPath, "scripts/verify-dsh-native-acceptance.ts"], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain("usage:");
  });
});

// Real-runtime acceptance runs only when the harness points at the frozen rc4/rc5 installs.
const runtimes = (process.env.DSH_NATIVE_SEAM_INSTALLS ?? "").split(":").filter(Boolean);
const native = runtimes.length ? describe : describe.skip;
native("independent native boundary acceptance / published providers", () => {
  for (const runtime of runtimes) {
    test(`boundaries against ${runtime}`, async () => {
      const { verifyNativeBoundaries } = await import("./verify-dsh-native-acceptance.ts");
      const result = await verifyNativeBoundaries(runtime);
      const failed = result.checks.filter(check => !check.passed);
      expect(failed).toEqual([]);
    }, 120_000);
  }
});
