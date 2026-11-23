# DSH adapter — installed Host entry, owner Remote, native tools and CLI

The plugin that ships in the `dsh-ensemble` package. Maintainer-facing: what each
module is responsible for, what the boundaries are, and which gates actually
exercise it. The **user-facing** install/use guide is
[`package-readme.md`](package-readme.md), which is the file placed inside the
published package.

**Supported set:** exactly DSH `0.2.2-rc.4` and `0.2.2-rc.5`, with `0.2.2-rc.5`
the default. `engines.dsh = "0.2.2-rc.4 || 0.2.2-rc.5"` and every DSH peer uses
the same disjunction so pnpm dedupes to the host copy (`@deepseek-ai/cordis`
stays `~4.1.0`). The set is an explicit enumeration on purpose: DSH judges an own
`engines.dsh` with `includePrerelease`, so a range such as `>=0.2.2-rc.4` would
admit future prereleases nobody tested. An unknown release is refused until it is
verified and added deliberately. See [Version support and upgrade](../../docs/UPGRADING.md).

## What the installed composition is

One entry (`index.ts`) that registers four things, all sharing one authorization
and storage boundary:

| Piece | Surface |
|---|---|
| Skill provider | `ensemble`, user-invocable only (`disable-model-invocation: true`), bundled method text |
| Model tools | `ensemble_work`, `ensemble_learn`, `ensemble_read`, `ensemble_upload` (`tools/`), plus `ensemble_reference` |
| Owner Remote | `ensembleArchive` over the Typert gateway: `status`, `initialize`, `bind`, `readBack` (**retired, see below**), `projects`, `query`, `manage`, `choose`, `approve`, `environment`, `watch` |
| CLI | `bin/ensemble-archive.js`, a plain-Node client for that Remote |
| Client extension | `client/` (owned separately), declared through `dsh.client` |

**There is exactly one archive writer.** The installed entry constructs the v2
product executor (`native/product.ts`); the pre-1.0 `owner-service.ts` writer is
**not constructed at all**. Two writers reachable from one
`DSH_ENSEMBLE_ARCHIVE_ROOT` was the defect that retirement removes: an old
four-method payload can no longer create a second repository.

Authority never comes from a request:

- **Model tools** derive their actor from the live native caller — `exec.agent`
  plus the registered Workspace and the deployment's execution-world mapping
  (`native/identity.ts`, `native/dsh.ts`). A tool call with no `exec.agent` is
  refused. No path, project-for-write, role, owner or world field authorizes
  anything.
- **Owner Remote** takes its actor from the authenticated Remote invocation and
  refuses when `ctx.invocation` is absent, so in-process code cannot reach it.
- **Store** (`store/`) enforces current grants, the authorization epoch,
  receipt-first retries and CAS. Domain decisions live in `modules/ensemble`.

## Retired in 1.0 (breaking change vs 0.3.0)

`initialize`, `bind`, `status` and `readBack` are retired **for creation**:

- Remote: each returns `code: "unsupported_version"` with a migration message,
  after the owner guard. `status`/`readBack` would delegate to a read-only legacy
  reader only if one were mounted — the product mounts none.
- CLI: refused **before any connection is opened**, exit `2`, naming the
  replacement.
- Replacement: `manage {action:"initialize"|"bind"}` for creation/rebinding;
  `projects`/`query` for reads.

A 0.3.0 archive is migrated only by an explicit owner flow: plan a
`legacy_upgrade` through `manage` (`maintenance/legacy.ts` preview), review it,
back the archive up, prove the old writer stopped, then commit the upgrade into a
**new** archive identity with fresh grants. The old repository, its head and its
history are never written by the new package. The legacy reader is kept so that
migration can read original bytes.

## Configuration (read once at plugin load; changes need a restart)

| Variable | Meaning |
|---|---|
| `DSH_ENSEMBLE_ARCHIVE_ROOT` | Absolute path outside every bound source; created on first `initialize`. Relative, empty or overlapping is refused. |
| `DSH_ENSEMBLE_AUTHORITY_ID` | This Host's authority identity. |
| `DSH_ENSEMBLE_ARCHIVE_WORLD` | The archive's execution-world label. |
| `DSH_ENSEMBLE_SOURCE_WORLD` | The label mapped to real source services. Unset ⇒ owner Remote and CLI work, model tools refuse `the caller's execution world has no deployment mapping`. |
| `DSH_ENSEMBLE_REPLICA_DESTINATIONS` | Optional JSON map of replica destinations. Unset ⇒ no network transport is mounted. |

`native/replication.ts` parses the replica map strictly, and every failure is at
**boot**: unknown fields, a credential ref without its non-secret
`credential_username`, a user name containing `:`/control codes/surrounding
spaces, an unsupported scheme, or an allowlist that does not cover a declared
destination. Endpoints must be `https`, `http` or `git` — `ssh` is refused.

The carrier variable is deliberately **not** configuration. A deployment cannot
name a `GIT_*` variable and cannot name a helper program: the maintenance
transport owns a fixed, private askpass helper, and the secret reaches Git only
through it, with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, an empty config scope (so no
ambient `credential.helper`) and redirects disabled so a redirect cannot hand the
secret to another origin. `native/replication.ts` resolves the pair
`{username, secret}` on **every** transfer through `ctx.credentials` — never
cached, so a rotated or revoked secret takes effect immediately — and passes it to
the transport's typed `credential` hook. Nothing reaches a URL, argv, a result or
the archive.

This distinction is observable, not theoretical: `scripts/fixtures/git-auth-probe.mjs`
shows a plain injected variable fails exactly like no credential while the helper
succeeds, and `scripts/fixtures/git-auth-transport.mjs` shows the real transport
refused without a credential and succeeding with one. An anonymous `git://`
endpoint therefore proves nothing about credential authentication.

## Execution worlds

`LocationWorld.current()` decides whether a world this product was built against
is still the one it is talking to. Only the **Cordis isolation scope label** is a
stable identity: `ctx.fs` and `ctx.get("fs")` hand out a fresh service proxy on
every access (`ctx.get("fs") === ctx.get("fs")` is `false`), and the label for a
service is `undefined` before that service is provided. Comparing proxies — which
this code used to do — is permanently false and silently refused every source
selection. `native/locations.test.ts` pins both facts against a real
`LocalFileSystem`.

The plugin validates non-overlap after `realpath` and records the
owner-supplied `worldIdentity`; it does **not** prove Host and source share an
execution world. That is a deployment assertion. Cross-container evidence (a
source world in a second container, read over loopback RPC with per-read
revocation) shows two container filesystems are separate; it is not a
physical-host boundary.

## Selection evidence

`native/selection.ts` resolves an attempt's recorded selection for
`environment_record_selection`: the **requested** route and the currently bound
member Session come from the archive record, never from a tool argument, and the
member is the **last** `binding_history` entry so a `replace` cannot attribute the
replaced Session's log to the attempt. Only those two fields leave the record.
`environment/selection.ts` then derives `created`/`actual` from the member's own
native log (`inherited_event_count` excludes fork-inherited prefix events), and a
stage the events do not establish is `unknown`/`unavailable` rather than a guess.

## Files

| File | Role |
|---|---|
| `index.ts` | Plugin entry: skill provider, reference tool, Remote registration, product mount. |
| `meta.ts` | Names, peers, `engines.dsh`, rank, reference enumeration, output budget. |
| `compatibility.ts` | The single version fact (`SUPPORTED_DSH_VERSIONS`, `ENGINES_DSH`, peers). |
| `owner-remote.ts` | Typert Remote; owner guard per method; retired-entry refusals. |
| `owner-service.ts` | Pre-1.0 archive logic. **Not mounted**; kept for the read-only legacy path and its tests. |
| `owner.ts` | The owner guard itself, dependency-free so it is tested without an install. |
| `archive.ts`, `records.ts` | Archive root validation, canonical records. |
| `store/` | v2 durable registry, transaction, lock, query IO, kernel. |
| `native/` | Product composition, native identity/facts bridge, execution-world mapping, selection resolver, replica transport. |
| `tools/` | The four model tools and their schema projection. |
| `maintenance/`, `uploads/`, `environment/` | Lifecycle, byte transfer, preferences (each owned by its author). |
| `client/` | Web Client extension (owned separately). |
| `reference.ts`, `skill.ts` | Closed-enumeration reference reader and skill provider. No DSH imports. |
| `bin/ensemble-archive.js` | The packaged CLI. Its transport is the generated `lib/transport.bundle.mjs`. |
| `package-readme.md` | The README placed inside the package (not this file). |
| `loader-check.ts`, `typecheck-host.ts` | Real-Loader and Host-type gates against an isolated install. |

## Package

`scripts/pack-dsh.ts` produces `build/pack/dsh/dsh-ensemble-<version>.tgz` and an
immutable copy under `build/pack/candidates/`. The bundled skill text comes from
the in-memory `build('dsh')` result, so a stale checkout cannot enter a package.
The CLI's transport is a **generated** bundle: `lib/transport.mjs` imports bare
specifiers a Node process started from an installed package cannot resolve, so
`make dsh-bundle` inlines that closed four-package closure into one file;
`make check` verifies its digest and closure offline.

## Gates

```bash
make typecheck INSTALL_DIR=…        # repository types (no DSH install needed for the shared part)
make typecheck-host INSTALL_DIR=…   # Host entry types against a real rc.4/rc.5 install
make host-check INSTALL_DIR=…       # real Loader behaviour (44 PASS per release)
make test                           # full suite, including this adapter's tests
make pack-dsh                       # stage + npm pack
```

Two things these gates **cannot** establish, and no report should imply
otherwise: answer quality of any model (the end-to-end driver uses a deterministic
registered provider, so it proves the execution path), and browser rendering
(that is the Client author's evidence).

`make profile-check` and `make isolation-check` are gates: they exit 0 only when
the capability is verified, and exit 2 with an explicit configuration error when
there is no usable install, so they never pass by skipping. `make diagnose` is
observation only, exits 0, and asserts nothing.

The earlier `dsh --profile probe --help` timeout was a measurement artifact:
`--help` is the **app's** help, so a composition with no app/startup row boots and
keeps running without printing one. That is why the documented profile is `web`.

## Registration behaviour

- **Skill `ensemble`** — `ctx.skills.registerProvider` with `rank = 600`, and the
  invocation policy parsed from the bundled frontmatter
  (`disable-model-invocation: true` ⇒ user-only). A project-local source outranks
  it; the registry keeps one winning definition and never concatenates bodies.
- **Duplicate provider** — a second registration of the same name in one layer
  fails; the Loader reports that row inactive and the first keeps serving.
- **Unload** — every registration is an effect of the plugin's fiber, so disposing
  the tree removes them.
- **`ensemble_reference`** — exactly five names; rejects any separator, traversal
  segment, absolute path, unknown name or `SKILL.md` (`UNKNOWN_RESOURCE`); a
  symlink fails `RESOURCE_UNAVAILABLE`; over 65536 bytes fails
  `OUTPUT_BUDGET_EXCEEDED`. It never truncates, paginates or falls back.

## What this is not

Not a claim that every clause of the ensemble method is complete. Model-facing
tools, native authority, the owner Remote, the v2 transaction, the CLI and the
Client entry are implemented and gated as described above. Migration/restore,
replication, environment preferences, uploads and maintenance have their own
authors and acceptance; cross-Host replication additionally needs a real
allowlisted endpoint that this repository cannot provide. The isolated Host-local
group runs archive Git in its own subprocess/sandbox scope; that is a plugin
boundary, not a hypervisor claim.

`loader-check.ts` proves the published Loader loads this package in an install. It
is not evidence about a running Host, a GUI, or a profile installation, and it
does not replace an installed-product acceptance run.
