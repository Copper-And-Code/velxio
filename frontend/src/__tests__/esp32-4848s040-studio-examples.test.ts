/**
 * The Copper and Code Studio examples for the ESP32-4848S040
 * (data/examples-studio-esp32-4848s040.ts, scripts/sync-studio-examples.py
 * --profile esp32_4848s040_480): main.py first, importing the app_main.py Studio
 * generated for the 480x480 panel; every other file a module the MicroPython
 * session writes to the board filesystem.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { studioEsp32_4848s040Examples } from '../data/examples-studio-esp32-4848s040';
import { exampleProjects } from '../data/examples';

describe('Studio examples for esp32-4848s040', () => {
  it('there are some, all in the gallery, with ids apart from the STM32H7 ones', () => {
    expect(studioEsp32_4848s040Examples.length).toBeGreaterThan(0);
    const ids = new Set(exampleProjects.map((e) => e.id));
    for (const ex of studioEsp32_4848s040Examples) {
      expect(ids.has(ex.id), ex.id).toBe(true);
      expect(ex.id.startsWith('studio-esp32-4848s040-'), ex.id).toBe(true);
    }
    expect(new Set(exampleProjects.map((e) => e.id)).size).toBe(exampleProjects.length);
  });

  it.each(studioEsp32_4848s040Examples.map((e) => [e.id, e] as const))('%s runs app_main.py from main.py', (_id, ex) => {
    expect(ex.boardType).toBe('esp32-4848s040');
    expect(ex.languageMode).toBe('micropython');
    const files = ex.files ?? [];
    expect(files[0]?.name).toBe('main.py');
    expect(files[0]?.content).toMatch(/^import app_main$/m);
    const names = files.map((f) => f.name);
    expect(names).toContain('app_main.py');
    expect(names).toContain('ui.py');
    expect(new Set(names).size).toBe(names.length);
    // Studio checks the panel size at start; the board's is 480x480.
    expect(files.find((f) => f.name === 'app_main.py')!.content).toContain('(480, 480)');
  });

  it.each(studioEsp32_4848s040Examples.map((e) => [e.id] as const))('%s has a gallery thumbnail', (id) => {
    expect(existsSync(resolve(__dirname, '../../public/examples-thumbs', `${id}.webp`))).toBe(true);
  });
});
