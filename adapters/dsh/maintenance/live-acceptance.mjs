/**
 * Live acceptance for the maintenance line (C07/C13/C14/C17).
 *
 * This driver does not build a composition of its own and never calls an
 * internal helper. It consumes the installed package that `make pack` produced,
 * through the package's own client transport:
 *
 * 1. `scripts/verify-dsh-product.ts` performs the standard
 *    `dsh plugin --profile web add`, boots the real Host, proves the
 *    authenticated owner HTTP Remote and leaves a `connection.json` handoff
 *    (origin, cookie file, package root, project, workspace, source).
 * 2. This file connects with `lib/transport.bundle.mjs` and drives the whole
 *    maintenance lifecycle over `ensembleArchive/*` — the same endpoints the
 *    Client and the packaged CLI use.
 *
 * Environment (set by `scripts/verify-dsh-maintenance.ts --live`):
 *   ENSEMBLE_LIVE_HANDOFF, ENSEMBLE_LIVE_SOURCE, ENSEMBLE_LIVE_RESULT
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const handoff = JSON.parse(readFileSync(process.env.ENSEMBLE_LIVE_HANDOFF, 'utf8'));
const source = resolve(process.env.ENSEMBLE_LIVE_SOURCE);
const resultPath = resolve(process.env.ENSEMBLE_LIVE_RESULT);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const record = (check, detail) => checks.push({ check, detail });
const assert = (truth, message) => { if (!truth) throw new Error(message); };
const ok = (value, label) => { if (!value || value.ok !== true) throw new Error(`${label} failed: ${JSON.stringify(value)}`); return value.value; };
const refused = (value, code, label) => { assert(value && value.ok === false, `${label} was not refused: ${JSON.stringify(value)}`); assert(value.error.code === code, `${label} refused with ${value.error.code}, expected ${code}`); };

const hostWorld = process.env.ENSEMBLE_LIVE_HOST_WORLD;
const sourceWorld = process.env.ENSEMBLE_LIVE_SOURCE_WORLD;
if (!hostWorld || !sourceWorld) throw new Error('live driver needs ENSEMBLE_LIVE_HOST_WORLD and ENSEMBLE_LIVE_SOURCE_WORLD');
const { connect } = await import(pathToFileURL(join(handoff.packageRoot, 'lib/transport.bundle.mjs')).href);
const connection = await connect({ url: handoff.origin, cookie: readFileSync(handoff.cookieFile, 'utf8').trim() });
const call = async (method, request) => {
  const value = await connection.call('ensembleArchive/' + method, { request });
  if (value === undefined) throw new Error(`${method} returned no value`);
  return value;
};
const result = { package: handoff.packageRoot, origin: handoff.origin, status: 'FAILED', checks };
try {
  const manifest = JSON.parse(readFileSync(join(handoff.packageRoot, 'package.json'), 'utf8'));
  assert(manifest.name === 'dsh-ensemble' && manifest.version === '1.0.0', 'unexpected installed package identity');
  const projects = ok(await call('projects', {}), 'projects');
  assert(projects.projects.length === 1, 'expected exactly one project from the installed product');
  let projectId = projects.projects[0].project_id;
  assert(projectId, 'project id missing');
  record('installed package identity and authenticated owner Remote', { name: manifest.name, version: manifest.version, project: projectId });

  // Source handles belong to the source execution world; every Host-local
  // destination (export, backup, relocation) belongs to the Host world. The
  // Remote refuses a source selection in the wrong world, which is the point.
  const choose = async (kind, path, world = hostWorld) => ok(await call('choose', { kind, path, world }), `choose ${kind}`);
  const approve = async request => ok(await call('approve', request), `approve ${request.action}`);
  const context = async id => ok(await call('query', { kind: 'context', project_id: id }), 'context');
  const diagnose = async id => ok(await call('manage', { action: 'diagnose', project_id: id, expected_revision: (await context(id)).read_revision, operation_id: `diagnose-${Date.now()}`, payload: { scope: 'all' } }), 'diagnose');
  /**
   * Diagnose when the archive cannot be read yet.
   *
   * An unbound archive deliberately refuses a context read, so the revision must come from
   * the operation that produced this state rather than from a read the owner is not yet
   * entitled to make.
   */
  const diagnoseAt = async (id, revision) => ok(await call('manage', { action: 'diagnose', project_id: id, expected_revision: revision, operation_id: `diagnose-${Date.now()}`, payload: { scope: 'all' } }), 'diagnose');

  // Probe both location kinds first: a refusal here is an integration fact to
  // report, not something to route around by choosing a different transport.
  const sourceProbe = await call('choose', { kind: 'source', path: source, world: sourceWorld });
  const destinationProbe = await call('choose', { kind: 'destination', path: join(resolve(source, '..'), 'probe-destination'), world: hostWorld });
  assert(destinationProbe.ok === true, 'Host-local destination selection was refused: ' + JSON.stringify(destinationProbe));
  let sourceHandle;
  if (sourceProbe.ok === true) {
    sourceHandle = sourceProbe.value;
    record('owner location handles issued through the authenticated Remote', { source: sourceHandle.world, destination: destinationProbe.value.world });
  } else {
    result.integrationGap = { where: 'choose(source)', refusal: sourceProbe.error };
    record('source location selection refused by the native world check', sourceProbe.error);
  }

  // --- import / export (needs the source world) -------------------------------
  const current = await context(projectId);
  if (sourceHandle) {
  const inventory = ok(await call('manage', { action: 'inventory_import', project_id: projectId, expected_revision: current.read_revision, operation_id: 'live-inventory', payload: { source_handle: sourceHandle.handle, selection: [], budget: 100000 } }), 'inventory_import');
  const importApproval = await approve({ project_id: projectId, action: 'commit_import', target_digest: inventory.digest, statement: 'accept the exact reviewed inventory', expires_after_ms: 60000 });
  const imported = ok(await call('manage', { action: 'commit_import', project_id: projectId, expected_revision: current.read_revision, operation_id: 'live-import', payload: { inventory_id: inventory.id, accepted_exceptions: [], approval_ref: { approval_id: importApproval.approval_id } } }), 'commit_import');
  const exportPath = join(resolve(source, '..'), 'live-export');
  const exportHandle = await choose('destination', exportPath);
  const exported = ok(await call('manage', { action: 'export', project_id: projectId, expected_revision: imported.committed_revision, operation_id: 'live-export', payload: { revision: imported.committed_revision, selection: [], destination_handle: exportHandle.handle } }), 'export');
  const exportedManifest = JSON.parse(readFileSync(join(exportPath, 'manifest.json'), 'utf8'));
  const original = exportedManifest.files.find(file => file.path.endsWith('/original.bin'));
  assert(original, 'export manifest lost the imported original');
  assert(sha(readFileSync(join(exportPath, original.path))) === sha(readFileSync(join(source, 'original.bin'))), 'export changed the original bytes');
  record('owner import and export preserve original bytes through the installed Remote', { files: exported.files, digest: exported.digest });
  }

  // --- backup, verified restore, lossy activation ----------------------------
  const backupPath = join(resolve(source, '..'), 'live-backup');
  const backupHandle = await choose('destination', backupPath);
  const head = (await context(projectId)).read_revision;
  const backup = ok(await call('manage', { action: 'backup', project_id: projectId, expected_revision: head, operation_id: 'live-backup', payload: { revision: head, destination_handle: backupHandle.handle } }), 'backup');
  const readBackup = await choose('backup', backupPath);
  const candidate = ok(await call('manage', { action: 'restore', project_id: projectId, expected_revision: head, operation_id: 'live-restore', payload: { backup_handle: readBackup.handle, mapping_evidence: [] } }), 'restore');
  assert(candidate.readOnly === true && candidate.identity.head === head, 'restore candidate was not the verified read-only backup');
  const restoreApproval = await approve({ project_id: projectId, action: 'activate_restore', candidate_id: candidate.id, target_digest: candidate.backupDigest, statement: 'accept the exact restored candidate', expires_after_ms: 60000 });
  const freshGrant = { subject: { kind: 'session', sessionId: handoff.rootSessionId, rootSessionId: handoff.rootSessionId }, rights: ['read', 'open'], scope: { kind: 'project' } };
  // A lossy replacement is only allowed while the previous primary is paused:
  // two writable identities for one archive must never exist at once.
  const pausedOriginal = ok(await call('manage', { action: 'pause', project_id: projectId, expected_revision: head, operation_id: 'live-pause-original', payload: { reason: 'replace with the restored candidate' } }), 'pause before activation');
  const activated = ok(await call('manage', {
    action: 'activate_restore', project_id: projectId, expected_revision: pausedOriginal.committed_revision, operation_id: 'live-activate',
    payload: { candidate_id: candidate.id, mode: 'lossy', source_descriptor: { worldIdentity: sourceWorld, canonicalAddress: source, nativeWorkspaceRef: handoff.workspaceId }, initial_grants: [freshGrant], approval_ref: { approval_id: restoreApproval.approval_id }, source_stop_evidence: [], loss_statement: 'Final primary head is unknown; accept the unknown interval' },
  }), 'activate_restore');
  assert(activated.archiveId !== candidate.identity.archiveId, 'lossy activation reused the previous identity');
  const recoveryProject = activated.projectId;
  const recovered = await context(recoveryProject);
  assert(recovered.read_revision === activated.revision, 'recovered archive is not readable at its activation revision');
  record('backup, verified read-only restore, lossy activation with new archive id and fresh grants only', { restored: activated.archiveId, revision: activated.revision });

  // --- pause, relocate, diagnose --------------------------------------------
  const paused = ok(await call('manage', { action: 'pause', project_id: recoveryProject, expected_revision: activated.revision, operation_id: 'live-pause', payload: { reason: 'relocate acceptance' } }), 'pause');
  const relocatePath = join(resolve(source, '..'), 'live-relocated');
  const relocateHandle = await choose('destination', relocatePath);
  const relocateApproval = await approve({ project_id: recoveryProject, action: 'relocate', target_digest: sha(Buffer.from(relocateHandle.handle)), statement: 'approve this exact relocation destination', expires_after_ms: 60000 });
  const unapproved = await call('manage', { action: 'relocate', project_id: recoveryProject, expected_revision: paused.committed_revision, operation_id: 'live-relocate-unapproved', payload: { destination_handle: relocateHandle.handle, source_stop_evidence: [{ kind: 'reported', statement: 'primary paused in this Host', source_label: 'live-acceptance', supporting_refs: [] }], mapping_evidence: [], source_descriptor: { worldIdentity: sourceWorld, canonicalAddress: source, nativeWorkspaceRef: handoff.workspaceId }, initial_grants: [freshGrant], approval_ref: { approval_id: 'approval_not_issued' } } });
  refused(unapproved, 'not_authorized', 'relocate without a current owner approval');
  const relocated = ok(await call('manage', { action: 'relocate', project_id: recoveryProject, expected_revision: paused.committed_revision, operation_id: 'live-relocate', payload: { destination_handle: relocateHandle.handle, source_stop_evidence: [{ kind: 'reported', statement: 'primary paused in this Host', source_label: 'live-acceptance', supporting_refs: [] }], mapping_evidence: [], source_descriptor: { worldIdentity: sourceWorld, canonicalAddress: source, nativeWorkspaceRef: handoff.workspaceId }, initial_grants: [freshGrant], approval_ref: { approval_id: relocateApproval.approval_id } } }), 'relocate');
  assert(statSync(relocatePath).isDirectory(), 'relocation did not create the new location');
  const diagnosed = await diagnose(recoveryProject);
  assert(diagnosed.paused === true && diagnosed.grants === 1, 'relocated archive is not paused with exactly the fresh grant');
  assert(diagnosed.grant_ids.length === 1 && typeof diagnosed.grant_ids[0].grant_id === 'string', 'diagnose did not expose the grant identity the owner must revoke');
  record('relocation switched the live root; diagnose reports paused authority and revocable grant ids', { revision: relocated.revision, grants: diagnosed.grants, objects: diagnosed.objects });

  // --- approved purge (C14/C17) ---------------------------------------------
  // A purge needs a published original to target, so it is only reachable when
  // the import above could read the source world. Skipping it is recorded as a
  // gap; it is never reported as a pass.
  if (sourceHandle) {
    let revision = relocated.revision;
    for (const grant of diagnosed.grant_ids.filter(entry => !entry.revoked)) {
      const revoked = ok(await call('manage', { action: 'revoke', project_id: recoveryProject, expected_revision: revision, operation_id: `live-revoke-${grant.grant_id}`, payload: { grant_id: grant.grant_id, reason: 'purge requires no live Session reads' } }), 'revoke');
      revision = revoked.committed_revision;
    }
    // Re-read after revocation: a revoked grant may stay visible as a record while
    // the *active* grant count drops to zero, and purge's precondition is about
    // active Session reads, not about the number of historical records.
    const afterRevoke = await diagnose(recoveryProject);
    const active = afterRevoke.grant_ids.filter(entry => !entry.revoked);
    assert(active.length === 0, `grants remained after revocation: ${JSON.stringify(afterRevoke.grant_ids)}`);
    const purgeBackupPath = join(resolve(source, '..'), 'live-purge-backup');
    const purgeDestination = await choose('destination', purgeBackupPath);
    ok(await call('manage', { action: 'backup', project_id: recoveryProject, expected_revision: revision, operation_id: 'live-purge-backup', payload: { revision, destination_handle: purgeDestination.handle } }), 'purge backup');
    const purgeBackup = await choose('backup', purgeBackupPath);
    const sensitive = sha(readFileSync(join(source, 'original.bin')));
    const plan = ok(await call('manage', { action: 'plan_maintenance', project_id: recoveryProject, expected_revision: revision, operation_id: 'live-purge-plan', payload: { kind: 'purge', backup_handle: purgeBackup.handle, reason: 'owner approved sensitive-content purge', content_digests: [sensitive] } }), 'plan_maintenance');
    assert(plan.affectedArtifacts.length > 0, 'purge plan did not identify the sensitive original');
    assert(plan.unconfirmedExternalCopies === true, 'purge plan hid unconfirmed external copies');
    refused(await call('manage', { action: 'maintain', project_id: recoveryProject, expected_revision: revision, operation_id: 'live-purge-unapproved', payload: { plan_ref: plan.plan_ref, approval_ref: { approval_id: 'approval_not_issued' } } }), 'not_authorized', 'purge without a current owner approval');
    // An approval that exists but was issued for a different digest must be refused: approval
    // is digest-bound, not merely an unguessable id.
    const wrongApproval = await approve({ project_id: recoveryProject, action: 'purge', target_digest: sha(Buffer.from('a different purge plan')), statement: 'approve a different plan', expires_after_ms: 60000 });
    refused(await call('manage', { action: 'maintain', project_id: recoveryProject, expected_revision: revision, operation_id: 'live-purge-wrong-approval', payload: { plan_ref: plan.plan_ref, approval_ref: { approval_id: wrongApproval.approval_id } } }), 'not_authorized', 'purge with an approval for another digest');
    // An approval for the right digest but the wrong action must also be refused.
    const wrongAction = await approve({ project_id: recoveryProject, action: 'gc', target_digest: plan.digest, statement: 'approve garbage collection', expires_after_ms: 60000 });
    refused(await call('manage', { action: 'maintain', project_id: recoveryProject, expected_revision: revision, operation_id: 'live-purge-wrong-action', payload: { plan_ref: plan.plan_ref, approval_ref: { approval_id: wrongAction.approval_id } } }), 'not_authorized', 'purge with a gc approval');
    record('approval is bound to both the plan digest and its action', { wrongDigest: 'not_authorized', wrongAction: 'not_authorized' });
    const purgeApproval = await approve({ project_id: recoveryProject, action: 'purge', target_digest: plan.digest, statement: 'approve this exact purge plan', expires_after_ms: 60000 });
    const purgeRequest = { action: 'maintain', project_id: recoveryProject, expected_revision: revision, operation_id: 'live-purge', payload: { plan_ref: plan.plan_ref, approval_ref: { approval_id: purgeApproval.approval_id } } };
    const purged = ok(await call('manage', purgeRequest), 'purge');
    record('purge result shape', { keys: Object.keys(purged) });
    assert(purged.archiveId !== activated.archiveId, 'purge reused the purged identity');
    assert(purged.completeness === 'partial', 'purge claimed complete disposal of external copies');

    // --- purge leaves a NEW identity that is paused and unbound --------------------
    // The rebuilt archive must not inherit the old mapping or authority: no bindings
    // (so nothing can be read yet), no active grants, and still paused (a fresh bind
    // must never silently resume writing).
    const purgedRevision = purged.revision;
    const purgedDiagnose = await diagnoseAt(purged.projectId, purgedRevision);
    assert(purgedDiagnose.paused === true, 'the purged identity must still be paused');
    assert(purgedDiagnose.bindings === 0, `the purged identity must have no binding, saw ${purgedDiagnose.bindings}`);
    assert(purgedDiagnose.grant_ids.filter(grant => !grant.revoked).length === 0, 'the purged identity must carry no active grant');
    record('purge allocates a new identity that is paused, unbound and grant-free', {
      archive: purged.archiveId, paused: purgedDiagnose.paused, bindings: purgedDiagnose.bindings,
      activeGrants: purgedDiagnose.grant_ids.filter(grant => !grant.revoked).length,
    });

    // Reading before the owner binds must refuse: resolving the project is not authority.
    const unbound = await call('query', { kind: 'context', project_id: purged.projectId });
    refused(unbound, 'binding_required', 'reading a purged archive before it is rebound');
    record('purged archive refuses reads until the owner binds it', { code: unbound.error.code });

    // --- explicit fresh binding, fresh grant, then explicit resume -----------------
    const rebind = ok(await call('manage', {
      action: 'bind', project_id: purged.projectId, expected_revision: purgedRevision,
      operation_id: 'live-purge-rebind',
      payload: { source_descriptor: { worldIdentity: sourceWorld, canonicalAddress: source, nativeWorkspaceRef: handoff.workspaceId }, mapping_evidence: [], reason: 'bind the rebuilt archive to its source' },
    }), 'rebind after purge');
    const afterBind = await diagnoseAt(purged.projectId, rebind.committed_revision);
    assert(afterBind.bindings === 1, 'rebinding must leave exactly one active binding');
    assert(afterBind.paused === true, 'rebinding must not resume writing');
    record('fresh bind establishes exactly one active binding without resuming', { revision: rebind.committed_revision, bindings: afterBind.bindings, paused: afterBind.paused });

    const freshPurgeGrant = ok(await call('manage', {
      action: 'grant', project_id: purged.projectId, expected_revision: rebind.committed_revision,
      operation_id: 'live-purge-grant',
      payload: { subject: { kind: 'session', sessionId: handoff.rootSessionId, rootSessionId: handoff.rootSessionId }, rights: ['read', 'open'], scope: { kind: 'project' }, reason: 'fresh authority for the rebuilt archive' },
    }), 'fresh grant after purge');
    const afterGrant = await diagnoseAt(purged.projectId, freshPurgeGrant.committed_revision);
    assert(afterGrant.grant_ids.filter(grant => !grant.revoked).length === 1, 'the fresh grant must be the only active grant');
    record('fresh grant is explicit and is the only active authority', { grants: afterGrant.grant_ids.filter(grant => !grant.revoked).length });

    const resumed = ok(await call('manage', {
      action: 'resume', project_id: purged.projectId, expected_revision: freshPurgeGrant.committed_revision,
      operation_id: 'live-purge-resume',
      payload: { reason: 'owner resumes the rebuilt archive after a fresh binding and grant', diagnostic_ref: { kind: 'reported', statement: 'rebound after approved purge', source_label: 'live-acceptance', supporting_refs: [] } },
    }), 'resume after purge');
    const afterResume = await diagnoseAt(purged.projectId, resumed.committed_revision);
    assert(afterResume.paused === false, 'resume did not clear the paused flag');
    const readable = await context(purged.projectId);
    assert(typeof readable.read_revision === 'string', 'the resumed archive has no readable revision');
    record('resume makes the rebuilt archive writable and readable for the fresh authority', { revision: resumed.committed_revision, paused: afterResume.paused });

    // The fresh grant is the only authority, and revoking it removes it: the rebuilt
    // archive cannot silently keep authority from before the purge.
    const liveGrant = afterGrant.grant_ids.find(grant => !grant.revoked);
    assert(liveGrant, 'the fresh grant has no identity to revoke');
    const revokedFresh = ok(await call('manage', {
      action: 'revoke', project_id: purged.projectId, expected_revision: resumed.committed_revision,
      operation_id: 'live-purge-revoke',
      payload: { grant_id: liveGrant.grant_id, reason: 'prove the rebuilt archive has no inherited authority' },
    }), 'revoke the fresh grant');
    const afterFreshRevoke = await diagnoseAt(purged.projectId, revokedFresh.committed_revision);
    assert(afterFreshRevoke.grant_ids.filter(grant => !grant.revoked).length === 0, 'revocation left active authority on the rebuilt archive');
    record('revoking the fresh grant removes the only authority the rebuilt archive has', { revision: revokedFresh.committed_revision, active: 0 });

    // The retired identity stays retired even now that a new one is live.
    assert((await call('query', { kind: 'context', project_id: recoveryProject })).ok === false, 'the purged identity remained readable');

    // Destructive replay returns the durable receipt and does not rebuild again.
    const replay = ok(await call('manage', purgeRequest), 'purge replay');
    assert(replay.reconciled === true && replay.archiveId === purged.archiveId, 'destructive replay lost its durable receipt');
    record('approved purge replays its durable receipt without rebuilding', { purged: purged.archiveId, replay: replay.reconciled });
  } else {
    result.gaps = [...(result.gaps ?? []), 'purge/import not reachable: the source execution world was refused by the native location check'];
    record('purge not attempted because the source world is unreachable', { gap: true });
  }
  // --- the original source is never modified by any of the above ------------------
  // The maintenance line only reads the source location; the archive lives in its own Git
  // repository. Compare the fixture bytes written at the start with what is on disk now,
  // after purge built a replacement identity and after the rebuild was resumed.
  const sourceBytes = readFileSync(join(source, 'original.bin'));
  assert(sha(sourceBytes) === sha(Buffer.from([0, 255, 254, 128, 13, 10, 65, 0])), 'the maintenance lifecycle modified the bound source content');
  record('the bound source content is unchanged by the whole lifecycle', { bytes: sourceBytes.length, digest: sha(sourceBytes) });

  // A recorded gap means this candidate has not satisfied the maintenance
  // acceptance: the gate fails instead of reporting a softer "partial pass".
  // The reason is printed and written so a reviewer sees exactly what is missing.
  result.status = result.integrationGap || result.gaps ? 'INCOMPLETE' : 'PASS';
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  if (result.status === 'PASS') console.log('PASS live packaged maintenance lifecycle: ' + checks.length + ' checks');
  else { console.error('INCOMPLETE live packaged maintenance lifecycle: ' + JSON.stringify(result.integrationGap ?? result.gaps)); process.exitCode = 1; }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await connection.close?.();
}
