/**
 * Regression for owner-form validation.
 *
 * The defect this pins: `formPayload` throws on a missing required field or malformed JSON,
 * the panel used to swallow that throw, and the user saw a button that did nothing — no
 * message, no alert, and (correctly) no network request. A silent no-op is
 * indistinguishable from a broken button, so the failure has to name what to fix.
 *
 * These tests drive `formPayload` through the same `management` table the form renders from,
 * so a new required field is covered automatically.
 *
 * @module adapters/dsh/client/management.test
 */
import { describe, expect, test } from "bun:test";
import { formPayload, management, type ManagementAction } from "./management.ts";

describe("owner form validation", () => {
  test("a missing required field throws with the field name, so the panel can show it", () => {
    // `formPayload` reports the first field it cannot complete, which is what the panel
    // renders. Each field must independently produce that message when it is the only one
    // missing, so the user is never told merely "invalid".
    for (const field of management.initialize) {
      const values: Record<string, string> = {
        root_handle: "default",
        source_descriptor: JSON.stringify({ worldIdentity: "host", canonicalAddress: "/host/one", nativeWorkspaceRef: "ws-1" }),
        initial_grants: "[]",
        limits: JSON.stringify({ inline_input_bytes: 1, response_bytes: 1, artifact_bytes: 1, upload_chunk_bytes: 1, upload_total_bytes: 1, concurrent_uploads: 1, page_items: 1 }),
      };
      delete values[field.name];
      expect(() => formPayload("initialize", values)).toThrow(field.name);
    }
  });

  test("malformed JSON is refused rather than sent as a string", () => {
    const jsonField = management.initialize.find(field => field.format === "json")!;
    expect(() => formPayload("initialize", { [jsonField.name]: "{not json" })).toThrow();
  });

  test("a valid payload is produced once the required fields are present", () => {
    // The exact shape the fresh-Host journey submits: an empty grant list and the archive
    // limits. `initial_grants` is an array by contract, so `[]` is a legitimate value.
    const payload = formPayload("initialize", {
      root_handle: "default",
      source_descriptor: JSON.stringify({ worldIdentity: "host", canonicalAddress: "/host/one", nativeWorkspaceRef: "ws-1" }),
      initial_grants: "[]",
      limits: JSON.stringify({
        inline_input_bytes: 65536, response_bytes: 1048576, artifact_bytes: 10485760,
        upload_chunk_bytes: 65536, upload_total_bytes: 104857600, concurrent_uploads: 4, page_items: 100,
      }),
    });
    expect(payload.root_handle).toBe("default");
    expect(payload.initial_grants).toEqual([]);
    expect((payload.source_descriptor as { nativeWorkspaceRef?: string }).nativeWorkspaceRef).toBe("ws-1");
    expect((payload.limits as { page_items?: number }).page_items).toBe(100);
  });

  test("every action's first required field is named, so the message is actionable", () => {
    // A panel that only said "invalid" would leave the user guessing; the throw carries the
    // field name and the panel renders it.
    for (const action of Object.keys(management) as ManagementAction[]) {
      const required = management[action].filter(field => field.optional !== true);
      if (required.length === 0) continue;
      expect(() => formPayload(action, {})).toThrow(required[0]!.name);
    }
  });
});
