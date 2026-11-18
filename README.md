# Skills

Portable skills packaged with native Oh My Pi capabilities where needed.

## Install

### Oh My Pi

Install the plugin directly from GitHub:

```bash
omp install github:vcup/skills
```

This single online installation provides the `ensemble`, `always`, and `edit-commit-msg` skills, native `ensemble-*` task agents, and the path-safe `ensemble_state` tool. Do not clone the repository, pass a local `--extension` path, or separately install a skill with `npx skills` on OMP.

Update or remove it through OMP's plugin manager.

### Other harnesses

Discover and select portable skills from this repository:

```bash
npx skills@latest add vcup/skills
```

To select a specific skill:

```bash
npx skills@latest add vcup/skills --skill ensemble
npx skills@latest add vcup/skills --skill always
npx skills@latest add vcup/skills --skill edit-commit-msg
```

Add `-a <agent>` to select the target harness.

`npx skills` installs the selected method under `skills/`; it does not install OMP runtime agents or tools.

## Use

On OMP, invoke `/skill:ensemble <deliverable, constraints, and completion checks>`. See the [OMP guide](adapters/omp/README.md) for role loading and checkpoint storage. Other harnesses use their native skill invocation and the [portable method](skills/ensemble/SKILL.md).

## Package surface

- [Ensemble](skills/ensemble/SKILL.md): portable method, [practice guide](skills/ensemble/README.md), and [patterns](skills/ensemble/PATTERNS.md).
- [Always](skills/always/SKILL.md): lossless clarity, compression, and logic audits (formerly `lossless`).
- [Edit commit message](skills/edit-commit-msg/SKILL.md): crafts Git's pending message without changing history or workflow state.
- [Scout](agents/ensemble-scout.md), [reviewer](agents/ensemble-reviewer.md), and [worker](agents/ensemble-worker.md): OMP-native assignment roles.
- [OMP adapter](adapters/omp/index.ts): the path-safe `ensemble_state` tool.
- [DSH design](docs/ensemble/README.md): the planned managed adapter and its [delivery roadmap](ROADMAP.md).

## Design

`ensemble` covers full outcomes through independent contributions checked against ground truth. `always` applies lossless clarity and logic checks throughout every task, compressing language only after recovering its propositions, relations, boundaries, and practical effect. `edit-commit-msg` reconstructs commit intent from read-only evidence and writes only Git's pending message file; it never creates, amends, or advances a commit.

Harness adapters should use their strongest native capabilities instead of emulating a lowest common denominator. On OMP:

- plugin installation supplies the skill and agents together;
- native task roles and tool allowlists provide contribution shapes;
- the harness selects models and reports available agents;
- task notifications eliminate polling;
- task outputs and artifacts are evidence pointers;
- `ensemble_state` atomically writes only `.ensemble/<NNN>-<slug>/STATE.md`.

The coordinator remains responsible for the outcome and may investigate, implement, integrate, or validate directly. Delegation exists to create useful independence and parallelism, not to forbid coordinator work.

Maintainer design: [separate ensemble distributions](docs/ensemble/DISTRIBUTION.md) keeps `vcup/skills` as the pure-skill Git installation source. Its complete generated skill directory and local references will be committed here; OMP and DSH will use independent packages. This repository overview serves source maintainers; installed skills and packages receive only their own usage guides.

## Version control

Keep product changes under this repository's conventions. Concrete environment configuration and high-frequency coordination/learning history belong in separate private storage, not merely separate commits here. A managed adapter maintains them through tools outside the workspace; current OMP only provides the documented state writer. The [DSH plugin design](docs/ensemble/README.md) specifies the proposed managed workflow. The [roadmap](ROADMAP.md) assesses its current stage and plans design completion, implementation, and acceptance of the full feature set.
