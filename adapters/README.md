# Adapter Contract

`npx skills` distributes only `skills/ensemble/`. It does not install the role adapters in this directory.

| Harness | Native role location | Role format | Status |
|---|---|---|---|
| Oh My Pi | extension package `agents/` | Markdown frontmatter | implemented |
| Claude Code | plugin `agents/` | Markdown frontmatter | contract-only |
| Codex | `.codex/agents/` | TOML | contract-only |
| GitHub Copilot | `.github/agents/` | Markdown frontmatter | contract-only |

A future adapter must map `skills/ensemble/ROLE-CONTRACT.yaml` without claiming stronger enforcement than its harness supplies. It must preserve these rules:

- `state-writer` copies supplied invocation content verbatim and never modifies the deliverable;
- workers are assessed against their assigned coverage, while the accepted set is assessed against full coverage;
- state recovery and code-history submission are separate;
- unavailable VCS, tool isolation, or role discovery is recorded as a capability loss.

Until an adapter is implemented, invoke the portable `ensemble` skill and express roles as task assignments. Do not copy a foreign adapter format into another harness.
