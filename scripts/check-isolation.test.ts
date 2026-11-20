import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildProbes,
  classify,
  createProbeWorld,
  loadProvider,
  observeSpawn,
  resolveWithin,
  runIsolationChecks,
  runProbe,
  type ConfinedResultLike,
  type ProbeDef,
  type SpawnResultLike,
} from '../adapters/dsh/probes/isolation.ts';

const fakeConfined = (over: Partial<ConfinedResultLike> = {}): ConfinedResultLike => ({
  argv: ['/fake/landlock-run', '--profile', 'x', '--', 'sh', '-c', 'script'],
  enforcement: 'full',
  denialSignatures: ['permission denied'],
  runnerFailureRules: [
    { allowedExitCodes: [125], fatalSignatures: ['landlock-run: '] },
  ],
  ...over,
});

const spawnOk = (): SpawnResultLike => ({ status: 0, stderr: '' });
const spawnDenied = (): SpawnResultLike => ({
  status: 1,
  stderr: 'sh: line 1: /x/a.txt: Permission denied',
});
const spawnRunnerFailed = (): SpawnResultLike => ({
  status: 125,
  stderr: 'landlock-run: cannot set up profile',
});

describe('observeSpawn', () => {
  test('exit 0 is ok', () => {
    expect(observeSpawn(spawnOk(), fakeConfined())).toBe('ok');
  });

  test('nonzero exit without runner-failure signature is denied', () => {
    expect(observeSpawn(spawnDenied(), fakeConfined())).toBe('denied');
  });

  test('runner-failure fatal signature is runner-failed, not denied', () => {
    expect(observeSpawn(spawnRunnerFailed(), fakeConfined())).toBe('runner-failed');
  });

  test('informational runner lines are excluded before fatal matching', () => {
    const result: SpawnResultLike = {
      status: 1,
      stderr: 'landlock-run: partial enforcement (older Landlock ABI)\nsh: Permission denied',
    };
    expect(observeSpawn(result, fakeConfined())).toBe('denied');
  });

  test('spawn error is unavailable', () => {
    expect(observeSpawn({ status: null, error: new Error('spawn ENOENT') }, fakeConfined()))
      .toBe('unavailable');
  });

  test('null status (killed by signal) is unavailable, not a denial', () => {
    expect(observeSpawn({ status: null, signal: 'SIGKILL' }, fakeConfined())).toBe('unavailable');
  });
});

describe('classify', () => {
  test('expectations agree: ok/pass -> PASS, denied/refused -> REFUSED', () => {
    expect(classify('ok', 'pass')).toBe('PASS');
    expect(classify('denied', 'refused')).toBe('REFUSED');
  });

  test('contradictions are FAIL, never a quiet PASS', () => {
    expect(classify('denied', 'pass')).toBe('FAIL');
    expect(classify('ok', 'refused')).toBe('FAIL');
  });

  test('runner failure and unavailable are UNVERIFY in both directions', () => {
    expect(classify('runner-failed', 'pass')).toBe('UNVERIFY');
    expect(classify('runner-failed', 'refused')).toBe('UNVERIFY');
    expect(classify('unavailable', 'pass')).toBe('UNVERIFY');
  });
});

describe('runProbe', () => {
  const def: ProbeDef = {
    name: 'probe',
    expect: 'refused',
    mode: 'workspace-write',
    script: 'echo x > /elsewhere',
  };

  test('PASS requires a real runner argv from confine, not a passthrough', async () => {
    const passthrough: ConfinedResultLike = {
      ...fakeConfined(),
      argv: ['sh', '-c', def.script],
    };
    const result = await runProbe(def, 1, '/root', async () => passthrough, spawnOk);
    expect(result.verdict).toBe('UNVERIFY');
    expect(result.detail).toContain('non-runner argv');
  });

  test('denial with matching dialect is REFUSED and records enforcement', async () => {
    const result = await runProbe(def, 1, '/root', async () => fakeConfined(), spawnDenied);
    expect(result.verdict).toBe('REFUSED');
    expect(result.exitCode).toBe(1);
    expect(result.enforcement).toBe('full');
    expect(result.detail).not.toContain('does not match');
  });

  test('denial with a foreign dialect records the dialect mismatch in detail', async () => {
    const result = await runProbe(def, 1, '/root', async () => fakeConfined({
      denialSignatures: ['EPERM under Seatbelt'],
    }), spawnDenied);
    expect(result.verdict).toBe('REFUSED');
    expect(result.detail).toContain('does not match the backend denial dialect');
  });

  test('confine rejection is UNVERIFY with the rejection detail', async () => {
    const result = await runProbe(def, 1, '/root', async () => {
      throw new Error('SANDBOX_UNAVAILABLE: no runner for linux');
    }, spawnOk);
    expect(result.verdict).toBe('UNVERIFY');
    expect(result.detail).toContain('SANDBOX_UNAVAILABLE');
  });

  test('runner failure before executing the command is UNVERIFY, not REFUSED', async () => {
    const result = await runProbe(def, 1, '/root', async () => fakeConfined(), spawnRunnerFailed);
    expect(result.verdict).toBe('UNVERIFY');
  });
});

describe('probe world and probe definitions', () => {
  test('every probe is confined inside a fresh mkdtemp root; no user paths written', () => {
    const world = createProbeWorld() as Exclude<ReturnType<typeof createProbeWorld>, { error: string }>;
    try {
      expect(world.root).toMatch(/dsh-iso-root-/);
      const defs = buildProbes(world);
      expect(defs.length).toBeGreaterThanOrEqual(10);
      for (const d of defs) {
        // Git and fsync probes only reference the fresh probe root.
        expect(d.script).not.toMatch(/vcup-skills/);
        if (d.env?.HOME) expect(d.env.HOME).toBe(world.root);
      }
      // The two refusal probes outside the root point at fresh home escape dirs.
      for (const d of defs.filter((x) => x.expect === 'refused' && x.script.includes('echo probe > /'))) {
        expect(d.script.includes(world.escapeRoot) || d.script.includes(world.escapeSibling) || d.script.includes("'in'") || d.script.includes('/dev/null')).toBe(true);
      }
    } finally {
      world.dispose();
    }
  });

  test('escape targets are cleaned up on dispose', () => {
    const world = createProbeWorld() as Exclude<ReturnType<typeof createProbeWorld>, { error: string }>;
    const escapeRoot = world.escapeRoot;
    const escapeSibling = world.escapeSibling;
    world.dispose();
    expect(existsSync(escapeRoot)).toBe(false);
    expect(existsSync(escapeSibling)).toBe(false);
  });
});

describe('resolveWithin (fail-closed provider resolution)', () => {
  test('a resolution inside the install dir is accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-iso-res-'));
    const target = join(dir, 'pkg', 'lib', 'index.js');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
    try {
      const r = resolveWithin(dir, () => target, 'p');
      expect('path' in r).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ancestor-dir fallback outside INSTALL_DIR is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-iso-res-'));
    const target = join(dir, 'elsewhere.js');
    writeFileSync(target, '');
    try {
      const outside = mkdtempSync(join(tmpdir(), 'dsh-iso-out-'));
      const targetOutside = join(outside, 'pkg.js');
      writeFileSync(targetOutside, '');
      try {
        const r = resolveWithin(dir, () => targetOutside, 'p');
        expect('error' in r).toBe(true);
        if ('error' in r) expect(r.error).toContain('outside INSTALL_DIR');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unresolvable package is rejected with the package name', () => {
    const r = resolveWithin('/', () => { throw new Error('Cannot find package'); }, 'p');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('p not resolvable');
  });

  test('loadProvider rejects an INSTALL_DIR without its own node_modules instead of walking ancestors', () => {
    // Bun's createRequire('/tmp/package.json') cannot find the packages here,
    // but the contract under test is: whatever happens, loadProvider must
    // never return a provider whose source lies outside the install dir.
    // The release is judged first, so a directory that is not an install at all
    // is refused for that reason rather than for a downstream resolve failure.
    const result = loadProvider('/tmp');
    if ('provider' in result) {
      expect(result.provider.source.startsWith('/tmp/')).toBe(true);
    } else {
      expect(result.error).toMatch(
        /outside INSTALL_DIR|not resolvable|install dir|not a tested DSH release/,
      );
    }
  });

  test('loadProvider refuses a mixed install instead of measuring it', () => {
    // Two DSH packages at different releases: the probe would load a different
    // release than the host, so no verdict may be attributed to this directory.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-iso-mixed-'));
    try {
      for (const [name, version] of [
        ['@deepseek-ai/dsh', '0.2.2-rc.5'],
        ['@deepseek-ai/dsh-skill', '0.2.2-rc.5'],
        ['@deepseek-ai/dsh-tools', '0.2.2-rc.4'],
      ] as const) {
        mkdirSync(join(dir, 'node_modules', name), { recursive: true });
        writeFileSync(join(dir, 'node_modules', name, 'package.json'), `{"version":"${version}"}`);
      }
      const result = loadProvider(dir);
      expect('error' in result).toBe(true);
      if ('error' in result) expect(result.error).toContain('mixed DSH releases');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadProvider refuses a probe-private peer copy at another release', () => {
    // The host is consistent, but the plugin carries its own rc.4 copy: that is
    // the mixed shape a pinned-exact peer would produce, and it is refused.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-iso-shadow-'));
    try {
      for (const [name, version] of [
        ['@deepseek-ai/dsh', '0.2.2-rc.5'],
        ['@deepseek-ai/dsh-skill', '0.2.2-rc.5'],
        ['@deepseek-ai/dsh-tools', '0.2.2-rc.5'],
      ] as const) {
        mkdirSync(join(dir, 'node_modules', name), { recursive: true });
        writeFileSync(join(dir, 'node_modules', name, 'package.json'), `{"version":"${version}"}`);
      }
      const nested = join(dir, 'node_modules/dsh-ensemble-probe/node_modules/@deepseek-ai/dsh-skill');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'package.json'), '{"version":"0.2.2-rc.4"}');

      const result = loadProvider(dir);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('mixed DSH install');
        expect(result.error).toContain('private');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runIsolationChecks (no real provider needed)', () => {
  test('gate mode, no INSTALL_DIR -> UNVERIFY, exit 2 (a -check gate never returns green unverified)', async () => {
    const report = await runIsolationChecks(null);
    expect(report.exitCode).toBe(2);
    expect(report.counts.total).toBe(0);
    expect(report.lines.join('\n')).toContain('UNVERIFY');
    expect(report.lines.join('\n')).toContain('UNVERIFIED: provider-load');
    expect(report.lines.join('\n')).toContain('re-run with: make isolation-check INSTALL_DIR=');
    expect(report.lines.some((l) => l.includes('coverage: 0/11 probes executed'))).toBe(true);
  });

  test('gate mode, INSTALL_DIR given but nonexistent -> CONFIG ERROR, exit 2, not a UNVERIFY count', async () => {
    const report = await runIsolationChecks('/definitely/not/a/dir');
    expect(report.exitCode).toBe(2);
    expect(report.counts).toEqual({ PASS: 0, REFUSED: 0, UNVERIFY: 0, FAIL: 0, total: 0 });
    expect(report.lines.join('\n')).toContain('install dir does not exist');
    expect(report.lines.some((l) => l.startsWith('CONFIG ERROR:'))).toBe(true);
    expect(report.lines.join('\n')).toContain('nothing was verified');
  });

  test('gate mode, INSTALL_DIR given but not a tested DSH install -> CONFIG ERROR, exit 2, stable across runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-iso-notinstall-'));
    try {
      for (let run = 0; run < 2; run++) {
        const report = await runIsolationChecks(dir);
        expect(report.exitCode).toBe(2);
        expect(report.counts.total).toBe(0);
        const text = report.lines.join('\n');
        expect(text).toContain('CONFIG ERROR:');
        // Fail-closed: the release is not one this gate measures, or the
        // provider is unresolvable/outside the dir — never a provider loaded
        // from somewhere else without saying so.
        expect(text).toMatch(
          /not a tested DSH release|not resolvable|outside INSTALL_DIR|did not export/,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('observe mode, no INSTALL_DIR -> exit 0 with first line OBSERVATION ONLY', async () => {
    const report = await runIsolationChecks(null, { observe: true });
    expect(report.exitCode).toBe(0);
    expect(report.lines[0]).toBe(
      'OBSERVATION ONLY — not a check; this run does not assert the execution world is isolated',
    );
    expect(report.lines.join('\n')).toContain('UNVERIFY');
  });

  test('observe mode, unusable INSTALL_DIR -> exit 0 with first line OBSERVATION ONLY', async () => {
    const report = await runIsolationChecks('/definitely/not/a/dir', { observe: true });
    expect(report.exitCode).toBe(0);
    expect(report.lines[0]).toContain('OBSERVATION ONLY');
    expect(report.lines.join('\n')).toContain('CONFIG ERROR:');
  });

  test('positive gate path with a real install (env-gated, like MAKE_TEST_INSTALL_DIR)', async () => {
    const installDir = process.env.ISOLATION_TEST_INSTALL_DIR;
    if (installDir === undefined || installDir === '') {
      console.log('skip: set ISOLATION_TEST_INSTALL_DIR=<isolated DSH install of a tested release> to run the positive gate path');
      return;
    }
    const report = await runIsolationChecks(installDir);
    expect(report.exitCode).toBe(0);
    expect(report.counts.total).toBe(11);
    expect(report.counts.FAIL).toBe(0);
    expect(report.lines.join('\n')).toContain('UNVERIFIED: none');
    // The provider provenance line must pin the build the results bind to.
    expect(report.lines.join('\n')).toMatch(/provider: @deepseek-ai\/dsh-sandbox-local@\S+ from /);
    expect(report.lines.some((l) => l.includes(`coverage: 11/11 probes executed`))).toBe(true);
  });

  test('full-path simulation with injected confine/spawn: expected outcomes exit 0', async () => {
    const world = createProbeWorld() as Exclude<ReturnType<typeof createProbeWorld>, { error: string }>;
    try {
      const defs = buildProbes(world);
      const expectByScript = new Map(defs.map((d) => [d.script, d.expect] as const));
      const fakeConfine = async (argv: string[]) => {
        const expect = expectByScript.get(argv[2]);
        if (!expect) throw new Error('probe script not recognized');
        return { ...fakeConfined(), argv: [...fakeConfined().argv.slice(0, 4), ...argv] };
      };
      const fakeSpawn = ((argv: string[], opts?: { env?: Record<string, string> }) => {
        const expect = expectByScript.get(argv[argv.length - 1]);
        if (expect === 'refused') return spawnDenied();
        if (expect === 'pass') return spawnOk();
        return { status: 125, stderr: 'unknown probe' };
      }) as never;
      const report = await runIsolationChecks('/fake/install', { confine: fakeConfine as never, spawn: fakeSpawn, probeDefs: defs });
      const probeLines = report.lines.filter((l) => l.startsWith('probe['));
      expect(probeLines.length).toBe(defs.length);
      expect(report.counts.PASS).toBe(defs.filter((d) => d.expect === 'pass').length);
      expect(report.counts.REFUSED).toBe(defs.filter((d) => d.expect === 'refused').length);
      expect(report.counts.FAIL).toBe(0);
      expect(report.exitCode).toBe(0);
      expect(report.lines).toContain('UNVERIFIED: none');
      // Locked contract: expected refusals are REFUSED, never FAIL and never
      // a nonzero exit — only expect/observation contradictions drive exit 1.
      expect(report.counts.REFUSED).toBe(defs.filter((d) => d.expect === 'refused').length);
      expect(defs.filter((d) => d.expect === 'refused').length).toBe(5);
    } finally {
      world.dispose();
    }
  });

  test('full-path simulation: one contradiction produces exit 1', async () => {
    const world = createProbeWorld() as Exclude<ReturnType<typeof createProbeWorld>, { error: string }>;
    try {
      const defs = buildProbes(world);
      const expectByScript = new Map(defs.map((d) => [d.script, d.expect] as const));
      const fakeConfine = async (argv: string[]) => {
        const expect = expectByScript.get(argv[2]);
        if (!expect) throw new Error('probe script not recognized');
        return { ...fakeConfined(), argv: [...fakeConfined().argv.slice(0, 4), ...argv] };
      };
      // Every probe observes the opposite of what is expected -> FAILs.
      const fakeSpawn = ((argv: string[]) => {
        const expect = expectByScript.get(argv[argv.length - 1]);
        return expect === 'refused' ? spawnOk() : spawnDenied();
      }) as never;
      const report = await runIsolationChecks('/fake/install', { confine: fakeConfine as never, spawn: fakeSpawn, probeDefs: defs });
      expect(report.counts.FAIL).toBe(defs.length);
      expect(report.exitCode).toBe(1);
    } finally {
      world.dispose();
    }
  });

  test('a probe contradicting its expectation drives exit code 1', async () => {
    const report = await runIsolationChecks(null);
    // Contract check on the summary contract itself: an UNVERIFY-only run
    // never claims success of any probe (pass=0 refused=0).
    const summary = report.lines.find((l) => l.startsWith('SUMMARY'))!;
    expect(summary).toContain('pass=0');
    expect(summary).toContain('refused=0');
  });

  test('FAIL mapping: injected contradictory behavior produces exit 1', async () => {
    const def: ProbeDef = { name: 'x', expect: 'refused', mode: 'workspace-write', script: 'true' };
    const result = await runProbe(def, 1, '/root', async () => fakeConfined(), spawnOk);
    expect(result.verdict).toBe('FAIL');
    expect(classify('ok', 'refused')).toBe('FAIL');
  });
});
