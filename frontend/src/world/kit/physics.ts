/**
 * How a robot moves: its wheels follow the motors bound to them (a first-order
 * lag), the body goes where the wheels take it unless something is in the way.
 */
import { DEG, asList, cosd, num, sind, wrap } from './math';
import { DEADBAND, LAG } from './presets';
import { collides, settle } from './world';
import type { FrameParts, Robot, World } from './types';

/** The speed (m/s) the motors of one side ask for: the mean of their rpm at
 *  the wheel's radius. A motor below the deadband does not turn. */
export function sideSpeed(rb: Robot, ids: string | string[] | undefined, invert: boolean | undefined, parts: FrameParts): number {
  let sum = 0;
  let n = 0;
  asList(ids).forEach((id) => {
    const q = parts[id];
    if (!q) return;
    const d = num(q.drive, 0);
    let rpm = 0;
    if (Math.abs(d) >= DEADBAND) rpm = q.rpm !== undefined ? num(q.rpm, d * 200) : d * 200;
    sum += (rpm / 60) * 2 * Math.PI * rb.p.r;
    n++;
  });
  const v = n ? sum / n : 0;
  return invert ? -v : v;
}

/** One step of dt seconds. */
export function stepRobot(world: World, rb: Robot, dt: number, parts: FrameParts): void {
  const tl = sideSpeed(rb, rb.bind.left, rb.bind.invertLeft, parts);
  const tr = sideSpeed(rb, rb.bind.right, rb.bind.invertRight, parts);
  const k = 1 - Math.exp(-dt / LAG);
  rb.vl += (tl - rb.vl) * k;
  rb.vr += (tr - rb.vr) * k;
  const slow = 1 - Math.min(0.6, Math.abs(Math.sin(rb.pitch * DEG)) * 2); // uphill / downhill drag
  let v = ((rb.vl + rb.vr) / 2) * slow;
  const w = (rb.vr - rb.vl) / (rb.p.track * rb.p.skid);
  const nrot = rb.rot + (w * dt) / DEG;
  const a = (rb.rot + nrot) / 2;
  const nx = rb.x + v * cosd(a) * dt;
  const ny = rb.y + v * sind(a) * dt;
  if (collides(world, rb, nx, ny, nrot)) {
    if (!collides(world, rb, rb.x, rb.y, nrot)) rb.rot = nrot; // turning on the spot is fine
    rb.bumped = true;
    v = 0;
  } else {
    rb.x = nx;
    rb.y = ny;
    rb.rot = nrot;
    rb.bumped = false;
  }
  rb.accel = ((v - rb.v) / dt) * 0.05 + rb.accel * 0.95;
  rb.v = v;
  rb.w = w;
  rb.rot = wrap(rb.rot);
  settle(world, rb);
}
