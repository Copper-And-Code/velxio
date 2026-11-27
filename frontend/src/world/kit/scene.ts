/**
 * The scene JSON: what the page wrote becomes a scene the kit can rely on
 * (`normalizeScene`), each of its objects a runtime object (`makeObj`), and an
 * edit goes back as JSON that differs from the page's only by the edit
 * (`sceneJson`).
 */
import { clamp, num } from './math';
import { PRESETS } from './presets';
import type { Arm, Obj, RobotBind, SceneJson, SceneObjectJson } from './types';

/** What the page wrote, so a save keeps its JSON as it was apart from the edit:
 *  a default the kit filled in is not written back. */
export interface Written {
  floorColor: boolean;
  rot: Record<string, boolean>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The scene with its defaults filled in and every object given an id, a place
 * and a heading. It is a copy: the keys the kit does not know stay in it, so
 * they stay in the JSON a save writes.
 */
export function normalizeScene(input: unknown): { scene: SceneJson; written: Written } {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const f = (s.floor || {}) as Record<string, unknown>;
  const written: Written = { floorColor: typeof f.color === 'string', rot: {} };

  const out = clone(s) as SceneJson;
  out.version = 1;
  out.view = s.view === '2d' ? '2d' : '3d';
  if (typeof s.follow === 'string') out.follow = s.follow;
  else delete out.follow;
  out.floor = (f && typeof f === 'object' && !Array.isArray(f) ? clone(f) : {}) as SceneJson['floor'];
  out.floor.w = Math.max(0.2, num(f.w, 2.4));
  out.floor.h = Math.max(0.2, num(f.h, 1.6));
  out.floor.grid = f.grid !== false;
  out.floor.color = typeof f.color === 'string' ? f.color : '#f2efe8';
  out.objects = [];

  const seen: Record<string, boolean> = {};
  (Array.isArray(s.objects) ? (s.objects as unknown[]) : []).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const o = raw as Record<string, unknown>;
    let id = String(o.id || String(o.type || 'object') + (i + 1));
    while (seen[id]) id += '_';
    seen[id] = true;
    const c = clone(o) as SceneObjectJson;
    c.id = id;
    written.rot[id] = o.rot !== undefined;
    c.x = num(o.x, 0);
    c.y = num(o.y, 0);
    c.rot = num(o.rot, 0);
    out.objects.push(c);
  });
  return { scene: out, written };
}

const TRACK_SHAPES = ['loop', 'oval', 'figure8', 'line'] as const;
const RAMP_PROFILES = ['wedge', 'bridge', 'hill'] as const;

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return (list as readonly unknown[]).indexOf(v) >= 0 ? (v as T) : fallback;
}

/** The runtime object of a scene object; null (with a warning) for a type the
 *  kit does not know. */
export function makeObj(o: SceneObjectJson, warn: (text: string) => void): Obj | null {
  const t = o.type;
  const base = {
    id: o.id,
    src: o,
    x: o.x,
    y: o.y,
    rot: o.rot,
    color: o.color as string | undefined,
    label: o.label as string | undefined,
  };
  if (t === 'robot') {
    const known = Object.prototype.hasOwnProperty.call(PRESETS, String(o.preset));
    const key = known ? String(o.preset) : 'diff2';
    if (!known) warn('robot "' + o.id + '": unknown preset "' + o.preset + '", using diff2');
    const bind = (o.bind || {}) as RobotBind;
    return {
      ...base,
      type: 'robot',
      preset: key,
      p: PRESETS[key],
      bind,
      z: 0,
      pitch: 0,
      roll: 0,
      vl: 0,
      vr: 0,
      v: 0,
      w: 0,
      accel: 0,
      line: [],
      sonarCm: null,
      bumped: false,
      lastSonarT: -1,
      lastImuT: -1,
      sonarAngle: 0,
      // line sensors this far apart across the front: inside a 2.2 cm tape by
      // default, so a robot centred on it sees black with both
      lineSpacing: clamp(num(o.lineSpacing, 0.016), 0.004, 0.08),
      displayId: bind.display ? String(bind.display) : null,
      displayTilt: clamp(num(o.displayTilt, 50), 0, 90),
    };
  }
  if (t === 'track') {
    return {
      ...base,
      type: 'track',
      shape: oneOf(TRACK_SHAPES, o.shape, 'loop'),
      w: Math.max(0.05, num(o.w, 1.6)),
      h: Math.max(0.05, num(o.h, 0.9)),
      tape: clamp(num(o.tape, 0.022), 0.003, 0.2),
    };
  }
  if (t === 'box' || t === 'wall') {
    const wall = t === 'wall';
    return {
      ...base,
      type: t,
      w: Math.max(0.005, num(o.w, wall ? 1.0 : 0.15)),
      d: Math.max(0.005, num(o.d, wall ? 0.02 : 0.15)),
      h: Math.max(0.002, num(o.h, wall ? 0.1 : 0.15)),
    };
  }
  if (t === 'cylinder') {
    return { ...base, type: 'cylinder', r: Math.max(0.005, num(o.r, 0.05)), h: Math.max(0.002, num(o.h, 0.12)) };
  }
  if (t === 'ramp') {
    return {
      ...base,
      type: 'ramp',
      profile: oneOf(RAMP_PROFILES, o.profile, 'wedge'),
      w: Math.max(0.05, num(o.w, 0.4)),
      d: Math.max(0.05, num(o.d, 0.3)),
      h: Math.max(0.002, num(o.h, 0.03)),
    };
  }
  if (t === 'arm') {
    return {
      ...base,
      type: 'arm',
      bind: (o.bind || {}) as Arm['bind'],
      angles: { base: 90, shoulder: 90, elbow: 90, gripper: 90 },
    };
  }
  warn('object "' + o.id + '": unknown type "' + t + '"');
  return null;
}

/**
 * The JSON a save writes: the scene, without the defaults the page had not
 * written (the floor's colour, a heading of 0). A heading that is no longer 0
 * counts as written from then on.
 */
export function sceneJson(scene: SceneJson, written: Written): string {
  const out = clone(scene) as SceneJson;
  if (!written.floorColor) delete (out.floor as Record<string, unknown>).color;
  if (out.follow === undefined) delete out.follow;
  out.objects.forEach((o) => {
    if (o.rot === 0 && !written.rot[o.id]) delete (o as Record<string, unknown>).rot;
    else if (o.rot !== 0) written.rot[o.id] = true;
  });
  return JSON.stringify(out, null, 2);
}
