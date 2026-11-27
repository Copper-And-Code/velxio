/** The plan view: the floor's picture and every object seen from above. */
import { DEG, asList, clamp, cosd, sind, type Pt } from './math';
import { armPose, toLocal, toWorld } from './geometry';
import type { Arm, Obj, Robot } from './types';
import type { FloorHit, ScreenHit, View, ViewHost } from './view';

export function make2d(host: ViewHost): View {
  const root = host.root;
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  root.appendChild(cv);
  const cam = { x: 0, y: 0, s: 1, base: 1 };
  let need = true;
  let raf = 0;
  let alive = true;

  function fit(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = root.clientWidth;
    const h = root.clientHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const f = host.world.scene.floor;
    cam.base = Math.min(w / (f.w + 0.3), h / (f.h + 0.3));
    need = true;
  }
  const scale = (): number => cam.base * cam.s;
  // Not while its robot is dragged: the drag is measured on the floor under
  // the pointer, and a camera that follows would add the offset every frame.
  function track(): void {
    const o = host.followed();
    if (o && o !== host.dragging) {
      cam.x = o.x;
      cam.y = o.y;
    }
  }
  const sx = (x: number): number => root.clientWidth / 2 + (x - cam.x) * scale();
  const sy = (y: number): number => root.clientHeight / 2 - (y - cam.y) * scale();
  function floorAt(cx: number, cy: number): FloorHit {
    const r = cv.getBoundingClientRect();
    return [(cx - r.left - root.clientWidth / 2) / scale() + cam.x, -(cy - r.top - root.clientHeight / 2) / scale() + cam.y];
  }
  function poly(o: Obj, pts: Pt[]): void {
    g.beginPath();
    pts.forEach((p, i) => {
      const w = toWorld(o, p[0], p[1]);
      if (i) g.lineTo(sx(w[0]), sy(w[1]));
      else g.moveTo(sx(w[0]), sy(w[1]));
    });
    g.closePath();
  }
  const rect = (o: Obj, hx: number, hy: number): void => poly(o, [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]);
  /** Where a robot's screen sits on it, in its own frame. */
  function screen2d(o: Robot) {
    const sc = host.screenOf(o.displayId);
    return sc ? { sc, cx: -o.p.L * 0.1 } : null;
  }

  function draw(): void {
    raf = 0;
    if (!alive) return;
    if (!need || !host.visible) return;
    need = false;
    track();
    const dpr = window.devicePixelRatio || 1;
    const th = host.theme();
    const f = host.world.scene.floor;
    const k = scale();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.bg;
    g.fillRect(0, 0, root.clientWidth, root.clientHeight);
    g.imageSmoothingEnabled = true;
    if (host.raster.canvas) g.drawImage(host.raster.canvas, sx(-f.w / 2), sy(f.h / 2), f.w * k, f.h * k);
    host.world.objs.forEach((o) => {
      g.lineWidth = 1;
      if (o.type === 'ramp') {
        rect(o, o.w / 2, o.d / 2);
        g.fillStyle = o.color || '#c8b48a';
        g.globalAlpha = 0.85;
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = 'rgba(0,0,0,.4)';
        g.stroke();
        const a0 = toWorld(o, -o.w / 2 + 0.02, 0);
        const a1 = toWorld(o, o.w / 2 - 0.02, 0);
        g.beginPath();
        g.moveTo(sx(a0[0]), sy(a0[1]));
        g.lineTo(sx(a1[0]), sy(a1[1]));
        g.stroke();
      } else if (o.type === 'box' || o.type === 'wall') {
        rect(o, o.w / 2, o.d / 2);
        g.fillStyle = o.color || (o.type === 'wall' ? '#8a8f98' : '#b0723a');
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,.5)';
        g.stroke();
      } else if (o.type === 'cylinder') {
        g.beginPath();
        g.arc(sx(o.x), sy(o.y), o.r * k, 0, 2 * Math.PI);
        g.fillStyle = o.color || '#6a8fb0';
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,.5)';
        g.stroke();
      } else if (o.type === 'arm') drawArm(o, k);
      else if (o.type === 'robot') drawRobot(o, k);
      if (o === host.selected) {
        g.strokeStyle = '#ffb020';
        g.lineWidth = 2;
        if (o.type === 'cylinder') {
          g.beginPath();
          g.arc(sx(o.x), sy(o.y), o.r * k + 3, 0, 2 * Math.PI);
          g.stroke();
        } else if (o.type === 'track') {
          rect(o, o.w / 2, o.h / 2);
          g.stroke();
        } else if (o.type === 'robot') {
          rect(o, o.p.L / 2 + 0.006, o.p.W / 2 + 0.006);
          g.stroke();
        } else if (o.type === 'arm') {
          g.beginPath();
          g.arc(sx(o.x), sy(o.y), 0.07 * k, 0, 2 * Math.PI);
          g.stroke();
        } else {
          rect(o, o.w / 2 + 0.005, o.d / 2 + 0.005);
          g.stroke();
        }
      }
      if (o.label) {
        g.fillStyle = th.fg;
        g.font = '11px system-ui';
        g.textAlign = 'center';
        g.fillText(o.label, sx(o.x), sy(o.y) - 6 - (o.type === 'robot' ? (o.p.W * k) / 2 : 0));
      }
    });
  }

  function drawRobot(o: Robot, k: number): void {
    const p = o.p;
    g.fillStyle = '#222';
    if (o.preset === 'tank') {
      rect(o, p.L / 2, p.W / 2);
      g.fill();
    } else {
      const ws: Pt[] = p.wheels === 4 ? [[p.L * 0.3, 1], [p.L * 0.3, -1], [-p.L * 0.3, 1], [-p.L * 0.3, -1]] : [[0, 1], [0, -1]];
      ws.forEach((w) => {
        const y = (w[1] * p.track) / 2;
        poly(o, [[w[0] - p.r, y - 0.011], [w[0] + p.r, y - 0.011], [w[0] + p.r, y + 0.011], [w[0] - p.r, y + 0.011]]);
        g.fill();
      });
    }
    const bodyW = o.preset === 'tank' ? p.W * 0.72 : p.W;
    rect(o, p.L / 2, bodyW / 2);
    g.fillStyle = o.color || p.color;
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.stroke();
    // nose
    poly(o, [[p.L / 2 - 0.004, 0], [p.L / 2 - 0.03, 0.018], [p.L / 2 - 0.03, -0.018]]);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fill();
    const ids = asList(o.bind.line);
    const n = ids.length;
    ids.forEach((_id, i) => {
      const w = toWorld(o, p.ahead, ((n - 1) / 2 - i) * o.lineSpacing);
      g.beginPath();
      g.arc(sx(w[0]), sy(w[1]), Math.max(2, 0.004 * k), 0, 2 * Math.PI);
      g.fillStyle = o.line[i] !== undefined && o.line[i] < 0.5 ? '#ff3b30' : '#7cfc00';
      g.fill();
    });
    const s2 = o.displayId ? screen2d(o) : null;
    if (s2) {
      const c = toWorld(o, s2.cx, 0);
      g.save();
      g.translate(sx(c[0]), sy(c[1]));
      g.rotate(-(o.rot - 90) * DEG);
      const sw = s2.sc.width * k;
      const sh = s2.sc.height * k;
      g.fillStyle = '#111';
      g.fillRect(-sw / 2 - 3, -sh / 2 - 3, sw + 6, sh + 6);
      g.drawImage(s2.sc.canvas, -sw / 2, -sh / 2, sw, sh);
      g.restore();
    }
    if (o.bind.sonar && o.sonarCm !== null) {
      const nose = toWorld(o, p.L / 2, 0);
      const a = o.rot + o.sonarAngle;
      const d = o.sonarCm / 100;
      g.strokeStyle = 'rgba(0,200,255,.6)';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(sx(nose[0]), sy(nose[1]));
      g.lineTo(sx(nose[0] + cosd(a) * d), sy(nose[1] + sind(a) * d));
      g.stroke();
      g.setLineDash([]);
    }
  }

  function drawArm(o: Arm, k: number): void {
    const A = armPose(o);
    g.beginPath();
    g.arc(sx(o.x), sy(o.y), 0.05 * k, 0, 2 * Math.PI);
    g.fillStyle = o.color || '#444c56';
    g.fill();
    g.strokeStyle = '#f2c230';
    g.lineWidth = Math.max(3, 0.018 * k);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(sx(A.base[0]), sy(A.base[1]));
    g.lineTo(sx(A.elbow[0]), sy(A.elbow[1]));
    g.lineTo(sx(A.wrist[0]), sy(A.wrist[1]));
    g.stroke();
    g.lineWidth = 1;
    g.lineCap = 'butt';
    g.beginPath();
    g.arc(sx(A.wrist[0]), sy(A.wrist[1]), Math.max(3, (0.01 + 0.012 * A.open) * k), 0, 2 * Math.PI);
    g.strokeStyle = '#ddd';
    g.stroke();
  }

  function frame(): void {
    if (!raf && alive) raf = requestAnimationFrame(draw);
  }
  function screenAt(cx: number, cy: number): ScreenHit | null {
    const w = floorAt(cx, cy);
    const objs = host.world.objs;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      const s2 = o.type === 'robot' && o.displayId ? screen2d(o) : null;
      if (!s2 || o.type !== 'robot' || !o.displayId) continue;
      const l = toLocal(o, w[0], w[1]);
      // image x runs to the robot's right (-y), image y from its nose (+x) back
      const u = 0.5 - l[1] / s2.sc.width;
      const v = 0.5 - (l[0] - s2.cx) / s2.sc.height;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return { id: o.displayId, u, v };
    }
    return null;
  }

  host.bindPointer(
    cv,
    floorAt,
    (dx, dy) => {
      cam.x -= dx / scale();
      cam.y += dy / scale();
      need = true;
      frame();
    },
    (d) => {
      cam.s = clamp(cam.s * (d > 0 ? 0.9 : 1.1), 0.3, 8);
      need = true;
      frame();
    },
    screenAt,
  );
  const onResize = (): void => {
    fit();
    frame();
  };
  window.addEventListener('resize', onResize);
  fit();
  frame();
  return {
    dirty() {
      need = true;
      frame();
    },
    follow(o) {
      if (o) cam.s = Math.max(cam.s, 3);
      else {
        cam.s = 1;
        cam.x = cam.y = 0;
      }
      need = true;
      frame();
    },
    destroy() {
      alive = false;
      window.removeEventListener('resize', onResize);
      cv.remove();
    },
  };
}
