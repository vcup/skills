/**
 * A gate that cannot tell provisioning from product bugs is worse than no gate.
 * These tests pin the classification, including the two mistakes that matter:
 * calling a product bug a fixture gap (hides a real defect) and calling a missing
 * fixture a product bug (sends a reader to the wrong file).
 */

import { describe, expect, test } from "bun:test";
import { GateFailure, classifyHostFailure, exitCodeOf, prerequisite, product } from "./gate-failure.ts";

describe("exit contract", () => {
  test("prerequisite exit 2, product exit 1", () => {
    expect(exitCodeOf("prerequisite")).toBe(2);
    expect(exitCodeOf("product")).toBe(1);
  });

  test("the helpers carry their kind and message", () => {
    try { prerequisite("no connection.json"); } catch (error) {
      expect(error).toBeInstanceOf(GateFailure);
      expect((error as GateFailure).kind).toBe("prerequisite");
      expect((error as Error).message).toBe("no connection.json");
    }
    try { product("boot manifest lacks dsh-ensemble"); } catch (error) {
      expect((error as GateFailure).kind).toBe("product");
    }
  });

  test("a cause is preserved for diagnostics", () => {
    const cause = new Error("inner");
    try { prerequisite("outer", cause); } catch (error) { expect((error as GateFailure).cause).toBe(cause); }
  });
});

describe("host failure classification", () => {
  test("an unreachable Host is a prerequisite", () => {
    for (const message of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:35883", "socket hang up", "could not reach the Host at http://127.0.0.1:1"]) {
      const classified = classifyHostFailure(new Error(message));
      expect(classified.kind).toBe("prerequisite");
      expect(classified.message).toMatch(/serve fixture/u);
    }
  });

  test("a rejected session is a product failure, not a provisioning gap", () => {
    for (const message of ["HTTP 401", "unauthorized", "dsh web authentication required; reopen the URL printed by dsh web."]) {
      const classified = classifyHostFailure(new Error(message));
      expect(classified.kind).toBe("product");
      expect(classified.message).toMatch(/not a provisioning gap/u);
    }
  });

  test("a domain refusal from a reached Host is a product failure", () => {
    const classified = classifyHostFailure(new Error("the Host refused: invalid_input No closed variant matches"));
    expect(classified.kind).toBe("product");
    expect(classified.message).toMatch(/refused the gate's authenticated request/u);
  });

  test("a non-Error throw still classifies", () => {
    expect(classifyHostFailure("fetch failed").kind).toBe("prerequisite");
    expect(classifyHostFailure("HTTP 401").kind).toBe("product");
  });
});
