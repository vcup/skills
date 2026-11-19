# Skills

Portable skills packaged with native Oh My Pi capabilities where needed.

## Install

### Oh My Pi

The isolated OMP package is a local artifact: it is **not published to a registry and has no remote address**. OMP 17.2.15's installer accepts a local directory or a registry spec, but not a `.tgz` file. How you install depends on what you have:

- **Maintainers, inside the mother repository working tree:** build the staging root from the repository root, then install that directory:

  ```bash
  bun scripts/pack-omp.ts
  omp install ./build/pack/omp/staging
  ```

- **If you already have an unpacked package:** change into the unpacked directory and install it there; the package is self-contained and does not need the mother repository or its build scripts:

  ```bash
  omp install .
  ```

This local package provides the `ensemble`, `always`, and `edit-commit-msg` skills, the native `ensemble-*` task agents, and the path-safe `ensemble_state` tool in one isolated installation root. OMP enables it through its plugin manager. No manual `--extension` path is needed; the former mixed Git entry (`omp install github:vcup/skills`) has been replaced by this isolated package. The working-tree artifacts are not committed or published in this round.

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
- [DSH design](docs/ensemble/README.md): the managed adapter design and its [delivery roadmap](ROADMAP.md).

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

Maintainer design: [separate ensemble distributions](docs/ensemble/DISTRIBUTION.md) keeps `vcup/skills` as the pure-skill Git installation source. The generated `skills/ensemble/` directory is produced in the working tree from a single maintained source and passes the generation consistency check; it is not committed in this round. OMP and DSH have their own local build roots, installed as described above and in the [DSH probe delivery record](docs/ensemble/P1-DELIVERY.md), and are not published. This repository overview serves source maintainers; installed skills and packages receive only their own usage guides.

## Version control

Keep product changes under this repository's conventions. Concrete environment configuration and high-frequency coordination/learning history belong in separate private storage, not merely separate commits here. A managed adapter maintains them through tools outside the workspace; current OMP only provides the documented state writer. The [DSH plugin design](docs/ensemble/README.md) specifies the proposed managed workflow. The [roadmap](ROADMAP.md) assesses its current stage and plans design completion, implementation, and acceptance of the full feature set. Durable [research and review evidence](docs/ensemble/research/README.md) and the [design evolution](docs/ensemble/EVOLUTION.md) belong in this repository alongside the design they support. Run `python3 scripts/check-docs.py` to check maintained documentation without private scratch files. The current [P1 delivery record](docs/ensemble/P1-DELIVERY.md) reports what the working-tree probes have verified and what remains unverified.
