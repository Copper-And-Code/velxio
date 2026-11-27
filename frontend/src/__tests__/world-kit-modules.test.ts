/**
 * The World kit's modules (src/world/kit/), tested as they are.
 *
 * The kit used to be one string literal: nothing of it could be imported, so
 * its scene handling, geometry and physics were only ever exercised in a
 * browser, by hand. As modules, what needs no page is tested here:
 *
 *  - scene: defaults and ids, the keys the kit does not know, and a save that
 *    differs from what the page wrote only by the edit;
 *  - geometry and the mat: frames, tracks, ramps, what a sonar beam meets,
 *    what a robot runs into, what the pointer picks;
 *  - physics: wheel speed from the motors, a robot that drives, turns, stops
 *    at a wall and climbs only the ramps its preset allows.
 */
import { describe, expect, it } from 'vitest';
import { asList, lum, num, segDist, wrap } from '../world/kit/math';
import { PRESETS, STEP } from '../world/kit/presets';
import { makeObj, normalizeScene, sceneJson } from '../world/kit/scene';
import { armPose, circleObb, obbOverlap, rampHeight, rampSlope, toLocal, toWorld, trackPath } from '../world/kit/geometry';
import { collides, groundAt, pick, rayCast, settle } from '../world/kit/world';
import { sideSpeed, stepRobot } from '../world/kit/physics';
import { robotSummary } from '../world/kit';
import type { Arm, Obj, Ramp, Robot, World } from '../world/kit/types';

/** A world from a scene as a page would write it. */
function worldOf(scene: unknown): { world: World; warnings: string[]; byId: Record<string, Obj> } {
  const warnings: string[] = [];
  const world: World = { scene: normalizeScene(scene).scene, objs: [] };
  const byId: Record<string, Obj> = {};
  world.scene.objects.forEach((o) => {
    const r = makeObj(o, (w) => warnings.push(w));
    if (r) {
      world.objs.push(r);
      byId[r.id] = r;
    }
  });
  world.objs.forEach((o) => {
    if (o.type === 'robot') settle(world, o);
  });
  return { world, warnings, byId };
}

const robot = (extra: Record<string, unknown> = {}) => ({
  id: 'rb', type: 'robot', preset: 'diff2', x: 0, y: 0, rot: 0, bind: { left: ['mL'], right: ['mR'] }, ...extra,
});

/** Run the physics for `seconds` with both sides at the given drive. */
function drive(world: World, rb: Robot, left: number, right: number, seconds: number): void {
  const parts = { mL: { drive: left, rpm: left * 200 }, mR: { drive: right, rpm: right * 200 } };
  for (let t = 0; t < seconds; t += STEP) stepRobot(world, rb, STEP, parts);
}

describe('math', () => {
  it('keeps angles in (-180, 180] and numbers finite', () => {
    expect(wrap(190)).toBe(-170);
    expect(wrap(-180)).toBe(180);
    expect(wrap(540)).toBe(180);
    expect(num('1.5', 0)).toBe(1.5);
    expect(num('x', 7)).toBe(7);
    expect(num(Infinity, 7)).toBe(7);
    expect(asList('a')).toEqual(['a']);
    expect(asList(['a', 'b'])).toEqual(['a', 'b']);
    expect(asList(undefined)).toEqual([]);
  });

  it('reads a colour\'s luminance and a point\'s distance to a segment', () => {
    expect(lum('#000')).toBe(0);
    expect(lum('#ffffff')).toBeCloseTo(1, 6);
    expect(lum('nonsense')).toBe(0.5);
    expect(segDist([0, 1], [-1, 0], [1, 0])).toBe(1);
    expect(segDist([3, 0], [-1, 0], [1, 0])).toBe(2);
  });
});

describe('scene', () => {
  it('fills in the defaults and gives every object an id, a place and a heading', () => {
    const { scene, written } = normalizeScene({ objects: [{ type: 'box' }, { type: 'box' }, { id: 'box1', type: 'wall', x: '0.5' }, null, 3] });
    expect(scene.version).toBe(1);
    expect(scene.view).toBe('3d');
    expect(scene.floor).toEqual({ w: 2.4, h: 1.6, grid: true, color: '#f2efe8' });
    expect(scene.objects.map((o) => o.id)).toEqual(['box1', 'box2', 'box1_']);
    expect(scene.objects[2]).toMatchObject({ x: 0.5, y: 0, rot: 0 });
    expect(written.floorColor).toBe(false);
    expect(normalizeScene(null).scene.objects).toEqual([]);
    expect(normalizeScene('a string').scene.floor.w).toBe(2.4);
  });

  it('a save differs from what the page wrote only by the edit', () => {
    const page = {
      version: 1, view: '2d', title: 'Lesson 3',
      floor: { w: 2, h: 1, note: 'kept' },
      objects: [{ id: 'r', type: 'robot', x: 0.1, y: 0.2, speedLimit: 3 }, { id: 'b', type: 'box', x: 1, y: 0, rot: 30 }],
    };
    const { scene, written } = normalizeScene(page);
    // untouched: the page's own JSON, with the floor's grid as the only default written
    expect(JSON.parse(sceneJson(scene, written))).toEqual({ ...page, floor: { w: 2, h: 1, note: 'kept', grid: true } });
    // the robot is turned: its heading is written from now on, also back at 0
    scene.objects[0].rot = 15;
    expect(JSON.parse(sceneJson(scene, written)).objects[0]).toEqual({ id: 'r', type: 'robot', x: 0.1, y: 0.2, speedLimit: 3, rot: 15 });
    scene.objects[0].rot = 0;
    expect(JSON.parse(sceneJson(scene, written)).objects[0].rot).toBe(0);
    // following a robot and no longer following it
    scene.follow = 'r';
    expect(JSON.parse(sceneJson(scene, written)).follow).toBe('r');
    delete scene.follow;
    expect('follow' in JSON.parse(sceneJson(scene, written))).toBe(false);
  });

  it('makes runtime objects, with a warning for what it does not know', () => {
    const { world, warnings, byId } = worldOf({
      objects: [
        robot({ preset: 'hovercraft', lineSpacing: 5, bind: { left: 'a', right: 'b', display: 'esp32-4848s040' } }),
        { id: 't', type: 'track', shape: 'spiral', tape: 9 },
        { id: 'w', type: 'wall' },
        { id: 'x', type: 'teleporter' },
        { id: 'p', type: 'robot', preset: 'constructor' },
      ],
    });
    expect(world.objs.map((o) => o.id)).toEqual(['rb', 't', 'w', 'p']);
    expect(warnings).toEqual([
      'robot "rb": unknown preset "hovercraft", using diff2',
      'object "x": unknown type "teleporter"',
      'robot "p": unknown preset "constructor", using diff2',
    ]);
    expect(byId.rb).toMatchObject({ preset: 'diff2', p: PRESETS.diff2, lineSpacing: 0.08, displayId: 'esp32-4848s040', displayTilt: 50 });
    expect(byId.t).toMatchObject({ shape: 'loop', tape: 0.2 });
    expect(byId.w).toMatchObject({ w: 1, d: 0.02, h: 0.1 });
  });
});

describe('geometry', () => {
  it('goes to an object\'s frame and back', () => {
    const o = { x: 0.3, y: -0.2, rot: 30 };
    const l = toLocal(o, 0.7, 0.5);
    const w = toWorld(o, l[0], l[1]);
    expect(w[0]).toBeCloseTo(0.7, 9);
    expect(w[1]).toBeCloseTo(0.5, 9);
    expect(toWorld({ x: 0, y: 0, rot: 90 }, 1, 0)[1]).toBeCloseTo(1, 9); // headings turn counter-clockwise
  });

  it('draws a track inside its box, the tape included', () => {
    for (const shape of ['loop', 'oval', 'figure8'] as const) {
      const path = trackPath({ shape, w: 1.6, h: 0.9, tape: 0.022 });
      expect(path.closed).toBe(true);
      for (const p of path.pts) {
        expect(Math.abs(p[0])).toBeLessThanOrEqual(0.8 - 0.011 + 1e-9);
        expect(Math.abs(p[1])).toBeLessThanOrEqual(0.45 - 0.011 + 1e-9);
      }
    }
    expect(trackPath({ shape: 'line', w: 1, h: 0.5, tape: 0.02 })).toEqual({ pts: [[-0.49, 0], [0.49, 0]], closed: false });
  });

  it('knows a ramp\'s height and its steepest slope', () => {
    const wedge = { type: 'ramp', profile: 'wedge', w: 0.4, d: 0.3, h: 0.04 } as Ramp;
    expect(rampHeight(wedge, -0.2, 0)).toBe(0);
    expect(rampHeight(wedge, 0, 0)).toBeCloseTo(0.02, 9);
    expect(rampHeight(wedge, 0.2, 0)).toBeCloseTo(0.04, 9);
    expect(rampHeight(wedge, 0.21, 0)).toBe(0);
    expect(rampSlope(wedge)).toBeCloseTo(0.1, 9);
    const bridge = { ...wedge, profile: 'bridge' } as Ramp;
    expect(rampHeight(bridge, 0, 0)).toBeCloseTo(0.04, 9);
    expect(rampSlope(bridge)).toBeCloseTo(0.3, 9);
  });

  it('tells when boxes and circles overlap', () => {
    expect(obbOverlap(0, 0, 1, 1, 0, 1.9, 0, 1, 1, 0)).toBe(true);
    expect(obbOverlap(0, 0, 1, 1, 0, 2.1, 0, 1, 1, 0)).toBe(false);
    // two unit squares corner to corner along x: apart when square, touching when one is turned 45
    expect(obbOverlap(0, 0, 0.5, 0.5, 0, 1.1, 0, 0.5, 0.5, 0)).toBe(false);
    expect(obbOverlap(0, 0, 0.5, 0.5, 0, 1.1, 0, 0.5, 0.5, 45)).toBe(true);
    expect(circleObb(1.4, 0, 0.5, 0, 0, 1, 1, 0)).toBe(true);
    expect(circleObb(1.6, 0, 0.5, 0, 0, 1, 1, 0)).toBe(false);
  });

  it('poses an arm from its servo angles', () => {
    const arm = { type: 'arm', x: 0, y: 0, rot: 0, angles: { base: 90, shoulder: 0, elbow: 90, gripper: 180 } } as Arm;
    const flat = armPose(arm);
    expect(flat.wrist[0]).toBeCloseTo(0.22, 9); // both links flat, straight ahead
    expect(flat.wrist[2]).toBeCloseTo(0.06, 9);
    expect(flat.open).toBe(1);
    arm.angles.shoulder = 90;
    expect(armPose(arm).elbow[2]).toBeCloseTo(0.18, 9); // the upper arm straight up
    arm.angles.base = 180;
    expect(armPose(arm).yaw).toBe(90);
  });
});

describe('the mat', () => {
  it('measures what a sonar beam meets, and lets it pass over what is lower', () => {
    const { world, byId } = worldOf({
      objects: [robot(), { id: 'box', type: 'box', x: 0.5, y: 0, w: 0.1, d: 0.1, h: 0.15 }, { id: 'kerb', type: 'box', x: 0.3, y: 0, w: 0.02, d: 0.5, h: 0.01 }, { id: 'can', type: 'cylinder', x: 0, y: 0.6, r: 0.05 }],
    });
    const rb = byId.rb as Robot;
    expect(rayCast(world, 0, 0, 0, rb)).toBeCloseTo(0.29, 9); // the kerb is first
    expect(rayCast(world, 0, 0, 0, rb, 0.04)).toBeCloseTo(0.45, 9); // at sensor height it is under the beam
    expect(rayCast(world, 0, 0, 90, rb)).toBeCloseTo(0.55, 9); // the can
    expect(rayCast(world, 0, 0, 180, rb)).toBe(4); // nothing: the most it reports
  });

  it('stops a robot at an object and at the edge of the table', () => {
    const { world, byId } = worldOf({ floor: { w: 1, h: 1 }, objects: [robot(), { id: 'wall', type: 'wall', x: 0.3, y: 0, rot: 90 }] });
    const rb = byId.rb as Robot;
    expect(collides(world, rb, 0, 0, 0)).toBeNull();
    expect(collides(world, rb, 0.22, 0, 0)).toBe(byId.wall);
    expect(collides(world, rb, -1.2, 0, 0)).toEqual({ id: 'edge' });
  });

  it('puts a robot on a ramp it can climb, and picks the smallest object under the pointer', () => {
    const { world, byId } = worldOf({
      objects: [
        robot({ x: 0.5, y: 0 }),
        { id: 'ramp', type: 'ramp', x: 0.5, y: 0, w: 0.4, d: 0.3, h: 0.04 },
        { id: 'steep', type: 'ramp', x: -0.5, y: 0, w: 0.1, d: 0.3, h: 0.04 },
        { id: 'track', type: 'track', shape: 'line', x: 0.5, y: 0, w: 1.2 },
      ],
    });
    const rb = byId.rb as Robot;
    expect(groundAt(world, rb, 0.5, 0)).toBeCloseTo(0.02, 9);
    expect(groundAt(world, rb, -0.5, 0)).toBe(0); // 0.4 rise/run: over a diff2's 0.30
    expect(rb.z).toBeCloseTo(0.02, 3);
    expect(rb.pitch).toBeGreaterThan(0); // nose up the wedge
    expect(pick(world, 0.5, 0)).toBe(rb);
    expect(pick(world, 0.5, 0.12)).toBe(byId.ramp);
    expect(pick(world, 0.95, 0)).toBe(byId.track);
    expect(pick(world, 0, 0.6)).toBeNull();
  });
});

describe('physics', () => {
  it('turns motor output into wheel speed', () => {
    const { byId } = worldOf({ objects: [robot()] });
    const rb = byId.rb as Robot;
    const r = PRESETS.diff2.r;
    expect(sideSpeed(rb, ['m'], false, { m: { drive: 0.5, rpm: 100 } })).toBeCloseTo((100 / 60) * 2 * Math.PI * r, 9);
    expect(sideSpeed(rb, 'm', true, { m: { drive: 0.5, rpm: 100 } })).toBeCloseTo(-(100 / 60) * 2 * Math.PI * r, 9);
    expect(sideSpeed(rb, ['m'], false, { m: { drive: 0.04, rpm: 8 } })).toBe(0); // under the deadband
    expect(sideSpeed(rb, ['m'], false, { m: { drive: 0.5 } })).toBeCloseTo((100 / 60) * 2 * Math.PI * r, 9); // no rpm: 200 at full drive
    expect(sideSpeed(rb, ['a', 'b'], false, { a: { drive: 1, rpm: 200 }, b: { drive: 0, rpm: 0 } })).toBeCloseTo((100 / 60) * 2 * Math.PI * r, 9);
    expect(sideSpeed(rb, ['gone'], false, {})).toBe(0);
  });

  it('drives straight at the wheels\' speed, and turns toward the slower side', () => {
    const { world, byId } = worldOf({ objects: [robot()] });
    const rb = byId.rb as Robot;
    drive(world, rb, 0.5, 0.5, 1);
    const v = (100 / 60) * 2 * Math.PI * PRESETS.diff2.r;
    expect(rb.v).toBeCloseTo(v, 4);
    expect(rb.x).toBeGreaterThan(v * 0.85); // a second, less the motors' lag
    expect(rb.y).toBeCloseTo(0, 9);
    expect(rb.rot).toBe(0);
    drive(world, rb, 0, 0.5, 0.3); // the right side alone: to the left, counter-clockwise
    expect(rb.rot).toBeGreaterThan(5);
    expect(rb.y).toBeGreaterThan(0);
  });

  it('stops at a wall, says so, and goes again when it backs off', () => {
    const { world, byId } = worldOf({ objects: [robot(), { id: 'wall', type: 'wall', x: 0.3, y: 0, rot: 90 }] });
    const rb = byId.rb as Robot;
    drive(world, rb, 1, 1, 2);
    expect(rb.bumped).toBe(true);
    expect(rb.v).toBe(0);
    expect(rb.x + PRESETS.diff2.L / 2).toBeLessThanOrEqual(0.29 + 1e-9); // its nose short of the wall's face
    expect(rb.x + PRESETS.diff2.L / 2).toBeGreaterThan(0.27);
    drive(world, rb, -1, -1, 0.5);
    expect(rb.bumped).toBe(false);
    expect(rb.x).toBeLessThan(0.1);
  });

  it('climbs the ramps its preset allows and stops at the others', () => {
    const scene = (preset: string) => ({ objects: [robot({ preset }), { id: 'ramp', type: 'ramp', x: 0.45, y: 0, w: 0.3, d: 0.4, h: 0.1 }] });
    const tank = worldOf(scene('tank')); // 0.33 rise/run: a tank's grade is 0.58
    drive(tank.world, tank.byId.rb as Robot, 1, 1, 1.2);
    expect((tank.byId.rb as Robot).bumped).toBe(false);
    expect((tank.byId.rb as Robot).z).toBeGreaterThan(0.02);
    const diff2 = worldOf(scene('diff2')); // over a diff2's 0.30
    drive(diff2.world, diff2.byId.rb as Robot, 1, 1, 1.2);
    expect((diff2.byId.rb as Robot).bumped).toBe(true);
    expect((diff2.byId.rb as Robot).z).toBe(0);
  });

  it('sums a robot up in a line', () => {
    const { byId } = worldOf({ objects: [robot()] });
    const rb = byId.rb as Robot;
    Object.assign(rb, { v: 0.254, line: [0.1, 0.9], sonarCm: 23, bumped: true });
    expect(robotSummary(rb)).toBe('25 cm/s  line #.  sonar 23 cm  BUMP');
  });
});
