/**
 * Check that the committed CLI bundle still matches its provenance.
 *
 * The bundle is a committed artifact, so it can drift in two ways: someone edits
 * it by hand, or the build step changes and the committed copy is stale. Both
 * are silent until a user runs the CLI, which is the worst place to find out, so
 * this check runs in `make check` and fails loudly.
 *
 * It verifies what can be verified **offline**: the file's digest against the
 * provenance, the closure rules (no bare imports but Node builtins, no Host-side
 * package inlined), and that the shipped entry point actually imports the
 * bundle. It deliberately does *not* rebuild: rebuilding needs a DSH install, and
 * the offline gate must not require one. Regeneration is `make dsh-bundle`.
 *
 * @module scripts/check-dsh-bundle
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBundleClosure,
  BUNDLE_OUTPUT,
  BUNDLE_PROVENANCE,
  readCommittedBundle,
  type BundleProvenance,
} from "./build-dsh-bundle.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One check's outcome. */
export interface BundleCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly summary: string;
}

/**
 * Verify the committed bundle without rebuilding it.
 * @param options.root - repository root, for tests.
 * @returns the verdict and a one-line summary.
 */
export function checkBundle(options: { root?: string } = {}): BundleCheck {
  const root = options.root ?? REPO_ROOT;
  const problems: string[] = [];

  const codePath = join(root, BUNDLE_OUTPUT);
  const provenancePath = join(root, BUNDLE_PROVENANCE);
  if (!existsSync(codePath)) problems.push(`${BUNDLE_OUTPUT} is missing`);
  if (!existsSync(provenancePath)) problems.push(`${BUNDLE_PROVENANCE} is missing`);
  if (problems.length > 0) {
    return { ok: false, problems, summary: "the CLI bundle is not built" };
  }

  let provenance: BundleProvenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as BundleProvenance;
  } catch (error) {
    return {
      ok: false,
      problems: [`${BUNDLE_PROVENANCE} is not valid JSON: ${(error as Error).message}`],
      summary: "the CLI bundle provenance is unreadable",
    };
  }
  if (provenance.format !== "dsh-cli-bundle/v1") {
    problems.push(`${BUNDLE_PROVENANCE} has format ${JSON.stringify(provenance.format)}, expected "dsh-cli-bundle/v1"`);
  }

  try {
    readCommittedBundle({ root });
  } catch (error) {
    problems.push((error as Error).message);
  }

  // The closure rules again, on the file as committed: `readCommittedBundle`
  // checks them for the digest it verified, and this repeats them for a reader
  // who only has the file.
  if (problems.length === 0) {
    const body = readFileSync(codePath, "utf8").split("\n\n").slice(1).join("\n\n");
    try {
      assertBundleClosure(body, provenance);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  // The shipped entry point must import the bundle. A bin that still imports the
  // reviewed source would ship a transport that cannot resolve, which is the
  // defect this whole step exists to remove.
  const binPath = join(root, "adapters/dsh/bin/ensemble-archive.js");
  if (!existsSync(binPath)) {
    problems.push("adapters/dsh/bin/ensemble-archive.js is missing");
  } else {
    const bin = readFileSync(binPath, "utf8");
    if (!bin.includes("lib/transport.bundle.mjs")) {
      problems.push("bin/ensemble-archive.js does not import lib/transport.bundle.mjs");
    }
    if (/from\s+["']\.\.\/lib\/transport\.mjs["']/.test(bin)) {
      problems.push(
        "bin/ensemble-archive.js still imports the reviewed source lib/transport.mjs, " +
          "whose bare imports cannot resolve from an installed package",
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    summary: `bundle ${provenance.bytes} bytes, sha256 ${provenance.sha256.slice(0, 12)}…, ${provenance.inputs.length} inputs`,
  };
}

if (import.meta.main) {
  const verdict = checkBundle();
  if (!verdict.ok) {
    for (const problem of verdict.problems) process.stderr.write(`error: ${problem}\n`);
    process.stderr.write(
      "  Regenerate the bundle with `make dsh-bundle DSH_BUNDLE_INSTALL=<isolated DSH install>`.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`== dsh-bundle-check: ok (${verdict.summary})\n`);
}
