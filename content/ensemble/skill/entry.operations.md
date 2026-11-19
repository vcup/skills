## Records on this path

This installation is a portable skill directory. It contains the complete method and its local references, and it does not require a build step, network access, or files outside this directory to be read.

**Invocation checkpoint.** Keep the checkpoint in a records area outside this skill directory and outside the product commit stream. A separate records repository, or a locally excluded directory in the working repository, both work. Use ordinary authorized file tools to write it. Start from [`STATE-TEMPLATE.md`](STATE-TEMPLATE.md), which lists the fields to keep current.

**Identity and history.** You allocate the invocation identity and any history yourself. No tool here validates the checkpoint's meaning, numbers invocations, coordinates concurrent writers, or commits history. Report what you actually preserved; do not describe these records as a managed archive.

**Evolution readings.** Follow [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md) in the same records area. Keep entries in sequence without narrative timestamps or work durations, and preserve failed approaches and corrections.

**Installation and updates.** The skill directory is generated from a single maintained source and committed. Install or update it through your harness's normal skill installation for this repository; do not edit files here, because the next installation replaces them. If two installations of `ensemble` are visible at once, report the duplicate sources and stop rather than merging their instructions.

**Capabilities.** Agent creation, model selection, isolation, messaging, task boards, and notifications come from your harness. Use the ones it actually exposes and record any missing capability as a gap.
