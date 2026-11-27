/**
 * What is where on the mat: the solids a robot stops against, the ground it
 * stands on, what a sonar beam meets, what the pointer picks.
 */
import { DEG, cosd, segDist, sind } from './math';
import { circleObb, obbOverlap, rampHeight, rampSlope, toLocal, toWorld, trackPath } from './geometry';
import type { Obj, Robot, World } from './types';

/** A shape robots stop against: a box (half extents) or a circle, with its height. */
type Solid =
  | { o: Obj; kind: 'box'; hx: number; hy: number; h: number; ramp?: boolean }
  | { o: Obj; kind: 'circle'; r: number; h: number; ramp?: undefined };

export function solids(world: World, except: Obj | null): Solid[] {
  const out: Solid[] = [];
  world.objs.forEach((o) => {
    if (o === except) return;
    if (o.type === 'box' || o.type === 'wall') out.push({ o, kind: 'box', hx: o.w / 2, hy: o.d / 2, h: o.h });
    else if (o.type === 'cylinder') out.push({ o, kind: 'circle', r: o.r, h: o.h });
    else if (o.type === 'robot') out.push({ o, kind: 'box', hx: o.p.L / 2, hy: o.p.W / 2, h: 0.06 });
    else if (o.type === 'arm') out.push({ o, kind: 'circle', r: 0.055, h: 0.06 });
    else if (o.type === 'ramp') out.push({ o, kind: 'box', hx: o.w / 2, hy: o.d / 2, h: o.h, ramp: true });
  });
  return out;
}

/** How high the ground is under (x, y) for robot rb: the ramps it can climb,
 *  the blocks low enough to drive onto. */
export function groundAt(world: World, rb: Robot | null, x: number, y: number): number {
  let h = 0;
  for (const o of world.objs) {
    if (o.type === 'ramp' && (!rb || rampSlope(o) <= rb.p.grade)) {
      const l = toLocal(o, x, y);
      h = Math.max(h, rampHeight(o, l[0], l[1]));
    } else if ((o.type === 'box' || o.type === 'wall') && rb && o.h <= rb.p.climb) {
      const l = toLocal(o, x, y);
      if (Math.abs(l[0]) <= o.w / 2 && Math.abs(l[1]) <= o.d / 2) h = Math.max(h, o.h);
    } else if (o.type === 'cylinder' && rb && o.h <= rb.p.climb) {
      if (Math.hypot(x - o.x, y - o.y) <= o.r) h = Math.max(h, o.h);
    }
  }
  return h;
}

/** What robot rb would run into at (x, y, rot): an object, the edge of the
 *  table (`{ id: 'edge' }`), or null. */
export function collides(world: World, rb: Robot, x: number, y: number, rot: number): Obj | { id: 'edge' } | null {
  const hx = rb.p.L / 2;
  const hy = rb.p.W / 2;
  for (const s of solids(world, rb)) {
    const o = s.o;
    if (s.ramp && o.type === 'ramp' && rampSlope(o) <= rb.p.grade) continue;
    if (!s.ramp && o.type !== 'robot' && o.type !== 'arm' && s.h <= rb.p.climb) continue;
    if (s.kind === 'box') {
      if (obbOverlap(x, y, hx, hy, rot, o.x, o.y, s.hx, s.hy, o.rot)) return o;
    } else if (circleObb(o.x, o.y, s.r, x, y, hx, hy, rot)) return o;
  }
  const f = world.scene.floor;
  if (Math.abs(x) > f.w / 2 + 0.6 || Math.abs(y) > f.h / 2 + 0.6) return { id: 'edge' };
  return null;
}

/**
 * Distance from (x, y) along heading a to the first solid, metres (4 at most).
 * `from` is left out; with `zAt`, so is whatever is lower than the beam.
 */
export function rayCast(world: World, x: number, y: number, a: number, from: Obj | null, zAt?: number): number {
  const dx = cosd(a);
  const dy = sind(a);
  let best = 4;
  solids(world, from).forEach((s) => {
    const o = s.o;
    if (zAt !== undefined && s.h < zAt - 0.005) return; // the beam passes over it
    if (s.kind === 'circle') {
      const ox = x - o.x;
      const oy = y - o.y;
      const b = ox * dx + oy * dy;
      const c = ox * ox + oy * oy - s.r * s.r;
      const disc = b * b - c;
      if (disc < 0) return;
      const t = -b - Math.sqrt(disc);
      if (t >= 0 && t < best) best = t;
      return;
    }
    const cs = cosd(o.rot);
    const sn = sind(o.rot);
    const px = x - o.x;
    const py = y - o.y;
    const lx = px * cs + py * sn;
    const ly = -px * sn + py * cs;
    const ldx = dx * cs + dy * sn;
    const ldy = -dx * sn + dy * cs;
    let t0 = -Infinity;
    let t1 = Infinity;
    let ok = true;
    [[lx, ldx, s.hx], [ly, ldy, s.hy]].forEach((q) => {
      if (!ok) return;
      if (Math.abs(q[1]) < 1e-9) {
        if (Math.abs(q[0]) > q[2]) ok = false;
        return;
      }
      let ta = (-q[2] - q[0]) / q[1];
      let tb = (q[2] - q[0]) / q[1];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    });
    if (!ok || t0 > t1 || t1 < 0) return;
    const t = t0 >= 0 ? t0 : 0;
    if (t < best) best = t;
  });
  return best;
}

/** Put a robot on the ground under it: its height and its lean. */
export function settle(world: World, rb: Robot): void {
  const L = rb.p.L / 2;
  const W = rb.p.W / 2;
  const f = toWorld(rb, L * 0.8, 0);
  const b = toWorld(rb, -L * 0.8, 0);
  const l = toWorld(rb, 0, W * 0.8);
  const r = toWorld(rb, 0, -W * 0.8);
  const hf = groundAt(world, rb, f[0], f[1]);
  const hb = groundAt(world, rb, b[0], b[1]);
  const hl = groundAt(world, rb, l[0], l[1]);
  const hr = groundAt(world, rb, r[0], r[1]);
  rb.z = Math.max((hf + hb) / 2, (hl + hr) / 2);
  rb.pitch = Math.atan2(hf - hb, 1.6 * L) / DEG;
  rb.roll = Math.atan2(hl - hr, 1.6 * W) / DEG;
}

/** The object under (x, y): the smallest one when several are. */
export function pick(world: World, x: number, y: number): Obj | null {
  let best: Obj | null = null;
  let bestArea = Infinity;
  world.objs.forEach((o) => {
    const l = toLocal(o, x, y);
    let inside = false;
    let area: number;
    if (o.type === 'cylinder') {
      inside = Math.hypot(x - o.x, y - o.y) <= o.r + 0.01;
      area = o.r * o.r * 4;
    } else if (o.type === 'arm') {
      inside = Math.hypot(x - o.x, y - o.y) <= 0.07;
      area = 0.02;
    } else if (o.type === 'track') {
      const path = trackPath(o);
      const n = path.pts.length;
      let d = Infinity;
      for (let i = 0; i < n - (path.closed ? 0 : 1); i++) d = Math.min(d, segDist(l, path.pts[i], path.pts[(i + 1) % n]));
      inside = d <= o.tape / 2 + 0.02;
      area = o.w * o.h * 10;
    } else {
      const hx = o.type === 'robot' ? o.p.L / 2 : o.w / 2;
      const hy = o.type === 'robot' ? o.p.W / 2 : o.d / 2;
      inside = Math.abs(l[0]) <= hx + 0.01 && Math.abs(l[1]) <= hy + 0.01;
      area = hx * hy * (o.type === 'robot' ? 0.5 : 1);
    }
    if (inside && area < bestArea) {
      best = o;
      bestArea = area;
    }
  });
  return best;
}
