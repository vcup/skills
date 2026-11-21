# DSH Adapter — Host-only P1 probe

A bounded probe for DeepSeek Harness `0.2.2-rc.4` and `0.2.2-rc.5`; `0.2.2-rc.5`
is the default for new installs. The original rc.4 source baseline
(`3f321d32bfe382212a8ed8785c1d47a5a300aa23`) remains the pinned design source
for the DSH seam; it is not a claim that rc.5 is unsupported. It exists to answer
one P1 question with real evidence: **can the published Loader load a package
that registers the `ensemble` skill and one read-only reference tool, with no
source checkout present?**

It answers that question and nothing else. See [What this is
not](#what-this-is-not).

**Supported set:** exactly DSH `0.2.2-rc.4` and `0.2.2-rc.5`, with `0.2.2-rc.5`
the default. `engines.dsh = "0.2.2-rc.4 || 0.2.2-rc.5"` and the
`dsh-skill`/`dsh-tools` peers use the same disjunction so pnpm dedupes to the
host copy (`@deepseek-ai/cordis` remains `~4.1.0`). The set is an explicit
enumeration: DSH judges an own `engines.dsh` with `includePrerelease`, so
open ranges such as `>=0.2.2-rc.4` or `^0.2.2-rc.4` would admit future
prereleases nobody tested. An unknown or future release is refused until it is
verified and added on purpose. See [Version support and upgrade](../../docs/UPGRADING.md).

## Owner archive replay (maintainers)

0.3.0 ships a **bounded** owner-only archive surface; it does **not** mean P2 is
complete. The namespace is `ensembleArchive` on the Typert Remote gateway, with
four methods — `initialize`, `bind`, `status`, `readBack` — each taking exactly
one object parameter named `request`. There is **no `dsh` subcommand** for the
archive. From this repository, the Make entry points `archive-owner-help`,
`archive-owner-status` (credential from `ENSEMBLE_ARCHIVE_COOKIE`), and
`archive-owner-call` (`ARCHIVE_METHOD` + `ARCHIVE_REQUEST`) drive the packaged
`ensemble-archive` CLI, each requiring `INSTALL_DIR` (see the [development
guide](../../docs/DEVELOPMENT.md)). The CLI itself runs on plain Node with **no
external DSH install** — its client transport is bundled privately in the
package — and it is the entry to that Remote. It talks to a running Host through
the Host's client transport from an authenticated owner Peer; the Peer and its
`owner` principal are assigned by the Host's connection layer from the session
cookie, never by a request field or by in-process code.

CLI shape (also in the installed package README):

```text
ensemble-archive <status|initialize|bind|readBack> [--url <origin>] [--request <json|@file>] \
  [--cookie-file|--cookie-stdin|ENSEMBLE_ARCHIVE_COOKIE] [--json]
```

`dsh plugin add` installs that binary into the **profile**, not onto `PATH`:
`<DSH_HOME>/profiles/<name>/node_modules/.bin/ensemble-archive`. A bare
`ensemble-archive` therefore fails with exit 127, and `dsh plugin` offers no
`exec` subcommand to reach it (it forwards to pnpm only). Invoke it by that path
or put the profile's `.bin` on `PATH` first; `node` must also be on `PATH`, since
the shebang is `#!/usr/bin/env node`.

Credentials are accepted only from a file, stdin, or the
`ENSEMBLE_ARCHIVE_COOKIE` environment variable. `--cookie <value>` on the
command line is refused (exit 2) and the value is never echoed. Exit codes:
`0` success; `1` invalid input / host refusal; `2` usage error; `3` no or empty
credential; `4` credential rejected by the Host; `5` Host unreachable.

Verified gateway-tier evidence (packed tgz, real
`TypertGatewayService.invoke`): `initialize` ok (`arch-9bdb9ddae63d74c3`,
sequence 1); `bind` ok (sequence 2, canonical address recorded); a stale `bind`
returned `revision_conflict`; after a Host restart `status` showed the same
`headRevision` and `archiveId`; `readBack` returned 277 bytes containing
`ensemble-archive/v1`. The CLI was measured on a live Host for the exit-code
table above. Transport remains headless HTTP/WebSocket over loopback only:
**no browser SPA load and no TLS**; HTTPS origins are accepted but TLS and
`Secure`-cookie branches were read, not run. A non-owner over the transport
cannot be tested in this release (the principal map has only `owner`); the
non-owner refusal is proven at the guard level.

Driven over the **real transport** (isolated `DSH_HOME`, real `dsh plugin add`,
real Host, launch token exchanged by `curl -c`, verbatim `#HttpOnly_` jar, plain
Node): `status` ok (`archiveInitialized: false`); `initialize` ok
(`arch-1045f15e3288f6ec`, sequence 1, head `6086dc79…`); `bind` ok (sequence 2,
head `9777dd53…`, `nativeWorkspaceRef: ws:2` recorded); a stale `bind` returned
`revision_conflict` (exit 1, "nothing was written"); `readBack` returned
`meta.json` (311 bytes) **and** `operations/1.json` plus `operations/2.json`, so
the second `bind` preserved the earlier record at the head; after a Host restart
the same `headRevision` and `archiveId` were reported with no re-initialize. The
non-owner refusal and the cross-world refusal remain proven at the guard level
only — a second authenticated principal and a genuinely different world cannot
be produced in this environment.

Set two variables in the Host process **before it starts** (systemd
`Environment=`, shell export, or container env); they are read once in
`apply()`, so changes need a restart:

- `DSH_ENSEMBLE_ARCHIVE_ROOT` — absolute path outside every bound source; may
  not exist yet and is created on first `initialize`. A relative, empty, or
  overlapping root is refused.
- `DSH_ENSEMBLE_ARCHIVE_WORLD` — explicitly chosen by the deployment; never
  derived from a path or Session cwd.

The plugin validates non-overlap after `realpath` and records the
owner-supplied `worldIdentity` in the binding; it does **not** prove Host and
source are in the same execution world. An unproven cross-world source is
refused (`cross-world source is not supported`, head unchanged); a deployment
that evidences the world is accepted. That is a real gate, not a plugin proof
of same-world.

The full user-visible root refusals from the Remote are:

- unset/empty: `the configured archive root is unusable: the archive root is empty: set DSH_ENSEMBLE_ARCHIVE_ROOT to an absolute path outside every bound source`
- relative: `the configured archive root is unusable: the archive root must be absolute, not "<value>": a relative path resolves against a process cwd this code does not own` (`<value>` is quoted, e.g. `not "relative/archive":`)
- overlap, root inside source: `the configured archive root is unusable: the archive root <canonical> is inside the bound source <canonicalSource>; the archive must live outside every source it records`
- overlap, source inside root: `the configured archive root is unusable: the bound source <canonicalSource> is inside the archive root <canonical>; a commit there would appear in the user's own repository`

Replay sequence (owner Peer, same archive root throughout):

1. `export DSH_ENSEMBLE_ARCHIVE_ROOT=<absolute path outside the source>`.
2. Start the Host and connect as the authenticated owner Peer.
3. `initialize { request: { source_descriptor, initial_grants, expected_revision: "absent" } }`; record `committedRevision`.
4. `bind { request: { source_descriptor, reason, expected_revision: <committedRevision> } }`.
5. `status { request: {} }`; record `headRevision`.
6. Restart the Host, reconnect, `status { request: {} }`; `headRevision` and `archiveId` must be unchanged.
7. `readBack { request: { revision: <headRevision>, path: "meta.json" } }`.

`source_descriptor` carries owner-supplied `worldIdentity`, `canonicalAddress`,
`nativeWorkspaceRef`, and optional `nativeSessionRef`/`baseline`. Boundary
rules: `expected_revision` must be the commit id just read; `latest` and `HEAD`
are refused; `absent` is accepted only by `initialize`; a second `initialize`
returns `archive_already_initialized`. No grant/revoke/takeover, model write
tool, or Client/GUI exists in 0.3.0.

## Files

| File | Role |
|---|---|
| `index.ts` | Plugin entry: registers the skill provider and `ensemble_reference`. The only file importing `@deepseek-ai/*`. |
| `meta.ts` | Names, peers, `engines.dsh`, rank, reference enumeration, output budget. |
| `reference.ts` | Closed-enumeration reader: allowlist, symlink refusal, 64 KiB budget. No DSH imports. |
| `skill.ts` | Frontmatter parsing and provider factory. No DSH imports. |
| `package-readme.md` | README placed in the packaged bundle (not this repository's). |
| `loader-check.ts` | Real-Loader verification script. Not a `*.test.ts`; runs against an isolated install. |
| `tsconfig.json` | Type check for the DSH modules that do not import `@deepseek-ai/*` (`meta`, `reference`, `skill`) plus `scripts/pack-dsh*` and `typecheck-host.ts`. |
| `tsconfig.host.json` | Compiler options for the Host entry modules (`index.ts`, `loader-check.ts`), which import `@deepseek-ai/*` and are therefore **not** in any repository tsconfig. |
| `typecheck-host.ts` | Runs the check above against a real isolated rc.4 install. Separate gate; not part of the repository typecheck. |

## Package

`scripts/pack-dsh.ts` produces `build/pack/dsh/dsh-ensemble-probe-0.3.0.tgz`
(git-ignored). The bundled skill text comes from the in-memory
`build('dsh')` result of `scripts/build-ensemble.ts`; the ignored default
staging directory is never read, so a stale checkout cannot enter a package.

The staged package includes the host plugin and skill/reference files, plus
0.3.0's CLI. The CLI's transport is a **generated** bundle rather than the
reviewed source: `lib/transport.mjs` imports `@deepseek-ai/cordis` and the client
entry as bare specifiers, which a Node process started from an installed package
cannot resolve, so `make dsh-bundle` inlines that four-package closure into one
file with no bare imports. `make pack` only reads it, and `make check` verifies
its digest and closure offline:

```text
bin/ensemble-archive.js         packaged owner-archive CLI
lib/transport.bundle.mjs        generated private bundle of the client transport
lib/transport.bundle.json       its provenance: inputs, versions, digests, externals
lib/cookie-jar.mjs              session cookie reader
package.json                    bin, exports, and Host peers (no ordinary dependency)
cordis.patch.yml                one insert row naming this package
index.js                        bun-built entry, @deepseek-ai/* left external
bundle-manifest.json            {target: dsh, files:[{path,sha256,bytes}]}
README.md                       package home (from package-readme.md)
skills/ensemble/SKILL.md        user-invocable instructions
skills/ensemble/README.md       five references, fixed enumeration
skills/ensemble/PATTERNS.md
skills/ensemble/GLOSSARY.md
skills/ensemble/STATE-TEMPLATE.md
skills/ensemble/EVOLUTION-TEMPLATE.md
```

## Commands

Repository operations go through the Make entry point (see the [development guide](../../docs/DEVELOPMENT.md)):

```bash
make pack-dsh                 # stage + npm pack
make test                     # the full suite, including this probe's tests
make typecheck                # type check, dependency-free modules
```

`make test-narrow` runs only the content builder's tests
(`scripts/build-ensemble.test.ts`); it does **not** run this probe's tests.

## Installing the package into a profile

`dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`; without it `add`
fails with `pnpm was not found` (exit 127). `remove` also fails (exit 1) if
`PNPM_HOME` differs from the one used for `add`. `--profile` precedes the pnpm
verb. Both are prerequisites, not defects.

Use a profile that has an app row. `web` is the shipped template and the safe
choice: a composition with no app/startup row boots and then keeps running
instead of printing help, which looks like a hang.

From the repository root, every line runs in the same directory:

```bash
make pack-dsh
dsh plugin --profile web add ./build/pack/dsh/dsh-ensemble-probe-0.3.0.tgz
dsh plugin --profile web list                        # shows dsh-ensemble-probe@0.3.0
dsh --profile web                                    # start DSH
```

If the package arrives on its own, the tarball is not beside a `build/`
directory. Run `add` from the directory that holds it, with a path relative to
that directory:

```bash
cd <directory-containing-the-tgz>
dsh plugin --profile web add ./dsh-ensemble-probe-0.3.0.tgz
```

`add` prints two lines that are **not** failures — `Agent skills awaiting
approval: … Run "pnpm approve" to review them.` and a peer-dependency `WARN`.
Both are non-fatal; `add` exits 0.

### Isolated first run

A throwaway scratch root, so nothing touches `~/.dsh`. Run from the repository
root (the `add` path is relative to it):

```bash
scratch="$(mktemp -d)"
export DSH_HOME="$scratch/home" npm_config_cache="$scratch/npm-cache" PNPM_HOME="$scratch/pnpm"
export PATH="<your-rc4-install>/node_modules/.bin:$PATH"   # provides the dsh CLI
make pack-dsh
dsh plugin --profile web add ./build/pack/dsh/dsh-ensemble-probe-0.3.0.tgz
dsh --profile web
```

### Startup output

`dsh --profile web` serves on `127.0.0.1:3080` by default and prints:

```text
dsh web: http://127.0.0.1:<port>/?token=<redacted>
dsh web: opening the default browser; pass --no-open to disable
```

The second line appears only when a browser handoff is available; `--no-open`,
or an SSH session (`SSH_CONNECTION`/`SSH_TTY`), suppresses it. The URL carries a
session token — treat it as a credential and do not paste it elsewhere.

### Removing

Use the same `DSH_HOME` and `PNPM_HOME`:

```bash
dsh plugin --profile web remove dsh-ensemble-probe
```

Both registrations are effects of the plugin's own fiber, so unloading disposes
them. On a **running** server the skill leaves the catalog at once, but a tool
already in the roster can linger until a later or fresh session; restart to be
sure both are gone.

The `update` verb exists and runs (`dsh plugin --profile web update` reports
`Already up to date` on an unchanged install). The 0.1.0 → 0.1.1 in-place
upgrade was observed on an rc.4 host with the real CLI: adding 0.1.1 to the same
profile replaced 0.1.0 (pnpm printed `- 0.1.0` / `+ 0.1.1`), `plugin list` and
the on-disk manifest showed 0.1.1 with the explicit rc.4/rc.5 set, and no
private peer copies remained. See [Version support and upgrade](../../docs/UPGRADING.md).

Two checks need an installation that resolves `@deepseek-ai/*`; neither is part
of the full test or repository typecheck. Pass an already prepared isolated
rc.4 install through `INSTALL_DIR` (see the development guide for how it is
prepared). That install must also contain the probe tgz produced by `make
pack-dsh`, otherwise the real Loader step of `host-check` fails with `Cannot
find package 'dsh-ensemble-probe'`.

```bash
make typecheck-host INSTALL_DIR=<isolated-rc4-install-dir>   # Host entry types
make host-check INSTALL_DIR=<isolated-rc4-install-dir>       # real Loader behaviour
```

`make profile-check INSTALL_DIR=<isolated-rc4-install-dir>` and `make
isolation-check INSTALL_DIR=<isolated-rc4-install-dir>` are gates: they exit 0
only when the capability is actually verified; without a usable install they
exit 2 with an explicit configuration error, so they never report a pass by
skipping a check. `make diagnose INSTALL_DIR=<isolated-rc4-install-dir>` is
observation only (`OBSERVATION ONLY — not a check`) and always exits 0 without
asserting a conclusion.

`typecheck-host.ts` copies the modules beside the install, compiles them with
that install's `tsc` under `tsconfig.host.json`, and refuses a directory without
`@deepseek-ai/dsh-skill@0.2.2-rc.4`. No shim, stub, or hand-written declaration
is involved. It proves the Host entry modules type-check against the published
rc.4 types; it is not part of the repository typecheck (`make typecheck`), and nothing in this repository
type-checks `index.ts` or `loader-check.ts` without such an install.

## What was run, and where it stops

Historical P1 baseline observation in a container-only isolated install
(published rc.4 packages plus the then-current 0.1.0 probe tarball, with an
isolated home). The version and support strings in this table are what was
measured then; current install commands above use 0.3.0 and the explicit
rc.4/rc.5 set.

| Command | Result |
|---|---|
| `make pack-dsh`（同一脚本） | exit 0, 11 files, stable sha256 across runs |
| `bun test` | exit 0; the 18 probe tests pass |
| `tsc -p adapters/dsh/tsconfig.json` | exit 0 (dependency-free modules + pack scripts) |
| `bun adapters/dsh/typecheck-host.ts <install>` | exit 0 — `index.ts` + `loader-check.ts` against published rc.4 types |
| `tsc -p tsconfig.json` | exit 0 |
| `python3 scripts/check-docs.py` | exit 0 |
| `node loader-check.ts` | exit 0, 44 PASS |
| `dsh plugin --profile web add <tarball>` | exit 0; dependency added and `dsh-ensemble-probe` appended to `dsh.profile.bundles` |
| `dsh plugin --profile web list` | exit 0; `dsh-ensemble-probe@0.1.0` listed |
| `dsh --profile web --dump-config` | exit 0; `# == dsh-ensemble-probe` layer present |
| `dsh --profile web` | exit 0; serves `127.0.0.1:3080` and prints its URL line (plus a browser-handoff line when one is available) |
| `dsh plugin --profile web update` | exit 0; `Already up to date` (no newer build exists to exercise) |
| `dsh plugin --profile web remove dsh-ensemble-probe` | exit 0; bundle and dependency removed |
| `make profile-check INSTALL_DIR=<install>` | exit 0; 3/3 profile shapes measured on rc.4 |

`dsh plugin` forwards to pnpm, so pnpm must be on `PATH`; without it `add` fails
with `pnpm was not found` (exit 127). `remove` also fails (exit 1) if
`PNPM_HOME` differs from the one used for `add`. `--profile` precedes the pnpm
verb. Both are prerequisites, not defects.

The earlier `dsh --profile probe` / `--profile probe --help` timeout (exit 124)
was a measurement artifact, not a Loader failure: `--help` is the **app's** help,
so a composition with no app/startup row boots successfully and then keeps
running without printing one. That is also why the documented profile is `web`
(a shipped template with an app row) rather than a hand-made base-only profile.
`make profile-check` measures the distinction directly, in three shapes:

- a shipped template with an app row prints its app help and exits 0;
- a hand-composed profile with an app bundle does the same;
- a profile with **no** app row boots and stays running — measured at the
  deadline with no help output and no error, which is the expected success, not
  a hang.

So the accurate success criterion for a profile is: with an app row, it prints
that app's help and exits 0; without one, it boots and keeps running, and the
absence of `--help` output proves nothing. A profile that fails to boot reports
its error or the timeout verbatim and `profile-check` exits 1.

`--dump-config` shows the layer is composed; it does not show the row
activating. The row's activation is proven by `loader-check.ts` under `boot()`,
which is the same Loader the CLI uses, but not the CLI's own profile boot.
Profile boot in a container install is not evidence about a live Host profile.

## Registration behaviour

- **Skill `ensemble`.** Registered through `ctx.skills.registerProvider` with
  `rank = 600` (`BUNDLED_SKILL_RANK`, rc.4 `packages/skill/skill/src/index.ts`
  line 28) and the invocation policy parsed from the bundled frontmatter:
  `disable-model-invocation: true` ⇒ `{modelInvocable: false, userInvocable:
  true}`, matching `packages/skill/skill-filesystem/src/index.ts` lines
  1015–1021. The skill is therefore reachable by a user gesture and absent from
  model-facing catalogs. A project-local source outranks it; the registry keeps
  one winning definition and never concatenates bodies.
- **Duplicate provider.** A second registration of the same provider name in one
  layer fails; the Loader reports that row as an inactive entry with a warning
  and the first provider keeps serving. Verified in the real Loader.
- **Unload.** Both registrations are effects of the plugin's fiber. Disposing
  the tree removes the provider and the tool.
- **`ensemble_reference`.** Accepts exactly one of the five reference names. The
  schema declares the enumeration, and `execute` re-validates it, so a relaxed
  schema would not widen what the body accepts. Any separator, traversal
  segment, absolute path, unknown name, or `SKILL.md` is rejected with
  `UNKNOWN_RESOURCE`; a symbolic link fails with `RESOURCE_UNAVAILABLE`; a file
  over 65536 bytes fails with `OUTPUT_BUDGET_EXCEEDED`. It never truncates,
  paginates, or falls back to another directory.

## What this is not

0.3.0's owner archive and CLI are a bounded first slice, not "P2 complete". Not
implemented and not accepted here: model-facing domain write tools,
grant/revoke/takeover, the Client/GUI half or settings, model/provider selection
policy, and any claim that the plugin proves physical Host/execution-world
separation. The isolated Host-local group runs archive Git in its own
subprocess/sandbox scope; whether Host and source share an execution world is
the owner's deployment assertion recorded as `worldIdentity`, not plugin proof.

`loader-check.ts` proves the published Loader loads this package in a container
install. It is not evidence about a real Host, a running GUI, or a profile
installation, and it is not a substitute for the R8/R15/R18 acceptance runs.
