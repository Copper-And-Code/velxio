#!/usr/bin/env python3
"""
Copper and Code Studio examples -> Velxio gallery examples for the STM32H743 Core.

For every project in <studio>/examples/*/project.json, runs Studio's own
generator for the board (`generate --target board --board-profile
stm32h7_core_v1_3_1024x600`, the code a real STM32H7_CORE V1.3 runs) and writes
the result to frontend/src/data/examples-studio-stm32h7.ts:

  - main.py      `import app_main`: the board's entry point as a module, so its
                 __file__ (which app_main.py uses to find its folder) is set
  - app_main.py, ui.py, app_events.py, board_adapter.py and the project's own
                 modules, as Studio generated them

Velxio writes every file but main.py onto the board's /flash (a littlefs in RAM
in the VELXIO firmware), then runs main.py. A project whose screen is not
1024x600 is skipped with Studio's reason (most are made for the 480x480
ESP32-4848S040).

The code Studio generates is MIT (Studio's LICENSING.md); the file says so.

Usage, from the repository root:
    python3 scripts/sync-studio-examples.py --studio /path/to/copper-and-code-studio
    [--python /path/to/studio/.venv/bin/python] [--only snake,simon]
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

PROFILE = 'stm32h7_core_v1_3_1024x600'
BOARD_KIND = 'stm32h7-core-v13'
OUT = Path(__file__).resolve().parent.parent / 'frontend' / 'src' / 'data' / 'examples-studio-stm32h7.ts'
# Generated next to the app but not part of what the board runs.
SKIP_FILES = {'manifest.json', 'sourcemap.json', 'board_profile.json'}
GAMES = {'breakout', 'simon', 'snake', 'tictactoe', 'block-drop', 'fifteen', 'frog',
         'sandwich-tower', 'star-guard', 'crossword', 'orbit'}
MAIN_PY = (
    '# Entry point for Velxio: the app Copper and Code Studio generated for the\n'
    '# STM32H7_CORE V1.3 (1024x600) is app_main.py, run as a module.\n'
    'import app_main\n'
)


def readme_summary(folder: Path) -> str:
    """First paragraph of the example's README, without its title."""
    for name in ('README.md', 'README.it.md'):
        readme = folder / name
        if not readme.is_file():
            continue
        paragraphs = [p.strip() for p in readme.read_text(encoding='utf-8').split('\n\n')]
        for p in paragraphs:
            if p and not p.startswith('#') and not p.startswith('!['):
                p = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', p)  # [text](link) -> text
                p = re.sub(r'(\*\*|__|`)', '', p)  # bold and code marks: the card shows plain text
                return re.sub(r'\s+', ' ', p)
    return ''


def generate(studio: Path, python: str, project: Path, out: Path) -> str | None:
    """Studio's board code for PROFILE in `out`; None, or Studio's reason it can't."""
    cmd = [python, '-c', 'import sys; from copper_and_code_studio.cli import main; sys.exit(main(sys.argv[1:]))',
           'generate', str(project), '--target', 'board', '--board-profile', PROFILE,
           '--output', str(out), '--force']
    r = subprocess.run(cmd, cwd=studio, capture_output=True, text=True, timeout=300)
    if (out / 'manifest.json').is_file():
        return None
    lines = (r.stderr or r.stdout).strip().splitlines()
    return lines[-1] if lines else 'exit %d' % r.returncode


def example_entry(folder: Path, build: Path) -> dict:
    project = json.loads((folder / 'project.json').read_text(encoding='utf-8'))
    manifest = json.loads((build / 'manifest.json').read_text(encoding='utf-8'))
    names = sorted(n for n in manifest['files'] if n not in SKIP_FILES)
    if manifest.get('entryPoint') != 'app_main.py' or 'app_main.py' not in names:
        raise ValueError('%s: no app_main.py entry point' % folder.name)
    # The entry point first: the editor opens the first file.
    files = [{'name': 'main.py', 'content': MAIN_PY}]
    for name in ['app_main.py'] + [n for n in names if n != 'app_main.py']:
        files.append({'name': name, 'content': (build / name).read_text(encoding='utf-8')})
    title = project.get('projectName') or folder.name
    summary = readme_summary(folder)
    return {
        'id': 'studio-%s' % folder.name,
        'title': 'Studio: %s' % title,
        'description': summary or ('%s, made in Copper and Code Studio (LVGL, MicroPython) '
                                   'for the STM32H743 Core 1024x600 panel.' % title),
        'category': 'games' if folder.name in GAMES else 'displays',
        'difficulty': 'intermediate',
        'boardType': BOARD_KIND,
        'boardFilter': BOARD_KIND,
        'languageMode': 'micropython',
        'tags': ['studio', 'copper-and-code-studio', 'lvgl', 'micropython', 'stm32h7'],
        'code': '',
        'files': files,
        'components': [],
        'wires': [],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--studio', type=Path, required=True, help='copper-and-code-studio checkout')
    ap.add_argument('--python', help='Python with Studio installed (default: <studio>/.venv/bin/python)')
    ap.add_argument('--only', help='comma-separated example folders')
    args = ap.parse_args()
    studio = args.studio.resolve()
    python = args.python or str(studio / '.venv' / 'bin' / 'python')
    only = set(args.only.split(',')) if args.only else None
    commit = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=studio,
                            capture_output=True, text=True).stdout.strip() or 'unknown'

    entries, skipped = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for project in sorted((studio / 'examples').glob('*/project.json')):
            folder = project.parent
            if only and folder.name not in only:
                continue
            build = Path(tmp) / folder.name
            reason = generate(studio, python, project, build)
            if reason:
                skipped.append((folder.name, reason))
                continue
            entries.append(example_entry(folder, build))

    body = json.dumps(entries, indent=2, ensure_ascii=False)
    OUT.write_text(
        '/**\n'
        ' * Copper and Code Studio examples for the STM32H743 Core (stm32h7-core-v13).\n'
        ' *\n'
        ' * GENERATED by scripts/sync-studio-examples.py from copper-and-code-studio\n'
        ' * %s (each examples/<name>/project.json, Studio generate --target board --board-profile\n'
        ' * %s). Do not edit: change the project in Studio and run the script again.\n'
        ' *\n'
        ' * The app code is generated by Copper and Code Studio and is under the MIT\n'
        ' * license (Studio LICENSING.md, LICENSE-MIT.txt), not this repository\'s.\n'
        ' */\n'
        "import type { ExampleProject } from './examples';\n\n"
        'export const studioStm32h7Examples: ExampleProject[] = %s;\n' % (commit, PROFILE, body),
        encoding='utf-8')
    print('wrote %s: %d examples' % (OUT, len(entries)))
    for e in entries:
        print('  %-28s %d files, %d KB' % (e['id'], len(e['files']),
                                            sum(len(f['content']) for f in e['files']) // 1024))
    for name, reason in skipped:
        print('  skipped %-20s %s' % (name, reason))
    return 0


if __name__ == '__main__':
    sys.exit(main())
