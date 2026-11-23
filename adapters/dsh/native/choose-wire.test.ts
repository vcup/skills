/**
 * The `choose` wire contract, and the picker read that makes it usable.
 *
 * Two things a Client needs from this layer, both easy to get subtly wrong:
 *
 * 1. **Which field names a network destination.** `choose` takes `destinationKey`
 *    and *not* a path. It must not be confused with `destination_handle`, which is
 *    the opaque capability id `choose` returns. Getting these two backwards is
 *    exactly the defect that made every real network `configure_replica` fail, so
 *    the shapes are asserted directly: one of `path`/`destinationKey`, never both,
 *    never neither.
 *
 * 2. **Where a picker gets the names.** Before a first successful `choose` there is
 *    no handle to list, so a user would have to guess a key. `destinations` is the
 *    read that fixes that, and it must expose only `{ key, identity }` — a URL or a
 *    credential reference in a browser payload would be a deployment secret leak.
 */

import { describe, expect, test } from "bun:test";
import { createProductOwner } from "./owner.ts";

const hostAuthorityId = "host-1";
const deps = (overrides: Partial<Parameters<typeof createProductOwner>[0]> = {}) => ({
  hostAuthorityId,
  ownerId: "authenticated-host-owner",
  authorizationRefreshMs: 1_000,
  projects: async () => ({ ok: true, value: { capabilities: [], root_handles: [], source_handles: [], destination_handles: [], projects: [] } }) as never,
  query: async () => ({ ok: true, value: {} }) as never,
  manage: async () => ({ ok: true, value: {} }),
  choose: async (_actor: unknown, request: unknown) => ({ ok: true, value: { request } }),
  approve: async () => ({ ok: true, value: {} }),
  subscribe: () => () => {},
  ...overrides,
});

/** The authenticated owner: a `peer.principal` of kind `owner`, per `ownerVerdict`. */
const invocation = { peer: { principal: { kind: "owner" } } } as never;

describe("choose wire shape", () => {
  test("a network replica sends destinationKey and never a path", async () => {
    const owner = createProductOwner(deps());
    const result = await owner.choose({ kind: "replica", world: "w", destinationKey: "mirror" }, invocation, AbortSignal.timeout(1_000));
    // It reached the engine as a capability selection, not as a filesystem path.
    expect(result).toEqual({ ok: true, value: { request: { kind: "replica", world: "w", destinationKey: "mirror" } } });
  });

  test("a filesystem location sends a path and never a destination key", async () => {
    const owner = createProductOwner(deps());
    const result = await owner.choose({ kind: "source", world: "w", path: "/var/tmp/source" }, invocation, AbortSignal.timeout(1_000));
    expect(result).toEqual({ ok: true, value: { request: { kind: "source", world: "w", path: "/var/tmp/source" } } });
  });

  test("exactly one selector is required, and the refusals name the field", async () => {
    const owner = createProductOwner(deps());
    const call = (request: unknown) => owner.choose(request, invocation, AbortSignal.timeout(1_000));
    for (const [request, expected] of [
      [{ kind: "source", world: "w" }, "exactly one of path or destinationKey"],
      [{ kind: "source", world: "w", path: "/p", destinationKey: "mirror" }, "exactly one of path or destinationKey"],
      // A destination is only meaningful for a replica.
      [{ kind: "backup", world: "w", destinationKey: "mirror" }, "only a replica selection"],
      // A URL is not a destination name; the deployment names destinations.
      [{ kind: "replica", world: "w", destinationKey: "https://evil.example/x.git" }, "plain name"],
      [{ kind: "replica", world: "w", destinationKey: "../escape" }, "plain name"],
      // A model cannot smuggle a different field name past the decoder: the wire
      // name is exactly `destinationKey`, and a snake_case caller is refused rather
      // than silently accepted as a second spelling of the same thing.
      [{ kind: "replica", world: "w", destination_key: "mirror" }, "unknown fields"],
      [{ kind: "replica", world: "w", destination: "mirror" }, "unknown fields"],
    ] as const) {
      const result = await call(request) as { ok: boolean; error?: { code: string; message: string } };
      expect(result.ok, JSON.stringify(request)).toBe(false);
      expect(result.error?.message).toContain(expected);
    }
  });
});

describe("destinations picker read", () => {
  test("returns only key and identity", async () => {
    const owner = createProductOwner(deps({ destinations: async () => ({ ok: true, value: [{ key: "mirror", identity: "mirror-host" }] }) as never }));
    const result = await owner.destinations({}, invocation, AbortSignal.timeout(1_000));
    expect(result).toEqual({ ok: true, value: [{ key: "mirror", identity: "mirror-host" }] });
  });

  test("a Host with no declared destinations says so instead of returning nothing", async () => {
    const owner = createProductOwner(deps());
    const result = await owner.destinations({}, invocation, AbortSignal.timeout(1_000)) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("storage_unavailable");
  });

  test("it takes no parameters and is owner-only", async () => {
    const owner = createProductOwner(deps({ destinations: async () => ({ ok: true, value: [] }) as never }));
    const withParams = await owner.destinations({ key: "mirror" }, invocation, AbortSignal.timeout(1_000)) as { ok: boolean; error?: { message: string } };
    expect(withParams.ok).toBe(false);
    expect(withParams.error?.message).toContain("empty request");
    // No invocation at all is not the authenticated owner.
    const anonymous = await owner.destinations({}, undefined, AbortSignal.timeout(1_000)) as { ok: boolean };
    expect(anonymous.ok).toBe(false);
  });
});
