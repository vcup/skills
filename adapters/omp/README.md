# OMP Adapter

## Discovery

OMP discovers task agents from enabled extension-package `agents/` directories. Loading this repository as an OMP extension therefore exposes:

- `skills/ensemble/` as `ensemble`;
- `agents/ensemble-*.md` as task agent types.

The extension entry is intentionally inert. Discovery, not runtime code, provides the adapter behavior.

## Mapping

| Semantic role | OMP agent | OMP enforcement |
|---|---|---|
| scout | `ensemble-scout` | read/search/web-only tool allowlist |
| reviewer | `ensemble-reviewer` | read/search/inspection tool allowlist |
| worker | `ensemble-worker` | declared tool allowlist; assignment scope is prompt-enforced |
| state-writer | `ensemble-state-writer` | `read` and `write`; invocation path and verbatim behavior are prompt-enforced |
| integrator | `ensemble-integrator` | declared tool allowlist; repository submission boundary is prompt-enforced |

OMP auto-adds `yield` to declared tool lists and retains `hub`. These are harness behaviors, not role-capability violations.

## Limits

OMP tool allowlists restrict tool names. They do not path-sandbox `write`, `edit`, or `bash`; the manifest's write scopes remain semantic contracts. If stricter isolation is required, run the role in an OMP isolation mode or supply a path-enforcing tool/hook.
