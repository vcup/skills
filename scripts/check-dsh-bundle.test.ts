/**
 * Tests for the CLI bundle's offline gate.
 *
 * The bundle is a committed artifact, so the interesting failure is a committed
 * copy that no longer matches what the package will run. These cases drive the
 * real checker against real files: each one writes a fixture tree, breaks one
 * thing, and asserts the checker says so. A checker that cannot fail is worse
 * than no checker, because it certifies whatever happens to be committed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BUNDLE_ENTRY,
  BUNDLE_OUTPUT,
  BUNDLE_PROVENANCE,
  renderBundle,
  renderProvenance,
  type BundleProvenance,
} from "./build-dsh-bundle.ts";
import { checkBundle } from "./check-dsh-bundle.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-bundle-check-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPO_ROOT = join(import.meta.dir, "..");

/** The committed bundle, read from the repository, as a fixture's starting point. */
function committed(): { code: string; provenance: BundleProvenance } {
  const file = readFileSync(join(REPO_ROOT, BUNDLE_OUTPUT), "utf8");
  const body = file.split("\n\n").slice(1).join("\n\n");
  const provenance = JSON.parse(readFileSync(join(REPO_ROOT, BUNDLE_PROVENANCE), "utf8")) as BundleProvenance;
  return { code: body, provenance };
}

/** Write a fixture tree: the bundle, its provenance, and the shipped bin. */
function fixture(options: {
  readonly code?: string;
  readonly provenance?: BundleProvenance;
  readonly bin?: string;
  readonly omitBundle?: boolean;
} = {}): string {
  const root = temporaryRoot();
  mkdirSync(join(root, "adapters/dsh/lib"), { recursive: true });
  mkdirSync(join(root, "adapters/dsh/bin"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, BUNDLE_ENTRY), readFileSync(join(REPO_ROOT, BUNDLE_ENTRY)));
  writeFileSync(join(root, "scripts/build-dsh-bundle.ts"), readFileSync(join(REPO_ROOT, "scripts/build-dsh-bundle.ts")));
  const base = committed();
  const code = options.code ?? base.code;
  const provenance = options.provenance ?? base.provenance;
  if (options.omitBundle !== true) {
    writeFileSync(join(root, BUNDLE_OUTPUT), renderBundle({ code, provenance }));
    writeFileSync(join(root, BUNDLE_PROVENANCE), renderProvenance(provenance));
  }
  writeFileSync(
    join(root, "adapters/dsh/bin/ensemble-archive.js"),
    options.bin ?? 'import { connect } from "../lib/transport.bundle.mjs";\n',
  );
  return root;
}

describe("checkBundle", () => {
  test("the committed bundle in this repository passes", () => {
    const verdict = checkBundle();
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("an unmodified fixture passes, so the failing cases below are the only difference", () => {
    const verdict = checkBundle({ root: fixture() });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("a reviewed transport edit requires regeneration even when the bundle is untouched", () => {
    const root = fixture();
    writeFileSync(join(root, BUNDLE_ENTRY), readFileSync(join(root, BUNDLE_ENTRY), "utf8") + "\n// changed source\n");
    const verdict = checkBundle({ root });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("reviewed transport source");
  });

  test("a generator edit requires regeneration", () => {
    const root = fixture();
    writeFileSync(join(root, "scripts/build-dsh-bundle.ts"), "// changed generator\n");
    const verdict = checkBundle({ root });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("generator");
  });

  test("actual bare imports cannot be hidden by a dishonest externals list", () => {
    const base = committed();
    const code = base.code + '\nimport "unlisted-dependency";\n';
    const provenance = { ...base.provenance, bytes: Buffer.byteLength(code), sha256: createHash("sha256").update(code).digest("hex") };
    const verdict = checkBundle({ root: fixture({ code, provenance }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("unlisted-dependency");
  });

  test("malformed provenance is a failed check rather than a checker crash", () => {
    for (const text of ["null", "{}", '{"format":"dsh-cli-bundle/v2"}']) {
      const root = fixture();
      writeFileSync(join(root, BUNDLE_PROVENANCE), text);
      expect(checkBundle({ root }).ok).toBe(false);
    }
  });

  test("a missing bundle is reported, not treated as an empty pass", () => {
    const verdict = checkBundle({ root: fixture({ omitBundle: true }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("is missing");
  });

  test("a hand-edited bundle is caught by the recorded digest", () => {
    const base = committed();
    // One character changes; the digest in the provenance does not.
    const tampered = `${base.code}\n// edited by hand\n`;
    const verdict = checkBundle({ root: fixture({ code: tampered, provenance: base.provenance }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("does not match the digest");
  });

  test("a bundle that still needs a bare import is refused", () => {
    const base = committed();
    // The exact defect: a transport that needs a resolver the CLI does not have.
    const leaky = `${base.code}\nimport { Context as LeakedContext } from "@deepseek-ai/cordis";\n`;
    const provenance: BundleProvenance = {
      ...base.provenance,
      bytes: Buffer.byteLength(leaky, "utf8"),
      sha256: createHash("sha256").update(leaky, "utf8").digest("hex"),
      externals: [...base.provenance.externals, "@deepseek-ai/cordis"].sort(),
    };
    const verdict = checkBundle({ root: fixture({ code: leaky, provenance }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("still needs");
  });

  test("a bundle carrying a Host-side package is refused", () => {
    const base = committed();
    const provenance: BundleProvenance = {
      ...base.provenance,
      inputs: [
        ...base.provenance.inputs,
        {
          package: "@deepseek-ai/dsh-api-gateway",
          version: "0.2.2-rc.5",
          path: "node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js",
          sha256: "0".repeat(64),
        },
      ],
    };
    const verdict = checkBundle({ root: fixture({ provenance }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("belongs to the Host side");
  });

  test("a bin that still imports the reviewed source is refused", () => {
    const verdict = checkBundle({
      root: fixture({ bin: 'import { connect } from "../lib/transport.mjs";\n' }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("does not import lib/transport.bundle.mjs");
  });
});
