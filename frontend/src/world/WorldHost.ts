/**
 * Velxio's side of the World link: answers the page in the iframe
 * (worldRuntime.ts) from the simulator store and the canvas.
 *
 *   frames    about 125 per second: t/dt (seconds the boards have run since
 *             Run, paused while stopped), running, every part's outputs read
 *             from its canvas element;
 *   set       a sensor's inputs, clamped, through dispatchSensorUpdate (the
 *             same path as the sensor panel's sliders);
 *   press     a pushbutton, through the element's button-press/release events;
 *   display   copies of a screen's canvas (a panel board's, an ILI9341's) as
 *             ImageBitmaps, at the fps the page asks for;
 *   touch     a panel board's touch controller, in panel pixels;
 *   asset     a World file's bytes.
 */
import { getBoardSimulator, getEsp32Bridge, getStm32H7Bridge, useSimulatorStore } from '../store/useSimulatorStore';
import { guestMillis } from '../simulation/parts/partUtils';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { b64ToBuffer, useWorldStore } from './useWorldStore';
import {
  BOARD_DISPLAYS,
  clampInputs,
  describeWorld,
  PRESS_PARTS,
  readPartOutputs,
  type WorldInfo,
} from './worldCatalog';
import { WORLD_CHANNEL } from './worldRuntime';

export interface WorldLogEntry {
  level: string;
  text: string;
  at: number;
}

/** The most wall time one frame advances a scene by (see simulatedDt). */
const WALL_DT_MAX = 0.02;
const FRAME_MS = 8;
const ESP32_PANEL_TOUCH_PIN = 19;

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** The <canvas> a board or part draws its screen on. */
function screenCanvas(id: string): HTMLCanvasElement | null {
  const el = document.getElementById(id);
  if (!el) return null;
  if (el instanceof HTMLCanvasElement) return el;
  const own = el.shadowRoot?.querySelector('canvas') ?? el.querySelector('canvas');
  return (own as HTMLCanvasElement | null) ?? null;
}

export class WorldHost {
  private win: Window;
  private timer: number | null = null;
  private displayTimers = new Map<string, number>();
  private info: WorldInfo | null = null;
  private infoKey = '';
  private t = 0;
  private lastTick = 0;
  private wasRunning = false;
  /** The guest clock (ms) of the board the frames count on, at the last frame. */
  private lastGuest: { id: string; ms: number } | null = null;
  private pressed = new Set<string>();
  private themeObserver: MutationObserver | null = null;
  private unsubStore: (() => void) | null = null;
  private onMessage = (e: MessageEvent) => this.handle(e);
  /** console.* and errors of the page. */
  onLog: ((entry: WorldLogEntry) => void) | null = null;
  onTelemetry: ((data: Record<string, unknown>) => void) | null = null;

  constructor(win: Window) {
    this.win = win;
    window.addEventListener('message', this.onMessage);
    this.themeObserver = new MutationObserver(() => {
      if (this.info && this.info.theme !== currentTheme()) {
        this.info.theme = currentTheme();
        this.notify('theme', this.info.theme);
      }
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // A part added or removed while the World runs: tell the page.
    this.unsubStore = useSimulatorStore.subscribe((s, prev) => {
      if (s.components === prev.components && s.boards === prev.boards && s.wires === prev.wires) return;
      const before = this.infoKey;
      this.refreshInfo();
      if (this.infoKey !== before) this.notify('parts', this.info);
    });
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    if (this.timer !== null) window.clearInterval(this.timer);
    for (const t of this.displayTimers.values()) window.clearInterval(t);
    this.displayTimers.clear();
    for (const id of this.pressed) this.release(id);
    this.themeObserver?.disconnect();
    this.unsubStore?.();
  }

  setVisible(visible: boolean): void {
    this.notify('visibility', visible);
  }

  private refreshInfo(): WorldInfo {
    const s = useSimulatorStore.getState();
    this.info = describeWorld(s.boards, s.components, s.wires, currentTheme());
    this.infoKey = JSON.stringify(this.info.boards) + JSON.stringify(this.info.parts);
    return this.info;
  }

  private post(msg: Record<string, unknown>, transfer: Transferable[] = []): void {
    try {
      this.win.postMessage({ ...msg, velxio: WORLD_CHANNEL }, '*', transfer);
    } catch {
      /* the iframe was replaced */
    }
  }

  private notify(method: string, params: unknown, transfer: Transferable[] = []): void {
    this.post({ method, params }, transfer);
  }

  private log(level: string, text: string): void {
    this.onLog?.({ level, text, at: Date.now() });
  }

  private handle(e: MessageEvent): void {
    if (e.source !== this.win) return;
    const msg = e.data as { velxio?: string; id?: number; method?: string; params?: Record<string, unknown> };
    if (!msg || msg.velxio !== WORLD_CHANNEL || typeof msg.method !== 'string') return;
    const p = msg.params ?? {};
    const reply = (result: unknown, transfer: Transferable[] = []) =>
      msg.id !== undefined && this.post({ id: msg.id, result }, transfer);
    const fail = (error: string) => msg.id !== undefined && this.post({ id: msg.id, error });
    switch (msg.method) {
      case 'hello':
        // Repeated until answered: answer each one, the page keeps the first.
        this.notify('info', this.refreshInfo());
        this.start();
        break;
      case 'set':
        this.set(String(p.id), (p.values ?? {}) as Record<string, unknown>);
        break;
      case 'press':
        this.press(String(p.id));
        break;
      case 'release':
        this.release(String(p.id));
        break;
      case 'touch':
        this.touch(String(p.id), Number(p.x), Number(p.y), !!p.pressed);
        break;
      case 'display':
        this.subscribeDisplay(String(p.id), Number(p.fps) || 15);
        break;
      case 'telemetry':
        this.onTelemetry?.(p);
        break;
      case 'log':
        this.log(String(p.level ?? 'log'), String(p.text ?? ''));
        break;
      case 'asset': {
        const a = useWorldStore.getState().assets.find((x) => x.name === p.name);
        if (!a) {
          fail(`No World file named "${String(p.name)}" (add it with Files in the World panel)`);
          break;
        }
        const buffer = b64ToBuffer(a.b64);
        reply({ name: a.name, mime: a.mime, buffer }, [buffer]);
        break;
      }
      case 'kit/scene':
        // The kit's scene after an edit with the mouse: into the page's JSON block.
        // Only over the scene the page loaded (`base`): one typed into the
        // page since this Run is newer than the page's, and is left alone.
        if (typeof p.json === 'string') {
          const html = useWorldStore.getState().html;
          if (typeof p.base === 'string' && !sameKitScene(kitSceneText(html), p.base)) {
            this.notify('kit/stale', null);
            break;
          }
          const next = replaceKitScene(html, p.json);
          if (next !== null && next !== html) useWorldStore.getState().setHtml(next);
        }
        break;
      case 'assets':
        reply(
          useWorldStore.getState().assets.map((a) => ({
            name: a.name,
            mime: a.mime,
            size: Math.floor((a.b64.length * 3) / 4) - (a.b64.match(/=*$/)?.[0].length ?? 0),
          })),
        );
        break;
      default:
        fail(`Unknown method ${msg.method}`);
    }
  }

  /**
   * Seconds the boards ran since the last frame: the guest clock of the first
   * running board that has one this tab can read (an AVR's cycles, an
   * RP2040's timer, what a QEMU worker says of a guest under -icount), so
   * physics keeps step with the firmware whatever speed it is emulated at;
   * the wall time for a board on host time (QEMU without -icount), which is
   * the clock its firmware reads. A jump (a new board, a reset) counts as one
   * wall frame.
   *
   * Wall time is capped at WALL_DT_MAX per frame: while the page is busy (a
   * slow 3D frame, a burst of messages) the scene slows down instead of
   * jumping ahead of the sensor and motor messages still queued, so a
   * firmware in another process keeps steering it.
   */
  private simulatedDt(boards: { id: string; running: boolean }[], wall: number): number {
    for (const b of boards) {
      if (!b.running) continue;
      const sim = getBoardSimulator(b.id);
      const ms = sim ? guestMillis(sim as never) : null;
      if (ms === null) continue;
      const prev = this.lastGuest;
      this.lastGuest = { id: b.id, ms };
      if (!prev || prev.id !== b.id) return Math.min(wall, WALL_DT_MAX);
      const d = (ms - prev.ms) / 1000;
      return d >= 0 && d <= 0.25 ? d : Math.min(wall, WALL_DT_MAX);
    }
    this.lastGuest = null;
    return Math.min(wall, WALL_DT_MAX);
  }

  private start(): void {
    if (this.timer !== null) return;
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.frame(), FRAME_MS);
  }

  private frame(): void {
    const now = performance.now();
    const wall = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const s = useSimulatorStore.getState();
    const running = s.boards.some((b) => b.running);
    if (running && !this.wasRunning) {
      this.t = 0;
      this.notify('reset', null);
    }
    this.wasRunning = running;
    const dt = running ? this.simulatedDt(s.boards, wall) : 0;
    if (running) this.t += dt;
    const parts: Record<string, Record<string, number | boolean>> = {};
    for (const c of s.components) {
      const out = readPartOutputs(c.metadataId, document.getElementById(c.id));
      if (out) parts[c.id] = out;
    }
    this.notify('frame', { t: running ? this.t : null, dt, running, parts });
  }

  private set(id: string, values: Record<string, unknown>): void {
    const part = this.info?.parts.find((x) => x.id === id);
    if (!part) return;
    const clamped = clampInputs(part.inputs, values);
    if (Object.keys(clamped).length) dispatchSensorUpdate(id, clamped);
  }

  private press(id: string): void {
    const part = this.info?.parts.find((x) => x.id === id);
    const el = document.getElementById(id) as (HTMLElement & { pressed?: boolean }) | null;
    if (!part || !PRESS_PARTS.has(part.type) || !el || this.pressed.has(id)) return;
    this.pressed.add(id);
    el.pressed = true;
    el.dispatchEvent(new Event('button-press'));
  }

  private release(id: string): void {
    const el = document.getElementById(id) as (HTMLElement & { pressed?: boolean }) | null;
    if (!this.pressed.delete(id) || !el) return;
    el.pressed = false;
    el.dispatchEvent(new Event('button-release'));
  }

  private touch(id: string, x: number, y: number, pressed: boolean): void {
    const board = useSimulatorStore.getState().boards.find((b) => b.id === id);
    const d = board && BOARD_DISPLAYS[board.boardKind];
    if (!board || !d || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const tx = Math.round(Math.max(0, Math.min(d.w - 1, x)));
    const ty = Math.round(Math.max(0, Math.min(d.h - 1, y)));
    if (board.boardKind === 'esp32-4848s040') {
      getEsp32Bridge(id)?.sendSensorUpdate(ESP32_PANEL_TOUCH_PIN, { x: tx, y: ty, pressed });
    } else {
      getStm32H7Bridge(id)?.sendTouch(tx, ty, pressed);
    }
  }

  private subscribeDisplay(id: string, fps: number): void {
    const old = this.displayTimers.get(id);
    if (old !== undefined) window.clearInterval(old);
    const period = 1000 / Math.max(1, Math.min(60, fps));
    let busy = false;
    const grab = () => {
      const src = screenCanvas(id);
      if (!src || busy || src.width === 0 || src.height === 0) return;
      busy = true;
      createImageBitmap(src)
        .then((bitmap) => this.notify('display', { id, bitmap }, [bitmap]))
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    this.displayTimers.set(id, window.setInterval(grab, period));
    grab();
  }
}

/**
 * The page with the content of its `<script type="application/json"
 * id="velxio-scene">` block replaced by `json`; null when it has none.
 */
const KIT_SCENE_RE = /(<script\b[^>]*\bid\s*=\s*["']velxio-scene["'][^>]*>)([\s\S]*?)(<\/script>)/i;

/** The text of the page's velxio-scene block; null when it has none. */
export function kitSceneText(html: string): string | null {
  const m = KIT_SCENE_RE.exec(html);
  return m ? m[2] : null;
}

/**
 * Whether two scene texts say the same scene: the JSON they hold, not its
 * spelling (the block keeps `</script` escaped, the kit sends it plain). A
 * text that does not parse is the same as nothing but itself.
 */
export function sameKitScene(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.trim() === b.trim()) return true;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

export function replaceKitScene(html: string, json: string): string | null {
  const re = KIT_SCENE_RE;
  const m = re.exec(html);
  if (!m) return null;
  const body = '\n' + json.replace(/<\/script/gi, '<\\/script') + '\n';
  return html.slice(0, m.index) + m[1] + body + m[3] + html.slice(m.index + m[0].length);
}
