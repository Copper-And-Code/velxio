/**
 * The kit's types: the scene as the page writes it, the objects it becomes
 * at run time, and the part of `window.velxio` the kit uses.
 */

/** One object of the scene JSON, with what `normalizeScene` guarantees. */
export interface SceneObjectJson {
  id: string;
  type: string;
  x: number;
  y: number;
  rot: number;
  [key: string]: unknown;
}

/** The scene JSON after `normalizeScene`. Keys the kit does not know stay. */
export interface SceneJson {
  version: 1;
  view: '2d' | '3d';
  follow?: string;
  floor: { w: number; h: number; grid: boolean; color: string; [key: string]: unknown };
  objects: SceneObjectJson[];
  [key: string]: unknown;
}

/** A robot body: L x W (m), wheel radius, track width between wheel centres,
 *  climb (the highest step it drives onto), grade (the steepest ramp,
 *  rise/run), line sensors this far ahead of the centre, skid factor on
 *  turns, how many wheels are drawn (0: tracks). */
export interface Preset {
  L: number;
  W: number;
  r: number;
  track: number;
  climb: number;
  grade: number;
  ahead: number;
  skid: number;
  wheels: number;
  color: string;
}

/** What every runtime object has: where it is now, and the scene object it
 *  came from (`src`: its start place, which a save writes back). */
interface ObjBase {
  id: string;
  src: SceneObjectJson;
  x: number;
  y: number;
  rot: number;
  color?: string;
  label?: string;
}

export interface RobotBind {
  left?: string | string[];
  right?: string | string[];
  invertLeft?: boolean;
  invertRight?: boolean;
  line?: string | string[];
  sonar?: string;
  sonarServo?: string;
  imu?: string;
  display?: string;
}

export interface Robot extends ObjBase {
  type: 'robot';
  preset: string;
  p: Preset;
  bind: RobotBind;
  /** Height of the body's centre over the floor, and its lean, degrees. */
  z: number;
  pitch: number;
  roll: number;
  /** Wheel speeds (m/s), forward speed, turn rate (rad/s), smoothed acceleration. */
  vl: number;
  vr: number;
  v: number;
  w: number;
  accel: number;
  /** What each line sensor sees, 0 black .. 1 white. */
  line: number[];
  sonarCm: number | null;
  bumped: boolean;
  lastSonarT: number;
  lastImuT: number;
  sonarAngle: number;
  lineSpacing: number;
  displayId: string | null;
  displayTilt: number;
}

export interface Track extends ObjBase {
  type: 'track';
  shape: 'loop' | 'oval' | 'figure8' | 'line';
  w: number;
  h: number;
  tape: number;
}

export interface Block extends ObjBase {
  type: 'box' | 'wall';
  w: number;
  d: number;
  h: number;
}

export interface Cylinder extends ObjBase {
  type: 'cylinder';
  r: number;
  h: number;
}

export interface Ramp extends ObjBase {
  type: 'ramp';
  profile: 'wedge' | 'bridge' | 'hill';
  w: number;
  d: number;
  h: number;
}

export type ArmJoint = 'base' | 'shoulder' | 'elbow' | 'gripper';

export interface Arm extends ObjBase {
  type: 'arm';
  bind: Partial<Record<ArmJoint, string>>;
  angles: Record<ArmJoint, number>;
}

export type Obj = Robot | Track | Block | Cylinder | Ramp | Arm;

/** The scene and its runtime objects: what the physics works on. */
export interface World {
  scene: SceneJson;
  objs: Obj[];
}

// ── window.velxio, as far as the kit uses it ─────────────────────────────────

export interface PartInput {
  key: string;
  kind: string;
  min: number;
  max: number;
  unit?: string;
}

export interface DisplayInfo {
  w: number;
  h: number;
  touch?: boolean;
}

export interface PartInfo {
  id: string;
  type: string;
  board?: string;
  outputs?: string[];
  inputs?: PartInput[];
  display?: DisplayInfo;
}

export interface BoardInfo {
  id: string;
  kind: string;
  display?: DisplayInfo;
}

export interface Info {
  parts: PartInfo[];
  boards: BoardInfo[];
  theme: string;
}

/** Each part's outputs in a frame: a motor's `drive` and `rpm`, a servo's `angle`. */
export type FrameParts = Record<string, Record<string, unknown> | undefined>;

export interface Frame {
  t: number | null;
  dt: number;
  running: boolean;
  parts?: FrameParts;
}

export interface Velxio {
  ready(): Promise<Info>;
  on(name: string, fn: (arg: never) => void): unknown;
  onFrame(fn: (frame: Frame) => void): unknown;
  set(id: string, values: Record<string, unknown>): void;
  touch(id: string, x: number, y: number, pressed: boolean): void;
  display(id: string, opts?: { fps?: number }): HTMLCanvasElement;
  telemetry(values: Record<string, unknown>): void;
}

/** What the kit sends the host besides the `velxio` calls (`kit/scene`). */
export type Send = (method: string, params: Record<string, unknown>) => void;

/** A board's or a part's screen a robot carries (`bind.display`). */
export interface Screen {
  canvas: HTMLCanvasElement;
  /** The panel in pixels, and its real size in metres. */
  w: number;
  h: number;
  touch: boolean;
  width: number;
  height: number;
  /** Bumped at every new picture. */
  version: number;
}
