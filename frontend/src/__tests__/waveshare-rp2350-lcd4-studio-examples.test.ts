/**
 * The Copper and Code Studio examples for the Waveshare RP2350-Touch-LCD-4
 * (data/examples-studio-waveshare-rp2350-lcd4.ts, scripts/sync-studio-examples.py
 * --profile waveshare_rp2350_touch_lcd_4_240): main.py first, importing the app_main.py Studio
 * generated for its panel (480x480 logical, the board with PSRAM); every other file a module the MicroPython
 * session writes to the board filesystem.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { studioWaveshareRp2350Lcd4Examples } from '../data/examples-studio-waveshare-rp2350-lcd4';
import { exampleProjects, WAVESHARE_RP2350_NETWORK_APPS } from '../data/examples';

describe('Studio examples for waveshare-rp2350-lcd4', () => {
  it('there are some, in the gallery but the network apps, with ids apart from the STM32H7 ones', () => {
    expect(studioWaveshareRp2350Lcd4Examples.length).toBeGreaterThan(0);
    const ids = new Set(exampleProjects.map((e) => e.id));
    for (const ex of studioWaveshareRp2350Lcd4Examples) {
      expect(ids.has(ex.id), ex.id).toBe(!WAVESHARE_RP2350_NETWORK_APPS.has(ex.id));
      expect(ex.id.startsWith('studio-waveshare-rp2350-lcd4-'), ex.id).toBe(true);
    }
    expect(new Set(exampleProjects.map((e) => e.id)).size).toBe(exampleProjects.length);
  });

  it.each(studioWaveshareRp2350Lcd4Examples.map((e) => [e.id, e] as const))('%s runs app_main.py from main.py', (_id, ex) => {
    expect(ex.boardType).toBe('waveshare-rp2350-lcd4');
    expect(ex.languageMode).toBe('micropython');
    const files = ex.files ?? [];
    expect(files[0]?.name).toBe('main.py');
    expect(files[0]?.content).toMatch(/^import app_main$/m);
    const names = files.map((f) => f.name);
    expect(names).toContain('app_main.py');
    expect(names).toContain('ui.py');
    expect(new Set(names).size).toBe(names.length);
    // Studio checks the panel size at start: 480x480, the board with its PSRAM.
    expect(files.find((f) => f.name === 'app_main.py')!.content).toContain('(480, 480)');
  });

  it.each(
    studioWaveshareRp2350Lcd4Examples
      .filter((e) => !WAVESHARE_RP2350_NETWORK_APPS.has(e.id))
      .map((e) => [e.id] as const),
  )('%s has a gallery thumbnail', (id) => {
    expect(existsSync(resolve(__dirname, '../../public/examples-thumbs', `${id}.webp`))).toBe(true);
  });
});
