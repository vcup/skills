# Ensemble Invocation State

`STATE.md` is a compact recovery view, not a work ledger or technical dossier. Keep technical truth in the subject and evidence; keep frequent history in a separate repository rather than the product commit stream.

**Where it goes.** `.ensemble/<NNN>-<invocation-slug>/STATE.md` relative to the session working directory. The Lead allocates the next three-digit prefix from `001` through `999`, one state writer at a time; at exhaustion choose another authorized records location rather than overwriting an invocation or passing `1000`.

**How it is written.** `ensemble_state` replaces the complete checkpoint atomically through a temporary file and rename. It rejects symlink roots and symlinked invocation directories and cannot redirect to an external archive. Atomic replacement alone does not guarantee power-loss durability.

**What is not provided.** The writer does not allocate identities, validate the checkpoint's meaning, coordinate concurrent writers, or commit history. Keep `.ensemble/` in its own repository and exclude it locally from the product repository when it is not already tracked. For a records location outside the workspace, use ordinary authorized file tools and allocate identities there instead of calling this writer. Existing tracked records require a separate migration decision rather than an automatic move.
