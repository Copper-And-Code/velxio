/**
 * What a World sees of the circuit: the boards and parts `velxio.ready()`
 * returns, and each part's outputs in a frame.
 *
 * Pure functions over the store's boards/components and the canvas elements,
 * so they can be tested without a running simulation.
 */
import {
  getSensorControlForComponent,
  sliderInput,
  type SensorControlDef,
} from '../simulation/sensorControlConfig';

export interface WorldInput {
  key: string;
  kind: 'number' | 'bool' | 'choice';
  min: number;
  max: number;
  unit: string;
  options?: { value: number; label: string }[];
}

export interface WorldDisplay {
  w: number;
  h: number;
  /** velxio.touch(id, x, y, pressed) reaches the screen's touch controller. */
  touch?: boolean;
}

export interface WorldBoard {
  id: string;
  kind: string;
  name?: string;
  display?: WorldDisplay;
}

export interface WorldPart {
  id: string;
  type: string;
  board: string | null;
  outputs: string[];
  inputs: WorldInput[];
  display?: WorldDisplay;
  press?: true;
}

export interface WorldInfo {
  boards: WorldBoard[];
  parts: WorldPart[];
  theme: 'dark' | 'light';
}

interface BoardLike {
  id: string;
  boardKind: string;
  name?: string;
}

interface ComponentLike {
  id: string;
  metadataId: string;
  properties?: Record<string, unknown>;
}

interface WireLike {
  start: { componentId: string };
  end: { componentId: string };
}

/** Boards with a screen of their own: its size in panel pixels. */
export const BOARD_DISPLAYS: Record<string, WorldDisplay> = {
  'stm32h7-core-v13': { w: 1024, h: 600, touch: true },
  'esp32-4848s040': { w: 480, h: 480, touch: true },
  'waveshare-rp2350-lcd4': { w: 480, h: 480, touch: true },
};

/** Parts whose screen the World can show. */
export const PART_DISPLAYS: Record<string, WorldDisplay> = {
  ili9341: { w: 240, h: 320 },
  'ili9341-cap-touch': { w: 240, h: 320 },
  ssd1306: { w: 128, h: 64 },
  'ssd1306-i2c-4pin': { w: 128, h: 64 },
};

/** Outputs a frame carries for each part type. */
export const PART_OUTPUTS: Record<string, string[]> = {
  led: ['on', 'brightness'],
  'rgb-led': ['on', 'r', 'g', 'b'],
  servo: ['angle'],
  'stepper-motor': ['angle'],
  'biaxial-stepper': ['angle'],
  buzzer: ['on'],
  'dc-motor': ['drive', 'rpm'],
};

export const PRESS_PARTS = new Set(['pushbutton', 'pushbutton-6mm']);

/** The inputs a World may write: the sliders of the part's sensor panel. */
export function sensorInputs(def: SensorControlDef | undefined): WorldInput[] {
  if (!def) return [];
  const out: WorldInput[] = [];
  for (const c of def.controls) {
    if (c.type !== 'slider') continue;
    const how = sliderInput(c);
    out.push({
      key: c.key,
      kind: how.kind === 'range' ? 'number' : how.kind === 'toggle' ? 'bool' : 'choice',
      min: c.min,
      max: c.max,
      unit: c.unit,
      ...(how.kind === 'choice' ? { options: how.options } : {}),
    });
  }
  return out;
}

/** The board a part is wired to: the first board at the far end of a wire. */
function partBoard(id: string, boardIds: Set<string>, wires: WireLike[]): string | null {
  for (const w of wires) {
    if (w.start.componentId === id && boardIds.has(w.end.componentId)) return w.end.componentId;
    if (w.end.componentId === id && boardIds.has(w.start.componentId)) return w.start.componentId;
  }
  return null;
}

export function describeWorld(
  boards: BoardLike[],
  components: ComponentLike[],
  wires: WireLike[],
  theme: 'dark' | 'light',
): WorldInfo {
  const boardIds = new Set(boards.map((b) => b.id));
  const onlyBoard = boards.length === 1 ? boards[0].id : null;
  return {
    boards: boards.map((b) => ({
      id: b.id,
      kind: b.boardKind,
      ...(b.name ? { name: b.name } : {}),
      ...(BOARD_DISPLAYS[b.boardKind] ? { display: { ...BOARD_DISPLAYS[b.boardKind] } } : {}),
    })),
    parts: components
      .filter((c) => !c.metadataId.startsWith('wire') && c.metadataId !== 'breadboard')
      .map((c) => {
        const part: WorldPart = {
          id: c.id,
          type: c.metadataId,
          board: partBoard(c.id, boardIds, wires) ?? onlyBoard,
          outputs: PART_OUTPUTS[c.metadataId] ?? [],
          inputs: sensorInputs(getSensorControlForComponent(c)),
        };
        if (PART_DISPLAYS[c.metadataId]) part.display = { ...PART_DISPLAYS[c.metadataId] };
        if (PRESS_PARTS.has(c.metadataId)) part.press = true;
        return part;
      }),
    theme,
  };
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** A part's outputs, read from its canvas element (what the simulation drew). */
export function readPartOutputs(type: string, el: unknown): Record<string, number | boolean> | null {
  if (!el) return null;
  const e = el as Record<string, unknown>;
  switch (type) {
    case 'led': {
      const on = e.value === true || e.value === 'true';
      return { on, brightness: on ? Math.max(0, Math.min(1, num(e.brightness, 1))) : 0 };
    }
    case 'rgb-led': {
      const r = Math.max(0, Math.min(1, num(e.ledRed)));
      const g = Math.max(0, Math.min(1, num(e.ledGreen)));
      const b = Math.max(0, Math.min(1, num(e.ledBlue)));
      return { on: r > 0 || g > 0 || b > 0, r, g, b };
    }
    case 'servo':
    case 'stepper-motor':
    case 'biaxial-stepper':
      return { angle: num(e.angle) };
    case 'buzzer':
      return { on: e.hasSignal === true };
    case 'dc-motor':
      // `speed` is the element's live speed; its `rpm` is the no-load property.
      return { drive: Math.max(-1, Math.min(1, num(e.drive))), rpm: num(e.speed) };
    default:
      return null;
  }
}

/** Clamp the values a World writes to the inputs the part declares. */
export function clampInputs(
  inputs: WorldInput[],
  values: Record<string, unknown>,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const inp of inputs) {
    if (!(inp.key in values)) continue;
    const raw = values[inp.key];
    if (inp.kind === 'bool') {
      out[inp.key] = raw === true || raw === 1 ? 1 : 0;
      continue;
    }
    const n = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (!Number.isFinite(n)) continue;
    out[inp.key] = Math.max(inp.min, Math.min(inp.max, n));
  }
  return out;
}
