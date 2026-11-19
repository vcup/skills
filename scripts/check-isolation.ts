/**
 * `make isolation-check` entry point (a GATE, not an observer) plus an
 * observation mode.
 *
 * Usage: bun scripts/check-isolation.ts [--observe] [INSTALL_DIR]
 *
 * INSTALL_DIR is an isolated rc.4 install (the same one `make host-check
 * INSTALL_DIR=...` uses).
 *
 * Gate-mode exit codes (default; `*-check` targets must not return green
 * without having verified):
 * - 0 = provider loaded, all probes executed, every verdict matched its
 *   expectation
 * - 1 = some probe observed behavior contradicting its expectation
 * - 2 = unverified: no INSTALL_DIR given, or the requested INSTALL_DIR is
 *   unusable (missing, not an rc.4 install, provider unresolvable or outside
 *   the dir)
 *
 * `--observe` switches to observation mode: identical honest output but the
 * first line reads OBSERVATION ONLY and the exit code is always 0; use it for
 * diagnosis, never as a gate.
 */

import { runIsolationChecks } from '../adapters/dsh/probes/isolation.ts';

const args = process.argv.slice(2);
const observe = args.includes('--observe');
const positional = args.filter((a) => a !== '--observe');
const installDir = positional[0] ?? null;

const report = await runIsolationChecks(installDir, { observe });
for (const line of report.lines) console.log(line);
process.exit(report.exitCode);
