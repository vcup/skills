#!/usr/bin/env bun
/**
 * Observe published DSH versions and report where they stand against the
 * supported set.
 *
 * This is an **observation**, not a gate and not an upgrade. It reads the public
 * npm registry for the packages this adapter depends on and compares what it
 * finds against `adapters/dsh/compatibility.ts`, the single source of truth for
 * which releases are supported. It never installs, never upgrades, never edits
 * that set, and never treats a registry `latest` string as evidence of support:
 * `latest` is a publisher's choice, not a compatibility claim.
 *
 * **Tags are classified by package role, because they do not mean the same
 * thing.** `@deepseek-ai/dsh` is the runtime, so its dist-tags are release
 * signals. `dsh-skill` and `dsh-tools` are peers: they are versioned in lockstep
 * with the runtime, and their own `latest` tag is a stale dead series
 * (`0.0.1-rc.1`, last published 2026-08-10) that never tracks the runtime. For a
 * peer the meaningful question is not "what does latest say" but "are the
 * releases we support actually published". Treating a stale peer `latest` as a
 * support problem would make this command exit 1 forever, and a permanent
 * warning is indistinguishable from no warning.
 *
 *   bun scripts/check-upstream.ts [--registry <url>] [--timeout <ms>] [--json]
 *
 * Exit codes:
 *   0  the runtime's tags are within the supported set and every supported
 *      release is published for every required package
 *   1  a runtime tag (`latest`/`next`) points outside the supported set — a real
 *      candidate to evaluate; nothing is claimed about it
 *   2  the registry could not be read, or a supported release is missing from a
 *      required package (a fresh install would fail)
 *
 * `1` means "there is something to look at"; `2` means "the observation failed".
 * Conflating them would either hide a new release or invent a verdict from a
 * failed request. Peer tags are reported for information and never decide the
 * exit code.
 *
 * The registry is public and unauthenticated; no token is sent, and no
 * environment variable or credential is printed.
 *
 * @module scripts/check-upstream
 */

import {
  DEFAULT_DSH_VERSION,
  DSH_REGISTRY_PACKAGES,
  DSH_RUNTIME_PACKAGE,
  SUPPORTED_DSH_VERSIONS,
  isSupportedDshVersion,
  supportedVersionsText,
} from "../adapters/dsh/compatibility";

/** Public registry used when nothing overrides it. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Wall-clock limit for one registry request. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Exit codes, named so callers and tests cannot drift from them. */
export const EXIT = {
  supported: 0,
  candidate: 1,
  queryFailed: 2,
} as const;

/** What a package is, which decides how its tags are read. */
export type Role = "runtime" | "peer";

/** Where one observed version stands. */
export type Verdict = "supported-current" | "supported-tested" | "unsupported" | "informational";

export interface TagObservation {
  readonly tag: string;
  readonly version: string;
  readonly verdict: Verdict;
}

export interface PackageObservation {
  readonly package: string;
  readonly role: Role;
  readonly tags: readonly TagObservation[];
  /** Supported releases confirmed published for this package. */
  readonly published: readonly string[];
  /** Supported releases missing from this package. */
  readonly missing: readonly string[];
  /** Set when this package could not be read; `tags` and `published` are then empty. */
  readonly failure?: string;
}

export interface UpstreamReport {
  readonly registry: string;
  readonly packages: readonly PackageObservation[];
  /** Runtime tags that count toward the exit code. */
  readonly supported: number;
  readonly unsupported: number;
  readonly missing: number;
  readonly queryFailures: number;
  /** Exit code this report implies. */
  readonly code: number;
}

export interface CheckUpstreamOptions {
  /** Registry base URL. Tests point this at a local fixture server. */
  registry?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Packages to query; defaults to the adapter's own dependency set. */
  packages?: readonly string[];
}

/**
 * Whether a package name is the runtime or a peer.
 * @param packageName - the package to classify.
 * @returns the role.
 */
export function roleOf(packageName: string): Role {
  return packageName === DSH_RUNTIME_PACKAGE ? "runtime" : "peer";
}

/**
 * Classify one observed version against the supported set.
 * @param version - a version string read from a dist-tag.
 * @returns the verdict; anything outside the exact set is `unsupported`.
 */
export function classify(version: string): Verdict {
  if (!isSupportedDshVersion(version)) return "unsupported";
  return version === DEFAULT_DSH_VERSION ? "supported-current" : "supported-tested";
}

/**
 * Runtime tags that actually announce a release worth evaluating.
 *
 * `latest` and `next` are the promotion channels a consumer installs from.
 * Other channels are not: `alpha` carries a pre-release that may sit *behind*
 * the tested default (today `0.2.2-alpha.3` < `0.2.2-rc.5`), so treating it as
 * a candidate would make this command exit 1 forever. A signal that never
 * clears is indistinguishable from no signal.
 */
export const DECISIVE_RUNTIME_TAGS = ["latest", "next"] as const;

/**
 * Classify one tag, taking the package's role and the tag's channel into account.
 *
 * Only decisive runtime tags carry a release signal. Everything else is
 * informational: a peer's `latest` is a stale series unrelated to the runtime
 * (`0.0.1-rc.1`, last published 2026-08-10), and a runtime `alpha` is a
 * pre-release channel that can lag the tested default.
 * @param role - runtime or peer.
 * @param tag - the dist-tag name.
 * @param version - the version the tag points at.
 * @returns the verdict to display.
 */
export function classifyTag(role: Role, tag: string, version: string): Verdict {
  if (role === "peer") return "informational";
  if (!(DECISIVE_RUNTIME_TAGS as readonly string[]).includes(tag)) return "informational";
  return classify(version);
}

/**
 * Human-readable status for one row, kept separate from the verdict enum.
 * @param verdict - the verdict to render.
 * @returns the status text.
 */
export function statusText(verdict: Verdict): string {
  switch (verdict) {
    case "supported-current":
      return "supported (current default)";
    case "supported-tested":
      return "supported (tested)";
    case "unsupported":
      return "unsupported (not tested — needs verification)";
    case "informational":
      return "informational (not a support signal)";
  }
}

interface RegistryDocument {
  "dist-tags"?: unknown;
  versions?: unknown;
}

/**
 * Read one package's dist-tags and published version list.
 *
 * Every failure is returned as a message instead of thrown, so one unreachable
 * package cannot hide the others; the caller decides the exit code.
 * @param registry - registry base URL.
 * @param packageName - package to read.
 * @param timeoutMs - per-request wall-clock limit.
 * @param fetchImpl - fetch implementation (injected in tests).
 * @returns the document, or a failure message.
 */
async function readRegistryDocument(
  registry: string,
  packageName: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ tags?: Record<string, string>; versions?: string[]; failure?: string }> {
  const url = `${registry.replace(/\/+$/, "")}/${packageName.replace("/", "%2f")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) {
      return { failure: `${packageName}: HTTP ${response.status} from ${url}` };
    }
    let body: RegistryDocument;
    try {
      body = (await response.json()) as RegistryDocument;
    } catch {
      return { failure: `${packageName}: response is not valid JSON` };
    }
    const raw = body["dist-tags"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { failure: `${packageName}: no dist-tags in the registry response` };
    }
    const tags: Record<string, string> = {};
    for (const [tag, version] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof version === "string" && version !== "") tags[tag] = version;
    }
    if (Object.keys(tags).length === 0) {
      return { failure: `${packageName}: dist-tags is empty` };
    }
    const versions =
      body.versions === null || typeof body.versions !== "object" || Array.isArray(body.versions)
        ? []
        : Object.keys(body.versions as Record<string, unknown>);
    return { tags, versions };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      failure: `${packageName}: ${
        controller.signal.aborted ? `timed out after ${timeoutMs}ms` : `request failed (${reason})`
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query every package and build the report. Registry problems never throw.
 * @param options - registry, timeout, fetch and package overrides.
 * @returns the observation and the exit code it implies.
 */
export async function checkUpstream(options: CheckUpstreamOptions = {}): Promise<UpstreamReport> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const packages = options.packages ?? DSH_REGISTRY_PACKAGES;

  const observations: PackageObservation[] = [];
  let supported = 0;
  let unsupported = 0;
  let missing = 0;
  let queryFailures = 0;

  for (const packageName of packages) {
    const role = roleOf(packageName);
    const document = await readRegistryDocument(registry, packageName, timeoutMs, fetchImpl);
    if (document.tags === undefined) {
      queryFailures += 1;
      observations.push({
        package: packageName,
        role,
        tags: [],
        published: [],
        missing: [],
        failure: document.failure ?? "unknown failure",
      });
      continue;
    }

    const rows: TagObservation[] = Object.entries(document.tags)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, version]) => {
        const verdict = classifyTag(role, tag, version);
        // Only runtime tags drive the count; peer tags are informational.
        if (verdict === "unsupported") unsupported += 1;
        else if (verdict !== "informational") supported += 1;
        return { tag, version, verdict };
      });

    // For every package, the supported releases must actually be published: a
    // missing one would break a fresh install of the documented default.
    const publishedVersions = new Set(document.versions ?? []);
    const present = SUPPORTED_DSH_VERSIONS.filter((version) => publishedVersions.has(version));
    const absent = SUPPORTED_DSH_VERSIONS.filter((version) => !publishedVersions.has(version));
    missing += absent.length;

    observations.push({ package: packageName, role, tags: rows, published: present, missing: absent });
  }

  // A failed query outranks everything: an incomplete observation must not be
  // reported as the strongest available conclusion. A missing supported release
  // is a real defect that would break a fresh install, so it fails as well.
  const code =
    queryFailures > 0
      ? EXIT.queryFailed
      : missing > 0
        ? EXIT.queryFailed
        : unsupported > 0
          ? EXIT.candidate
          : EXIT.supported;

  return { registry, packages: observations, supported, unsupported, missing, queryFailures, code };
}

/**
 * Render the report as the human-readable table the Make target prints.
 * @param report - the observation to render.
 * @returns the text, newline-terminated.
 */
export function renderReport(report: UpstreamReport): string {
  const lines: string[] = [];
  lines.push(`registry: ${report.registry}`);
  lines.push(`supported set: ${supportedVersionsText()} (default ${DEFAULT_DSH_VERSION})`);
  lines.push("");
  for (const entry of report.packages) {
    lines.push(`${entry.package}  [${entry.role}]`);
    if (entry.failure !== undefined) {
      lines.push(`  ! ${entry.failure}`);
      continue;
    }
    const width = Math.max(...entry.tags.map((row) => row.tag.length));
    for (const row of entry.tags) {
      lines.push(`  ${row.tag.padEnd(width)}  ${row.version.padEnd(14)} ${statusText(row.verdict)}`);
    }
    lines.push(`  supported releases published: ${entry.published.join(", ") || "(none)"}`);
    if (entry.missing.length > 0) {
      lines.push(`  MISSING supported releases: ${entry.missing.join(", ")}`);
    }
  }
  lines.push("");
  lines.push(
    `SUMMARY runtime-tags=${report.supported + report.unsupported} supported=${report.supported} ` +
      `unsupported=${report.unsupported} missing=${report.missing} query-failures=${report.queryFailures}`,
  );
  if (report.code === EXIT.candidate) {
    lines.push("");
    lines.push("A runtime tag points outside the supported set. Nothing was installed, upgraded,");
    lines.push("or reclassified: evaluating that release is separate work, and this output does");
    lines.push("not claim compatibility with it. Peer tags are informational and never decide this.");
  }
  if (report.code === EXIT.queryFailed) {
    lines.push("");
    lines.push("The registry could not be read completely, or a supported release is not published");
    lines.push("for a required package. No compatibility conclusion is available; this is a failed");
    lines.push("observation, not evidence of incompatibility.");
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: CheckUpstreamOptions = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--registry") options.registry = args[++index];
    else if (arg === "--timeout") {
      const raw = args[++index];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`invalid --timeout value: ${raw ?? "(none)"}`);
        process.exit(EXIT.queryFailed);
      }
      options.timeoutMs = parsed;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(EXIT.queryFailed);
    }
  }

  const report = await checkUpstream(options);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  process.exit(report.code);
}
