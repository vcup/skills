# dsh-ensemble

Managed ensemble coordination, versioned archives and reviewed learning for
DeepSeek Harness `0.2.2-rc.4` and `0.2.2-rc.5` (`0.2.2-rc.5` is the default for
new installs). Any other release is refused rather than tried.

The package carries four pieces that share one authorization and storage
boundary:

- the **`ensemble` skill**, user-invocable only, with the method text bundled;
- **four model-facing tools** — `ensemble_work`, `ensemble_learn`,
  `ensemble_read`, `ensemble_upload` — plus the read-only `ensemble_reference`
  reader for the bundled resources;
- the **`ensembleArchive` owner Remote** and its **`ensemble-archive`** CLI, for
  project binding, grants, queries and the archive lifecycle;
- a **web Client extension**, declared through `dsh.client`, for project
  selection, authorization management, checkpoints, history and original bytes.

Everything the tools and the CLI touch goes through the same executor: current
grants and the current authorization epoch are checked per call, and a write is
one durable, receipted commit.

## Install

`dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`; without it `add`
fails with `pnpm was not found` (exit 127). Keep `PNPM_HOME` the same across
`add` and `remove`, or `remove` fails on a store mismatch. `--profile` comes
before the pnpm verb.

Add the package to a profile that has an app row. `web` is the shipped profile
and is the safe choice:

```bash
dsh plugin --profile web add ./dsh-ensemble-1.0.0.tgz
dsh plugin --profile web list      # shows dsh-ensemble@1.0.0
dsh --profile web
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's bundle list. It requires a host that provides the services it injects
(`skills`, `tools`, and — for the native tools and Client — `agents`,
`subagents`, `workingDirectory`, `workspaceRegistry`, `sessionQuery` and `fs`) at
exactly `0.2.2-rc.4` or `0.2.2-rc.5`. `@deepseek-ai/cordis` remains at `~4.1.0`,
and every DSH package the entry imports is declared as a peer so the Host's own
resolver supplies it; the package installs no second copy of DSH.

Do **not** point `--profile` at a custom composition with no app/startup row:
such a profile boots and then keeps running without printing help, which looks
like a hang.

Two messages from `add` are not failures: `Agent skills awaiting approval: … Run
"pnpm approve" to review them.` and a peer-dependency `WARN`. Both are non-fatal
and `add` exits 0.

## Configure the deployment

Four variables are read once when the plugin loads, so a change needs a Host
restart. They describe **this deployment**, not a request:

| Variable | Meaning |
|---|---|
| `DSH_ENSEMBLE_ARCHIVE_ROOT` | Absolute path, outside every bound source; created on first `initialize`. A relative, empty, or overlapping root is refused. |
| `DSH_ENSEMBLE_AUTHORITY_ID` | This Host's authority identity. Owner actions are built from it. |
| `DSH_ENSEMBLE_ARCHIVE_WORLD` | The archive's own execution-world label, chosen by the deployment. |
| `DSH_ENSEMBLE_SOURCE_WORLD` | The label of the source execution world this deployment maps to real services. |

`DSH_ENSEMBLE_SOURCE_WORLD` is what lets a model tool call prove *where* it is
running. The mapping is decided from live native service scopes, never from a
path or from text the model supplies. If it is unset, the owner Remote and CLI
still work but the model tools refuse with `the caller's execution world has no
deployment mapping`; that refusal is the feature, not a bug to work around.

No model argument can name a path, a project to write, a role, an owner, or an
execution world. Such a field is refused as `invalid_input` before any handler
runs. Authority is taken from the live native caller, never from input.

## First use

Type the skill name in the composer:

```text
/ensemble <task, constraints, and completion checks>
```

The skill is user-invocable only (`disable-model-invocation: true`), so the
model's catalog does not offer it and asking the model to "use the ensemble
skill" will not reach it. The model-facing tools are registered separately and
are available to a normal turn.

Whether a model turn completes is outside this package's evidence: a turn needs
provider credentials, and without an API key DSH reports
`no API key for provider route`.

## What it registers

| Capability | Behaviour |
|---|---|
| Skill `ensemble` | User-invocable only. Bundled method text plus the reference resources. |
| `ensemble_work` | The complete work lifecycle: frame, coverage and criteria, attempts, artifacts, contributions, findings, decisions, candidate, checks and challenges, next action, and lifecycle transitions. |
| `ensemble_learn` | Coaching, reflection, review, publication, amendments, lessons and application evidence. |
| `ensemble_read` | Authorized projects, current context, checkpoint, objects, original bytes, fixed-revision lists and history, lessons, receipts and environment preferences. |
| `ensemble_upload` | Bounded byte transfer for material too large to inline: begin, chunk, status, seal, commit, cancel. A sealed upload becomes an artifact only when a work command archives it. |
| `ensemble_reference` | Reads back exactly one of `EVOLUTION-TEMPLATE.md`, `GLOSSARY.md`, `PATTERNS.md`, `README.md`, `STATE-TEMPLATE.md` from this package. |

Model tools accept only their closed parameter unions. `ensemble_read` and
`ensemble_upload` take no project id for a write: the bound project is resolved
from the trusted native session and workspace. `ensemble_reference` has no path
argument, refuses any name outside the enumeration, refuses symbolic links, and
returns at most 65536 bytes per call; a larger resource fails with
`OUTPUT_BUDGET_EXCEEDED` rather than being truncated.

Grants, revocations and the authorization epoch are enforced by the archive, so
a call that was authorized when a turn started is refused if the grant was
revoked before it committed. Reads are pinned to a revision you supply, and a
stale revision is refused instead of silently reading newer state.

## Owner archive

`ensembleArchive` is a Typert Remote: reach it as an **authenticated owner
Peer**, through the Client or the CLI. Every method takes one object argument
named `request`.

| Method | Purpose |
|---|---|
| `status` | Current head and archive state, including after a restart. |
| `initialize` | Create the archive for a source, with `limits`, `source_descriptor` and `initial_grants`. Only `expected_revision: "absent"` is accepted. |
| `bind` | Bind or rebind a source at an explicit revision. |
| `readBack` | Read a stored file at an exact revision. |
| `projects` | Projects you may currently see, with capabilities. |
| `query` | Project context, checkpoint, objects, original bytes, lists, history, receipts and environment preferences. |
| `manage` | Archive lifecycle: grants, revocation, takeover, reviewer assignment, pause/resume, and the maintenance actions this deployment supports. |
| `choose` | Choose a source or destination location inside a registered execution world. |
| `approve` | Record an owner approval for an exact digest. |
| `environment` | Environment preferences (the owner-managed role/provider/model history). |
| `watch` | A stream of authorization/revision frames for one project; ends when access ends. |

The plugin validates non-overlap after realpath and records the deployment's
`worldIdentity` in the binding. It does not prove that the Host and the source
share an execution world: that is a deployment assertion, and a source whose
world the deployment has not declared is refused rather than enabled.

## Client

The package declares `dsh.client` for the `web` platform and ships `./client` as
a lazy CommonJS factory, so DSH's own module loader registers it as a normal
Client extension alongside the stock ones. It injects `dsh-api-gateway`,
`dsh-client-connection`, `dsh-client-locale`, `dsh-client-ui-renderer`,
`dsh-client-ui-layout` and `dsh-client-ui-sidebar`.

It gives you project selection, grant/revoke/takeover/reviewer and pause/resume
management, the current checkpoint, contributions and checks, fixed-revision
history, original bytes, reading and lesson views, and the maintenance entry
points. Content is rendered as text; untrusted HTML is never executed and remote
images are not auto-loaded. When the connection drops, cached state is cleared
and management submission is disabled rather than queued.

## Archive CLI

`ensemble-archive` is the headless client for the same Remote. It runs on plain
Node — no external DSH install — because its client transport is bundled
privately in `lib/transport.bundle.mjs`. It talks to a **running** Host over the
Host's own client transport, so the Peer and its `owner` principal are assigned
by the Host's connection layer from your session cookie. The command never
builds a principal itself and never falls back to a local call: without a
credential it sends nothing and exits 3.

### Get a session cookie

Start the web profile in one terminal. In a second terminal, using the same
`DSH_HOME`, exchange the launch token it prints for a cookie:

```bash
dsh --profile web --port 3731
# the Host prints a URL carrying a launch token
curl -c jar.txt "http://127.0.0.1:3731/?token=<launch token>"
```

Pass the jar itself with `--cookie-file`; no extraction step is needed. `curl`
writes an `HttpOnly` cookie as a `#HttpOnly_`-prefixed Netscape line, which the
CLI reads as a cookie (not a comment), so the jar works verbatim:

```bash
# Use the DSH_HOME chosen for the running Host and its web profile.
# If DSH_HOME is unset, set it to that Host's actual data directory first.
: "${DSH_HOME:?Set DSH_HOME to the running Host data directory}"
ENSEMBLE_ARCHIVE="$DSH_HOME/profiles/web/node_modules/.bin/ensemble-archive"
"$ENSEMBLE_ARCHIVE" status --cookie-file jar.txt
```

A `Cookie:` header line copied from a browser's network panel, or a bare
`name=value` pair, is also accepted by the same option.

`dsh plugin add` puts the binary in the profile's `node_modules/.bin`, so a bare
`ensemble-archive` fails with `command not found` (exit 127). There is also no
`dsh plugin exec` subcommand to reach it through: `dsh plugin` only forwards its
arguments to pnpm. The shebang is `#!/usr/bin/env node`, so `node` must be on
`PATH` too. Nothing is installed globally and nothing is added to your shell
profile by the installer.

### Run a command

The binary is installed into the profile, not onto your `PATH`. Resolve it from
the running Host's data directory, then call it by that path:

```bash
: "${DSH_HOME:?Set DSH_HOME to the running Host data directory}"
ENSEMBLE_ARCHIVE="$DSH_HOME/profiles/web/node_modules/.bin/ensemble-archive"
"$ENSEMBLE_ARCHIVE" status --cookie-file jar.txt
```

Or put the profile's `.bin` on `PATH` for the rest of the shell, after which the
bare form is correct:

```bash
export PATH="$DSH_HOME/profiles/web/node_modules/.bin:$PATH"
ensemble-archive status --cookie-file jar.txt
```

Every command takes `--request <json|@file>`; `@` reads the object from a file,
which is the practical form for anything long.

`initialize` accepts only `"expected_revision": "absent"`, and a second
`initialize` on the same root is refused. Every other method takes a
`project_id` and the exact revision you just read. After a restart, `status`
reports the same `headRevision`; no re-initialize is needed.

`bind` was driven over the transport: a valid `bind` advanced the head, and a
second `bind` at the now-stale revision was refused with `revision_conflict`
while the head stayed where the successful one left it. Same-world refusal is
enforced at the admission check rather than over this transport, because one
Host cannot present a genuinely different execution world.

### Retired commands

`status`, `initialize`, `bind` and `readBack` are **retired in the 1.0 package**
and are refused by this client before it opens a connection (exit 2), so an old
script cannot reach a Host with a payload shape this version no longer writes:

```text
ensemble-archive: initialize is retired in the 1.0 package; nothing was sent.

  Create or rebind an archive with `manage`: {"action":"initialize",…} or {"action":"bind",…}.
```

Use `manage` for creation and change, and `projects` / `query` for reads. Moving a
0.3.0 archive is a separate, explicit owner flow: plan a `legacy_upgrade` through
`manage`, review it, back the archive up, stop the old writer, then commit the
upgrade. The old repository, its head and its history are never written by this
package.

### Replicating to another Host

Cross-Host replication needs a deployment-declared destination. It is off by
default: with no destination declared, the Host answers
`not_authorized "replication requires a separately approved native network
capability"`. Declare destinations before starting the Host:

```bash
export DSH_ENSEMBLE_REPLICA_DESTINATIONS='{
  "mirror": { "url": "https://git.internal.example/team/archive.git",
              "identity": "mirror-host",
              "credential_ref": "GIT_MIRROR_TOKEN",
              "credential_username": "archive-bot" }
}'
```

Only `https`, `http` and `git` endpoints are accepted; `ssh` is refused. The URL's
host must be on the deployment allowlist, which is derived from these URLs unless
stated explicitly with a top-level `"allow": ["host[:port]"]` that must cover
every declared destination.

`credential_ref` names a secret in the Host's credential provider;
`credential_username` is the **non-secret** HTTP Basic user name that goes with
it, and the two are required together. The user name cannot contain `:`, a control
character or surrounding spaces. You do **not** choose how the secret reaches
Git: the package builds a fixed private helper for each transfer and Git reads
through that, with prompts in `LC_ALL=C`, no ambient credential helper and
redirects disabled, so the secret cannot be handed to a different origin. The
secret never appears in a URL, an argument, a result, or the archive.

Then:

```bash
"$ENSEMBLE_ARCHIVE" manage --cookie-file jar.txt --request @replica.json
# replica.json: { "action":"configure_replica", "project_id":"…",
#   "expected_revision":"<40-hex>", "operation_id":"configure-mirror",
#   "payload": { "destination_handle":"mirror", "credential_handle":"GIT_MIRROR_TOKEN",
#                "expected_remote_identity":"mirror-host" } }
```

`push_replica` is a compare-and-swap against the remote's current head and never
forces or merges; a divergent remote is refused with `remote_conflict`.
`fetch_replica` verifies the fetched candidate in a private quarantine and never
touches the primary archive. A push whose acknowledgement is lost reports
`outcome_unknown` rather than success or failure — re-read the remote before
retrying.

| Option | Meaning |
|---|---|
| `--url <origin>` | Host origin, default `http://127.0.0.1:3731` |
| `--request <json\|@file>` | the endpoint's `request` object |
| `--cookie-file <path>` | cookie from a jar, a `Cookie:` line, or `name=value` |
| `--cookie-stdin` | the same text on stdin |
| `ENSEMBLE_ARCHIVE_COOKIE` | the same text in the environment |

The credential is accepted only from a file, stdin, or that environment
variable. `--cookie <value>` is refused on purpose: an argument would be visible
in shell history and in a process listing. The value is never echoed.

### Exit codes

| Code | Meaning | Nothing was sent? |
|---|---|---|
| 0 | success | — |
| 1 | the Host refused the operation (invalid input, unsafe path, revision conflict, denied access) | no, the Host answered |
| 2 | usage error, including a credential passed on the command line | yes |
| 3 | no credential, or an empty one | yes |
| 4 | the Host rejected the credential | no, the Host answered 401 |
| 5 | the Host could not be reached | yes |

### Boundaries

- **Headless HTTP + WebSocket only.** The same cookie, trust fence, and
  admission path a browser uses are exercised; a real browser page load is a
  separate check, not this CLI's evidence.
- **Plain HTTP on loopback only.** `https` origins are accepted and
  `redirect: "error"` is forced so the cookie cannot follow a redirect, but the
  TLS and `Secure`-cookie branches were read, not run.
- **One owner principal.** This Host's principal map has exactly one member,
  `owner`, so "an authenticated non-owner is refused" is proven at the guard
  level, not over the transport.
- The archive's Git runs in the plugin's own isolated local
  subprocess/sandbox group, not through the session's execution world.

## Capability status

This is version 1.0 of the package, not a claim that every clause of the
ensemble method is finished everywhere. Implemented and covered by the package's
own checks: the four model tools with closed inputs, native authority from the
live caller, the owner Remote with current-grant enforcement, the archive
transaction with receipts and exact revisions, the CLI, and the web Client
extension.

Not claimed here:

- **Answer quality of any model.** The package's end-to-end check drives the real
  AgentLoop and ToolRunner with a deterministic registered provider, which proves
  the execution path, not the quality of a paid model's output.
- **A physical-host boundary between execution worlds.** Cross-world evidence is
  container-level: source bytes were read from a second container over loopback
  with a test-only fixture, and permission was checked per read. That proves two
  container filesystems are separate, not that a hypervisor boundary exists.
- **Browser rendering as part of this package's evidence.** The Client entry is
  shipped and its bytes are pinned; the browser run belongs to the Client
  author's acceptance.
- Migration, restore, replication, environment preferences, uploads and
  maintenance have their own owners and their own acceptance. Obtain their
  evidence before relying on them for a consequential operation.

When a step of the method needs a capability this deployment does not provide,
report the gap; do not improvise a records mechanism or substitute another
toolchain's storage.

## Uninstall

Use the same `DSH_HOME` and `PNPM_HOME` you installed with:

```bash
dsh plugin --profile web remove dsh-ensemble
```

Both registrations are effects of the plugin's own fiber, so unloading the
package disposes them. On a **running** server the skill disappears from the
catalog immediately, but a tool already in the roster can linger until a later
or fresh session. Restart DSH if you need both gone at once.

The archive data lives outside the profile, in `DSH_ENSEMBLE_ARCHIVE_ROOT`, and
is not touched by `remove`. Delete it only when you have decided the archive is
disposable.

## Upgrade

Add the new tarball to the same profile and restart the Host:

```bash
dsh plugin --profile web add ./dsh-ensemble-<new version>.tgz
dsh plugin --profile web list      # confirm the version
```

The archive format is versioned and read by the running package; a package that
does not recognize the format refuses rather than guessing. Keep the previous
tarball until you have opened the archive once with the new version.
