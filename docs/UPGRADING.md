# Version support, identity change and upgrade

This is the current lifecycle contract for the DSH ensemble package: what is
supported now, what changed from the earlier probe, how an old archive is moved
to the new identity, and how a future DSH release is evaluated. It is not a
changelog for the method and it does not claim the product is accepted.

## 1. Three axes, kept separate

| Axis | Current value | What it does **not** mean |
|---|---|---|
| Package identity and version | `dsh-ensemble@1.0.0` (supersedes `dsh-ensemble-probe@0.3.0`) | The DSH release it runs on; feature completeness; acceptance |
| DSH releases tested together | `0.2.2-rc.4` and `0.2.2-rc.5`; default `0.2.2-rc.5` | That a newer tag or `latest` is supported |
| Capability maturity | Model tools, owner Remote, CLI and Client are implemented and gate-verified for the paths named in [production status](PRODUCTION.md#current-status) | That final acceptance, browser evidence on the final artifact, or network replication is complete |

These axes change independently. A package version bump may add a tested DSH
release without adding features; a new DSH release is not supported merely
because a registry tag moved.

## 2. Current support declaration

The supported set is declared once, in `adapters/dsh/compatibility.ts`, and every
consumer reads it: the package manifest's `engines.dsh`, the peer ranges, the
Host type gate, the profile and isolation gates, the Makefile precheck, and the
packaging allowlist. Exactly `0.2.2-rc.4` and `0.2.2-rc.5`; `0.2.2-rc.5` is the
default for a new install.

- `engines.dsh = "0.2.2-rc.4 || 0.2.2-rc.5"`, and the `dsh-skill`/`dsh-tools`
  peers use the same disjunction so pnpm dedupes to the host copy instead of
  installing a private release beside it.
- `@deepseek-ai/cordis` stays `~4.1.0`, independently of the DSH release.
- `engines.node = ">=24.9.0"`, matching both supported CLI manifests.

The set is an explicit enumeration, not a range. DSH's compatibility gate
evaluates an own `engines.dsh` with `includePrerelease`, so an open range such as
`>=0.2.2-rc.4` or `^0.2.2-rc.4` would admit future prereleases nobody tested. A
closed disjunction fails closed: an unknown or future release is refused until it
is added on purpose with matrix evidence. `make matrix-check` re-reads the packed
manifests and fails when a shipped package declares a set the maintained
declaration does not.

### Dated registry observation (not a standing truth)

Observed 2026-11-20T01:22Z from <https://registry.npmjs.org/@deepseek-ai%2Fdsh>:
`latest = 0.2.2-rc.5`, `next = 0.2.2-rc.5`, `alpha = 0.2.2-alpha.3`; rc.5 was
published 2026-11-18T13:17Z and rc.4 on 2026-11-17T17:03Z. This is a point-in-time
observation of publisher tags. No tag is evidence of compatibility and none
widens the supported set.

## 3. From `dsh-ensemble-probe` 0.3.0 to `dsh-ensemble` 1.0.0

The package identity, the archive format and the capability surface all changed.
Treat the transition as a migration, not as an in-place upgrade.

| | 0.3.0 probe | 1.0.0 |
|---|---|---|
| Package name | `dsh-ensemble-probe` | `dsh-ensemble` |
| Archive format marker | `ensemble-archive/v1` | `ensemble-archive/v2` |
| Model-facing tools | `ensemble_reference` only | `ensemble_work`, `ensemble_learn`, `ensemble_read`, `ensemble_upload`, plus `ensemble_reference` |
| Owner surface | `initialize`, `bind`, `status`, `readBack` | the same four plus `projects`, `query`, `manage`, `choose`, `approve`, `environment` and a streaming `watch` |
| Client | none | a web Client extension declared through `dsh.client` |
| CLI | `ensemble-archive` (four methods) | the same binary, with the full method set |

Rules that do not soften during migration:

- **The old archive is read-only until an owner migrates it explicitly.** Nothing
  auto-detects, upgrades in place, or reinterprets a v1 archive as v2 on open.
  Updating the package never migrates data as a side effect.
- **Old grants are historical.** A v1 grant, operation key or retry namespace
  does not become a current grant. The migrated archive gets a **new archive
  identity** and **fresh grants** issued by the current owner.
- **The old writer must be stopped.** Migration requires evidence that the
  previous writer stopped and its final head, not merely that the new copy looks
  complete.
- **The migration creates a new identity, not a renamed copy.** Existing records
  and history are preserved as original material; the old archive stays where it
  is, for reading and for comparison.

### Migrating a 0.3.0 probe archive

The migration is two owner steps on the authenticated surface, plus a stop
statement. Both steps are `manage` actions, reachable from the Client's
management tab and from the CLI:

1. **Preview.** `plan_maintenance` with `kind: "legacy_upgrade"` and a
   `source_handle` for the old archive location. The result inventories the old
   archive, refuses anything that is not a recognisable v1 identity, and records
   the old head and a digest. A preview is not an acceptance: nothing is written
   to the current archive yet.
2. **Stop the old writer, then approve.** Record the owner approval that names
   the stopped previous writer and its exact final head. `upgrade` requires
   `target_format` `ensemble-archive/v2` (or `2`), a `migration_plan_ref`
   pointing at the preview, an `approval_ref`, and `source_stop_ref` with
   `source_stop_evidence`. Any other target format is refused as `invalid_input`.
3. **Commit.** `upgrade` imports the old tree and history as original material
   under a new archive identity, with new grants; the old grants are recorded as
   historical only. If the source changed since the preview, the whole import is
   refused as `stale_inventory` — re-preview rather than mixing two snapshots.

Take a backup of the old archive before you start, and keep it until you have
read the migrated archive back once. The migration does not delete or rewrite the
old location, so a failed attempt leaves the old archive usable.

### What does not survive, and what must be re-established

| Item | After migration |
|---|---|
| Records, artifacts, original bytes, receipt history | Preserved as original material under the new identity |
| Old grants and permission epochs | Historical only; not active |
| Old operation keys / retry namespaces | Not reused; new identity means new namespace |
| Project binding | Must be confirmed again by the current owner |
| Source workspace mapping and execution world | Must be declared by this deployment; an unproven mapping is refused |

Full migration semantics — inventory, digests, source-change refusal, exceptions
and partial imports — are in [operations](ensemble/OPERATIONS.md#6-导入导出与恢复).

### Upgrading an installed package (same major identity)

Within `1.x`, add the new tarball to the same profile and restart the Host:

```bash
dsh plugin --profile web add ./dsh-ensemble-<new version>.tgz
dsh plugin --profile web list      # confirm the version
```

A package that does not recognise an archive format refuses rather than guessing.
Archive data lives outside the profile, so removing or replacing the package does
not touch it.

## 4. Supporting a future DSH release

1. **Observe upstream explicitly.** Run `make check-upstream` (explicit network;
   absent from `check`/`test`/`package-check`, which stay offline). It reads
   public npm dist-tags and classifies them against `compatibility.ts`; it never
   installs, upgrades, widens support or commits. An untested version in the
   output is a signal to evaluate, not a claim of incompatibility.
2. **Pick a concrete published version.** Pin an exact version for the
   experiment; `latest` and `next` are not test targets.
3. **Prepare the isolated runtime with the maintained target.** `make
   runtime-setup INSTALL_DIR=<dir> DSH_VERSION=<release>` installs a tested
   release and the built packages; an untested `DSH_VERSION` exits 2 without
   installing anything.
4. **Run the full matrix against that install.** `make host-check`,
   `make cli-check`, and the production gates named in [production
   status](PRODUCTION.md#4-验证门). Observation-only helpers and forced installs
   are not evidence for a support claim.
5. **Update the declaration only after evidence.** If every gate passes, add the
   version to `compatibility.ts`, set the default only when intended, bump the
   package version when the packaged contract changes, and update the install
   guides. If a gate fails, keep the set unchanged and record the rejected
   version with evidence.
6. **Non-author re-verification, then a logical commit.** A second person repeats
   the matrix on the same candidate bytes and confirms that commands, version
   strings and evidence agree.

No scheduled task, live-profile change, or auto-upgrade is part of this
procedure. `latest` never equals support.

### Dropping a release

When a release stops being supported, record a **Dropped** row: the last package
version that supported it, the migration path (which still-tested release to move
to, with the concrete install command), the behaviour differences, the date and
the evidence. The reason may be technical (a failed matrix, a security or
compatibility defect) **or a deliberate maintenance decision** (upstream EOL,
cost no longer justified) — but "we stopped testing it" is never by itself a
compatibility failure and never sufficient. `0.2.2-rc.4` is retained because it
passes the same matrix, not because it is old. History is not rewritten: the
support declaration changes so it stays accurate.

## 5. Error recovery during an upgrade

A failed upgrade must leave a readable archive and a clear next action. The
surface returns a typed code; the CLI maps the same failures onto its exit codes.

| Symptom | Code | Next action |
|---|---|---|
| Preview is stale or unknown | `not_found` | Re-run the preview; previews do not persist indefinitely |
| Source changed after the preview | `stale_inventory` | Re-preview against the current source; do not merge snapshots |
| Old writer not proven stopped | `source_stop_required` | Stop it and record the approval naming its exact final head |
| Wrong target format | `invalid_input` | Only `ensemble-archive/v2` is implemented |
| Someone else committed first | `revision_conflict` | Re-read the head and repeat with a new operation key |
| Operation outcome unknown | `outcome_unknown` | Read the receipt before any dependent action; do not retry blindly |
| Archive or receipt does not decode | `archive_corrupt` | Stop writing; run `diagnose` and restore from a verified backup |
| Format from a newer release | `unsupported_version` | Upgrade the package, or keep using the old one; never write |
| Restored copy is not the live archive | `restore_read_only` | Complete the activation steps before expecting writes |

`ensemble-archive` exit codes: `0` success, `1` the Host refused the operation,
`2` usage error (including a credential passed on the command line), `3` no
credential and nothing sent, `4` the Host rejected the credential, `5` the Host
could not be reached. Only `1` and `4` mean the Host answered.

A green gate is not a published release: neither `package-check` nor
`release-check` publishes, commits or installs into a live profile.

## 6. Change record (compact)

| Change | Package / DSH set | Evidence | Upgrade note |
|---|---|---|---|
| Added | 0.1.1 supports exactly rc.4 and rc.5, rc.5 default | Full matrix on real isolated installs of both releases: Host types, real Loader 44 PASS each, profile and isolation checks | Clean rc.5 install uses the 0.1.1 tarball |
| Added | 0.2.0 owner archive surface | `initialize`/`bind`/`status`/`readBack` through a real gateway; restart reads the same head | Still bounded; no model write tools, no Client |
| Added | 0.3.0 owner archive CLI | Packaged `bin/ensemble-archive.js` with a private transport bundle; measured exit codes 0–5 | Bounded probe; four Remote methods |
| **Renamed and extended** | **1.0.0 `dsh-ensemble`**: four model tools, full owner Remote, CLI, web Client, archive format v2 | Gates in [production status](PRODUCTION.md#4-验证门), plus the independent non-author store and native acceptance suites on both releases | **Old probe archives need the explicit migration in §3** |
| Deprecated (not dropped) | `dsh-ensemble-probe` 0.1.x–0.3.0 as the recommended install | Superseded by the 1.0.0 identity | Migrate the archive; do not expect in-place upgrade |
