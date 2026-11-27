/**
 * Plan geometry of the scene. Units are metres and degrees; the mat is centred
 * on the origin, x to the right, y away from the viewer, headings
 * counter-clockwise from +x.
 */
import { DEG, clamp, cosd, sind, type Pt } from './math';
import type { Arm, Ramp, Track } from './types';

interface Placed {
  x: number;
  y: number;
  rot: number;
}

/** (x, y) in o's own frame. */
export function toLocal(o: Placed, x: number, y: number): Pt {
  const c = cosd(o.rot);
  const s = sind(o.rot);
  const dx = x - o.x;
  const dy = y - o.y;
  return [dx * c + dy * s, -dx * s + dy * c];
}

/** (lx, ly) of o's own frame on the mat. */
export function toWorld(o: Placed, lx: number, ly: number): Pt {
  const c = cosd(o.rot);
  const s = sind(o.rot);
  return [o.x + lx * c - ly * s, o.y + lx * s + ly * c];
}

/** The track's centre line in its own frame, and whether it closes. */
export function trackPath(t: Pick<Track, 'w' | 'h' | 'tape' | 'shape'>): { pts: Pt[]; closed: boolean } {
  const W = Math.max(0.01, t.w - t.tape);
  const H = Math.max(0.01, t.h - t.tape);
  const pts: Pt[] = [];
  if (t.shape === 'line') return { pts: [[-W / 2, 0], [W / 2, 0]], closed: false };
  if (t.shape === 'figure8') {
    for (let i = 0; i < 240; i++) {
      const a = (i / 240) * 2 * Math.PI;
      pts.push([(W / 2) * Math.sin(a), H * Math.sin(a) * Math.cos(a)]);
    }
    return { pts, closed: true };
  }
  const rad = t.shape === 'oval' ? Math.min(W, H) / 2 : Math.min(W, H) * 0.3;
  const cx = W / 2 - rad;
  const cy = H / 2 - rad;
  const corners = [[cx, cy, 0], [-cx, cy, 90], [-cx, -cy, 180], [cx, -cy, 270]];
  corners.forEach((c) => {
    for (let k = 0; k <= 16; k++) {
      const ang = (c[2] + (k / 16) * 90) * DEG;
      pts.push([c[0] + rad * Math.cos(ang), c[1] + rad * Math.sin(ang)]);
    }
  });
  return { pts, closed: true };
}

/** The steepest part of a ramp, rise over run. */
export function rampSlope(o: Ramp): number {
  if (o.profile === 'wedge') return o.h / o.w;
  if (o.profile === 'bridge') return (3 * o.h) / o.w;
  return (Math.PI * o.h) / Math.min(o.w, o.d);
}

/** How high a ramp is at (lx, ly) of its own frame; 0 off it. */
export function rampHeight(o: Ramp, lx: number, ly: number): number {
  if (Math.abs(lx) > o.w / 2 || Math.abs(ly) > o.d / 2) return 0;
  const u = (lx + o.w / 2) / o.w;
  if (o.profile === 'wedge') return o.h * u;
  if (o.profile === 'bridge') return o.h * Math.min(1, 3 * u, 3 * (1 - u));
  return o.h * (0.5 + 0.5 * Math.cos((2 * Math.PI * lx) / o.w)) * (0.5 + 0.5 * Math.cos((2 * Math.PI * ly) / o.d));
}

function obbAxes(rot: number): [Pt, Pt] {
  const c = cosd(rot);
  const s = sind(rot);
  return [[c, s], [-s, c]];
}

/** Whether two boxes (centre, half extents, heading) overlap: separating axes. */
export function obbOverlap(
  ax: number, ay: number, ahx: number, ahy: number, arot: number,
  bx: number, by: number, bhx: number, bhy: number, brot: number,
): boolean {
  const A = obbAxes(arot);
  const B = obbAxes(brot);
  const d = [bx - ax, by - ay];
  const axes = [...A, ...B];
  for (let i = 0; i < 4; i++) {
    const n = axes[i];
    const ra = ahx * Math.abs(A[0][0] * n[0] + A[0][1] * n[1]) + ahy * Math.abs(A[1][0] * n[0] + A[1][1] * n[1]);
    const rb = bhx * Math.abs(B[0][0] * n[0] + B[0][1] * n[1]) + bhy * Math.abs(B[1][0] * n[0] + B[1][1] * n[1]);
    if (Math.abs(d[0] * n[0] + d[1] * n[1]) > ra + rb) return false;
  }
  return true;
}

/** Whether a circle overlaps a box (centre, half extents, heading). */
export function circleObb(
  cx: number, cy: number, r: number,
  bx: number, by: number, hx: number, hy: number, rot: number,
): boolean {
  const c = cosd(rot);
  const s = sind(rot);
  const dx = cx - bx;
  const dy = cy - by;
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const qx = clamp(lx, -hx, hx);
  const qy = clamp(ly, -hy, hy);
  return (lx - qx) * (lx - qx) + (ly - qy) * (ly - qy) < r * r;
}

export interface ArmPose {
  yaw: number;
  /** Shoulder and forearm angles from the horizontal, radians. */
  sh: number;
  el: number;
  L1: number;
  L2: number;
  H0: number;
  /** The joints on the mat, with their height. */
  base: [number, number, number];
  elbow: [number, number, number];
  wrist: [number, number, number];
  /** The gripper, 0 closed .. 1 open. */
  open: number;
}

/** The arm's joints on the mat and their heights, from its servo angles. */
export function armPose(o: Arm): ArmPose {
  const a = o.angles;
  const yaw = o.rot + (a.base - 90);
  const sh = clamp(a.shoulder, 0, 180) * DEG; // 0 forward flat, 90 straight up
  const el = sh + (clamp(a.elbow, 0, 180) - 90) * DEG; // the forearm, bent from the upper arm
  const L1 = 0.12;
  const L2 = 0.1;
  const H0 = 0.06;
  const r1 = L1 * Math.cos(sh);
  const z1 = H0 + L1 * Math.sin(sh);
  const r2 = r1 + L2 * Math.cos(el);
  const z2 = z1 + L2 * Math.sin(el);
  return {
    yaw, sh, el, L1, L2, H0,
    base: [o.x, o.y, H0],
    elbow: [o.x + r1 * cosd(yaw), o.y + r1 * sind(yaw), z1],
    wrist: [o.x + r2 * cosd(yaw), o.y + r2 * sind(yaw), Math.max(0.005, z2)],
    open: clamp(a.gripper, 0, 180) / 180,
  };
}
