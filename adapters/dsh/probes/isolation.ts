/**
 * Execution-world isolation probes: real `confine` + `spawn` checks against the
 * `@deepseek-ai/dsh-sandbox-local` provider loaded from an install directory
 * (`INSTALL_DIR`) of a tested DSH release. Every verdict below comes from
 * actually spawning the confined argv; nothing infers confinement from kernel
 * ABI presence or from types alone.
 *
 * Three-state honesty contract:
 * - `PASS`    — expected success observed after a real confined spawn.
 * - `REFUSED` — expected denial observed (nonzero exit without a runner-failure
 *               signature) after a real confined spawn.
 * - `UNVERIFY`— this environment could not verify (no install dir, provider
 *               load failure, runner failed before executing the command).
 * - `FAIL`    — observed behavior contradicts the expectation; the check
 *               process exits 1.
 *
 * Container-internal results are evidence about the environment that ran the
 * probes only. They must never be reported as "the Host is confined" unless
 * this script ran on the Host itself; the same command re-runs unchanged on a
 * real Host and produces the same three-state verdicts there.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  DSH_RELEASE_PACKAGES,
  judgeProbeShadow,
  judgeReleases,
  supportedVersionsText,
  type ReleaseReading,
} from '../compatibility.ts';

/** Expectation attached to a probe. */
export type ProbeExpect = 'pass' | 'refused';
/** Four-way verdict per probe. */
export type Verdict = 'PASS' | 'REFUSED' | 'UNVERIFY' | 'FAIL';

/** Minimal structural view of a confined wrap result (`ConfinedArgv`). */
export interface ConfinedResultLike {
  argv: string[];
  enforcement?: string;
  denialSignatures?: readonly string[];
  runnerFailureRules?: readonly {
    allowedExitCodes?: readonly number[];
    fatalSignatures: readonly string[];
    informationalLines?: readonly string[];
  }[];
}

/** Minimal structural view of a spawnSync result. */
export interface SpawnResultLike {
  status: number | null;
  signal?: string | null;
  stderr?: Buffer | string | null;
  error?: Error | null;
}

export interface SpawnFn {
  (argv: string[], options?: { env?: Record<string, string> }): SpawnResultLike;
}

export interface ConfineFn {
  (argv: string[], policy: {
    mode: 'read-only' | 'workspace-write';
    workspaceRoot: string;
    additionalWritableRoots?: readonly string[];
  }): Promise<ConfinedResultLike>;
}

/** One probe: what runs, under what policy, and what outcome is expected. */
export interface ProbeDef {
  name: string;
  expect: ProbeExpect;
  mode: 'read-only' | 'workspace-write';
  script: string;
  /** `workspace-write` extra writable roots; read-only ignores grants. */
  additionalWritableRoots?: readonly string[];
  /** Extra environment for the confined child (e.g. git identity). */
  env?: Record<string, string>;
}

export interface ProbeResult {
  index: number;
  name: string;
  expect: ProbeExpect;
  verdict: Verdict;
  exitCode: number | null;
  /** Enforcement reported by the backend for this wrap ('full'/'partial'). */
  enforcement: string | null;
  /** Short evidence: stderr tail or the reason verification was impossible. */
  detail: string;
}

const DETAIL_LIMIT = 160;

function stderrTail(result: SpawnResultLike): string {
  const raw = result.stderr;
  const text = typeof raw === 'string' ? raw : raw ? raw.toString() : '';
  return text.trim().slice(-DETAIL_LIMIT);
}

function matchesAny(text: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns) return false;
  const lower = text.toLowerCase();
  return patterns.some((p) => p.length > 0 && lower.includes(p.toLowerCase()));
}

function excludedLine(line: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns) return false;
  const lower = line.toLowerCase();
  return patterns.some((p) => p.toLowerCase() === lower);
}

/**
 * Classify one confined spawn into 'ok' | 'denied' | 'runner-failed' |
 * 'unavailable', honoring the backend's own runner-failure rules (a runner
 * that refuses its profile means the command never ran — confinement was not
 * exercised, so the result must be UNVERIFY, not REFUSED).
 */
export function observeSpawn(
  result: SpawnResultLike,
  confined: ConfinedResultLike | null,
): 'ok' | 'denied' | 'runner-failed' | 'unavailable' {
  if (result.error) return 'unavailable';
  if (result.status === null) return 'unavailable';
  if (result.status === 0) return 'ok';
  const stderrText = typeof result.stderr === 'string'
    ? result.stderr
    : result.stderr
      ? result.stderr.toString()
      : '';
  const lines = stderrText.split(/\r?\n/);
  for (const rule of confined?.runnerFailureRules ?? []) {
    const gated = rule.allowedExitCodes ? rule.allowedExitCodes.includes(result.status) : true;
    if (!gated) continue;
    for (const line of lines) {
      if (excludedLine(line, rule.informationalLines)) continue;
      if (matchesAny(line, rule.fatalSignatures)) return 'runner-failed';
    }
  }
  return 'denied';
}

export function classify(
  observation: ReturnType<typeof observeSpawn>,
  expect: ProbeExpect,
): Verdict {
  if (observation === 'unavailable' || observation === 'runner-failed') return 'UNVERIFY';
  if (observation === 'ok') return expect === 'pass' ? 'PASS' : 'FAIL';
  // observation === 'denied'
  return expect === 'refused' ? 'REFUSED' : 'FAIL';
}

/**
 * Run one probe: wrap, actually spawn the confined argv, classify, and report.
 * Never returns PASS without a real confined spawn having produced the
 * observed outcome.
 */
export async function runProbe(
  def: ProbeDef,
  index: number,
  workspaceRoot: string,
  confine: ConfineFn,
  spawn: SpawnFn,
): Promise<ProbeResult> {
  const base: ProbeResult = {
    index, name: def.name, expect: def.expect, verdict: 'UNVERIFY',
    exitCode: null, enforcement: null, detail: '',
  };
  let confined: ConfinedResultLike;
  try {
    confined = await confine(['sh', '-c', def.script], {
      mode: def.mode,
      workspaceRoot,
      ...(def.additionalWritableRoots ? { additionalWritableRoots: def.additionalWritableRoots } : {}),
    });
  } catch (err) {
    return { ...base, detail: `confine rejected: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
  // Fail-closed guard: a "confined" wrap that returns the caller's own argv
  // unchanged is not evidence of confinement, so never run it as one.
  if (!Array.isArray(confined.argv) || confined.argv.length < 4 || confined.argv[0] === 'sh') {
    return { ...base, detail: 'confine returned a non-runner argv; refusing to treat it as confinement' };
  }
  const enforcement = typeof confined.enforcement === 'string' ? confined.enforcement : null;
  let result: SpawnResultLike;
  try {
    result = spawn(confined.argv, def.env ? { env: def.env } : undefined);
  } catch (err) {
    return { ...base, enforcement, detail: `spawn threw: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
  const observation = observeSpawn(result, confined);
  const verdict = classify(observation, def.expect);
  const dialectNote = observation === 'denied'
    && !matchesAny(stderrTail(result), confined.denialSignatures)
    ? ' (stderr does not match the backend denial dialect)'
    : '';
  return {
    index,
    name: def.name,
    expect: def.expect,
    verdict,
    exitCode: result.status,
    enforcement,
    detail: (observation === 'ok'
      ? 'exit 0'
      : stderrTail(result) || `exit ${result.status}`) + dialectNote,
  };
}

/** The loaded provider plus its provenance, for audit output. */
export interface LoadedProvider {
  confine: ConfineFn;
  /** Absolute path of the loaded @deepseek-ai/dsh-sandbox-local entry. */
  source: string;
  /** Declared package version of the loaded build (best effort). */
  version: string | null;
  /** The DSH release the install provides; loading fails unless it is tested. */
  release: string;
}

/**
 * Resolve one package through `resolver` (anchored at the install dir) and
 * require the resolved file to live under `rootReal`. Node/Bun fall back to
 * ANCESTOR directory resolution when the install dir has no node_modules, so
 * an INSTALL_DIR without its own dependencies can silently load a provider
 * from somewhere else entirely; that would make probe results describe a
 * provider build this command never pointed at. Fail closed instead.
 */
export function resolveWithin(
  rootReal: string,
  resolver: (pkg: string) => string,
  pkg: string,
): { path: string } | { error: string } {
  let resolved: string;
  try {
    resolved = resolver(pkg);
  } catch (err) {
    return { error: `${pkg} not resolvable from the install dir: ${(err as Error).message.split('\n')[0].slice(0, DETAIL_LIMIT)}` };
  }
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch (err) {
    return { error: `${pkg} resolved to ${resolved} which cannot be stat'ed: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!resolvedReal.startsWith(prefix)) {
    return { error: `resolved ${pkg} outside INSTALL_DIR: ${resolvedReal}` };
  }
  return { path: resolved };
}

/**
 * Read the DSH release an install provides.
 *
 * The sandbox provider build is not self-identifying in a way that proves the
 * release, so the release is read from the packages the install actually
 * contains and judged against the tested set. A mixed or unknown install is
 * refused here rather than producing verdicts attributed to the wrong release.
 */
export function installRelease(
  installDir: string,
  resolver: (pkg: string) => string,
): { release: string } | { error: string } {
  const readings: ReleaseReading[] = DSH_RELEASE_PACKAGES.map((name) => {
    try {
      const manifest = resolver(`${name}/package.json`);
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
      return { package: name, version: typeof parsed.version === 'string' ? parsed.version : undefined };
    } catch {
      return { package: name, version: undefined };
    }
  });
  const verdict = judgeReleases(readings, { require: DSH_RELEASE_PACKAGES });
  if (!verdict.ok) {
    return {
      error: `install is not a tested DSH release (${supportedVersionsText()}): ${verdict.problems.join('; ')}`,
    };
  }

  // A probe-private peer copy is the other half of the mixed shape: the host is
  // consistent, but the plugin would load a different release than the host it
  // runs in. Read it from the probe's own nested node_modules, if any.
  const probeDir = join(installDir, 'node_modules', 'dsh-ensemble-probe', 'node_modules');
  const shadow: ReleaseReading[] = existsSync(probeDir)
    ? DSH_RELEASE_PACKAGES.flatMap((name) => {
        const manifest = join(probeDir, name, 'package.json');
        if (!existsSync(manifest)) return [];
        try {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
          const version = typeof parsed.version === 'string' ? parsed.version : undefined;
          return [{ package: name, version }];
        } catch {
          return [];
        }
      })
    : [];
  const shadowVerdict = judgeProbeShadow(readings, shadow);
  if (!shadowVerdict.ok) {
    return { error: `mixed DSH install: ${shadowVerdict.problems.join('; ')}` };
  }
  return { release: readings[0]?.version ?? '' };
}

/** Load the local sandbox provider from an install dir; error on failure. */
export function loadProvider(installDir: string): { provider: LoadedProvider } | { error: string } {
  try {
    if (!existsSync(installDir)) {
      return { error: `install dir does not exist: ${installDir}` };
    }
    const rootReal = realpathSync(installDir);
    const requireFromInstall = createRequire(join(installDir, 'package.json'));
    // Judge the release before resolving the provider. Otherwise an install of
    // an untested release reports "provider not resolvable", which describes a
    // missing file rather than the actual reason nothing may be verified.
    const releaseResult = installRelease(installDir, (pkg) => requireFromInstall.resolve(pkg));
    if ('error' in releaseResult) return releaseResult;
    const sandboxLocalResult = resolveWithin(rootReal, (pkg) => requireFromInstall.resolve(pkg), '@deepseek-ai/dsh-sandbox-local');
    if ('error' in sandboxLocalResult) return sandboxLocalResult;
    const cordisResult = resolveWithin(rootReal, (pkg) => requireFromInstall.resolve(pkg), '@deepseek-ai/cordis');
    if ('error' in cordisResult) return cordisResult;
    const sandboxLocal: any = requireFromInstall('@deepseek-ai/dsh-sandbox-local');
    const cordis: any = requireFromInstall('@deepseek-ai/cordis');
    if (typeof sandboxLocal?.LocalSandboxProvider !== 'function') {
      return { error: '@deepseek-ai/dsh-sandbox-local did not export LocalSandboxProvider' };
    }
    if (typeof cordis?.Context !== 'function') {
      return { error: '@deepseek-ai/cordis did not export Context' };
    }
    let version: string | null = null;
    try {
      version = requireFromInstall('@deepseek-ai/dsh-sandbox-local/package.json').version ?? null;
    } catch { /* provenance is best effort; the resolved path is the authoritative fact */ }
    const provider = new sandboxLocal.LocalSandboxProvider(new cordis.Context(), {
      runnerCommand: [],
      runnerFailureSignatures: [],
      probeTimeoutMs: 5000,
    });
    return {
      provider: {
        confine: (argv, policy) =>
          provider.confine(argv, policy) as Promise<ConfinedResultLike>,
        source: sandboxLocalResult.path,
        version,
        release: releaseResult.release,
      },
    };
  } catch (err) {
    return { error: `provider load failed: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
}

export interface ProbeWorld {
  /** Fresh mkdtemp workspace every probe set writes under. */
  root: string;
  /** Fresh non-temp escape target (outside /tmp & os.tmpdir()). */
  escapeRoot: string;
  /** Second escape target used as the ungranted control in the extra-root probe. */
  escapeSibling: string;
  dispose: () => void;
}

/** Best-effort writability probe for the escape-target parent. */
function writableDir(dir: string): boolean {
  const probe = join(dir, `.dsh-iso-writable-${Date.now()}`);
  try {
    mkdirSync(probe, { recursive: true });
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the probe world: all directories are freshly created, nothing
 * pre-existing in the user's tree is ever written. The escape targets live
 * under the home directory on purpose: `/tmp` and `os.tmpdir()` are the
 * documented backend temp areas that `workspace-write` allows (dsh-sandbox
 * roots.ts grants canonical `/tmp` and `os.tmpdir()`), so they cannot serve as
 * escape targets — writing there is by-design writable, not an escape.
 */
export function createProbeWorld(): ProbeWorld | { error: string } {
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), 'dsh-iso-root-'));
  } catch (err) {
    return { error: `cannot create probe root: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inRoot = join(root, 'in');
  // Escape targets must live OUTSIDE every documented writable root
  // (/tmp, os.tmpdir(), the workspace, extra grants). Prefer the home
  // directory; where the home filesystem is read-only (some containers),
  // fall back to /var/tmp, which no backend profile grants for writes.
  let escapeParent = homedir();
  if (!writableDir(escapeParent)) escapeParent = '/var/tmp';
  const escapeRoot = join(escapeParent, `.dsh-iso-esc-${stamp}`);
  const escapeSibling = join(escapeParent, `.dsh-iso-esc-${stamp}-ctl`);
  const dispose = () => {
    for (const dir of [root, escapeRoot, escapeSibling]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  try {
    mkdirSync(inRoot, { recursive: true });
    mkdirSync(escapeRoot, { recursive: true });
    mkdirSync(escapeSibling, { recursive: true });
  } catch (err) {
    dispose();
    return { error: `cannot prepare escape targets under ${escapeParent}: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
  // Symlink escape fixtures: a directory link and a file link pointing
  // outside the workspace root.
  try {
    symlinkSync(escapeRoot, join(root, 'link-out'));
    symlinkSync(join(escapeRoot, 'file'), join(root, 'file-link'));
  } catch (err) {
    dispose();
    return { error: `cannot create symlink fixtures: ${(err as Error).message.slice(0, DETAIL_LIMIT)}` };
  }
  return { root, escapeRoot, escapeSibling, dispose };
}

export function buildProbes(world: ProbeWorld): ProbeDef[] {
  const { root, escapeRoot, escapeSibling } = world;
  const w = (p: string) => `echo probe > '${p}'`;
  return [
    {
      name: 'workspace-write-in-root',
      expect: 'pass',
      mode: 'workspace-write',
      script: w(join(root, 'in', 'a.txt')),
    },
    {
      name: 'workspace-write-outside-root',
      expect: 'refused',
      mode: 'workspace-write',
      script: w(join(escapeRoot, 'a.txt')),
    },
    {
      name: 'symlink-dir-escape',
      expect: 'refused',
      mode: 'workspace-write',
      script: w(join(root, 'link-out', 'b.txt')),
    },
    {
      name: 'symlink-file-escape',
      expect: 'refused',
      mode: 'workspace-write',
      script: w(join(root, 'file-link')),
    },
    {
      name: 'read-only-in-root-write',
      expect: 'refused',
      mode: 'read-only',
      script: w(join(root, 'in', 'b.txt')),
    },
    {
      name: 'read-only-dev-null-sink',
      expect: 'pass',
      mode: 'read-only',
      script: 'echo probe > /dev/null',
    },
    {
      name: 'read-only-read-outside',
      expect: 'pass',
      mode: 'read-only',
      script: 'cat /etc/os-release > /dev/null 2>&1 || cat /etc/hostname > /dev/null 2>&1',
    },
    {
      name: 'extra-root-grant-writable',
      expect: 'pass',
      mode: 'workspace-write',
      script: w(join(escapeRoot, 'granted.txt')),
      additionalWritableRoots: [escapeRoot],
    },
    {
      name: 'extra-root-ungranted-refused',
      expect: 'refused',
      mode: 'workspace-write',
      script: w(join(escapeSibling, 'ungranted.txt')),
      additionalWritableRoots: [escapeRoot],
    },
    {
      name: 'git-init-commit-fresh-root',
      expect: 'pass',
      mode: 'workspace-write',
      // Only inside the fresh probe root; never touches any user repository.
      script:
        `git init -q '${root}' && git -C '${root}' -c user.name=iso-probe -c user.email=iso-probe@invalid` +
        ` commit --allow-empty -qm 'isolation probe'`,
      env: { HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    },
    {
      name: 'fsync-fresh-root-file',
      expect: 'pass',
      mode: 'workspace-write',
      script:
        `echo probe > '${join(root, 'in', 'c.txt')}' && ` +
        `(sync -d '${join(root, 'in', 'c.txt')}' 2>/dev/null || sync '${join(root, 'in', 'c.txt')}')`,
    },
  ];
}

export interface IsolationRunOptions {
  /** Inject for tests; defaults to node spawnSync. */
  spawn?: SpawnFn;
  /** Inject for tests; defaults to the provider loaded from installDir. */
  confine?: ConfineFn;
  /** Inject for tests; replaces the world-derived probe definitions. */
  probeDefs?: ProbeDef[];
  /** Observation mode: same output, always exit 0, first line OBSERVATION ONLY. */
  observe?: boolean;
}

export interface IsolationRunReport {
  lines: string[];
  exitCode: number;
  counts: Record<Verdict | 'total', number>;
  envScope: string;
}

function countVerdicts(results: ProbeResult[]): IsolationRunReport['counts'] {
  const counts = { PASS: 0, REFUSED: 0, UNVERIFY: 0, FAIL: 0, total: 0 } as IsolationRunReport['counts'];
  for (const r of results) {
    counts[r.verdict] += 1;
    counts.total += 1;
  }
  return counts;
}

const noInstallDirGuidance =
  'provider-load (no INSTALL_DIR given; re-run with: make isolation-check INSTALL_DIR=<a tested DSH install dir>)';

/** Static non-coverage declaration shared by every report shape. */
const NOT_COVERED =
  'not covered: Host-side process/FS coordinates, other enforcement rungs (bwrap/Seatbelt/Windows-ACL), ' +
  'partial-enforcement branch, P2 archive composition';

function configErrorReport(reason: string, installDir: string | null): IsolationRunReport {
  const lines = installDir
    ? [
        `CONFIG ERROR: INSTALL_DIR=${installDir} was requested but is unusable, so nothing was verified: ${reason.replace(/"/g, "'")}`,
        'coverage: 0/11 probes executed (necessary checks were not run)',
        NOT_COVERED,
        'SUMMARY pass=0 refused=0 unverify=0 fail=0 total=0',
        `UNVERIFIED: provider-load from INSTALL_DIR=${installDir} (config error, nothing verified)`,
        '== exit code 2 (unverified: requested install unavailable)',
      ]
    : [
        `provider-load verdict=UNVERIFY detail="${reason.replace(/"/g, "'")}"`,
        'coverage: 0/11 probes executed (necessary checks were not run)',
        NOT_COVERED,
        'SUMMARY pass=0 refused=0 unverify=0 fail=0 total=0',
        `UNVERIFIED: ${noInstallDirGuidance}`,
        '== exit code 2 (unverified: necessary checks were not run)',
      ];
  return { lines, exitCode: 2, counts: { PASS: 0, REFUSED: 0, UNVERIFY: 0, FAIL: 0, total: 0 }, envScope: 'n/a' };
}

/**
 * Full run: load provider (when an install dir is given), create the probe
 * world, execute every probe with a real confined spawn, and produce
 * machine-readable lines plus the process exit code.
 *
 * Gate-vs-observation contract (`-check` is a gate, not an observer):
 * - gate mode (default): exit 0 only when the provider loaded, ALL probes
 *   executed and every verdict matched its expectation; exit 1 when a probe
 *   observed behavior contradicting its expectation; exit 2 when a necessary
 *   precondition was not met (no INSTALL_DIR, unusable install, provider
 *   unresolvable or outside the install dir). Summary text never rescues a
 *   green exit code.
 * - observe mode (`--observe`): same output, but exit code 0 always, and the
 *   first line states OBSERVATION ONLY so the run cannot be mistaken for a
 *   passing check.
 */
export async function runIsolationChecks(
  installDir: string | null,
  options: IsolationRunOptions = {},
): Promise<IsolationRunReport> {
  const lines: string[] = [];
  const spawn = options.spawn ?? ((argv, opts) =>
    spawnSync(argv[0], argv.slice(1), {
      env: opts?.env
        ? { ...process.env, ...opts.env } as Record<string, string>
        : process.env as Record<string, string>,
    }));

  lines.push(`== isolation-check install-dir: ${installDir ?? '(not provided)'}`);
  lines.push(
    '== scope: verdicts describe ONLY the environment that executed these probes; ' +
    'container-internal results must not be reported as Host verification.',
  );

  if (!installDir) {
    const report = configErrorReport('no INSTALL_DIR given; provider was not loaded', null);
    return finalizeObserve({ lines: [...lines, ...report.lines], exitCode: report.exitCode, counts: report.counts, envScope: report.envScope }, options.observe === true);
  }

  const loaded = options.confine
    ? ({ provider: { confine: options.confine, source: '(injected for tests)', version: null, release: '(injected)' } } as { provider: LoadedProvider })
    : loadProvider(installDir);
  if ('error' in loaded) {
    const report = configErrorReport(loaded.error, installDir);
    return finalizeObserve({ lines: [...lines, ...report.lines], exitCode: report.exitCode, counts: report.counts, envScope: report.envScope }, options.observe === true);
  }
  lines.push(`install: DSH ${loaded.provider.release} (tested releases: ${supportedVersionsText()})`);
  lines.push(
    `provider: @deepseek-ai/dsh-sandbox-local${loaded.provider.version ? `@${loaded.provider.version}` : ''} ` +
    `from ${loaded.provider.source} (resolved within INSTALL_DIR, verified by realpath prefix check)`,
  );

  const world = createProbeWorld();
  if ('error' in world) {
    const report = configErrorReport(world.error, installDir);
    return finalizeObserve({ lines: [...lines, ...report.lines], exitCode: report.exitCode, counts: report.counts, envScope: report.envScope }, options.observe === true);
  }

  const results: ProbeResult[] = [];
  let defs: ProbeDef[] = [];
  try {
    defs = options.probeDefs ?? buildProbes(world);
    for (let i = 0; i < defs.length; i++) {
      const result = await runProbe(defs[i], i + 1, world.root, loaded.provider.confine, spawn);
      results.push(result);
    }
  } finally {
    world.dispose();
  }

  for (const r of results) {
    lines.push(
      `probe[${String(r.index).padStart(2, '0')}] ${r.name} verdict=${r.verdict} expect=${r.expect} ` +
      `exit=${r.exitCode === null ? 'null' : r.exitCode} enforcement=${r.enforcement ?? 'unknown'} ` +
      `detail="${r.detail.replace(/"/g, "'")}"`,
    );
  }
  const counts = countVerdicts(results);
  lines.push(`coverage: ${counts.total}/${defs.length} probes executed in the environment that ran this command (not necessarily the Host)`);
  lines.push(NOT_COVERED);
  lines.push(
    `SUMMARY pass=${counts.PASS} refused=${counts.REFUSED} unverify=${counts.UNVERIFY} fail=${counts.FAIL} total=${counts.total}`,
  );
  const unverified = results.filter((r) => r.verdict === 'UNVERIFY');
  lines.push(unverified.length
    ? `UNVERIFIED: ${unverified.map((r) => r.name).join(', ')}`
    : counts.FAIL > 0
      ? 'UNVERIFIED: none (all probes ran; the FAIL verdicts contradict expectations)'
      : 'UNVERIFIED: none');
  const exitCode = counts.FAIL > 0 ? 1 : counts.UNVERIFY > 0 ? 2 : 0;
  lines.push(`== exit code ${exitCode}${counts.UNVERIFY > 0 ? ' (unverified: some probes could not verify)' : counts.FAIL > 0 ? ' (verdicts contradict expectations)' : ''}`);
  const report: IsolationRunReport = { lines, exitCode, counts, envScope: 'the environment that ran this command' };
  return finalizeObserve(report, options.observe === true);
}

/** In observe mode the run never asserts a passing check: always exit 0, with an explicit first line. */
function finalizeObserve(report: IsolationRunReport, observe: boolean): IsolationRunReport {
  if (!observe) return report;
  return {
    ...report,
    lines: [
      'OBSERVATION ONLY — not a check; this run does not assert the execution world is isolated',
      ...report.lines,
    ],
    exitCode: 0,
  };
}
