/**
 * fork/openBuild: the open build (no pro overlay) lists only examples whose
 * boards can start here; the STM32 QEMU and Raspberry Pi Linux boards cannot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { boardRunsHere, exampleRunsHere, installOpenBuildFilters } from '../fork/openBuild';
import { galleryExamples, installGalleryExampleFilter } from '../lib/galleryExampleFilter';
import { exampleProjects, type ExampleProject } from '../data/examples';

const ex = (id: string, boardType?: string, boards?: string[]): ExampleProject =>
  ({
    id,
    title: id,
    description: '',
    category: 'basics',
    difficulty: 'beginner',
    boardType,
    boards: boards?.map((boardKind, i) => ({ boardKind, x: i * 100, y: 0, code: '' })),
    code: '',
    components: [],
    wires: [],
  }) as unknown as ExampleProject;

describe('fork open build', () => {
  afterEach(() => installGalleryExampleFilter(null));

  it('runs the open boards, not the paid-overlay ones', () => {
    for (const k of ['arduino-uno', 'esp32', 'raspberry-pi-pico', 'stm32h7-core-v13']) expect(boardRunsHere(k), k).toBe(true);
    for (const k of ['stm32-bluepill', 'stm32-blackpill', 'raspberry-pi-3', 'raspberry-pi-5', 'no-such-board'])
      expect(boardRunsHere(k), k).toBe(false);
  });

  it('keeps board-less circuits and drops an example with any paid board', () => {
    expect(exampleRunsHere(ex('circuit'))).toBe(true);
    expect(exampleRunsHere(ex('uno', 'arduino-uno'))).toBe(true);
    expect(exampleRunsHere(ex('pill', 'stm32-bluepill'))).toBe(false);
    expect(exampleRunsHere(ex('mixed', undefined, ['esp32', 'stm32-blackpill']))).toBe(false);
  });

  it('the installed gallery filter hides every paid-board example and nothing else', () => {
    installOpenBuildFilters();
    const shown = galleryExamples(exampleProjects);
    const hidden = exampleProjects.filter((e) => !shown.includes(e));
    expect(hidden.length).toBeGreaterThan(0);
    for (const e of hidden) expect(exampleRunsHere(e), e.id).toBe(false);
    expect(shown.some((e) => e.boardType === 'stm32h7-core-v13')).toBe(true);
    expect(shown.some((e) => e.boardType === 'stm32-bluepill')).toBe(false);
  });
});
