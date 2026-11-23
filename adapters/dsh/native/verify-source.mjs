/**
 * Prove source IO happens outside the runner's filesystem, through the public
 * native FileSystem seam.
 *
 * ## What the earlier version got wrong
 *
 * It asserted `stat('/source/binary.dat')` → ENOENT and called that separation.
 * `/source` is a **virtual prefix** the fixture strips before touching disk
 * (`source-world-server.mjs`: `path.slice('/source'.length)`), so it exists on no
 * filesystem at all — the assertion passes even when the fixture runs on the
 * runner's own filesystem. It also wrote `separateContainer: true` and
 * `hostSourcePathAbsent: true` as **literals**.
 *
 * ## What actually distinguishes the worlds
 *
 * The fixture serves from a real directory it created with `mkdtemp`, and reports
 * it on an authenticated `/fixture/identity` route. The runner then states that
 * exact path **locally** and requires ENOENT. That is a measurement the runner
 * performs against its own filesystem; the endpoint only supplies the value, and
 * it cannot choose a path the caller will see (it derives it from `mkdtemp`, not
 * from the environment).
 *
 * ## Honest limits
 *
 * This proves the source bytes are not on the runner's filesystem. It does **not**
 * prove the fixture is in a different container: a process on the same filesystem
 * answers `/fixture/identity` identically — and then `stat(root)` **succeeds**,
 * which is exactly the negative case this driver refuses. Container-level facts
 * (no project mount, distinct container) are reported separately as an
 * **attestation**, never derived from a path being absent.
 *
 * Trust model: the fixture is trusted test infrastructure. This is not a proof of
 * isolation against a *malicious* endpoint, which could lie about `root`. It is a
 * proof that an honest fixture on the same filesystem is rejected.
 *
 * Usage: bun adapters/dsh/native/verify-source.mjs [install-dir]
 * Env: ENSEMBLE_SOURCE_TEST_URL, ENSEMBLE_SOURCE_TEST_TOKEN, and the operator
 *      attestation (ENSEMBLE_SOURCE_ATTEST_BY / _CONTAINER / _STATEMENT /
 *      _COPY_SHA256) — required, because container facts are not observable here.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, stat, readFile } from 'node:fs/promises';
import { sourceFilesystemClass } from './source-fixture.mjs';
import { nativeSourceReader, locationAuthorizer } from './locations.ts';

const runtime = resolve(process.argv[2] ?? '.scratch/rc5-cycle/rc5');

const endpoint = process.env.ENSEMBLE_SOURCE_TEST_URL ?? 'http://127.0.0.1:18743';
const token = process.env.ENSEMBLE_SOURCE_TEST_TOKEN;
assert(token, 'test-only fixture token is required');

/** Bearer-authenticated JSON read, so identity cannot be read anonymously. */
async function fixtureJson(route, init = {}) {
  const response = await fetch(endpoint + route, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${route} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * Read the served world's identity and require the reported root to be a real,
 * absolute, already-generated directory path.
 *
 * The checks below are about *shape*, not trust: a relative or empty root would
 * make `stat` meaningless (it would resolve against the runner's cwd), so it is
 * refused rather than silently accepted.
 */
async function readIdentity() {
  const identity = await fixtureJson('/fixture/identity');
  assert.equal(identity.ok, true, 'identity must report ok');
  assert.equal(identity.fixture, 'source-world', 'identity must name this fixture');
  assert.equal(typeof identity.world, 'string', 'identity must carry a world id');
  assert.ok(identity.world.length >= 8, 'world id must be a real identifier');
  assert.equal(typeof identity.root, 'string', 'identity must carry the served root');
  assert.ok(isAbsolute(identity.root), `served root must be absolute, got ${JSON.stringify(identity.root)}`);
  // A served root naming a bare filesystem top-level would make "absent here"
  // trivially true for the wrong reason, so require a fixture-shaped path.
  assert.ok(identity.root.includes('ensemble-source-world-'), `served root must be a fixture root, got ${JSON.stringify(identity.root)}`);
  return identity;
}

/**
 * Read an operator attestation, refusing when it is absent.
 *
 * Container-level facts are not observable from the runner, so a missing statement
 * is a configuration error rather than something to default. Checked up front:
 * a later check would let a run fail for an unrelated reason first and bury this.
 */
function attested(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} must be stated by the operator who provisioned the fixture: ` +
      'container-level facts are not observable from the runner and this driver will not assume them');
  }
  return raw.trim();
}
// Resolved before any network call, so a missing statement fails immediately and
// for the right reason.
const ATTESTATION = {
  attestedBy: attested('ENSEMBLE_SOURCE_ATTEST_BY'),
  container: attested('ENSEMBLE_SOURCE_ATTEST_CONTAINER'),
  statement: attested('ENSEMBLE_SOURCE_ATTEST_STATEMENT'),
  fixtureCopySha256: attested('ENSEMBLE_SOURCE_ATTEST_COPY_SHA256'),
};

const identity = await readIdentity();
// The fixture signs its identity with the world `/health` also reports: a fixture
// answering two different worlds is not the one this run read from.
const health = await fixtureJson('/health');
assert.equal(health.ok, true, 'health must report ok');
assert.equal(health.world, identity.world, 'identity and health must describe the same world');

/**
 * The measurement: the world's real root must be absent **here**.
 *
 * `stat` succeeds exactly when the fixture shares this filesystem, which is the
 * same-filesystem false positive this driver must refuse.
 */
let rootAbsent = false;
try { await stat(identity.root); } catch (error) { if (error.code === 'ENOENT') rootAbsent = true; else throw error; }
if (!rootAbsent) {
  console.error(`FAIL the served source root exists on this filesystem: ${identity.root}`);
  console.error('     the fixture is not on a different filesystem, so this run proves nothing about source isolation');
  process.exit(1);
}
// And the specific file it will serve, so a root that merely looked absent while
// its content is reachable another way cannot pass.
let binaryAbsent = false;
try { await stat(join(identity.root, 'binary.dat')); } catch (error) { if (error.code === 'ENOENT') binaryAbsent = true; else throw error; }
assert.equal(binaryAbsent, true, `the served binary must be absent on this filesystem: ${join(identity.root, 'binary.dat')}`);

/**
 * Resolve the isolated install, **after** every refusal has already been decided.
 *
 * This step is last on purpose. It used to run at import time, before the token and
 * attestation checks, which meant the driver died with `Cannot find module
 * '@deepseek-ai/cordis'` on any tree without a local `.scratch/rc5-cycle` — a
 * gitignored directory. Fresh clones, CI runners and other checkouts therefore
 * failed the *negative-control tests* at module resolution, before the assertions
 * they exist to make could run.
 *
 * Keeping resolution here means the same-filesystem refusal (and the token and
 * attestation refusals) are observable with no install present, so those controls
 * genuinely execute in CI rather than being skipped.
 */
async function loadInstall() {
  if (!existsSync(join(runtime, 'package.json'))) {
    throw new Error(`the isolated install at ${runtime} is missing: pass an install directory, or set nothing and run the positive path where a real install exists`);
  }
  const require = createRequire(join(runtime, 'package.json'));
  const cordis = await import(require.resolve('@deepseek-ai/cordis'));
  const NativeFs = await sourceFilesystemClass(require);
  return { Context: cordis.Context, NativeFs };
}

// Only now, with every refusal already decided, is the install needed.
const { Context, NativeFs } = await loadInstall();
const ctx = new Context();
const fs = new NativeFs(ctx, { endpoint, token });
const world = { identity: 'separate-container-source', fs, hostLocal: false, current: () => true, readLink: (path, signal) => fs.readLink(path, signal) };
const signal = AbortSignal.timeout(20_000);
const root = await fs.resolve('/source', { signal });
const reader = nativeSourceReader(world, root);
const access = readable => fixtureJson('/fixture/access', { method: 'POST', body: JSON.stringify({ readable }) });

try {
  // `/source` is a virtual prefix: asserting it is absent says nothing about
  // filesystems, which is why the served root above is the real check.
  const scan = await reader.scan([], 1048576, signal);
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.value.completeness, 'complete', JSON.stringify(scan.value.entries));
  assert.deepEqual([...scan.value.contents.get('binary.dat')], [0, 255, 254, 128, 13, 10, 65, 0]);
  assert.equal(scan.value.entries.find(entry => entry.path === 'untrusted-link').link, '/etc/passwd');
  assert.equal(Buffer.from(scan.value.contents.get('untrusted-link')).toString(), '/etc/passwd');
  await assert.rejects(fs.resolve('/etc/passwd', { signal }));
  await assert.rejects(fs.resolve('/source/untrusted-link', { signal }));

  const authorize = locationAuthorizer([world]);
  const actor = { kind: 'owner', ownerId: 'owner', hostAuthorityId: 'host', channel: 'authenticated-remote' };
  const chosen = await authorize(actor, { kind: 'source', world: world.identity, path: '/source' }, signal);
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  await access(false);
  assert.equal(await chosen.value.check(signal), false);
  const denied = await reader.scan([], 1048576, signal);
  assert.equal(denied.ok, false);

  const release = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
  const evidence = {
    release,
    measured: {
      servedWorld: identity.world,
      servedRoot: identity.root,
      // The runner performed these `stat` calls itself and got ENOENT.
      servedRootAbsentOnRunner: true,
      servedBinaryAbsentOnRunner: true,
      binaryExact: true,
      symlinkRecordedWithoutFollowing: true,
      sourceRevocationDenied: true,
    },
    attestation: {
      // Every value below is a quote of what the operator stated, not something
      // this script computed. Resolved at startup, so a missing statement cannot be
      // silently replaced by an assumption.
      source: 'operator-provided (ENSEMBLE_SOURCE_ATTEST_*); not observable from the runner',
      ...ATTESTATION,
    },
  };
  const dir = await mkdtemp('/var/tmp/ensemble-source-proof-');
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS source world served from a directory absent on this filesystem, with exact bytes, symlink and live revocation');
  console.log('EVIDENCE ' + join(dir, 'evidence.json'));
} finally {
  await access(true);
  await ctx.fiber.dispose();
}
