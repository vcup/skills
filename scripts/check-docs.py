#!/usr/bin/env python3
"""Check maintained ensemble docs without private files or network access.

Requires only python3 and the repository's own files. Coverage is explicit:
this script names the maintained trees it checks and the generated/historical
trees it deliberately excludes, so a new maintained Markdown file under a
covered tree is picked up automatically.

Package READMEs are checked against the tree the user actually installs, not
against the source directory they happen to live in. Their virtual installed
trees are derived by this script from the packers' own maintained inputs:
  * OMP: content/ensemble/common/*.md are the files `build('omp')` emits under
    skills/ensemble/, plus the verbatim skills/roles copied by pack-omp.ts;
  * DSH: SKILL_DIR / SKILL_FILE / REFERENCE_RESOURCES are read from
    adapters/dsh/meta.ts, the same constants pack-dsh.ts imports to build its
    allowlist.
This keeps the link check python-only (no bun/node), requires no `make pack`,
and works whether or not the git-ignored build/ staging tree exists. A bad link
inside either package README fails the same gate as any other covered doc.

Optionally validate pinned DSH source links against local checkouts:
  python3 scripts/check-docs.py --upstream <full-sha>=/path/to/checkout
"""

import argparse
import json
from pathlib import Path
import posixpath
import re
import subprocess
from urllib.parse import unquote, urlsplit


# Maintained trees: every Markdown file below these roots is checked.
MAINTAINED_FILES = [
    "README.md", "ROADMAP.md", "GLOSSARY.md",
    "adapters/dsh/README.md", "adapters/dsh/package-readme.md",
    "adapters/dsh-agent-wait/README.md", "adapters/dsh-agent-wait/package-readme.md",
    "adapters/omp/README.md", "adapters/omp/package/README.md",
]
MAINTAINED_DIRS = ["docs", "skills/ensemble", "skills/always",
                   "skills/edit-commit-msg", "agents"]

# Deliberate discovery exclusions (not an accidental wildcard miss):
#   .ensemble/  frozen historical checkpoints; not maintained prose, but still
#               valid explicit link targets from maintained docs.
#   content/    single-source fragments (frontmatter/records); generated input
#               to the builder, not standalone reader-facing docs; valid targets.
#   build/      git-ignored generated/staging output; checked via its source
#               manifests by the package-README rule below.
#   .scratch/, .dsh-podman/, node_modules/  local scratch/tool state; never
#               accepted as a documentation link target.
# These are forbidden as link targets even when inside the repository:
# generated output and local scratch/tool state, not reader-facing docs.
FORBIDDEN_TARGET_DIRS = {"build", ".scratch", ".dsh-podman", "node_modules"}


class VirtFile:
    """A file in the virtual installed package tree."""
    __slots__ = ("source", "built_text")

    def __init__(self, source=None, built_text=None):
        self.source = source
        self.built_text = built_text

    def read_text(self, root):
        if self.built_text is not None:
            return self.built_text
        if self.source is None:
            return ""  # synthesized package file: exists, but has no headings
        return (root / self.source).read_text(encoding="utf-8")


def parse_built_output_names(text, target):
    """Read the output file names from build-ensemble.ts's `spec(<target>)`.

    The builder composes some outputs from multiple fragments, so the installed
    name set is not just `ls content/ensemble/common`. Parsing the spec keeps
    this checker aligned with the packer without executing TypeScript.
    """
    match = re.search(r'function\s+spec\([^)]*\)\s*:\s*TargetSpec\s*\{(.*?)\n\}', text, re.S)
    if not match:
        raise ValueError('scripts/build-ensemble.ts: cannot locate spec()')
    body = match.group(1)
    expected = (
        'target === "skill" ? "skills/ensemble" : `build/ensemble/${target}/skills/ensemble`'
    )
    if expected not in body:
        raise ValueError('scripts/build-ensemble.ts: unexpected outDir rule in spec()')
    repeats = re.findall(r'path:\s*"([^"]+)"\s*,\s*parts:\s*\[(.*?)\]', body, re.S)
    if len(repeats) < 5:
        raise ValueError('scripts/build-ensemble.ts: spec() yielded too few output files')
    return [name for name, _ in repeats]


def read_ts_string(text, name):
    """Read `export const NAME = "value";` from a TypeScript source file."""
    match = re.search(r'export\s+const\s+' + re.escape(name) + r'\s*=\s*"([^"]*)"', text)
    if not match:
        raise ValueError(f'adapters/dsh/meta.ts: missing export const {name}')
    return match.group(1)


def read_ts_string_array(text, name):
    """Read a `export const NAME = ["a", ...] as const;` array."""
    match = re.search(
        r'export\s+const\s+' + re.escape(name) + r'\s*=\s*\[(.*?)\]\s*as\s+const',
        text, re.S,
    )
    if not match:
        raise ValueError(f'adapters/dsh/meta.ts: missing array export {name}')
    return re.findall(r'"([^"]*)"', match.group(1))


def package_trees(root):
    """Return {source README: (virtual root, {installed path: VirtFile})}.

    Every link in these READMEs is resolved from the installed package root.
    The README itself is staged as `README.md`, matching both pack scripts.
    """
    # OMP: pack-omp.ts stages the in-memory build('omp') skill under
    # skills/ensemble/, verbatim skills under skills/always and
    # skills/edit-commit-msg, roles under agents/, plus its manifest/README/
    # extension. The installed filenames come from the builder's own spec();
    # for link checking it is enough that each installed Markdown path exists.
    omp = {
        "README.md": VirtFile(source="adapters/omp/package/README.md"),
        "package.json": VirtFile(source="adapters/omp/package/package.json"),
        "omp-extension/index.ts": VirtFile(source="adapters/omp/index.ts"),
    }
    builder = (root / "scripts/build-ensemble.ts").read_text(encoding="utf-8")
    for name in parse_built_output_names(builder, "omp"):
        omp[f"skills/ensemble/{name}"] = VirtFile()
    for directory in ["skills/always", "skills/edit-commit-msg", "agents"]:
        for path in sorted((root / directory).rglob("*")):
            if path.is_file():
                omp[path.relative_to(root).as_posix()] = VirtFile(
                    source=path.relative_to(root).as_posix())

    # DSH: pack-dsh.ts derives its allowlist from exactly these meta.ts
    # constants. Synthesized files count as present for link checks; their text
    # is irrelevant unless a README links to a heading in one of them.
    meta = (root / "adapters/dsh/meta.ts").read_text(encoding="utf-8")
    skill_dir = read_ts_string(meta, "SKILL_DIR")
    skill_file = read_ts_string(meta, "SKILL_FILE")
    resources = read_ts_string_array(meta, "REFERENCE_RESOURCES")
    if not skill_dir or not skill_file or len(resources) < 5:
        raise ValueError('adapters/dsh/meta.ts: unexpected package file constants')

    # Fail closed on an empty or drifted derivation: a package-tree rule that
    # silently resolves zero links would turn this checker into a rubber stamp.
    required_omp = {"skills/ensemble/STATE-TEMPLATE.md",
                    "skills/ensemble/EVOLUTION-TEMPLATE.md", "README.md"}
    required_dsh = {f"{skill_dir}/{skill_file}",
                    f"{skill_dir}/STATE-TEMPLATE.md", "README.md"}
    if not required_omp.issubset(omp):
        raise ValueError(f'OMP virtual tree missing required files: {sorted(required_omp - set(omp))}')
    dsh = {"README.md": VirtFile(source="adapters/dsh/package-readme.md")}
    for name in ["README.md", "bundle-manifest.json", "cordis.patch.yml",
                 "index.js", "package.json"]:
        dsh[name] = VirtFile()
    for name in resources:
        dsh[f"{skill_dir}/{name}"] = VirtFile()
    dsh[f"{skill_dir}/{skill_file}"] = VirtFile()
    if not required_dsh.issubset(dsh):
        raise ValueError(f'DSH virtual tree missing required files: {sorted(required_dsh - set(dsh))}')

    # dsh-agent-wait: pack-dsh-agent-wait.ts stages exactly these five files
    # (README.md + four synthesized). Its installed README links are resolved
    # against this tree, not against adapters/dsh-agent-wait/.
    wait = {"README.md": VirtFile(source="adapters/dsh-agent-wait/package-readme.md")}
    for name in ["bundle-manifest.json", "cordis.patch.yml", "index.js", "package.json"]:
        wait[name] = VirtFile()
    required_wait = {"README.md", "bundle-manifest.json", "cordis.patch.yml",
                     "index.js", "package.json"}
    if not required_wait.issubset(wait):
        raise ValueError(f'dsh-agent-wait virtual tree missing required files: {sorted(required_wait - set(wait))}')

    return {
        "adapters/omp/package/README.md": (".", omp),
        "adapters/dsh/package-readme.md": (".", dsh),
        "adapters/dsh-agent-wait/package-readme.md": (".", wait),
    }


def github_source_link(match, upstreams, rel, target):
    """Validate a pinned DSH source link; returns 1 when actually checked."""
    checkout = upstreams[match[1]]
    resolved = (checkout / unquote(match[2])).resolve()
    if not resolved.is_relative_to(checkout):
        raise ValueError(f'{rel}: source path escapes checkout: {target}')
    if not resolved.exists():
        raise ValueError(f'{rel}: missing pinned source: {target}')
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', action='append', default=[], metavar='SHA=PATH')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    upstreams = {}
    for value in args.upstream:
        sha, separator, path = value.partition('=')
        if not separator or not re.fullmatch(r'[0-9a-f]{40}', sha) or not path:
            parser.error('--upstream requires a full SHA=checkout-path')
        checkout = Path(path).resolve()
        result = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'],
                                capture_output=True, text=True, check=False)
        if result.returncode or result.stdout.strip() != sha:
            parser.error(f'checkout HEAD does not match {sha}: {checkout}')
        upstreams[sha] = checkout

    try:
        packages = package_trees(root)
    except (OSError, ValueError) as error:
        print(f'package manifest error: {error}')
        return True

    files = [root / name for name in MAINTAINED_FILES]
    for directory in MAINTAINED_DIRS:
        files += sorted((root / directory).rglob('*.md'))
    files = sorted(set(files), key=lambda p: p.relative_to(root).as_posix())

    errors = []
    links = source_checked = remote_skipped = 0
    for file in files:
        rel = file.relative_to(root).as_posix()
        is_package_readme = rel in packages
        virtual_tree = packages.get(rel, (None, None))[1]
        text = file.read_text(encoding='utf-8')
        prose = re.sub(r'^```[^\n]*\n.*?^```\s*$', '', text, flags=re.M | re.S)
        targets = re.findall(r'\]\((<[^>]+>|[^)]+)\)', prose)
        targets += re.findall(r'^\[[^\]]+\]:\s*(\S+)', prose, re.M)
        for raw in targets:
            target = raw.strip()
            target = target[1:-1] if target.startswith('<') and target.endswith('>') else target.split(' "', 1)[0]
            url = urlsplit(target)
            if url.scheme in ('http', 'https'):
                match = re.fullmatch(r'/deepseek-ai/deepseek-harness/blob/([0-9a-f]{40})/(.+)', url.path)
                if not match or url.netloc != 'github.com' or match[1] not in upstreams:
                    remote_skipped += 1
                    continue
                try:
                    source_checked += github_source_link(match, upstreams, rel, target)
                except ValueError as error:
                    errors.append(str(error))
                continue
            if url.scheme:
                continue
            if (url.path.startswith('/') or re.match(r'^/(tmp|var/tmp|home|Users|root)/', url.path)
                    or url.path.startswith('~')):
                errors.append(f'{rel}: nonportable absolute link: {target}')
                continue

            if is_package_readme:
                # Installed-package semantics: resolve from the virtual package
                # root, never from the README's source directory. This keeps
                # `skills/ensemble/STATE-TEMPLATE.md` green even though that
                # path does not exist under adapters/omp/package/.
                base = posixpath.normpath(posixpath.join('.', unquote(url.path))) if url.path else '.'
                if base == '..' or base.startswith('../'):
                    errors.append(f'{rel}: link escapes installed package: {target}')
                    continue
                resolved = virtual_tree.get(base)
                if resolved is None:
                    errors.append(f'{rel}: missing in installed package: {target}')
                    continue
                content = resolved.read_text(root)
                virtual_path = base
            else:
                resolved = (file.parent / unquote(url.path)).resolve() if url.path else file
                relative = resolved.relative_to(root) if resolved.is_relative_to(root) else None
                if relative is None or any(part in FORBIDDEN_TARGET_DIRS for part in relative.parts):
                    errors.append(f'{rel}: link depends on private files: {target}')
                    continue
                if not resolved.exists():
                    errors.append(f'{rel}: missing {target}')
                    continue
                if resolved.is_dir() or not url.fragment:
                    links += 1
                    continue
                content = resolved.read_text(encoding='utf-8')
                virtual_path = relative.as_posix()

            links += 1
            if not url.fragment:
                continue
            fragment = unquote(url.fragment)
            line = re.fullmatch(r'L(\d+)(?:-L(\d+))?', fragment)
            if line:
                start, end = int(line[1]), int(line[2] or line[1])
                if not 1 <= start <= end <= len(content.splitlines()):
                    errors.append(f'{rel}: out-of-range {target}')
            elif virtual_path.endswith('.md') or (virtual_path == '.' and rel.endswith('.md')):
                headings = re.findall(r'^#{1,6}\s+(.+)$', content, re.M)
                slugs = {re.sub(r'[^\w\- ]', '', h.strip().lower()).replace(' ', '-') for h in headings}
                slugs.update(re.findall(r'<a\s+(?:id|name)=["\x27]([^"\x27]+)', content))
                if fragment not in slugs:
                    errors.append(f'{rel}: unresolved heading {target}')

        for block in re.findall(r'^```json\n(.*?)^```', text, re.M | re.S):
            try:
                json.loads(block)
            except ValueError as error:
                errors.append(f'{rel}: invalid JSON example: {error}')

    for path, prefix, count in [('ROADMAP.md', 'D', 12), ('ROADMAP.md', 'C', 17),
                                ('docs/ensemble/IMPLEMENTATION.md', 'R', 30)]:
        ids = re.findall(r'^\| ' + prefix + r'(\d+)(?=：| \|)', (root / path).read_text(), re.M)
        if sorted(map(int, ids)) != list(range(1, count + 1)):
            errors.append(f'{path}: expected {prefix}1..{count} exactly once, got {ids}')
    print(f'Checked {len(files)} documents, {links} file/heading/line references, '
          f'{source_checked} pinned-source references; JSON and D/C/R coverage.')
    print(f'Skipped {remote_skipped} external references (no network check; optional --upstream for pinned DSH sources).')
    for error in errors:
        print(error)
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
