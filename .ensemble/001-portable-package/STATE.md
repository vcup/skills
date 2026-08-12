# Ensemble: native harness package

- **Lifecycle:** completed
- **Requested deliverable:** Make ensemble practical by using native harness capabilities, with OMP installed online rather than through a manual clone.
- **Subject and boundary:** portable ensemble method plus OMP plugin package; OMP is the implemented adapter, while other harnesses receive the skill through `npx skills`.
- **Required coverage:** online OMP install; native agents; path-safe state tool; removal of workaround-driven process; portable skill discovery; runtime and boundary verification.
- **Completion evidence:** OMP resolves `github:vcup/skills`; the extension loads three agents and writes only valid invocation state; tests and typecheck pass; `npx skills` still discovers the portable core.

## Contributions

| Attempt | Assigned coverage | Material difference or redundancy | Status | Result / evidence pointer |
|---|---|---|---|---|
| upstream research | OMP installation and plugin discovery | official docs and current CLI behavior | returned | `omp install github:vcup/skills --dry-run --json` |
| architecture audit | workaround-driven skill design | method vs harness-adapter boundary | returned | current skill/package revision |
| runtime smoke | native OMP capabilities | real extension session in a temporary project | returned | three agents discovered; `ensemble_state` wrote `STATE.md` |
| boundary tests | state path safety | invalid path and symlink escapes | returned | `adapters/omp/index.test.ts` |

## Decisions and findings

- OMP uses `omp install github:vcup/skills`; manual clone, local `--extension`, and separate `npx skills` install are not the OMP path.
- Portable skill keeps the method; adapters exploit native agents, models, isolation, notifications, artifacts, and tools.
- Removed mechanical state-writer, integrator role, role contract, scoped briefs, mandatory member summaries, coordinator intervention policing, role-model questions, and unavailable-member state machine.
- Coordinator owns the outcome and may work directly; agents provide independent result-changing contributions rather than enforcing an organizational boundary.
- `ensemble_state` enforces `.ensemble/<NNN>-<slug>/STATE.md`, rejects symlink escapes, and writes atomically.

## Candidate and verification

- **Candidate:** code committed at `95ebb1d` (`Redesign ensemble around native harness capabilities`).
- **Observed checks:** `bun test` passed 4 boundary tests; `bun run typecheck` passed; `npx skills add . --list` found `ensemble`; `omp install github:vcup/skills --dry-run --json` resolved the online source; OMP runtime smoke discovered `ensemble-scout`, `ensemble-reviewer`, and `ensemble-worker`, and `ensemble_state` wrote the requested state file.
- **Unavailable critical checks:** actual online installation of this revision requires pushing `95ebb1d`; source resolution and local plugin runtime were both observed.
- **Unresolved choices or risks:** none blocking.

## Next

- **Next action:** delivered; push the committed revision to make the online installer serve it.
- **Blockers:** none.
