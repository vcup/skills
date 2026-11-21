# dsh-ensemble-probe

A **Host-only probe** for DeepSeek Harness `0.2.2-rc.4` and `0.2.2-rc.5`
(`0.2.2-rc.5` is the default for new installs). It proves that the published
Loader can load one package that (a) registers the `ensemble` skill as a
user-invocable skill and (b) exposes one read-only tool over a fixed list of
reference files bundled in the package.

This package is not the ensemble product. It carries the method text, a
reference reader, and a bounded owner archive (the `ensembleArchive` Remote and
its `ensemble-archive` CLI). The CLI runs on plain Node — its client transport is
bundled privately in `lib/transport.bundle.mjs`, so it needs **no external DSH
install** to talk to a running Host. It does not carry model-facing write tools,
grant/revoke/takeover, a Client/GUI, or any claim of physical Host/execution-world
separation. See the owner archive section below for the bounded scope.

## Install

`dsh plugin` forwards to **pnpm**, so pnpm must be on `PATH`; without it `add`
fails with `pnpm was not found` (exit 127). Keep `PNPM_HOME` the same across
`add` and `remove`, or `remove` fails on a store mismatch. `--profile` comes
before the pnpm verb.

Add the package to a profile that has an app row. `web` is the shipped profile
and is the safe choice:

```bash
dsh plugin --profile web add ./dsh-ensemble-probe-0.3.0.tgz
dsh plugin --profile web list      # shows dsh-ensemble-probe@0.3.0
dsh --profile web
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's bundle list. It requires a host that provides the `skills` and `tools`
services (`@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-tools`) at exactly
`0.2.2-rc.4` or `0.2.2-rc.5`; any other release is refused until it is tested
and explicitly added. `@deepseek-ai/cordis` remains at `~4.1.0`.

Do **not** point `--profile` at a custom composition with no app/startup row:
such a profile boots and then keeps running without printing help, which looks
like a hang.

Two messages from `add` are not failures: `Agent skills awaiting approval: … Run
"pnpm approve" to review them.` and a peer-dependency `WARN`. Both are non-fatal
and `add` exits 0.

## First use

Type the skill name in the composer:

```text
/ensemble <task, constraints, and completion checks>
```

The skill is user-invocable only. Model-facing catalogs and the `skill` tool do
not offer it, so asking the model to "use the ensemble skill" will not reach it.

Whether a model turn completes is outside this package's evidence: a turn needs
provider credentials, and without an API key DSH reports
`no API key for provider route`.

## What it registers

| Capability | Behaviour |
|---|---|
| Skill `ensemble` | User-invocable only (`disable-model-invocation: true` in the bundled instructions). Model-facing catalogs and the `skill` tool do not offer it. |
| Tool `ensemble_reference` | Reads back exactly one of `EVOLUTION-TEMPLATE.md`, `GLOSSARY.md`, `PATTERNS.md`, `README.md`, `STATE-TEMPLATE.md` from this package. |

`ensemble_reference` takes a resource name from that fixed enumeration. It has
no path argument, refuses any name outside the enumeration, refuses symbolic
links, and returns at most 65536 bytes per call. A larger resource fails with
`OUTPUT_BUDGET_EXCEEDED`; the probe does not paginate or truncate. Failures are
reported, never replaced by a different source.

## Owner archive (bounded)

The package ships an owner-only Remote namespace `ensembleArchive` with
`initialize`, `bind`, `status`, and `readBack`; each takes one object argument
named `request`. Reach it only as an authenticated owner Peer through the
Typert Remote gateway. Set two variables before the Host starts (read once at
plugin load), so changes need a restart:

- `DSH_ENSEMBLE_ARCHIVE_ROOT` — absolute, outside every bound source; the
  directory is created on first `initialize`. A relative, empty, or overlapping
  root is refused.
- `DSH_ENSEMBLE_ARCHIVE_WORLD` — explicitly chosen by the deployment; never
  derived from a path or the session cwd.

The plugin validates non-overlap after realpath and records the owner-supplied
`worldIdentity` in the binding; it does not prove Host and source share an
execution world. A source whose world the deployment has not evidenced as the
archive's own is refused rather than enabled.

## Archive CLI

0.3.0 ships `ensemble-archive`, the client for that Remote. It runs on plain Node
— no external DSH install — because its client transport is bundled privately in
`lib/transport.bundle.mjs`. It talks to a **running** Host over the Host's own
client transport, so the Peer and its `owner` principal are assigned by the Host's
connection layer from your session cookie. The command never builds a principal
itself and never falls back to a local call: without a credential it sends
nothing and exits 3.

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

### Run a command

**The binary is installed into the profile, not onto your `PATH`.**
`dsh plugin add` puts it in the profile's `node_modules/.bin`, so a bare
`ensemble-archive` fails with `command not found` (exit 127). There is also no
`dsh plugin exec` subcommand to reach it through: `dsh plugin` only forwards its
arguments to pnpm.

Use the `ENSEMBLE_ARCHIVE` path set above
(`<DSH_HOME>/profiles/web/node_modules/.bin/ensemble-archive`) for subsequent commands.

Or put the profile's `.bin` on `PATH` for the rest of the shell:

```bash
export PATH="$DSH_HOME/profiles/web/node_modules/.bin:$PATH"
ensemble-archive status --cookie-file jar.txt
```

The shebang is `#!/usr/bin/env node`, so `node` must be on `PATH` too. Nothing is
installed globally and nothing is added to your shell profile by the installer.

```bash
"$ENSEMBLE_ARCHIVE" initialize --cookie-file jar.txt --request @init.json
# init.json:
# { "source_descriptor": { "worldIdentity": "...", "canonicalAddress": "...",
#                          "nativeWorkspaceRef": "..." },
#   "initial_grants": [ { "subjectId": "owner", "rights": ["manage"] } ] }

"$ENSEMBLE_ARCHIVE" readBack --cookie-file jar.txt \
  --request '{"revision":"<40-hex commit>","path":"meta.json"}'
```

After a restart, `status` reports the same `headRevision`; no re-initialize is
needed, and a second `initialize` on the same root is refused.

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
| 1 | the Host refused the operation (invalid input, unsafe path, revision conflict) | no, the Host answered |
| 2 | usage error, including a credential passed on the command line | yes |
| 3 | no credential, or an empty one | yes |
| 4 | the Host rejected the credential | no, the Host answered 401 |
| 5 | the Host could not be reached | yes |

### Boundaries

- **Headless HTTP + WebSocket only.** The same cookie, trust fence, and
  admission path a browser uses are exercised; a real browser page load is not.
- **Plain HTTP on loopback only.** `https` origins are accepted and
  `redirect: "error"` is forced so the cookie cannot follow a redirect, but the
  TLS and `Secure`-cookie branches were read, not run.
- **A non-owner cannot be tested on this Host.** This release's principal map
  has exactly one member, `owner`, so "an authenticated non-owner is refused" is
  proven at the guard level, not over the transport.
- `bind` was driven over the transport: a real `bind` advanced the head to
  sequence 2 and recorded the new `nativeWorkspaceRef`, and a stale `bind` was
  refused with `revision_conflict` (exit 1, "nothing was written"). The
  cross-world refusal is proven at the guard level, not over the transport: this
  environment cannot produce a genuinely different execution world.
- The archive's Git runs in the plugin's own isolated local
  subprocess/sandbox group, not through the session's execution world.

## Capability status

0.3.0 is a bounded slice, **not phase 2 complete**. The owner archive and its
CLI above are implemented; the following are **not** implemented or accepted
here:

- model-facing domain write tools for coordination, records, or learning;
- grant/revoke/takeover of archive authority;
- a Client/GUI half, resource views, or settings;
- model/provider selection policy;
- any guarantee about physical Host/execution-world separation.

When a step of the method needs a capability this package does not provide,
report the gap; do not improvise a records mechanism or substitute another
toolchain's storage.

## Uninstall

Use the same `DSH_HOME` and `PNPM_HOME` you installed with:

```bash
dsh plugin --profile web remove dsh-ensemble-probe
```

Both registrations are effects of the plugin's own fiber, so unloading the
package disposes them. On a **running** server the skill disappears from the
catalog immediately, but a tool already in the roster can linger until a later
or fresh session. Restart DSH if you need both gone at once.

The `update` verb exists and runs (`dsh plugin --profile web update` reports
`Already up to date` on an unchanged install). The 0.1.0 → 0.1.1 in-place
upgrade was observed with the real CLI: adding 0.1.1 to the same profile
replaced 0.1.0 (pnpm printed `- 0.1.0` / `+ 0.1.1`), and `plugin list` plus the
on-disk manifest showed 0.1.1 with the explicit rc.4/rc.5 set and no private
peer copies.
