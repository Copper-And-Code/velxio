/**
 * velxio.kit — ready-made robot scenes for a World.
 *
 * A page that is only a JSON block
 *
 *   <script type="application/json" id="velxio-scene">{ "version": 1, ... }</script>
 *   <script>velxio.kit.start();</script>
 *
 * gets the scene drawn in 3D (three.js) or 2D, its physics and its sensors run
 * on simulated time, and the objects editable with the mouse (the new places
 * are written back into the page's JSON block, see WorldHost 'kit/scene').
 *
 * The scene format is the public one of velxio.dev's World prompt (units:
 * metres and degrees, the mat centred on the origin, x right, y away from the
 * viewer, rot counter-clockwise from +x):
 *   robot     preset diff2 | diff4 | tank | maqueen-lite, bind {left, right,
 *             invertLeft, invertRight, line, sonar, sonarServo, imu}
 *   track     shape loop | oval | figure8 | line, w, h, tape
 *   box/wall  w, d, h       cylinder  r, h
 *   ramp      profile wedge | bridge | hill, w, d, h
 *   arm       bind {base, shoulder, elbow, gripper}
 * This implementation is the fork's own, written from that description.
 *
 * The kit runs inside the World's page, a sandboxed iframe, so it reaches it
 * as text: the build bundles this directory into one script
 * (vite-plugin-world-kit.ts, `virtual:world-kit`), which the World's runtime
 * script carries (worldKit.ts, worldRuntime.ts). The modules beside this one
 * hold what needs no page (the scene, the geometry, the physics) and can be
 * tested as they are; this one holds the state and the page.
 */
import { DEG, asList, clamp, num, r1, r3, wrap } from './math';
import { BACKLOG, PANEL_WIDTH, STEP } from './presets';
import { type Written, makeObj, normalizeScene, sceneJson } from './scene';
import { toWorld } from './geometry';
import { pick, rayCast, settle } from './world';
import { stepRobot } from './physics';
import { buildRaster, newRaster, reflectance } from './raster';
import { make2d } from './view2d';
import { make3d } from './view3d';
import type { FloorAt, ScreenAt, View, ViewHost } from './view';
import type { Frame, FrameParts, Info, Obj, PartInfo, PartInput, Robot, Screen, Send, Velxio, World } from './types';

/** Where three.js is loaded from; the real address replaces this when the
 *  bundle is embedded (worldKit.ts). */
const THREE_URL = '__THREE_URL__';

const STYLE =
  'html,body{margin:0;height:100%;overflow:hidden;font:12px system-ui,sans-serif}' +
  '#vk-root{position:fixed;inset:0}#vk-root canvas{display:block;width:100%;height:100%;touch-action:none}' +
  '.vk-bar{position:fixed;top:8px;left:8px;display:flex;gap:4px;z-index:3}' +
  '.vk-bar button{font:12px system-ui;padding:3px 9px;border-radius:4px;border:1px solid rgba(128,128,128,.5);background:rgba(30,32,36,.75);color:#eee;cursor:pointer}' +
  '.vk-bar button.on{background:#2f6fd6;border-color:#2f6fd6}' +
  '.vk-hud{position:fixed;left:8px;bottom:8px;padding:6px 8px;border-radius:5px;background:rgba(20,22,26,.72);color:#e8e8e8;white-space:pre;font:11px ui-monospace,monospace;z-index:3;pointer-events:none}' +
  '.vk-warn{position:fixed;right:8px;top:8px;max-width:46%;padding:6px 8px;border-radius:5px;background:rgba(160,60,20,.85);color:#fff;z-index:3;display:none;white-space:pre-wrap}' +
  '.vk-hint{position:fixed;right:8px;bottom:8px;color:rgba(160,160,160,.9);z-index:3;pointer-events:none}';

/** One line per robot: what the HUD and the telemetry show. */
export function robotSummary(o: Robot): string {
  let s = Math.round(o.v * 100) + ' cm/s';
  if (o.line.length) s += '  line ' + o.line.map((v) => (v < 0.5 ? '#' : '.')).join('');
  if (o.sonarCm !== null) s += '  sonar ' + o.sonarCm + ' cm';
  if (o.bumped) s += '  BUMP';
  return s;
}

/** The input of a part a line sensor's reading goes to: `reflectance`, else its first. */
function lineKey(p: PartInfo | undefined): PartInput | null {
  const ins = (p && p.inputs) || [];
  for (const i of ins) if (i.key === 'reflectance') return i;
  return ins[0] || null;
}

export function makeKit(velxio: Velxio, send: Send) {
  /** The scene as written (start places) and its runtime objects. */
  const world: World = { scene: normalizeScene(null).scene, objs: [] };
  let byId: Record<string, Obj> = {};
  let info: Info = { parts: [], boards: [], theme: 'dark' };
  let partsById: Record<string, PartInfo> = {};
  let warnings: string[] = [];
  let view: View | null = null; // the active renderer
  let root: HTMLElement;
  let hud: HTMLElement;
  let bar: HTMLElement;
  let warnBox: HTMLElement | null = null;
  let running = false;
  let simT = 0;
  let acc = 0;
  let lastFrameParts: FrameParts = {};
  let visible = true;
  let started = false;
  const raster = newRaster();

  // ── scene ────────────────────────────────────────────────────────────────
  // What the page wrote, so a save keeps its JSON as it was apart from the edit.
  let written: Written = { floorColor: false, rot: {} };
  // The scene block as this page loaded it, then as last saved: the host
  // writes an edit only over that text, so one made with the mouse cannot
  // undo what was typed into the page since this Run.
  let sceneBase: string | null = null;
  // The block did not parse: the scene on show is not the page's, never save it.
  let sceneBroken = false;
  // three.js did not load: the 2D view stands in, the scene still says 3D.
  let noThree = false;
  let viewLoad = 0;

  function rebuild(): void {
    world.objs = [];
    byId = {};
    world.scene.objects.forEach((o) => {
      const r = makeObj(o, warn);
      if (r) {
        world.objs.push(r);
        byId[r.id] = r;
      }
    });
    buildRaster(raster, world);
    world.objs.forEach((o) => {
      if (o.type === 'robot') settle(world, o);
    });
  }

  function resetWorld(): void {
    acc = 0;
    world.objs.forEach((o) => {
      o.x = o.src.x;
      o.y = o.src.y;
      o.rot = o.src.rot;
      if (o.type === 'robot') {
        o.vl = o.vr = o.v = o.w = o.accel = 0;
        o.bumped = false;
        o.lastSonarT = -1;
        o.lastImuT = -1;
        settle(world, o);
      }
    });
    lastWritten = {};
    if (view) view.dirty();
  }

  // ── parts ────────────────────────────────────────────────────────────────
  function warn(text: string): void {
    if (warnings.indexOf(text) >= 0) return;
    warnings.push(text);
    try {
      console.warn('velxio.kit: ' + text);
    } catch {
      /* no console */
    }
    if (warnBox) showWarnings();
  }

  function checkBinds(): void {
    world.objs.forEach((o) => {
      const need = (id: string | undefined, what: string, test?: (p: PartInfo) => boolean): void => {
        if (!id) return;
        const p = partsById[id];
        if (!p) warn(o.id + ': ' + what + ' "' + id + '" is not on the canvas');
        else if (test && !test(p)) warn(o.id + ': "' + id + '" (' + p.type + ') is not a ' + what);
      };
      const hasOut = (k: string) => (p: PartInfo) => (p.outputs || []).indexOf(k) >= 0;
      const hasIn = (p: PartInfo): boolean => (p.inputs || []).length > 0;
      if (o.type === 'robot') {
        asList(o.bind.left).concat(asList(o.bind.right)).forEach((id) => need(id, 'motor', hasOut('drive')));
        if (!asList(o.bind.left).length || !asList(o.bind.right).length) warn(o.id + ': bind.left and bind.right need a motor each');
        asList(o.bind.line).forEach((id) => need(id, 'line sensor', hasIn));
        need(o.bind.sonar, 'distance sensor', hasIn);
        need(o.bind.sonarServo, 'servo', hasOut('angle'));
        need(o.bind.imu, 'IMU', hasIn);
        if (o.bind.display && !screenOf(o.bind.display)) warn(o.id + ': display "' + o.bind.display + '" is not a board or a part with a screen');
      } else if (o.type === 'arm') {
        (['base', 'shoulder', 'elbow', 'gripper'] as const).forEach((k) => need(o.bind[k], k + ' servo', hasOut('angle')));
      }
    });
  }

  // ── screens a robot carries (bind.display) ────────────────────────────────
  const screens: Record<string, Screen> = {};
  function screenOf(id: string | null): Screen | null {
    if (!id) return null;
    let d = null;
    let kind: string | null = null;
    for (const b of info.boards || []) {
      if (b.id === id) {
        d = b.display;
        kind = b.kind;
      }
    }
    if (!d && partsById[id]) {
      d = partsById[id].display;
      kind = partsById[id].type;
    }
    if (!d) return null;
    let sc = screens[id];
    if (!sc) {
      const width = (kind && PANEL_WIDTH[kind]) || 0.06;
      sc = screens[id] = {
        canvas: velxio.display(id, { fps: 15 }),
        w: d.w,
        h: d.h,
        touch: !!d.touch,
        width,
        height: (width * d.h) / d.w,
        version: 0,
      };
      const made = sc;
      velxio.on('display:' + id, () => {
        made.version++;
        if (view) view.dirty();
      });
    }
    return sc;
  }
  /** Touch a screen at (u, v), 0..1 from its top left; pressed false lifts the finger. */
  function touchScreen(id: string, u: number, v: number, pressed: boolean): void {
    const sc = screens[id];
    if (!sc || !sc.touch) return;
    velxio.touch(id, Math.round(clamp(u, 0, 1) * (sc.w - 1)), Math.round(clamp(v, 0, 1) * (sc.h - 1)), pressed);
  }

  // Only changed values reach the circuit.
  let lastWritten: Record<string, unknown> = {};
  function write(id: string, values: Record<string, unknown>): void {
    const p = partsById[id];
    if (!p) return;
    const keys = (p.inputs || []).map((i) => i.key);
    const out: Record<string, unknown> = {};
    let any = false;
    for (const k in values) {
      if (keys.indexOf(k) < 0) continue;
      const key = id + '.' + k;
      if (lastWritten[key] === values[k]) continue;
      lastWritten[key] = values[k];
      out[k] = values[k];
      any = true;
    }
    if (any) velxio.set(id, out);
  }

  // ── sensors ──────────────────────────────────────────────────────────────
  function sense(rb: Robot): void {
    const ids = asList(rb.bind.line);
    const n = ids.length;
    if (n) {
      rb.line = ids.map((id, i) => {
        const ly = ((n - 1) / 2 - i) * rb.lineSpacing; // left to right across the front
        const p = toWorld(rb, rb.p.ahead, ly);
        const refl = reflectance(raster, world, p[0], p[1]);
        const inp = lineKey(partsById[id]);
        if (inp) {
          const val = inp.kind === 'bool' ? (refl < 0.5 ? 1 : 0) : Math.round(inp.min + (inp.max - inp.min) * refl);
          write(id, { [inp.key]: val });
        }
        return refl;
      });
    }
    if (rb.bind.sonarServo) {
      const sv = lastFrameParts[rb.bind.sonarServo];
      rb.sonarAngle = sv ? num(sv.angle, 90) - 90 : 0;
    }
    if (rb.bind.sonar && (rb.lastSonarT < 0 || simT - rb.lastSonarT >= 0.03)) {
      rb.lastSonarT = simT;
      const nose = toWorld(rb, rb.p.L / 2, 0);
      let best = 4;
      [-7, 0, 7].forEach((da) => {
        best = Math.min(best, rayCast(world, nose[0], nose[1], rb.rot + rb.sonarAngle + da, rb, rb.z + 0.04));
      });
      const cm = clamp(Math.round(best * 100), 2, 400);
      rb.sonarCm = cm;
      write(rb.bind.sonar, { distance: cm });
    }
    if (rb.bind.imu && (rb.lastImuT < 0 || simT - rb.lastImuT >= 0.02)) {
      rb.lastImuT = simT;
      const g = 9.81;
      write(rb.bind.imu, {
        accelX: Math.round((rb.accel / g + Math.sin(rb.pitch * DEG)) * 100) / 100,
        accelY: Math.round(-Math.sin(rb.roll * DEG) * 100) / 100,
        accelZ: Math.round(Math.cos(rb.pitch * DEG) * Math.cos(rb.roll * DEG) * 100) / 100,
        gyroX: 0,
        gyroY: 0,
        gyroZ: Math.round(rb.w / DEG),
      });
    }
  }

  function onFrame(f: Frame): void {
    lastFrameParts = f.parts || {};
    const wasRunning = running;
    running = !!f.running;
    world.objs.forEach((o) => {
      if (o.type !== 'arm') return;
      (['base', 'shoulder', 'elbow', 'gripper'] as const).forEach((k) => {
        const id = o.bind[k];
        const q = id ? lastFrameParts[id] : undefined;
        if (q && q.angle !== undefined) o.angles[k] = num(q.angle, 90);
      });
    });
    if (!running) {
      if (wasRunning) {
        updateHud();
        if (view) view.dirty();
      }
      return;
    }
    const dt = num(f.dt, 0);
    if (dt > 0) {
      acc = Math.min(acc + dt, BACKLOG);
      while (acc >= STEP) {
        for (const o of world.objs) if (o.type === 'robot' && o !== dragging) stepRobot(world, o, STEP, lastFrameParts);
        acc -= STEP;
        simT += STEP;
      }
    }
    world.objs.forEach((o) => {
      if (o.type === 'robot') sense(o);
    });
    if (view) view.dirty();
    telemetryTick();
  }

  let lastTele = 0;
  function telemetryTick(): void {
    if (simT - lastTele < 0.2) return;
    lastTele = simT;
    const t: Record<string, string> = {};
    world.objs.forEach((o) => {
      if (o.type === 'robot') t[o.id] = robotSummary(o);
    });
    velxio.telemetry(t);
    updateHud();
  }

  // ── editing ──────────────────────────────────────────────────────────────
  let dragging: Obj | null = null;
  let selected: Obj | null = null;
  let dragStart = { x: 0, y: 0, ox: 0, oy: 0, orot: 0, rotate: false, moved: false };
  function beginDrag(o: Obj, x: number, y: number, rotate: boolean): void {
    dragging = o;
    selected = o;
    dragStart = { x, y, ox: o.x, oy: o.y, orot: o.rot, rotate, moved: false };
  }
  function moveDrag(x: number, y: number, dxPixels: number): void {
    if (!dragging) return;
    const o = dragging;
    const s = dragStart;
    if (s.rotate) o.rot = wrap(s.orot - dxPixels * 0.5);
    else {
      o.x = s.ox + (x - s.x);
      o.y = s.oy + (y - s.y);
    }
    s.moved = true;
    if (o.type === 'robot') settle(world, o);
    if (o.type === 'track') buildRaster(raster, world);
    if (view) view.dirty();
  }
  function endDrag(): void {
    if (!dragging) return;
    const o = dragging;
    const moved = dragStart.moved;
    dragging = null;
    if (!moved) return;
    o.x = r3(o.x);
    o.y = r3(o.y);
    o.rot = r1(wrap(o.rot));
    o.src.x = o.x;
    o.src.y = o.y;
    o.src.rot = o.rot;
    if (o.type === 'robot') {
      o.vl = o.vr = o.v = 0;
      settle(world, o);
    }
    if (o.type === 'track' || o.type === 'ramp' || o.type === 'box' || o.type === 'wall') buildRaster(raster, world);
    save();
  }
  function rotateSelected(deg: number): void {
    if (!selected) return;
    const o = selected;
    // A robot that has driven is not at its start heading: turn both by the
    // step, or its heading now would be saved as the one it starts with.
    o.src.rot = r1(wrap(o.src.rot + deg));
    o.rot = r1(wrap(o.rot + deg));
    if (o.type === 'robot') settle(world, o);
    if (o.type === 'track') buildRaster(raster, world);
    if (view) view.dirty();
    save();
  }
  function save(): void {
    if (sceneBroken) return;
    const json = sceneJson(world.scene, written);
    send('kit/scene', { json, base: sceneBase });
    if (sceneBase !== null) sceneBase = json;
  }

  // ── page ─────────────────────────────────────────────────────────────────
  function buildPage(): void {
    const st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);
    const div = (className: string): HTMLElement => {
      const el = document.createElement('div');
      el.className = className;
      document.body.appendChild(el);
      return el;
    };
    root = div('');
    root.id = 'vk-root';
    bar = div('vk-bar');
    hud = div('vk-hud');
    warnBox = div('vk-warn');
    div('vk-hint').textContent = 'drag: move  ·  shift+drag or Q/E: turn  ·  empty space: orbit/pan  ·  wheel: zoom';
    const button = (text: string, onclick: () => void): HTMLButtonElement => {
      const el = document.createElement('button');
      el.textContent = text;
      el.onclick = onclick;
      bar.appendChild(el);
      return el;
    };
    ([['3D', '3d'], ['2D', '2d']] as const).forEach(([text, kind]) => {
      button(text, () => {
        const shown = noThree ? '2d' : world.scene.view;
        noThree = false; // asking for 3D again tries three.js again
        if (world.scene.view !== kind) {
          world.scene.view = kind;
          save();
        }
        if (shown !== kind) openView();
      }).dataset.view = kind;
    });
    button('Reset', resetWorld);
    const fl = button('Follow', () => {
      if (world.scene.follow) delete world.scene.follow;
      else {
        const rb = world.objs.filter((o): o is Robot => o.type === 'robot');
        const withScreen = rb.filter((o) => o.displayId);
        if (rb.length) world.scene.follow = (withScreen[0] || rb[0]).id;
      }
      followChanged();
      save();
    });
    fl.dataset.follow = '1';
    fl.title = 'Follow a robot from close behind (the one with a screen first)';
    window.addEventListener('keydown', (e) => {
      if (e.key === 'q' || e.key === 'Q') rotateSelected(15);
      else if (e.key === 'e' || e.key === 'E') rotateSelected(-15);
      else if (e.key === 'Escape') {
        selected = null;
        if (view) view.dirty();
      }
    });
    showWarnings();
  }
  /** The robot the camera follows, or null. */
  function followed(): Robot | null {
    const o = world.scene.follow ? byId[world.scene.follow] : undefined;
    return o && o.type === 'robot' ? o : null;
  }
  function followChanged(): void {
    const b = bar && bar.querySelector('button[data-follow]');
    if (b) b.className = followed() ? 'on' : '';
    if (view) {
      view.follow(followed());
      view.dirty();
    }
  }
  function showWarnings(): void {
    if (!warnBox) return;
    warnBox.style.display = warnings.length ? 'block' : 'none';
    warnBox.textContent = warnings.join('\n');
  }
  function updateHud(): void {
    const lines: string[] = [];
    world.objs.forEach((o) => {
      if (o.type === 'robot') lines.push(o.id + '  ' + robotSummary(o));
    });
    if (!running) lines.push('(stopped: press Run)');
    hud.textContent = lines.join('\n');
  }
  function theme(): { bg: string; fg: string } {
    return info.theme === 'light' ? { bg: '#dfe4ea', fg: '#222' } : { bg: '#15171a', fg: '#ddd' };
  }

  function openView(): void {
    if (view) {
      view.destroy();
      view = null;
    }
    const kind = noThree ? '2d' : world.scene.view;
    const load = ++viewLoad;
    bar.querySelectorAll<HTMLElement>('button[data-view]').forEach((b) => {
      b.className = b.dataset.view === kind ? 'on' : '';
    });
    if (kind === '3d') {
      import(/* @vite-ignore */ THREE_URL).then(
        (THREE) => {
          if (load !== viewLoad) return; // another view was asked for meanwhile
          view = make3d(THREE, host);
          followChanged();
        },
        (e: unknown) => {
          if (load !== viewLoad) return;
          warn('three.js did not load (' + (e instanceof Error ? e.message : String(e)) + '): showing the 2D view');
          noThree = true; // not written into the scene: a save must not make it 2D for good
          openView();
        },
      );
    } else {
      view = make2d(host);
      followChanged();
    }
  }

  // Pointer handling shared by both views.
  function bindPointer(
    canvas: HTMLElement,
    floorAt: FloorAt,
    onEmptyDrag: (dx: number, dy: number, pan: boolean) => void,
    onWheel: (deltaY: number) => void,
    screenAt: ScreenAt,
  ): void {
    let down: { screen: string | null; x: number; y: number; obj: Obj | null; button: number; last: [number, number] } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const hit = e.button === 0 && !e.shiftKey ? screenAt(e.clientX, e.clientY) : null;
      if (hit && screens[hit.id] && screens[hit.id].touch) {
        down = { screen: hit.id, x: e.clientX, y: e.clientY, obj: null, button: e.button, last: [e.clientX, e.clientY] };
        touchScreen(hit.id, hit.u, hit.v, true);
        return;
      }
      const p = floorAt(e.clientX, e.clientY);
      const o = p && e.button === 0 ? (p.length > 2 && p[2]) || pick(world, p[0], p[1]) : null;
      down = { screen: null, x: e.clientX, y: e.clientY, obj: o, button: e.button, last: [e.clientX, e.clientY] };
      if (o && p) beginDrag(o, p[0], p[1], e.shiftKey);
      else {
        selected = null;
        if (view) view.dirty();
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (down.screen) {
        const h = screenAt(e.clientX, e.clientY);
        if (h && h.id === down.screen) touchScreen(h.id, h.u, h.v, true);
        return;
      }
      const dx = e.clientX - down.last[0];
      const dy = e.clientY - down.last[1];
      down.last = [e.clientX, e.clientY];
      if (down.obj) {
        const p = floorAt(e.clientX, e.clientY);
        if (p) moveDrag(p[0], p[1], e.clientX - down.x);
      } else onEmptyDrag(dx, dy, down.button !== 0 || e.ctrlKey || e.metaKey);
    });
    const up = (): void => {
      if (down && down.screen) touchScreen(down.screen, 0, 0, false);
      else if (down && down.obj) endDrag();
      down = null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        onWheel(e.deltaY);
      },
      { passive: false },
    );
  }

  /** What a view sees of the kit. */
  const host: ViewHost = {
    world,
    raster,
    get byId() {
      return byId;
    },
    get root() {
      return root;
    },
    get selected() {
      return selected;
    },
    get dragging() {
      return dragging;
    },
    get visible() {
      return visible;
    },
    get running() {
      return running;
    },
    followed,
    theme,
    screenOf,
    bindPointer,
  };

  // ── start ────────────────────────────────────────────────────────────────
  function setInfo(inf: Info | null | undefined): void {
    info = inf || info;
    partsById = {};
    (info.parts || []).forEach((p) => {
      partsById[p.id] = p;
    });
    warnings = warnings.filter((w) => w.indexOf(' is not on the canvas') < 0 && w.indexOf(') is not a ') < 0);
    checkBinds();
    showWarnings();
  }

  function start(opts?: { scene?: unknown }) {
    if (started) return api;
    started = true;
    let s = opts ? opts.scene : undefined;
    if (!s) {
      const el = document.getElementById('velxio-scene');
      if (!el) warn('no <script type="application/json" id="velxio-scene"> in the page');
      else {
        sceneBase = el.textContent || '';
        try {
          s = JSON.parse(sceneBase || '{}');
        } catch (e) {
          sceneBroken = true;
          warn('the velxio-scene JSON does not parse: ' + (e instanceof Error ? e.message : String(e)) + '\nEdits made here are not saved until it does.');
        }
      }
    }
    const normal = normalizeScene(s);
    world.scene = normal.scene;
    written = normal.written;
    const go = (): void => {
      buildPage();
      rebuild();
      velxio.ready().then((inf) => {
        setInfo(inf);
        openView();
        updateHud();
      });
      velxio.on('parts', setInfo);
      velxio.on('reset', resetWorld);
      velxio.on('kit/stale', () => {
        warn('The scene in the page was edited after this Run: edits made here with the mouse are not saved. Run again to pick it up.');
      });
      velxio.on('theme', (t: string) => {
        info.theme = t;
        if (view) view.dirty();
      });
      velxio.on('visibility', (v: unknown) => {
        visible = !!v;
        if (visible && view) view.dirty();
      });
      velxio.onFrame(onFrame);
    };
    if (document.body) go();
    else document.addEventListener('DOMContentLoaded', go);
    return api;
  }

  const api = {
    start,
    reset(): void {
      resetWorld();
    },
    /** The scene as written, a copy; null before start(). */
    get scene() {
      return started ? (JSON.parse(JSON.stringify(world.scene)) as World['scene']) : null;
    },
    /** Live places, speeds and readings. */
    get objects() {
      return world.objs.map((o) => {
        const r: Record<string, unknown> = { id: o.id, type: o.type, x: o.x, y: o.y, rot: o.rot };
        if (o.type === 'robot') {
          r.z = o.z;
          r.speed = o.v;
          r.line = o.line.slice();
          r.sonar = o.sonarCm;
          r.bumped = o.bumped;
        }
        return r;
      });
    },
    /** For tests: the floor seen by a line sensor at (x, y), 0..1. */
    reflectance(x: number, y: number): number {
      return reflectance(raster, world, x, y);
    },
  };
  return api;
}
