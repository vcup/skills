# Skills

Portable skills packaged with native Oh My Pi capabilities where needed.

## Install

### Oh My Pi

Install the plugin directly from GitHub:

```bash
omp install github:vcup/skills
```

This single online installation provides the `ensemble`, `lossless`, and `edit-commit-msg` skills, native `ensemble-*` task agents, and the path-safe `ensemble_state` tool. Do not clone the repository, pass a local `--extension` path, or separately install a skill with `npx skills` on OMP.

Update or remove it through OMP's plugin manager.

### Other harnesses

Install a portable skill with `npx skills` when the harness does not consume this plugin package:

```bash
npx skills add vcup/skills --skill ensemble -a <agent>
npx skills add vcup/skills --skill lossless -a <agent>
npx skills add vcup/skills --skill edit-commit-msg -a <agent>
```

`npx skills` installs the selected method under `skills/`; it does not install OMP runtime agents or tools.

## Package surface

- `skills/ensemble/`: portable method and optional pattern references.
- `skills/lossless/`: portable method for concise, meaning-preserving prose and language audits.
- `skills/edit-commit-msg/`: safely crafts the pending Git commit message without changing history or workflow state.
- `agents/`: OMP-native independent scout, reviewer, and worker roles.
- `adapters/omp/index.ts`: registers the path-safe `ensemble_state` tool.

## Design

`ensemble` covers full outcomes through independent contributions checked against ground truth. `lossless` compresses language only after recovering its propositions, relations, boundaries, and practical effect. `edit-commit-msg` reconstructs commit intent from read-only evidence and writes only Git's pending message file; it never creates, amends, or advances a commit.

Harness adapters should use their strongest native capabilities instead of emulating a lowest common denominator. On OMP:

- plugin installation supplies the skill and agents together;
- native task roles and tool allowlists provide contribution shapes;
- the harness selects models and reports available agents;
- task notifications eliminate polling;
- task outputs and artifacts are evidence pointers;
- `ensemble_state` atomically writes only `.ensemble/<NNN>-<slug>/STATE.md`.

The coordinator remains responsible for the outcome and may investigate, implement, integrate, or validate directly. Delegation exists to create useful independence and parallelism, not to forbid coordinator work.

## Version control

Version coordination state through repository VCS when available. Submit code under repository conventions. Keep state and code submissions separate.
