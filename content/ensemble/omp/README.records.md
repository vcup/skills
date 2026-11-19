## Records on this path

- **Checkpoint:** `ensemble_state` writes `.ensemble/<NNN>-<invocation-slug>/STATE.md` relative to the session working directory. The Lead allocates the three-digit prefix, `001`–`999`, with one writer at a time.
- **Enforced by the writer:** path shape, no symlinked root or invocation directory, atomic replacement via temporary file and rename.
- **Not provided:** identity allocation, semantic validation, concurrent-writer coordination, history commits, external archive configuration, and power-loss durability guarantees.
- **History:** keep `.ensemble/` in its own repository and exclude it locally when it is not already tracked. Records outside the workspace use ordinary authorized file tools instead.
- **Evolution readings:** [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md) in the same records area.

See [`SKILL.md`](SKILL.md#records-on-this-path) for the operational statement and the exhaustion rule.
