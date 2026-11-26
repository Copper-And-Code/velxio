import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampInputs,
  describeWorld,
  readPartOutputs,
  sensorInputs,
} from '../world/worldCatalog';
import { buildWorldSrcdoc, WORLD_CSP } from '../world/worldRuntime';
import { b64ToBuffer, fileToB64, guessMime, useWorldStore } from '../world/useWorldStore';
import { getSensorControl } from '../simulation/sensorControlConfig';
import { buildVlxPayload } from '../utils/vlxFile';

describe('World catalog', () => {
  const boards = [
    { id: 'waveshare-rp2350-lcd4', boardKind: 'waveshare-rp2350-lcd4' },
    { id: 'arduino-uno', boardKind: 'arduino-uno', name: 'Uno' },
  ];
  const components = [
    { id: 'led1', metadataId: 'led', properties: {} },
    { id: 'srv', metadataId: 'servo', properties: {} },
    { id: 'btn', metadataId: 'pushbutton', properties: {} },
    { id: 'sonar', metadataId: 'hc-sr04', properties: {} },
    { id: 'tft', metadataId: 'ili9341', properties: {} },
  ];
  const wires = [
    { start: { componentId: 'led1' }, end: { componentId: 'arduino-uno' } },
    { start: { componentId: 'waveshare-rp2350-lcd4' }, end: { componentId: 'srv' } },
  ];

  it('describes boards, screens, outputs, inputs and buttons', () => {
    const info = describeWorld(boards, components, wires, 'dark');
    expect(info.theme).toBe('dark');
    expect(info.boards[0]).toEqual({
      id: 'waveshare-rp2350-lcd4',
      kind: 'waveshare-rp2350-lcd4',
      display: { w: 480, h: 480, touch: true },
    });
    expect(info.boards[1]).toEqual({ id: 'arduino-uno', kind: 'arduino-uno', name: 'Uno' });
    const byId = Object.fromEntries(info.parts.map((p) => [p.id, p]));
    expect(byId.led1).toMatchObject({ type: 'led', board: 'arduino-uno', outputs: ['on', 'brightness'] });
    expect(byId.srv).toMatchObject({ board: 'waveshare-rp2350-lcd4', outputs: ['angle'] });
    expect(byId.btn.press).toBe(true);
    expect(byId.tft.display).toEqual({ w: 240, h: 320 });
    // Unwired, with two boards: no board.
    expect(byId.sonar.board).toBeNull();
    expect(byId.sonar.inputs.find((i) => i.key === 'distance')).toMatchObject({ kind: 'number' });
  });

  it('gives an unwired part the only board', () => {
    const info = describeWorld([boards[1]], [components[0]], [], 'light');
    expect(info.parts[0].board).toBe('arduino-uno');
  });

  it('reads outputs from the canvas elements', () => {
    expect(readPartOutputs('led', { value: true, brightness: 0.4 })).toEqual({ on: true, brightness: 0.4 });
    expect(readPartOutputs('led', { value: false, brightness: 1 })).toEqual({ on: false, brightness: 0 });
    expect(readPartOutputs('servo', { angle: 90 })).toEqual({ angle: 90 });
    expect(readPartOutputs('rgb-led', { ledRed: 1, ledGreen: 0, ledBlue: 0.5 })).toEqual({
      on: true,
      r: 1,
      g: 0,
      b: 0.5,
    });
    expect(readPartOutputs('pushbutton', {})).toBeNull();
    expect(readPartOutputs('led', null)).toBeNull();
  });

  it('clamps what a World writes to the declared inputs', () => {
    const inputs = sensorInputs(getSensorControl('hc-sr04'));
    const d = inputs.find((i) => i.key === 'distance')!;
    expect(clampInputs(inputs, { distance: 1e9, bogus: 3 })).toEqual({ distance: d.max });
    expect(clampInputs(inputs, { distance: 'x' })).toEqual({});
    expect(
      clampInputs([{ key: 'on', kind: 'bool', min: 0, max: 1, unit: '' }], { on: true }),
    ).toEqual({ on: 1 });
  });
});

describe('World srcdoc', () => {
  it('puts the CSP and the runtime before the page scripts', () => {
    const doc = buildWorldSrcdoc('<!doctype html><html><head><script>page()</script></head><body></body></html>');
    const csp = doc.indexOf('Content-Security-Policy');
    const runtime = doc.indexOf("var CHANNEL = 'world/1'");
    expect(csp).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(csp);
    expect(doc.indexOf('page()')).toBeGreaterThan(runtime);
  });

  it('wraps a page without head or html', () => {
    expect(buildWorldSrcdoc('<canvas></canvas>')).toMatch(/^<!doctype html><head><meta/);
    expect(buildWorldSrcdoc('<!doctype html><body>x</body>')).toMatch(/^<!doctype html><head><meta/);
  });

  it('allows only the CDNs, inline code and blob: files', () => {
    expect(WORLD_CSP).toContain("default-src 'none'");
    expect(WORLD_CSP).toContain('https://cdn.jsdelivr.net');
    expect(WORLD_CSP).toMatch(/connect-src data: blob:/);
    expect(WORLD_CSP).not.toContain('*');
  });
});

describe('World store', () => {
  beforeEach(() => useWorldStore.getState().load(null));

  it('snapshots nothing while empty, and round-trips html and files', async () => {
    expect(useWorldStore.getState().snapshot()).toBeUndefined();
    const b64 = await fileToB64(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 255])]));
    useWorldStore.getState().setHtml('<p>hi</p>');
    useWorldStore.getState().putAsset({ name: 'a.glb', mime: guessMime('a.glb'), b64 });
    useWorldStore.getState().putAsset({ name: 'a.glb', mime: 'model/gltf-binary', b64 });
    const snap = useWorldStore.getState().snapshot()!;
    expect(snap.assets).toHaveLength(1);
    expect(snap.assets![0].mime).toBe('model/gltf-binary');
    expect(Array.from(new Uint8Array(b64ToBuffer(snap.assets![0].b64)))).toEqual([0x67, 0x6c, 0x54, 0x46, 0, 255]);
    expect(buildVlxPayload().world).toEqual(snap);

    useWorldStore.getState().load(null);
    expect(buildVlxPayload().world).toBeUndefined();
    useWorldStore.getState().load(snap);
    expect(useWorldStore.getState().html).toBe('<p>hi</p>');
  });
});
