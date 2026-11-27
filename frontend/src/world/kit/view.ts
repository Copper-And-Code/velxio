/** What a view (2D or 3D) is to the kit, and what the kit is to a view. */
import type { Raster } from './raster';
import type { Obj, Robot, Screen, World } from './types';

/** A point of the floor under the pointer, and in 3D the object the ray hit
 *  first (its top is above the floor under it). */
export type FloorHit = [number, number] | [number, number, Obj | null];
export type FloorAt = (clientX: number, clientY: number) => FloorHit | null;

/** A point of a robot's screen under the pointer, 0..1 from its top left. */
export interface ScreenHit {
  id: string;
  u: number;
  v: number;
}
export type ScreenAt = (clientX: number, clientY: number) => ScreenHit | null;

export interface View {
  /** Something changed: draw again. */
  dirty(): void;
  /** Follow this robot (null: the whole mat again). */
  follow(o: Robot | null): void;
  destroy(): void;
}

export interface ViewHost {
  readonly world: World;
  readonly byId: Record<string, Obj>;
  readonly raster: Raster;
  readonly root: HTMLElement;
  readonly selected: Obj | null;
  readonly dragging: Obj | null;
  readonly visible: boolean;
  readonly running: boolean;
  /** The robot the camera follows, or null. */
  followed(): Robot | null;
  theme(): { bg: string; fg: string };
  screenOf(id: string | null): Screen | null;
  /** Pointer handling shared by both views: picking, dragging, touching a
   *  screen, and the view's own orbit / pan and zoom on empty space. */
  bindPointer(
    canvas: HTMLElement,
    floorAt: FloorAt,
    onEmptyDrag: (dx: number, dy: number, pan: boolean) => void,
    onWheel: (deltaY: number) => void,
    screenAt: ScreenAt,
  ): void;
}
