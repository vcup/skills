# Ensemble

Ensemble methodology packaged with native harness capabilities.

## Install

### Oh My Pi

Install the plugin directly from GitHub:

```bash
omp install github:vcup/skills
```

This single online installation provides the `ensemble` skill, native `ensemble-*` task agents, and the path-safe `ensemble_state` tool. Do not clone the repository, pass a local `--extension` path, or separately install the skill with `npx skills` on OMP.

Update or remove it through OMP's plugin manager.

### Other harnesses

Install the portable skill with `npx skills` when the harness does not consume this plugin package:

```bash
npx skills add vcup/skills --skill ensemble -a <agent>
```

`npx skills` installs the method under `skills/ensemble/`; it does not install OMP runtime agents or tools.

## Package surface

- `skills/ensemble/`: portable method and optional pattern references.
- `agents/`: OMP-native independent scout, reviewer, and worker roles.
- `adapters/omp/index.ts`: registers the path-safe `ensemble_state` tool.

## Design

The portable skill states the method: cover the full outcome, produce independent materially different or intentionally redundant contributions, decide by observation rather than votes, evolve one deliverable, and verify the accepted candidate.

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
