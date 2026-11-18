#!/usr/bin/env python3
"""Check maintained ensemble docs without private files or network access.

Optionally validate pinned DSH source links against local checkouts:
  python3 scripts/check-docs.py --upstream <full-sha>=/path/to/checkout
"""

import argparse
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


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

    files = [root / 'README.md', root / 'ROADMAP.md', root / 'adapters/omp/README.md']
    files += sorted((root / 'skills/ensemble').glob('*.md'))
    files += sorted((root / 'docs/ensemble').rglob('*.md'))
    files += sorted((root / 'agents').glob('ensemble-*.md'))
    errors = []
    links = source_checked = remote_skipped = 0
    for file in files:
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
                if url.netloc != 'github.com' or not match or match[1] not in upstreams:
                    remote_skipped += 1
                    continue
                resolved = (upstreams[match[1]] / unquote(match[2])).resolve()
                if not resolved.is_relative_to(upstreams[match[1]]):
                    errors.append(f'{file.relative_to(root)}: source path escapes checkout: {target}')
                    continue
                source_checked += 1
            elif url.scheme:
                continue
            else:
                if url.path.startswith('/'):
                    errors.append(f'{file.relative_to(root)}: nonportable absolute link: {target}')
                    continue
                resolved = (file.parent / unquote(url.path)).resolve() if url.path else file
                if not resolved.is_relative_to(root) or '.scratch' in resolved.relative_to(root).parts:
                    errors.append(f'{file.relative_to(root)}: link depends on private files: {target}')
                    continue
            links += 1
            if not resolved.exists():
                errors.append(f'{file.relative_to(root)}: missing {target}')
                continue
            if resolved.is_dir() or not url.fragment:
                continue
            content = resolved.read_text(encoding='utf-8')
            fragment = unquote(url.fragment)
            line = re.fullmatch(r'L(\d+)(?:-L(\d+))?', fragment)
            if line:
                start, end = int(line[1]), int(line[2] or line[1])
                if not 1 <= start <= end <= len(content.splitlines()):
                    errors.append(f'{file.relative_to(root)}: out-of-range {target}')
            elif resolved.suffix == '.md':
                headings = re.findall(r'^#{1,6}\s+(.+)$', content, re.M)
                slugs = {re.sub(r'[^\w\- ]', '', h.strip().lower()).replace(' ', '-') for h in headings}
                slugs.update(re.findall(r'<a\s+(?:id|name)=[\"\x27]([^\"\x27]+)', content))
                if fragment not in slugs:
                    errors.append(f'{file.relative_to(root)}: unresolved heading {target}')
        for block in re.findall(r'^```json\n(.*?)^```', text, re.M | re.S):
            try:
                json.loads(block)
            except ValueError as error:
                errors.append(f'{file.relative_to(root)}: invalid JSON example: {error}')

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
