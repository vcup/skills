# Development environment

This container provides the toolchain needed to build, test, and debug the
package. It carries tools only; upstream sources are cloned at runtime.

## Toolchain

| Tool | Version | Why |
|---|---|---|
| bun | 1.4.4 | Runs the test suite (`bun:test`) and installs dependencies |
| node | 26.13.1 | Satisfies the DSH engine floor of `node >= 24.9.0` |
| pnpm | 12.21.0 | Matches the DSH workspace package manager |
| git | 2.56.1 | Clones and pins upstream sources |

The image is defined by [`.dsh-podman/skills-dev.yml`](../.dsh-podman/skills-dev.yml).
Load it with the container template, then run the checks from the workspace root:

```bash
bun install --frozen-lockfile
bun test          # 4 pass
bun run typecheck # tsc --noEmit, clean
```

## Upstream sources are fetched, not baked in

DSH moves quickly, so its source does not belong in the image. Clone it into
`.scratch/extra-src/` at the revision you are debugging:

```bash
mkdir -p .scratch/extra-src
git clone --depth 1 --filter=blob:none \
  https://github.com/deepseek-ai/deepseek-harness .scratch/extra-src/deepseek-harness
```

To reproduce a pinned revision, fetch the full history and check out the commit:

```bash
git -C .scratch/extra-src/deepseek-harness fetch --depth 1 origin <sha>
git -C .scratch/extra-src/deepseek-harness checkout <sha>
```

The roadmap pins DSH `0.2.2-rc.4` at `3f321d32bfe382212a8ed8785c1d47a5a300aa23`.
Check what a checkout actually contains before trusting it: an empty directory
makes `git -C` walk up to the enclosing repository and report *its* revision.

`.scratch/` is ignored as a whole. It holds throwaway checkouts, probes, and the
separate records repository, none of which belong in a product commit.

## Network

GitHub over HTTPS works and is the supported path; port 22 is refused, so remote
URLs must use `https://` rather than `git@github.com:`. The npm registry is
reachable, which is what `bun install` uses.

## Why the image rather than the running container

The container root filesystem is read-only, so `pacman`, `npm i -g`, and other
system-wide installs fail at runtime. Toolchain changes belong in the image
template; only `.scratch/` and the project mount are writable.
