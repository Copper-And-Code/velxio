/** Small numeric helpers of the kit. Angles are degrees unless said otherwise. */

export const DEG = Math.PI / 180;

/** `v` as a finite number, else `d`. */
export function num(v: unknown, d: number): number {
  const n = Number(v);
  return isFinite(n) ? n : d;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Rounded to a millimetre / to a tenth of a degree: what a save writes. */
export function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
export function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** An angle in (-180, 180]. */
export function wrap(a: number): number {
  a = a % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

export function cosd(a: number): number {
  return Math.cos(a * DEG);
}
export function sind(a: number): number {
  return Math.sin(a * DEG);
}

/** A value or a list of them, as a list. */
export function asList<T>(v: T | T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

/** Luminance of a `#rgb` / `#rrggbb` colour, 0..1 (0.5 when it does not parse). */
export function lum(hex: unknown): number {
  let c = String(hex || '#000').replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const v = parseInt(c, 16);
  if (!isFinite(v)) return 0.5;
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
}

export type Pt = [number, number];

/** Distance from point p to the segment a-b. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 ? clamp(((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2, 0, 1) : 0;
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
}
