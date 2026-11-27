/**
 * The floor as a picture: the mat, its grid and the tracks, drawn once on a
 * canvas. Both views show it, and the line sensors read it.
 */
import { DEG, clamp, lum } from './math';
import { toLocal, trackPath } from './geometry';
import type { World } from './types';

export interface Raster {
  canvas: HTMLCanvasElement | null;
  /** Pixels per metre. */
  px: number;
  data: Uint8ClampedArray | null;
  /** Bumped every time the picture is drawn again. */
  version: number;
}

export function newRaster(): Raster {
  return { canvas: null, px: 100, data: null, version: 0 };
}

export function buildRaster(raster: Raster, world: World): void {
  const f = world.scene.floor;
  const px = clamp(Math.floor(2048 / Math.max(f.w, f.h)), 60, 400);
  const cv = raster.canvas || (raster.canvas = document.createElement('canvas'));
  cv.width = Math.max(8, Math.round(f.w * px));
  cv.height = Math.max(8, Math.round(f.h * px));
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g) return;
  raster.px = px;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = f.color;
  g.fillRect(0, 0, cv.width, cv.height);
  if (f.grid) {
    g.strokeStyle = lum(f.color) < 0.45 ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)';
    g.lineWidth = 1;
    for (let gx = 0; gx <= f.w + 1e-6; gx += 0.1) {
      g.beginPath();
      g.moveTo(Math.round(gx * px) + 0.5, 0);
      g.lineTo(Math.round(gx * px) + 0.5, cv.height);
      g.stroke();
    }
    for (let gy = 0; gy <= f.h + 1e-6; gy += 0.1) {
      g.beginPath();
      g.moveTo(0, Math.round(gy * px) + 0.5);
      g.lineTo(cv.width, Math.round(gy * px) + 0.5);
      g.stroke();
    }
  }
  world.objs.forEach((t) => {
    if (t.type !== 'track') return;
    const path = trackPath(t);
    g.save();
    g.translate((t.x + f.w / 2) * px, (f.h / 2 - t.y) * px);
    g.scale(px, -px);
    g.rotate(t.rot * DEG);
    g.strokeStyle = t.color || '#111111';
    g.lineWidth = t.tape;
    g.lineJoin = 'round';
    g.lineCap = 'butt';
    g.beginPath();
    path.pts.forEach((p, i) => {
      if (i) g.lineTo(p[0], p[1]);
      else g.moveTo(p[0], p[1]);
    });
    if (path.closed) g.closePath();
    g.stroke();
    g.restore();
  });
  raster.data = g.getImageData(0, 0, cv.width, cv.height).data;
  raster.version++;
}

/** What a line sensor sees at (x, y): 0 black .. 1 white, a 3 x 3 px spot of
 *  the floor, or the top of a ramp or a block; off the mat a dark table. */
export function reflectance(raster: Raster, world: World, x: number, y: number): number {
  const f = world.scene.floor;
  const px = raster.px;
  const cv = raster.canvas;
  for (const o of world.objs) {
    if (o.type === 'ramp' || o.type === 'box' || o.type === 'wall') {
      const l = toLocal(o, x, y);
      if (Math.abs(l[0]) <= o.w / 2 && Math.abs(l[1]) <= o.d / 2) return lum(o.color || (o.type === 'ramp' ? '#c8b48a' : '#b0723a'));
    }
  }
  const u = Math.floor((x + f.w / 2) * px);
  const v = Math.floor((f.h / 2 - y) * px);
  const dd = raster.data;
  if (!dd || !cv || u < 1 || v < 1 || u >= cv.width - 1 || v >= cv.height - 1) return 0.08;
  const W = cv.width;
  let sum = 0;
  for (let dv = -1; dv <= 1; dv++) {
    for (let du = -1; du <= 1; du++) {
      const k = ((v + dv) * W + (u + du)) * 4;
      sum += 0.2126 * dd[k] + 0.7152 * dd[k + 1] + 0.0722 * dd[k + 2];
    }
  }
  return sum / (9 * 255);
}
