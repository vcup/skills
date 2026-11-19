## Installation

This skill installs from its Git source; no build step runs at install time and no file outside the installed directory is required.

```bash
npx skills@latest add vcup/skills
npx skills@latest add vcup/skills --skill ensemble
```

The first command discovers the skills available in the repository; the second selects `ensemble` directly. `@latest` selects the installer version, not an ensemble release version. Record the installer version and repository revision you actually resolved. Add `-a <agent>` to select the target harness.

`npx skills` installs the method under `skills/`. It does not install runtime agents or tools.

## Records on this path

This installation is a portable skill directory: the complete method and its local references, readable without a build step or files outside the directory.

- **Checkpoint:** the Lead keeps it in a records area outside this directory and outside the product commit stream, using ordinary authorized file tools. [`STATE-TEMPLATE.md`](STATE-TEMPLATE.md) lists the fields.
- **Evolution readings:** same records area, following [`EVOLUTION-TEMPLATE.md`](EVOLUTION-TEMPLATE.md).
- **What you own:** invocation identity, numbering, history, and review status are yours to allocate and maintain. Nothing here validates the checkpoint, serializes writers, or commits history.
- **Updates:** the directory is generated from a single maintained source and committed. Update it through your harness's normal skill installation rather than editing files in place.

See [`SKILL.md`](SKILL.md#records-on-this-path) for the operational statement and the duplicate-installation rule.
