# Ensemble

Portable ensemble methodology, installed as a skill with `npx skills`, plus an optional Oh My Pi adapter.

## Install the skill

Always install the portable skill with `npx skills`:

```bash
npx skills add <owner>/ensemble --skill ensemble -a <agent>
```

Use `--list` to inspect a source and `--copy` only where symlinks are unsuitable. Examples:

```bash
# Codex
npx skills add <owner>/ensemble --skill ensemble -a codex -y

# Claude Code
npx skills add <owner>/ensemble --skill ensemble -a claude-code -y

# GitHub Copilot
npx skills add <owner>/ensemble --skill ensemble -a github-copilot -y
```

The repository exposes the portable core at `skills/ensemble/`, which `npx skills` discovers. This is the recommended and only documented skill-installation path.

## Oh My Pi adapter

`npx skills` installs `SKILL.md` directories only. It does not install OMP extension modules or OMP `agents/` definitions, and OMP is not a `npx skills --agent` target. The adapter therefore needs OMP's native extension mechanism:

```text
omp --extension /absolute/path/to/ensemble
```

Loading the package makes OMP discover its sibling `skills/` and `agents/` directories. The `ensemble-*` agent types then become available to `task`; each autoloads the `ensemble` skill.

Do not present the adapter command as a skill installer. It loads runtime adapter capabilities after `npx skills` has installed the portable skill where needed.

## Package surface

- `skills/ensemble/`: portable Agent Skills methodology.
- `skills/ensemble/ROLE-CONTRACT.yaml`: authoritative semantic role, durability, and degradation contract; installed with the skill.
- `agents/`: OMP mappings from semantic roles to OMP agent definitions and tool allowlists.
- `adapters/`: harness-specific installation and enforcement notes.

## Role contract

| Role | Owns | Semantic capabilities |
|---|---|---|
| `scout` | independent facts and boundaries | read, search, web research |
| `reviewer` | independent claim checks | read, search, inspect |
| `worker` | one assigned contribution | read, modify, validate |
| `state-writer` | mechanical invocation persistence | read, persist state |
| `integrator` | accepted work and candidate validation | read, modify, validate, version control |

The manifest, not a role name, defines these meanings. An adapter maps them to its own agent schema and tools.

## Portability and degradation

The Agent Skills specification does not standardize subagent definitions, agent discovery, tool allowlists, write scopes, or permission enforcement. A harness without a matching adapter must:

1. use the core skill's assignment-based workflow;
2. record unavailable role/tool enforcement in `STATE.md` as a capability loss;
3. never claim a semantic capability is enforced merely because a prompt requests it.

The OMP adapter enforces its declared tool allowlists. OMP does not path-sandbox writes, so the `state-writer` invocation-directory restriction remains a role-contract obligation, not a runtime guarantee.

## Version control

Version coordination state through repository VCS when available; otherwise use harness durability and record the loss. Submit code history under repository conventions. Keep the two submissions separate.
