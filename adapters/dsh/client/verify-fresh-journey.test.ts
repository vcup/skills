/**
 * Contract tests for the fresh-Host journey probe.
 *
 * The probe drives the shipped DSH Workspace UI, so the things worth testing are its
 * refusals and its reporting — not a browser. A probe that quietly proceeds on the
 * wrong fixture, or guesses a selector it never observed, is worse than no probe: it
 * manufactures a green for a journey nobody actually walked.
 *
 * @module adapters/dsh/client/verify-fresh-journey.test
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingPrerequisite, parseArguments } from "./verify-fresh-journey.ts";

describe("fresh-Host journey probe", () => {
  test("every required input is named, and a missing one is a prerequisite", () => {
    const complete = parseArguments([
      "--connection", "/tmp/handoff.json",
      "--browser", "/tmp/chrome",
      "--output", "/tmp/out",
      "--host-directory", "/tmp/workspace",
    ]);
    expect(missingPrerequisite(complete)).toBeUndefined();
    for (const missing of ["connection", "browser", "output", "host-directory"] as const) {
      const partial = parseArguments([
        ...(missing === "connection" ? [] : ["--connection", "/tmp/handoff.json"]),
        ...(missing === "browser" ? [] : ["--browser", "/tmp/chrome"]),
        ...(missing === "output" ? [] : ["--output", "/tmp/out"]),
        ...(missing === "host-directory" ? [] : ["--host-directory", "/tmp/workspace"]),
      ]);
      // A prerequisite is exit 2: nothing was asserted, so this cannot be a pass.
      expect(missingPrerequisite(partial)).toBe(missing);
    }
  });

  test("a handoff that already carries a project is refused as the wrong lane", async () => {
    // The fresh lane's whole value is the from-nothing state. Running it against an
    // initialized Host would report the picker journey as if it were the create journey.
    const { freshPremiseFailure } = await import("./verify-fresh-journey.ts");
    expect(freshPremiseFailure({ projectId: "project-1" })).toBeDefined();
    expect(freshPremiseFailure({ workspaceId: "workspace-1" })).toBeDefined();
    expect(freshPremiseFailure({})).toBeUndefined();
  });
});
