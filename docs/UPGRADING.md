# DSH version support and upgrade

This page is the current lifecycle contract for the Host-only DSH probe. It
records **what is supported now**, what changed, and how a future DSH release
is evaluated. It is not a changelog for the ensemble product and does not claim
the probe is the full adapter.

## 1. Three axes, kept separate

| Axis | Current value | What it does **not** mean |
|---|---|---|
| Probe / plugin release | `dsh-ensemble-probe@0.3.0` | The DSH release it runs on; feature completeness |
| DSH releases tested together | `0.2.2-rc.4` and `0.2.2-rc.5`; default `0.2.2-rc.5` | That every newer tag or `latest` release is supported |
| Feature maturity | 0.3.0 adds the `ensemble-archive` CLI, an owner-only archive Remote, and an isolated Host-local runner; still no model-facing domain write, grant/revoke/takeover, Client/GUI, or physical cross-execution-world guarantee | That a wider support set or a new owner surface means phase 2 is complete |

These axes change independently. A probe version bump may add a tested DSH
release without adding features; a new DSH release is not supported merely
because a registry tag moved.

## 2. Current support declaration

Supported set, from `adapters/dsh/compatibility.ts` (the single source for every
consumer): exactly `0.2.2-rc.4` and `0.2.2-rc.5`. `0.2.2-rc.5` is the default
for new installs; `0.2.2-rc.4` is retained because it passes the same matrix.

- `engines.dsh = "0.2.2-rc.4 || 0.2.2-rc.5"`.
- `dsh-skill` and `dsh-tools` peers use the same disjunction so pnpm dedupes to
  the host copy instead of installing a private release beside it.
- `@deepseek-ai/cordis` stays `~4.1.0` (independent of the DSH release).

The set is an explicit enumeration, not a range. DSH's compatibility gate
(`evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot@0.2.2-rc.5`) lets
an own `engines.dsh` decide and evaluates it with `includePrerelease`, so an
open range such as `>=0.2.2-rc.4` or `^0.2.2-rc.4` would admit future
prereleases nobody tested. An exact disjunction fails closed: an unknown or
future release is refused until it is added on purpose with matrix evidence.

Supporting evidence, not a substitute for the run matrix: the five seam
packages' `lib/` trees are byte-identical between rc.4 and rc.5, and the main
manifest differs only in version strings. That explains why the same plugin can
pass on both; it does not replace installing and running the matrix on each.

### Dated registry observation (not a standing truth)

Observed 2026-11-20T01:22Z from <https://registry.npmjs.org/@deepseek-ai%2Fdsh>:
`latest = 0.2.2-rc.5`, `next = 0.2.2-rc.5`, `alpha = 0.2.2-alpha.3`;
rc.5 was published 2026-11-18T13:17Z and rc.4 on 2026-11-17T17:03Z. This is a
point-in-time observation of publisher tags. `latest`, `next`, or any other tag
is never itself evidence of compatibility and never automatically widens the
supported set.

## 3. Change record (compact, evidence-linked)

| Change | Probe / DSH set | Evidence | Upgrade note |
|---|---|---|---|
| Added | 0.1.1 supports exactly rc.4 and rc.5, rc.5 default | Observed full matrix in skills-dev on real isolated installs of both releases: `typecheck-host` exit 0 both; real Loader 44 PASS / 0 FAIL both; `profile-check` exit 0 with 3/3 shapes on each; `isolation-check` 11/11 probes on each. Standard `dsh plugin add` of 0.1.1 exited 0 on both hosts; `plugin list` showed 0.1.1 and no private `dsh-skill`/`dsh-tools` copies (deduped to host). Installed manifests matched the declared set. Isolation probes are container-internal, not Host verification. | Clean rc.5 install uses the 0.1.1 tarball; see §4 |
| Retained | rc.4 in the supported set | Same matrix above passed on rc.4; no forced move | Existing rc.4 profiles remain usable |
| Added | 0.2.0 owner archive surface | Measured against the packed tgz through a real `TypertGatewayService.invoke`: `initialize` ok (`arch-9bdb9ddae63d74c3`), `bind` ok with canonical address, stale `bind` refused (`revision_conflict`), restart `status` shows unchanged head and archive id, `readBack` ok (277 bytes containing `ensemble-archive/v1`). | 0.2.0 is still bounded: see the three-axis row above; do not read this as "P2 complete". Owner replay steps are in [the DSH adapter guide](../adapters/dsh/README.md#owner-archive-replay-maintainers). |
| Added | 0.3.0 owner archive CLI | Ships `bin/ensemble-archive.js`, `lib/transport.mjs`, `lib/cookie-jar.mjs`, and a generated `lib/transport.bundle.mjs` that privately inlines the client transport; the manifest has `bin` and `exports`, with **no external DSH client dependency**, so the CLI runs on plain Node. Measured on a live Host: exit codes 0 success, 1 invalid input/unsafe path, 2 usage (including `--cookie <value>` on argv, which is refused), 3 no/empty credential, 4 auth rejected (401), 5 host unreachable. Credentials only via file, stdin, or `ENSEMBLE_ARCHIVE_COOKIE`; never echoed. Transport is headless HTTP/WebSocket over loopback: no browser SPA load, no TLS proof; non-owner-over-transport untestable in this release and `bind` vectors not individually driven over transport. | Current install uses the 0.3.0 tarball; see the [DSH adapter guide](../adapters/dsh/README.md#owner-archive-replay-maintainers). Still not P2 complete. |
| Deprecated (not dropped) | 0.1.0/0.1.1/0.2.0 as the recommended install | Earlier versions lacked the CLI and/or the wider support set | Upgrade path from 0.1.0 → 0.1.1 was verified; for the current 0.3.0 capability use the 0.3.0 tarball. Upgrade must be re-verified with the real CLI for each version step. |

When a release later stops being supported, replace the relevant row with a
**Dropped** row. The reason may be technical (failed matrix, security or
compatibility defect) **or a deliberate maintenance decision** (upstream EOL,
maintenance cost no longer justified, benefit below burden) — "we stopped
testing it" is never a compatibility failure and is never sufficient by itself.
The record must name the **last probe/plugin version that supported it**, the
**migration path** (which still-tested release to move to, with the concrete
install command), and the **behaviour differences** in the new version. It must
include the date and evidence. History is not rewritten; the §2 declaration
changes so it stays accurate. No state machine, clock, or expiry scheduling.

## 4. Upgrade procedure for a future DSH release

1. **Observe upstream explicitly.** Run `make check-upstream` (explicit network;
   absent from `check`/`test`/`package-check`/`all`, which stay offline). It reads
   public npm dist-tags and classifies them against `compatibility.ts`; it never
   installs, upgrades, changes the support set, or commits. A finding of an
   untested version is a signal to evaluate, not a claim of incompatibility.
2. **Pick a concrete npm version.** Pin an exact published version for the
   experiment; do not use `latest` or `next` as the test target.
3. **Run the full matrix on a standard isolated install.** Install the pinned
   DSH release and the probe in a fresh, repository-external directory with the
   ordinary plugin command. Run the same type, Loader, profile and isolation
   checks used for the current set. Observation-only helpers and forced installs
   are not evidence for a support claim.
4. **Update the declaration only after evidence.** If all checks pass, add the
   version to `compatibility.ts`, set the default only when intended, bump the
   probe version when the packaged contract changes, and update the install
   guides consistently. If checks fail, keep the set unchanged and record the
   rejected version with evidence in §3.
5. **Non-author re-verification, then logical commit.** A second person repeats
   the matrix and confirms commands, version strings and evidence agree. Git
   history is handled by the repository's custodian; this procedure never
   commits on its own.

No scheduled task, live-profile change, or auto-upgrade is part of this
procedure. `latest` never equals support.

### Upstream observation interface

```bash
make check-upstream
```

This is an explicit network operation, absent from `check`/`test`/
`package-check`/`all`, which stay offline. It needs no `INSTALL_DIR` and sends
no credentials. It prints a registry line, the supported set, one section per
observed package with `TAG / VERSION / STATUS` rows, a "supported releases
published" line, and a `SUMMARY` line. `latest`/`next` drive the status;
`alpha` and all peer tags are `informational (not a support signal)` and do not
drive the exit code.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | runtime `latest`/`next` are in the supported set and every required package published all supported versions |
| `1` | runtime `latest`/`next` points outside the set — a candidate to evaluate, **not** a claim of incompatibility |
| `2` | observation failed: registry unreadable, or a supported version is missing from a required package — no conclusion was reached |

`1` means "a finding"; `2` means "could not determine". The command never
installs, upgrades, changes the supported set, or commits. On the 2026-11-20
observation it exited 0; that is a current measurement, not a promise about
future tags — if a runtime `latest` moves to an untested version, exit 1 is the
intended reminder to evaluate it.
