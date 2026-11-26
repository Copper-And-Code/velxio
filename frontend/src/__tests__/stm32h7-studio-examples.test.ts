/**
 * The Copper and Code Studio examples (data/examples-studio-stm32h7.ts, written by
 * scripts/sync-studio-examples.py) have the shape the STM32H743 Core loader
 * needs: main.py first (the editor opens it, the board runs it) importing the
 * app_main.py Studio generated, every other file a module written to /flash.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { studioStm32h7Examples } from '../data/examples-studio-stm32h7';
import { exampleProjects } from '../data/examples';

describe('Studio examples for stm32h7-core-v13', () => {
  it('there are some, all in the gallery', () => {
    expect(studioStm32h7Examples.length).toBeGreaterThan(0);
    const ids = new Set(exampleProjects.map((e) => e.id));
    for (const ex of studioStm32h7Examples) expect(ids.has(ex.id), ex.id).toBe(true);
  });

  it.each(studioStm32h7Examples.map((e) => [e.id, e] as const))('%s runs app_main.py from main.py', (_id, ex) => {
    expect(ex.boardType).toBe('stm32h7-core-v13');
    expect(ex.languageMode).toBe('micropython');
    const files = ex.files ?? [];
    expect(files[0]?.name).toBe('main.py');
    expect(files[0]?.content).toMatch(/^import app_main$/m);
    const names = files.map((f) => f.name);
    expect(names).toContain('app_main.py');
    expect(names).toContain('ui.py');
    expect(new Set(names).size).toBe(names.length);
    // Studio checks the panel size at start; the board's is 1024x600.
    expect(files.find((f) => f.name === 'app_main.py')!.content).toContain('(1024, 600)');
  });

  it.each(studioStm32h7Examples.map((e) => [e.id] as const))('%s has a gallery thumbnail', (id) => {
    expect(existsSync(resolve(__dirname, '../../public/examples-thumbs', `${id}.webp`))).toBe(true);
  });
});
