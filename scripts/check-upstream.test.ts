import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DSH_VERSION,
  DSH_REGISTRY_PACKAGES,
  DSH_RUNTIME_PACKAGE,
  SUPPORTED_DSH_VERSIONS,
} from "../adapters/dsh/compatibility";
import {
  checkUpstream,
  classify,
  classifyTag,
  DECISIVE_RUNTIME_TAGS,
  EXIT,
  renderReport,
  roleOf,
  statusText,
  type CheckUpstreamOptions,
} from "./check-upstream";

/**
 * Every test injects a controlled registry. Nothing here reaches the network: a
 * real request would make the suite depend on npm's current tags, which is the
 * very state this command exists to observe.
 */
interface Route {
  status?: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
  throws?: boolean;
}

function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const name = decodeURIComponent(url.split("/").pop() ?? "");
    const route = routes[name];
    if (route === undefined) throw new Error(`unexpected request for ${name}`);
    if (route.delayMs !== undefined) {
      // Honour the abort signal the way a real fetch does; otherwise a timeout
      // test would pass for the wrong reason (or hang).
      const signal = (init as RequestInit | undefined)?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("The operation was aborted."));
        });
      });
    }
    if (route.throws === true) throw new Error("connection refused");
    return new Response(route.raw !== undefined ? route.raw : JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** A registry where every package advertises the same tags and publishes `versions`. */
function registry(
  tags: Record<string, string>,
  versions: readonly string[] = SUPPORTED_DSH_VERSIONS,
): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const name of DSH_REGISTRY_PACKAGES) {
    routes[name] = {
      body: { "dist-tags": tags, versions: Object.fromEntries(versions.map((v) => [v, {}])) },
    };
  }
  return routes;
}

const options = (routes: Record<string, Route>, extra: Partial<CheckUpstreamOptions> = {}) =>
  ({
    registry: "https://fixture.test",
    fetchImpl: fakeFetch(routes),
    ...extra,
  }) as CheckUpstreamOptions;

describe("role and tag classification", () => {
  test("the runtime is distinguished from its peers", () => {
    expect(roleOf(DSH_RUNTIME_PACKAGE)).toBe("runtime");
    for (const name of DSH_REGISTRY_PACKAGES) {
      if (name === DSH_RUNTIME_PACKAGE) continue;
      expect(roleOf(name)).toBe("peer");
    }
  });

  test("only latest and next decide the runtime verdict", () => {
    expect([...DECISIVE_RUNTIME_TAGS]).toEqual(["latest", "next"]);
    expect(classifyTag("runtime", "latest", DEFAULT_DSH_VERSION)).toBe("supported-current");
    // A pre-release channel may sit behind the tested default; it must not warn.
    expect(classifyTag("runtime", "alpha", "0.2.2-alpha.3")).toBe("informational");
  });

  test("every peer tag is informational, including a stale latest", () => {
    for (const tag of ["latest", "next", "alpha", "beta"]) {
      expect(classifyTag("peer", tag, "0.0.1-rc.1")).toBe("informational");
    }
  });

  test("anything outside the exact set is unsupported, never inferred from shape", () => {
    for (const version of ["0.2.2-rc.6", "0.3.0", ">=0.2.2-rc.4", "^0.2.2-rc.4", "", "0.2.2-rc.5 "]) {
      expect(classify(version)).toBe("unsupported");
    }
  });

  test("status text names the required verification for an unsupported tag", () => {
    expect(statusText("unsupported")).toContain("needs verification");
    expect(statusText("supported-current")).toContain("current default");
    expect(statusText("informational")).toContain("not a support signal");
  });
});

describe("checkUpstream: healthy registry", () => {
  test("latest on the default release exits 0", async () => {
    const report = await checkUpstream(
      options(registry({ latest: DEFAULT_DSH_VERSION, next: DEFAULT_DSH_VERSION })),
    );
    expect(report.code).toBe(EXIT.supported);
    expect(report.unsupported).toBe(0);
    expect(report.missing).toBe(0);
  });

  test("a stale peer latest does not drive the exit code", async () => {
    // The real registry state on 2026-11-20: peers advertise 0.0.1-rc.1 on
    // latest while the runtime is on rc.5. That is not a support question.
    const routes = registry({ latest: DEFAULT_DSH_VERSION, next: DEFAULT_DSH_VERSION });
    for (const name of DSH_REGISTRY_PACKAGES) {
      if (name === DSH_RUNTIME_PACKAGE) continue;
      routes[name] = {
        body: {
          "dist-tags": { latest: "0.0.1-rc.1", next: DEFAULT_DSH_VERSION },
          versions: Object.fromEntries(SUPPORTED_DSH_VERSIONS.map((v) => [v, {}])),
        },
      };
    }
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.supported);
    expect(report.unsupported).toBe(0);
  });

  test("a runtime alpha behind the tested default stays informational", async () => {
    const report = await checkUpstream(
      options(registry({ latest: DEFAULT_DSH_VERSION, alpha: "0.2.2-alpha.3" })),
    );
    expect(report.code).toBe(EXIT.supported);
    expect(report.packages[0].tags.find((row) => row.tag === "alpha")?.verdict).toBe(
      "informational",
    );
  });

  test("a tag still on an older supported release is supported, not stale", async () => {
    const older = SUPPORTED_DSH_VERSIONS.find((v) => v !== DEFAULT_DSH_VERSION)!;
    const report = await checkUpstream(options(registry({ latest: older })));
    expect(report.code).toBe(EXIT.supported);
    expect(report.packages[0].tags[0].verdict).toBe("supported-tested");
  });

  test("the report restates the supported set and the default", async () => {
    const text = renderReport(
      await checkUpstream(options(registry({ latest: DEFAULT_DSH_VERSION }))),
    );
    for (const version of SUPPORTED_DSH_VERSIONS) expect(text).toContain(version);
    expect(text).toContain(`default ${DEFAULT_DSH_VERSION}`);
  });
});

describe("checkUpstream: unsupported candidate", () => {
  test("a runtime latest outside the set exits 1 and claims no compatibility", async () => {
    const report = await checkUpstream(
      options(registry({ latest: "0.2.2-rc.6", next: DEFAULT_DSH_VERSION })),
    );
    expect(report.code).toBe(EXIT.candidate);
    expect(report.unsupported).toBe(1);
    const text = renderReport(report);
    expect(text).toContain("needs verification");
    expect(text).toContain("not claim compatibility");
  });

  test("a future runtime next also exits 1", async () => {
    const report = await checkUpstream(
      options(registry({ latest: DEFAULT_DSH_VERSION, next: "0.3.0" })),
    );
    expect(report.code).toBe(EXIT.candidate);
  });

  test("a peer tag outside the set never causes exit 1", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[1]] = {
      body: {
        "dist-tags": { latest: "9.9.9" },
        versions: Object.fromEntries(SUPPORTED_DSH_VERSIONS.map((v) => [v, {}])),
      },
    };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.supported);
  });
});

describe("checkUpstream: broken registry", () => {
  test("a non-200 response exits 2 and reports the status", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { status: 503, raw: "unavailable" };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.packages[0].failure).toContain("HTTP 503");
  });

  test("invalid JSON exits 2 instead of throwing", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { raw: "<html>not json</html>" };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.packages[0].failure).toContain("not valid JSON");
  });

  test("a missing dist-tags field exits 2", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { body: { versions: {} } };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.packages[0].failure).toContain("no dist-tags");
  });

  test("empty dist-tags exits 2", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { body: { "dist-tags": {} } };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.packages[0].failure).toContain("empty");
  });

  test("a connection failure exits 2", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { throws: true };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.packages[0].failure).toContain("request failed");
  });

  test("a timeout exits 2 and says so", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { delayMs: 5_000, body: {} };
    const report = await checkUpstream(options(routes, { timeoutMs: 50 }));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.packages[0].failure).toContain("timed out");
  });

  test("a failed query outranks an unsupported tag", async () => {
    const routes = registry({ latest: "0.2.2-rc.6" });
    routes[DSH_REGISTRY_PACKAGES[1]] = { status: 500 };
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.unsupported).toBeGreaterThan(0);
  });

  test("a supported release missing from a required package exits 2", async () => {
    // A fresh install of the documented default would fail, so this is a real
    // defect rather than a version observation.
    const routes = registry({ latest: DEFAULT_DSH_VERSION }, [DEFAULT_DSH_VERSION]);
    const report = await checkUpstream(options(routes));
    expect(report.code).toBe(EXIT.queryFailed);
    expect(report.missing).toBeGreaterThan(0);
    expect(renderReport(report)).toContain("MISSING supported releases");
  });

  test("the failure report never presents itself as an incompatibility verdict", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { status: 500 };
    const text = renderReport(await checkUpstream(options(routes)));
    expect(text).toContain("failed");
    expect(text).toContain("not evidence of incompatibility");
  });
});

describe("checkUpstream: safety properties", () => {
  test("no credentials or environment values are printed", async () => {
    process.env.DSH_SECRET_TOKEN = "super-secret-value";
    try {
      const text = renderReport(
        await checkUpstream(options(registry({ latest: DEFAULT_DSH_VERSION }))),
      );
      expect(text).not.toContain("super-secret-value");
      expect(text).not.toContain("DSH_SECRET_TOKEN");
    } finally {
      delete process.env.DSH_SECRET_TOKEN;
    }
  });

  test("rows are ordered deterministically by tag name", async () => {
    const report = await checkUpstream(
      options(
        registry({ zeta: "0.2.2-rc.6", alpha: DEFAULT_DSH_VERSION, next: DEFAULT_DSH_VERSION }),
      ),
    );
    expect(report.packages[0].tags.map((row) => row.tag)).toEqual(["alpha", "next", "zeta"]);
  });

  test("a failing package does not hide the others", async () => {
    const routes = registry({ latest: DEFAULT_DSH_VERSION });
    routes[DSH_REGISTRY_PACKAGES[0]] = { status: 500 };
    const report = await checkUpstream(options(routes));
    const readable = report.packages.filter((entry) => entry.failure === undefined);
    expect(readable.length).toBe(DSH_REGISTRY_PACKAGES.length - 1);
    expect(readable.every((entry) => entry.tags.length > 0)).toBe(true);
  });

  test("every package reports which supported releases are published", async () => {
    const report = await checkUpstream(options(registry({ latest: DEFAULT_DSH_VERSION })));
    for (const entry of report.packages) {
      expect(entry.published).toEqual([...SUPPORTED_DSH_VERSIONS]);
      expect(entry.missing).toEqual([]);
    }
  });
});
