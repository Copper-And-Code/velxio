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
 * WORLD_KIT_JS runs inside the World's runtime script (worldRuntime.ts):
 * it defines makeKit(velxio, send), plain ES2017, no template literals.
 */
const KIT_SOURCE = String.raw`
function makeKit(velxio, send) {
  'use strict';
  var DEG = Math.PI / 180;
  var THREE_URL = '__THREE_URL__';
  var STEP = 0.002, BACKLOG = 0.25, LAG = 0.08, DEADBAND = 0.05;

  // ── presets ─────────────────────────────────────────────────────────────
  // L x W body (m), wheel radius, track width between wheel centres, climb
  // (the highest step it drives onto), grade (the steepest ramp, rise/run),
  // line sensors this far ahead of the centre, skid factor on turns.
  var PRESETS = {
    'diff2':        { L: 0.150, W: 0.105, r: 0.033, track: 0.125, climb: 0.010, grade: 0.30, ahead: 0.065, skid: 1.0, wheels: 2, color: '#2f6fd6' },
    'diff4':        { L: 0.200, W: 0.115, r: 0.033, track: 0.140, climb: 0.015, grade: 0.36, ahead: 0.090, skid: 1.35, wheels: 4, color: '#d64f2f' },
    'tank':         { L: 0.225, W: 0.220, r: 0.030, track: 0.190, climb: 0.030, grade: 0.58, ahead: 0.100, skid: 1.6, wheels: 0, color: '#4f7a3a' },
    'maqueen-lite': { L: 0.085, W: 0.081, r: 0.021, track: 0.070, climb: 0.006, grade: 0.25, ahead: 0.035, skid: 1.0, wheels: 2, color: '#1aa0c8' }
  };

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function wrap(a) { a = a % 360; if (a > 180) a -= 360; if (a <= -180) a += 360; return a; }
  function cosd(a) { return Math.cos(a * DEG); }
  function sind(a) { return Math.sin(a * DEG); }

  var scene = null;        // the scene as written (start places)
  var objs = [];           // runtime objects
  var byId = {};
  var info = { parts: [], boards: [], theme: 'dark' };
  var partsById = {};
  var warnings = [];
  var view = null;         // the active renderer
  var root, hud, bar, warnBox;
  var running = false, simT = 0, acc = 0;
  var lastFrameParts = {};
  var visible = true;
  var started = false;

  // ── scene ────────────────────────────────────────────────────────────────
  // What the page wrote, so a save keeps its JSON as it was apart from the edit.
  var written = { floorColor: false, rot: {} };
  function normalize(s) {
    s = s && typeof s === 'object' ? s : {};
    var f = s.floor || {};
    written.floorColor = typeof f.color === 'string';
    var out = {
      version: 1,
      view: s.view === '2d' ? '2d' : '3d',
      follow: typeof s.follow === 'string' ? s.follow : undefined,
      floor: { w: Math.max(0.2, num(f.w, 2.4)), h: Math.max(0.2, num(f.h, 1.6)), grid: f.grid !== false, color: typeof f.color === 'string' ? f.color : '#f2efe8' },
      objects: []
    };
    var seen = {};
    (Array.isArray(s.objects) ? s.objects : []).forEach(function (o, i) {
      if (!o || typeof o !== 'object') return;
      var id = String(o.id || (o.type || 'object') + (i + 1));
      while (seen[id]) id += '_';
      seen[id] = 1;
      var c = JSON.parse(JSON.stringify(o));
      c.id = id;
      written.rot[id] = o.rot !== undefined;
      c.x = num(o.x, 0); c.y = num(o.y, 0); c.rot = num(o.rot, 0);
      out.objects.push(c);
    });
    return out;
  }

  function makeObj(o) {
    var t = o.type;
    var r = { id: o.id, type: t, src: o, x: o.x, y: o.y, rot: o.rot, color: o.color, label: o.label };
    if (t === 'robot') {
      var key = PRESETS[o.preset] ? o.preset : 'diff2';
      if (!PRESETS[o.preset]) warn('robot "' + o.id + '": unknown preset "' + o.preset + '", using diff2');
      r.preset = key; r.p = PRESETS[key];
      r.bind = o.bind || {};
      r.z = 0; r.pitch = 0; r.roll = 0;
      r.vl = 0; r.vr = 0; r.v = 0; r.w = 0; r.accel = 0;
      r.line = []; r.sonarCm = null; r.bumped = false;
      r.lastSonarT = -1; r.lastImuT = -1; r.sonarAngle = 0;
      // line sensors this far apart across the front: inside a 2.2 cm tape by default,
      // so a robot centred on it sees black with both
      r.lineSpacing = clamp(num(o.lineSpacing, 0.016), 0.004, 0.08);
      r.displayId = r.bind.display ? String(r.bind.display) : null;
      r.displayTilt = clamp(num(o.displayTilt, 50), 0, 90);
    } else if (t === 'track') {
      r.shape = ['loop', 'oval', 'figure8', 'line'].indexOf(o.shape) >= 0 ? o.shape : 'loop';
      r.w = Math.max(0.05, num(o.w, 1.6)); r.h = Math.max(0.05, num(o.h, 0.9)); r.tape = clamp(num(o.tape, 0.022), 0.003, 0.2);
    } else if (t === 'box' || t === 'wall') {
      r.w = Math.max(0.005, num(o.w, t === 'wall' ? 1.0 : 0.15));
      r.d = Math.max(0.005, num(o.d, t === 'wall' ? 0.02 : 0.15));
      r.h = Math.max(0.002, num(o.h, t === 'wall' ? 0.1 : 0.15));
    } else if (t === 'cylinder') {
      r.r = Math.max(0.005, num(o.r, 0.05)); r.h = Math.max(0.002, num(o.h, 0.12));
    } else if (t === 'ramp') {
      r.profile = ['wedge', 'bridge', 'hill'].indexOf(o.profile) >= 0 ? o.profile : 'wedge';
      r.w = Math.max(0.05, num(o.w, 0.4)); r.d = Math.max(0.05, num(o.d, 0.3)); r.h = Math.max(0.002, num(o.h, 0.03));
    } else if (t === 'arm') {
      r.bind = o.bind || {};
      r.angles = { base: 90, shoulder: 90, elbow: 90, gripper: 90 };
    } else {
      warn('object "' + o.id + '": unknown type "' + t + '"');
      return null;
    }
    return r;
  }

  function rebuild() {
    objs = []; byId = {};
    scene.objects.forEach(function (o) {
      var r = makeObj(o);
      if (r) { objs.push(r); byId[r.id] = r; }
    });
    buildRaster();
    objs.forEach(function (o) { if (o.type === 'robot') settle(o); });
  }

  function resetWorld() {
    acc = 0;
    objs.forEach(function (o) {
      o.x = o.src.x; o.y = o.src.y; o.rot = o.src.rot;
      if (o.type === 'robot') {
        o.vl = o.vr = o.v = o.w = o.accel = 0; o.bumped = false;
        o.lastSonarT = -1; o.lastImuT = -1;
        settle(o);
      }
    });
    lastWritten = {};
    if (view) view.dirty();
  }

  // ── geometry ─────────────────────────────────────────────────────────────
  function toLocal(o, x, y) {
    var c = cosd(o.rot), s = sind(o.rot), dx = x - o.x, dy = y - o.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  function toWorld(o, lx, ly) {
    var c = cosd(o.rot), s = sind(o.rot);
    return [o.x + lx * c - ly * s, o.y + lx * s + ly * c];
  }

  /** The track's centre line in its own frame: [[x, y], ...] and closed. */
  function trackPath(t) {
    var W = Math.max(0.01, t.w - t.tape), H = Math.max(0.01, t.h - t.tape), pts = [], i;
    if (t.shape === 'line') return { pts: [[-W / 2, 0], [W / 2, 0]], closed: false };
    if (t.shape === 'figure8') {
      for (i = 0; i < 240; i++) {
        var a = (i / 240) * 2 * Math.PI;
        pts.push([(W / 2) * Math.sin(a), H * Math.sin(a) * Math.cos(a)]);
      }
      return { pts: pts, closed: true };
    }
    var rad = t.shape === 'oval' ? Math.min(W, H) / 2 : Math.min(W, H) * 0.3;
    var cx = W / 2 - rad, cy = H / 2 - rad;
    var corners = [[cx, cy, 0], [-cx, cy, 90], [-cx, -cy, 180], [cx, -cy, 270]];
    corners.forEach(function (c) {
      for (var k = 0; k <= 16; k++) {
        var ang = (c[2] + (k / 16) * 90) * DEG;
        pts.push([c[0] + rad * Math.cos(ang), c[1] + rad * Math.sin(ang)]);
      }
    });
    return { pts: pts, closed: true };
  }

  /** Solid shapes robots stop against: {o, kind:'box'|'circle', ..., h}. */
  function solids(except) {
    var out = [];
    objs.forEach(function (o) {
      if (o === except) return;
      if (o.type === 'box' || o.type === 'wall') out.push({ o: o, kind: 'box', hx: o.w / 2, hy: o.d / 2, h: o.h });
      else if (o.type === 'cylinder') out.push({ o: o, kind: 'circle', r: o.r, h: o.h });
      else if (o.type === 'robot') out.push({ o: o, kind: 'box', hx: o.p.L / 2, hy: o.p.W / 2, h: 0.06 });
      else if (o.type === 'arm') out.push({ o: o, kind: 'circle', r: 0.055, h: 0.06 });
      else if (o.type === 'ramp') out.push({ o: o, kind: 'box', hx: o.w / 2, hy: o.d / 2, h: o.h, ramp: true });
    });
    return out;
  }

  function rampSlope(o) {
    if (o.profile === 'wedge') return o.h / o.w;
    if (o.profile === 'bridge') return (3 * o.h) / o.w;
    return (Math.PI * o.h) / Math.min(o.w, o.d);
  }
  function rampHeight(o, lx, ly) {
    if (Math.abs(lx) > o.w / 2 || Math.abs(ly) > o.d / 2) return 0;
    var u = (lx + o.w / 2) / o.w;
    if (o.profile === 'wedge') return o.h * u;
    if (o.profile === 'bridge') return o.h * Math.min(1, 3 * u, 3 * (1 - u));
    return o.h * (0.5 + 0.5 * Math.cos((2 * Math.PI * lx) / o.w)) * (0.5 + 0.5 * Math.cos((2 * Math.PI * ly) / o.d));
  }

  /** How high the ground is under (x, y) for robot rb: ramps it can climb, low blocks. */
  function groundAt(rb, x, y) {
    var h = 0;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i], l;
      if (o.type === 'ramp' && (!rb || rampSlope(o) <= gradeOf(rb))) {
        l = toLocal(o, x, y); h = Math.max(h, rampHeight(o, l[0], l[1]));
      } else if ((o.type === 'box' || o.type === 'wall') && rb && o.h <= rb.p.climb) {
        l = toLocal(o, x, y); if (Math.abs(l[0]) <= o.w / 2 && Math.abs(l[1]) <= o.d / 2) h = Math.max(h, o.h);
      } else if (o.type === 'cylinder' && rb && o.h <= rb.p.climb) {
        if (Math.hypot(x - o.x, y - o.y) <= o.r) h = Math.max(h, o.h);
      }
    }
    return h;
  }
  function gradeOf(rb) { return rb.p.grade; }

  // OBB (centre, half extents, rot deg) overlap by separating axes.
  function obbAxes(rot) { var c = cosd(rot), s = sind(rot); return [[c, s], [-s, c]]; }
  function obbOverlap(ax, ay, ahx, ahy, arot, bx, by, bhx, bhy, brot) {
    var A = obbAxes(arot), B = obbAxes(brot), d = [bx - ax, by - ay], axes = A.concat(B);
    for (var i = 0; i < 4; i++) {
      var n = axes[i];
      var ra = ahx * Math.abs(A[0][0] * n[0] + A[0][1] * n[1]) + ahy * Math.abs(A[1][0] * n[0] + A[1][1] * n[1]);
      var rb = bhx * Math.abs(B[0][0] * n[0] + B[0][1] * n[1]) + bhy * Math.abs(B[1][0] * n[0] + B[1][1] * n[1]);
      if (Math.abs(d[0] * n[0] + d[1] * n[1]) > ra + rb) return false;
    }
    return true;
  }
  function circleObb(cx, cy, r, bx, by, hx, hy, rot) {
    var c = cosd(rot), s = sind(rot), dx = cx - bx, dy = cy - by;
    var lx = dx * c + dy * s, ly = -dx * s + dy * c;
    var qx = clamp(lx, -hx, hx), qy = clamp(ly, -hy, hy);
    return (lx - qx) * (lx - qx) + (ly - qy) * (ly - qy) < r * r;
  }

  function collides(rb, x, y, rot) {
    var hx = rb.p.L / 2, hy = rb.p.W / 2, list = solids(rb);
    for (var i = 0; i < list.length; i++) {
      var s = list[i], o = s.o;
      if (s.ramp && rampSlope(o) <= gradeOf(rb)) continue;
      if (!s.ramp && o.type !== 'robot' && o.type !== 'arm' && s.h <= rb.p.climb) continue;
      if (s.kind === 'box') { if (obbOverlap(x, y, hx, hy, rot, o.x, o.y, s.hx, s.hy, o.rot)) return o; }
      else if (circleObb(o.x, o.y, s.r, x, y, hx, hy, rot)) return o;
    }
    var f = scene.floor;
    if (Math.abs(x) > f.w / 2 + 0.6 || Math.abs(y) > f.h / 2 + 0.6) return { id: 'edge' };
    return null;
  }

  /** Distance from (x, y) along heading a (deg) to the first solid, metres (max 4). */
  function rayCast(x, y, a, from, zAt) {
    var dx = cosd(a), dy = sind(a), best = 4, list = solids(from);
    list.forEach(function (s) {
      var o = s.o, t;
      if (zAt !== undefined && s.h < zAt - 0.005) return;     // the beam passes over it
      if (s.kind === 'circle') {
        var ox = x - o.x, oy = y - o.y, b = ox * dx + oy * dy, c = ox * ox + oy * oy - s.r * s.r, disc = b * b - c;
        if (disc < 0) return;
        t = -b - Math.sqrt(disc);
        if (t >= 0 && t < best) best = t;
        return;
      }
      var cs = cosd(o.rot), sn = sind(o.rot), px = x - o.x, py = y - o.y;
      var lx = px * cs + py * sn, ly = -px * sn + py * cs, ldx = dx * cs + dy * sn, ldy = -dx * sn + dy * cs;
      var t0 = -Infinity, t1 = Infinity, ok = true;
      [[lx, ldx, s.hx], [ly, ldy, s.hy]].forEach(function (q) {
        if (!ok) return;
        if (Math.abs(q[1]) < 1e-9) { if (Math.abs(q[0]) > q[2]) ok = false; return; }
        var ta = (-q[2] - q[0]) / q[1], tb = (q[2] - q[0]) / q[1];
        if (ta > tb) { var tmp = ta; ta = tb; tb = tmp; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      });
      if (!ok || t0 > t1 || t1 < 0) return;
      t = t0 >= 0 ? t0 : 0;
      if (t < best) best = t;
    });
    return best;
  }

  // ── floor raster: drawn by both views, read by the line sensors ─────────
  var raster = { canvas: null, px: 100, data: null, version: 0 };
  function buildRaster() {
    var f = scene.floor;
    var px = clamp(Math.floor(2048 / Math.max(f.w, f.h)), 60, 400);
    var cv = raster.canvas || (raster.canvas = document.createElement('canvas'));
    cv.width = Math.max(8, Math.round(f.w * px)); cv.height = Math.max(8, Math.round(f.h * px));
    var g = cv.getContext('2d', { willReadFrequently: true });
    raster.px = px;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = f.color; g.fillRect(0, 0, cv.width, cv.height);
    if (f.grid) {
      g.strokeStyle = lum(f.color) < 0.45 ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)';
      g.lineWidth = 1;
      for (var gx = 0; gx <= f.w + 1e-6; gx += 0.1) { g.beginPath(); g.moveTo(Math.round(gx * px) + 0.5, 0); g.lineTo(Math.round(gx * px) + 0.5, cv.height); g.stroke(); }
      for (var gy = 0; gy <= f.h + 1e-6; gy += 0.1) { g.beginPath(); g.moveTo(0, Math.round(gy * px) + 0.5); g.lineTo(cv.width, Math.round(gy * px) + 0.5); g.stroke(); }
    }
    objs.forEach(function (t) {
      if (t.type !== 'track') return;
      var path = trackPath(t);
      g.save();
      g.translate((t.x + f.w / 2) * px, (f.h / 2 - t.y) * px);
      g.scale(px, -px);
      g.rotate(t.rot * DEG);
      g.strokeStyle = t.color || '#111111';
      g.lineWidth = t.tape; g.lineJoin = 'round'; g.lineCap = 'butt';
      g.beginPath();
      path.pts.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
      if (path.closed) g.closePath();
      g.stroke();
      g.restore();
    });
    raster.data = g.getImageData(0, 0, cv.width, cv.height).data;
    raster.version++;
  }
  function lum(hex) {
    var c = String(hex || '#000').replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var v = parseInt(c, 16);
    if (!isFinite(v)) return 0.5;
    return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  }
  /** 0 black .. 1 white, a 3 x 3 px spot; off the mat a dark table. */
  function reflectance(x, y) {
    var f = scene.floor, px = raster.px, cv = raster.canvas;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (o.type === 'ramp' || o.type === 'box' || o.type === 'wall') {
        var l = toLocal(o, x, y);
        if (Math.abs(l[0]) <= o.w / 2 && Math.abs(l[1]) <= o.d / 2) return lum(o.color || (o.type === 'ramp' ? '#c8b48a' : '#b0723a'));
      }
    }
    var u = Math.floor((x + f.w / 2) * px), v = Math.floor((f.h / 2 - y) * px);
    if (!raster.data || u < 1 || v < 1 || u >= cv.width - 1 || v >= cv.height - 1) return 0.08;
    var sum = 0, dd = raster.data, W = cv.width;
    for (var dv = -1; dv <= 1; dv++) for (var du = -1; du <= 1; du++) {
      var k = ((v + dv) * W + (u + du)) * 4;
      sum += 0.2126 * dd[k] + 0.7152 * dd[k + 1] + 0.0722 * dd[k + 2];
    }
    return sum / (9 * 255);
  }

  // ── parts ────────────────────────────────────────────────────────────────
  function warn(text) {
    if (warnings.indexOf(text) >= 0) return;
    warnings.push(text);
    try { console.warn('velxio.kit: ' + text); } catch (e) { /* no console */ }
    if (warnBox) showWarnings();
  }
  function asList(v) { return Array.isArray(v) ? v : v ? [v] : []; }
  function checkBinds() {
    objs.forEach(function (o) {
      if (!o.bind) return;
      var need = function (id, what, test) {
        if (!id) return;
        var p = partsById[id];
        if (!p) warn(o.id + ': ' + what + ' "' + id + '" is not on the canvas');
        else if (test && !test(p)) warn(o.id + ': "' + id + '" (' + p.type + ') is not a ' + what);
      };
      var hasOut = function (k) { return function (p) { return (p.outputs || []).indexOf(k) >= 0; }; };
      var hasIn = function (p) { return (p.inputs || []).length > 0; };
      if (o.type === 'robot') {
        asList(o.bind.left).concat(asList(o.bind.right)).forEach(function (id) { need(id, 'motor', hasOut('drive')); });
        if (!asList(o.bind.left).length || !asList(o.bind.right).length) warn(o.id + ': bind.left and bind.right need a motor each');
        asList(o.bind.line).forEach(function (id) { need(id, 'line sensor', hasIn); });
        need(o.bind.sonar, 'distance sensor', hasIn);
        need(o.bind.sonarServo, 'servo', hasOut('angle'));
        need(o.bind.imu, 'IMU', hasIn);
        if (o.bind.display && !screenOf(o.bind.display)) warn(o.id + ': display "' + o.bind.display + '" is not a board or a part with a screen');
      } else if (o.type === 'arm') {
        ['base', 'shoulder', 'elbow', 'gripper'].forEach(function (k) { need(o.bind[k], k + ' servo', hasOut('angle')); });
      }
    });
  }

  // ── screens a robot carries (bind.display) ────────────────────────────────
  // The real panel's width in metres: a 4" 480x480 module, the 7" 1024x600.
  var PANEL_WIDTH = { 'esp32-4848s040': 0.086, 'waveshare-rp2350-lcd4': 0.086, 'stm32h7-core-v13': 0.165 };
  var screens = {};       // id -> { canvas, w, h, width, height (m), version }
  function screenOf(id) {
    var i, d = null, kind = null;
    for (i = 0; i < (info.boards || []).length; i++) if (info.boards[i].id === id) { d = info.boards[i].display; kind = info.boards[i].kind; }
    if (!d && partsById[id]) { d = partsById[id].display; kind = partsById[id].type; }
    if (!d) return null;
    var sc = screens[id];
    if (!sc) {
      var width = PANEL_WIDTH[kind] || 0.06;
      sc = screens[id] = { canvas: velxio.display(id, { fps: 15 }), w: d.w, h: d.h, touch: !!d.touch,
        width: width, height: (width * d.h) / d.w, version: 0 };
      velxio.on('display:' + id, function () { sc.version++; if (view) view.dirty(); });
    }
    return sc;
  }
  /** Touch a screen at (u, v), 0..1 from its top left; pressed false lifts the finger. */
  var touching = null;
  function touchScreen(id, u, v, pressed) {
    var sc = screens[id];
    if (!sc || !sc.touch) return;
    velxio.touch(id, Math.round(clamp(u, 0, 1) * (sc.w - 1)), Math.round(clamp(v, 0, 1) * (sc.h - 1)), pressed);
    touching = pressed ? id : null;
  }
  /** Where a robot's screen sits on it, in its own frame, for the 2D view. */
  function screen2d(o) { var sc = screenOf(o.displayId); return sc ? { sc: sc, cx: -o.p.L * 0.1 } : null; }

  // Only changed values reach the circuit.
  var lastWritten = {};
  function write(id, values) {
    var p = partsById[id];
    if (!p) return;
    var keys = (p.inputs || []).map(function (i) { return i.key; });
    var out = {}, any = false;
    for (var k in values) {
      if (keys.indexOf(k) < 0) continue;
      var key = id + '.' + k;
      if (lastWritten[key] === values[k]) continue;
      lastWritten[key] = values[k]; out[k] = values[k]; any = true;
    }
    if (any) velxio.set(id, out);
  }
  function lineKey(p) {
    var ins = (p && p.inputs) || [];
    for (var i = 0; i < ins.length; i++) if (ins[i].key === 'reflectance') return ins[i];
    return ins[0] || null;
  }

  // ── physics ──────────────────────────────────────────────────────────────
  function sideSpeed(rb, ids, invert) {
    var list = asList(ids), sum = 0, n = 0;
    list.forEach(function (id) {
      var q = lastFrameParts[id];
      if (!q) return;
      var d = num(q.drive, 0), rpm = 0;
      if (Math.abs(d) >= DEADBAND) rpm = q.rpm !== undefined ? num(q.rpm, d * 200) : d * 200;
      sum += (rpm / 60) * 2 * Math.PI * rb.p.r; n++;
    });
    var v = n ? sum / n : 0;
    return invert ? -v : v;
  }

  function settle(rb) {
    var L = rb.p.L / 2, W = rb.p.W / 2;
    var f = toWorld(rb, L * 0.8, 0), b = toWorld(rb, -L * 0.8, 0), l = toWorld(rb, 0, W * 0.8), r = toWorld(rb, 0, -W * 0.8);
    var hf = groundAt(rb, f[0], f[1]), hb = groundAt(rb, b[0], b[1]), hl = groundAt(rb, l[0], l[1]), hr = groundAt(rb, r[0], r[1]);
    rb.z = Math.max((hf + hb) / 2, (hl + hr) / 2);
    rb.pitch = Math.atan2(hf - hb, 1.6 * L) / DEG;
    rb.roll = Math.atan2(hl - hr, 1.6 * W) / DEG;
  }

  function stepRobot(rb, dt) {
    var tl = sideSpeed(rb, rb.bind.left, rb.bind.invertLeft), tr = sideSpeed(rb, rb.bind.right, rb.bind.invertRight);
    var k = 1 - Math.exp(-dt / LAG);
    rb.vl += (tl - rb.vl) * k; rb.vr += (tr - rb.vr) * k;
    var slow = 1 - Math.min(0.6, Math.abs(Math.sin(rb.pitch * DEG)) * 2);   // uphill / downhill drag
    var v = ((rb.vl + rb.vr) / 2) * slow, w = (rb.vr - rb.vl) / (rb.p.track * rb.p.skid);
    var nrot = rb.rot + (w * dt) / DEG;
    var a = (rb.rot + nrot) / 2;
    var nx = rb.x + v * cosd(a) * dt, ny = rb.y + v * sind(a) * dt;
    var hit = collides(rb, nx, ny, nrot);
    if (hit) {
      if (!collides(rb, rb.x, rb.y, nrot)) { rb.rot = nrot; }    // turning on the spot is fine
      rb.bumped = true; v = 0;
    } else {
      rb.x = nx; rb.y = ny; rb.rot = nrot; rb.bumped = false;
    }
    rb.accel = (v - rb.v) / dt * 0.05 + rb.accel * 0.95;
    rb.v = v; rb.w = w;
    rb.rot = wrap(rb.rot);
    settle(rb);
  }

  function sense(rb) {
    var ids = asList(rb.bind.line), n = ids.length;
    if (n) {
      var spacing = rb.lineSpacing;
      rb.line = ids.map(function (id, i) {
        var ly = ((n - 1) / 2 - i) * spacing;             // left to right across the front
        var p = toWorld(rb, rb.p.ahead, ly);
        var refl = reflectance(p[0], p[1]);
        var inp = lineKey(partsById[id]);
        if (inp) {
          var val = inp.kind === 'bool' ? (refl < 0.5 ? 1 : 0) : Math.round(inp.min + (inp.max - inp.min) * refl);
          var o = {}; o[inp.key] = val; write(id, o);
        }
        return refl;
      });
    }
    if (rb.bind.sonarServo) {
      var sv = lastFrameParts[rb.bind.sonarServo];
      rb.sonarAngle = sv ? num(sv.angle, 90) - 90 : 0;
    }
    if (rb.bind.sonar && (rb.lastSonarT < 0 || simT - rb.lastSonarT >= 0.03)) {
      rb.lastSonarT = simT;
      var nose = toWorld(rb, rb.p.L / 2, 0), best = 4;
      [-7, 0, 7].forEach(function (da) { best = Math.min(best, rayCast(nose[0], nose[1], rb.rot + rb.sonarAngle + da, rb, rb.z + 0.04)); });
      var cm = clamp(Math.round(best * 100), 2, 400);
      rb.sonarCm = cm;
      write(rb.bind.sonar, { distance: cm });
    }
    if (rb.bind.imu && (rb.lastImuT < 0 || simT - rb.lastImuT >= 0.02)) {
      rb.lastImuT = simT;
      var g = 9.81;
      write(rb.bind.imu, {
        accelX: Math.round((rb.accel / g + Math.sin(rb.pitch * DEG)) * 100) / 100,
        accelY: Math.round(-Math.sin(rb.roll * DEG) * 100) / 100,
        accelZ: Math.round(Math.cos(rb.pitch * DEG) * Math.cos(rb.roll * DEG) * 100) / 100,
        gyroX: 0, gyroY: 0,
        gyroZ: Math.round(rb.w / DEG)
      });
    }
  }

  function onFrame(f) {
    lastFrameParts = f.parts || {};
    var wasRunning = running;
    running = !!f.running;
    objs.forEach(function (o) {
      if (o.type !== 'arm') return;
      ['base', 'shoulder', 'elbow', 'gripper'].forEach(function (k) {
        var q = o.bind[k] && lastFrameParts[o.bind[k]];
        if (q && q.angle !== undefined) o.angles[k] = num(q.angle, 90);
      });
    });
    if (!running) {
      if (wasRunning) { updateHud(); if (view) view.dirty(); }
      return;
    }
    var dt = num(f.dt, 0);
    if (dt > 0) {
      acc = Math.min(acc + dt, BACKLOG);
      while (acc >= STEP) {
        for (var i = 0; i < objs.length; i++) if (objs[i].type === 'robot' && objs[i] !== dragging) stepRobot(objs[i], STEP);
        acc -= STEP; simT += STEP;
      }
    }
    objs.forEach(function (o) { if (o.type === 'robot') sense(o); });
    if (view) view.dirty();
    telemetryTick();
  }

  var lastTele = 0;
  function telemetryTick() {
    if (simT - lastTele < 0.2) return;
    lastTele = simT;
    var t = {};
    objs.forEach(function (o) {
      if (o.type === 'robot') t[o.id] = robotSummary(o);
    });
    velxio.telemetry(t);
    updateHud();
  }

  // ── editing ──────────────────────────────────────────────────────────────
  var dragging = null, selected = null;
  function pick(x, y) {
    var best = null, bestArea = Infinity;
    objs.forEach(function (o) {
      var l = toLocal(o, x, y), hx, hy, inside = false, area;
      if (o.type === 'cylinder') { inside = Math.hypot(x - o.x, y - o.y) <= o.r + 0.01; area = o.r * o.r * 4; }
      else if (o.type === 'arm') { inside = Math.hypot(x - o.x, y - o.y) <= 0.07; area = 0.02; }
      else if (o.type === 'track') {
        var path = trackPath(o), d = Infinity, n = path.pts.length;
        for (var i = 0; i < n - (path.closed ? 0 : 1); i++) d = Math.min(d, segDist(l, path.pts[i], path.pts[(i + 1) % n]));
        inside = d <= o.tape / 2 + 0.02; area = o.w * o.h * 10;
      } else {
        hx = o.type === 'robot' ? o.p.L / 2 : o.w / 2; hy = o.type === 'robot' ? o.p.W / 2 : o.d / 2;
        inside = Math.abs(l[0]) <= hx + 0.01 && Math.abs(l[1]) <= hy + 0.01; area = hx * hy * (o.type === 'robot' ? 0.5 : 1);
      }
      if (inside && area < bestArea) { best = o; bestArea = area; }
    });
    return best;
  }
  function segDist(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
    var t = l2 ? clamp(((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2, 0, 1) : 0;
    return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
  }
  var dragStart = null;
  function beginDrag(o, x, y, rotate) {
    dragging = o; selected = o;
    dragStart = { x: x, y: y, ox: o.x, oy: o.y, orot: o.rot, rotate: rotate, moved: false };
  }
  function moveDrag(x, y, dxPixels) {
    if (!dragging) return;
    var o = dragging, s = dragStart;
    if (s.rotate) o.rot = wrap(s.orot - dxPixels * 0.5);
    else { o.x = s.ox + (x - s.x); o.y = s.oy + (y - s.y); }
    s.moved = true;
    if (o.type === 'robot') settle(o);
    if (o.type === 'track') buildRaster();
    if (view) view.dirty();
  }
  function endDrag() {
    if (!dragging) return;
    var o = dragging, moved = dragStart.moved;
    dragging = null;
    if (!moved) return;
    o.x = r3(o.x); o.y = r3(o.y); o.rot = r1(wrap(o.rot));
    o.src.x = o.x; o.src.y = o.y; o.src.rot = o.rot;
    if (o.type === 'robot') { o.vl = o.vr = o.v = 0; settle(o); }
    if (o.type === 'track' || o.type === 'ramp' || o.type === 'box' || o.type === 'wall') buildRaster();
    save();
  }
  function rotateSelected(deg) {
    if (!selected) return;
    var o = selected;
    o.rot = r1(wrap(o.rot + deg)); o.src.rot = o.rot;
    if (o.type === 'robot') settle(o);
    if (o.type === 'track') buildRaster();
    if (view) view.dirty();
    save();
  }
  function save() {
    var out = JSON.parse(JSON.stringify(scene));
    if (!written.floorColor) delete out.floor.color;
    if (out.follow === undefined) delete out.follow;
    out.objects.forEach(function (o) {
      if (o.rot === 0 && !written.rot[o.id]) delete o.rot;
      else if (o.rot !== 0) written.rot[o.id] = true;
    });
    send('kit/scene', { json: JSON.stringify(out, null, 2) });
  }

  // ── page ─────────────────────────────────────────────────────────────────
  var STYLE = 'html,body{margin:0;height:100%;overflow:hidden;font:12px system-ui,sans-serif}' +
    '#vk-root{position:fixed;inset:0}#vk-root canvas{display:block;width:100%;height:100%;touch-action:none}' +
    '.vk-bar{position:fixed;top:8px;left:8px;display:flex;gap:4px;z-index:3}' +
    '.vk-bar button{font:12px system-ui;padding:3px 9px;border-radius:4px;border:1px solid rgba(128,128,128,.5);background:rgba(30,32,36,.75);color:#eee;cursor:pointer}' +
    '.vk-bar button.on{background:#2f6fd6;border-color:#2f6fd6}' +
    '.vk-hud{position:fixed;left:8px;bottom:8px;padding:6px 8px;border-radius:5px;background:rgba(20,22,26,.72);color:#e8e8e8;white-space:pre;font:11px ui-monospace,monospace;z-index:3;pointer-events:none}' +
    '.vk-warn{position:fixed;right:8px;top:8px;max-width:46%;padding:6px 8px;border-radius:5px;background:rgba(160,60,20,.85);color:#fff;z-index:3;display:none;white-space:pre-wrap}' +
    '.vk-hint{position:fixed;right:8px;bottom:8px;color:rgba(160,160,160,.9);z-index:3;pointer-events:none}';

  function buildPage() {
    var st = document.createElement('style'); st.textContent = STYLE; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'vk-root'; document.body.appendChild(root);
    bar = document.createElement('div'); bar.className = 'vk-bar'; document.body.appendChild(bar);
    hud = document.createElement('div'); hud.className = 'vk-hud'; document.body.appendChild(hud);
    warnBox = document.createElement('div'); warnBox.className = 'vk-warn'; document.body.appendChild(warnBox);
    var hint = document.createElement('div'); hint.className = 'vk-hint';
    hint.textContent = 'drag: move  ·  shift+drag or Q/E: turn  ·  empty space: orbit/pan  ·  wheel: zoom';
    document.body.appendChild(hint);
    [['3D', '3d'], ['2D', '2d']].forEach(function (b) {
      var el = document.createElement('button'); el.textContent = b[0]; el.dataset.view = b[1];
      el.onclick = function () { if (scene.view !== b[1]) { scene.view = b[1]; openView(); save(); } };
      bar.appendChild(el);
    });
    var rs = document.createElement('button'); rs.textContent = 'Reset'; rs.onclick = resetWorld; bar.appendChild(rs);
    var fl = document.createElement('button'); fl.textContent = 'Follow'; fl.dataset.follow = '1';
    fl.title = 'Follow a robot from close behind (the one with a screen first)';
    fl.onclick = function () {
      if (scene.follow) delete scene.follow;
      else {
        var rb = objs.filter(function (o) { return o.type === 'robot'; });
        var withScreen = rb.filter(function (o) { return o.displayId; });
        if (rb.length) scene.follow = (withScreen[0] || rb[0]).id;
      }
      followChanged(); save();
    };
    bar.appendChild(fl);
    window.addEventListener('keydown', function (e) {
      if (e.key === 'q' || e.key === 'Q') rotateSelected(15);
      else if (e.key === 'e' || e.key === 'E') rotateSelected(-15);
      else if (e.key === 'Escape') { selected = null; if (view) view.dirty(); }
    });
    showWarnings();
  }
  /** The robot the camera follows, or null. */
  function followed() { var o = scene.follow && byId[scene.follow]; return o && o.type === 'robot' ? o : null; }
  function followChanged() {
    var b = bar && bar.querySelector('button[data-follow]');
    if (b) b.className = followed() ? 'on' : '';
    if (view && view.follow) view.follow(followed());
    if (view) view.dirty();
  }
  function showWarnings() {
    warnBox.style.display = warnings.length ? 'block' : 'none';
    warnBox.textContent = warnings.join('\n');
  }
  /** One line per robot: what the HUD and the telemetry show. */
  function robotSummary(o) {
    var s = Math.round(o.v * 100) + ' cm/s';
    if (o.line.length) s += '  line ' + o.line.map(function (v) { return v < 0.5 ? '#' : '.'; }).join('');
    if (o.sonarCm !== null) s += '  sonar ' + o.sonarCm + ' cm';
    if (o.bumped) s += '  BUMP';
    return s;
  }
  function updateHud() {
    var lines = [];
    objs.forEach(function (o) {
      if (o.type === 'robot') lines.push(o.id + '  ' + robotSummary(o));
    });
    if (!running) lines.push('(stopped: press Run)');
    hud.textContent = lines.join('\n');
  }
  function theme() { return info.theme === 'light' ? { bg: '#dfe4ea', fg: '#222' } : { bg: '#15171a', fg: '#ddd' }; }

  function openView() {
    if (view) { view.destroy(); view = null; }
    Array.prototype.forEach.call(bar.querySelectorAll('button[data-view]'), function (b) { b.className = b.dataset.view === scene.view ? 'on' : ''; });
    if (scene.view === '3d') {
      import(THREE_URL).then(function (THREE) {
        if (scene.view !== '3d') return;
        view = make3d(THREE);
        followChanged();
      }, function (e) {
        warn('three.js did not load (' + (e && e.message) + '): showing the 2D view');
        scene.view = '2d'; openView();
      });
    } else {
      view = make2d();
      followChanged();
    }
  }

  // Pointer handling shared by both views: toWorld(clientX, clientY) -> [x, y] on the floor or null.
  function bindPointer(canvas, floorAt, onEmptyDrag, onWheel, screenAt) {
    var down = null;
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      var hit = e.button === 0 && !e.shiftKey && screenAt ? screenAt(e.clientX, e.clientY) : null;
      if (hit && screens[hit.id] && screens[hit.id].touch) {
        down = { screen: hit.id, last: [e.clientX, e.clientY] };
        touchScreen(hit.id, hit.u, hit.v, true);
        return;
      }
      var p = floorAt(e.clientX, e.clientY);
      var o = p && e.button === 0 ? (p.length > 2 ? p[2] || pick(p[0], p[1]) : pick(p[0], p[1])) : null;
      down = { x: e.clientX, y: e.clientY, obj: o, button: e.button, last: [e.clientX, e.clientY] };
      if (o) beginDrag(o, p[0], p[1], e.shiftKey);
      else { selected = null; if (view) view.dirty(); }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!down) return;
      if (down.screen) {
        var h = screenAt(e.clientX, e.clientY);
        if (h && h.id === down.screen) touchScreen(h.id, h.u, h.v, true);
        return;
      }
      var dx = e.clientX - down.last[0], dy = e.clientY - down.last[1];
      down.last = [e.clientX, e.clientY];
      if (down.obj) {
        var p = floorAt(e.clientX, e.clientY);
        if (p) moveDrag(p[0], p[1], e.clientX - down.x);
      } else onEmptyDrag(dx, dy, down.button !== 0 || e.ctrlKey || e.metaKey);
    });
    var up = function () {
      if (down && down.screen) touchScreen(down.screen, 0, 0, false);
      else if (down && down.obj) endDrag();
      down = null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); onWheel(e.deltaY); }, { passive: false });
  }

  // ── 2D view ──────────────────────────────────────────────────────────────
  function make2d() {
    var cv = document.createElement('canvas'), g = cv.getContext('2d');
    root.appendChild(cv);
    var cam = { x: 0, y: 0, s: 1 }, need = true, raf = 0, alive = true;
    function fit() {
      var dpr = window.devicePixelRatio || 1, w = root.clientWidth, h = root.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      var f = scene.floor;
      cam.base = Math.min(w / (f.w + 0.3), h / (f.h + 0.3));
      need = true;
    }
    function scale() { return cam.base * cam.s; }
    function track() { var o = followed(); if (o) { cam.x = o.x; cam.y = o.y; } }
    function sx(x) { return root.clientWidth / 2 + (x - cam.x) * scale(); }
    function sy(y) { return root.clientHeight / 2 - (y - cam.y) * scale(); }
    function floorAt(cx, cy) {
      var r = cv.getBoundingClientRect();
      return [(cx - r.left - root.clientWidth / 2) / scale() + cam.x, -(cy - r.top - root.clientHeight / 2) / scale() + cam.y];
    }
    function poly(o, pts) {
      g.beginPath();
      pts.forEach(function (p, i) { var w = toWorld(o, p[0], p[1]); if (i) g.lineTo(sx(w[0]), sy(w[1])); else g.moveTo(sx(w[0]), sy(w[1])); });
      g.closePath();
    }
    function rect(o, hx, hy) { poly(o, [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]); }
    function draw() {
      raf = 0;
      if (!alive) return;
      if (!need || !visible) return;
      need = false;
      track();
      var dpr = window.devicePixelRatio || 1, th = theme(), f = scene.floor, k = scale();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = th.bg; g.fillRect(0, 0, root.clientWidth, root.clientHeight);
      g.imageSmoothingEnabled = true;
      g.drawImage(raster.canvas, sx(-f.w / 2), sy(f.h / 2), f.w * k, f.h * k);
      objs.forEach(function (o) {
        g.lineWidth = 1;
        if (o.type === 'ramp') {
          rect(o, o.w / 2, o.d / 2);
          g.fillStyle = o.color || '#c8b48a'; g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1;
          g.strokeStyle = 'rgba(0,0,0,.4)'; g.stroke();
          var a0 = toWorld(o, -o.w / 2 + 0.02, 0), a1 = toWorld(o, o.w / 2 - 0.02, 0);
          g.beginPath(); g.moveTo(sx(a0[0]), sy(a0[1])); g.lineTo(sx(a1[0]), sy(a1[1])); g.stroke();
        } else if (o.type === 'box' || o.type === 'wall') {
          rect(o, o.w / 2, o.d / 2); g.fillStyle = o.color || (o.type === 'wall' ? '#8a8f98' : '#b0723a'); g.fill();
          g.strokeStyle = 'rgba(0,0,0,.5)'; g.stroke();
        } else if (o.type === 'cylinder') {
          g.beginPath(); g.arc(sx(o.x), sy(o.y), o.r * k, 0, 2 * Math.PI); g.fillStyle = o.color || '#6a8fb0'; g.fill();
          g.strokeStyle = 'rgba(0,0,0,.5)'; g.stroke();
        } else if (o.type === 'arm') drawArm2d(o, k);
        else if (o.type === 'robot') drawRobot2d(o, k);
        if (o === selected) {
          g.strokeStyle = '#ffb020'; g.lineWidth = 2;
          if (o.type === 'cylinder') { g.beginPath(); g.arc(sx(o.x), sy(o.y), o.r * k + 3, 0, 2 * Math.PI); g.stroke(); }
          else if (o.type === 'track') { rect(o, o.w / 2, o.h / 2); g.stroke(); }
          else if (o.type === 'robot') { rect(o, o.p.L / 2 + 0.006, o.p.W / 2 + 0.006); g.stroke(); }
          else if (o.type === 'arm') { g.beginPath(); g.arc(sx(o.x), sy(o.y), 0.07 * k, 0, 2 * Math.PI); g.stroke(); }
          else { rect(o, o.w / 2 + 0.005, o.d / 2 + 0.005); g.stroke(); }
        }
        if (o.label) {
          g.fillStyle = th.fg; g.font = '11px system-ui'; g.textAlign = 'center';
          g.fillText(o.label, sx(o.x), sy(o.y) - 6 - (o.type === 'robot' ? o.p.W * k / 2 : 0));
        }
      });
    }
    function drawRobot2d(o, k) {
      var p = o.p;
      g.fillStyle = '#222';
      if (o.preset === 'tank') { rect(o, p.L / 2, p.W / 2); g.fill(); }
      else {
        var ws = p.wheels === 4 ? [[p.L * 0.3, 1], [p.L * 0.3, -1], [-p.L * 0.3, 1], [-p.L * 0.3, -1]] : [[0, 1], [0, -1]];
        ws.forEach(function (w) { poly(o, [[w[0] - p.r, w[1] * p.track / 2 - 0.011], [w[0] + p.r, w[1] * p.track / 2 - 0.011], [w[0] + p.r, w[1] * p.track / 2 + 0.011], [w[0] - p.r, w[1] * p.track / 2 + 0.011]]); g.fill(); });
      }
      var bodyW = o.preset === 'tank' ? p.W * 0.72 : p.W;
      rect(o, p.L / 2, bodyW / 2); g.fillStyle = o.color || p.color; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke();
      // nose
      poly(o, [[p.L / 2 - 0.004, 0], [p.L / 2 - 0.03, 0.018], [p.L / 2 - 0.03, -0.018]]); g.fillStyle = 'rgba(255,255,255,.85)'; g.fill();
      var ids = asList(o.bind.line), n = ids.length, spacing = o.lineSpacing;
      ids.forEach(function (id, i) {
        var w = toWorld(o, p.ahead, ((n - 1) / 2 - i) * spacing);
        g.beginPath(); g.arc(sx(w[0]), sy(w[1]), Math.max(2, 0.004 * k), 0, 2 * Math.PI);
        g.fillStyle = o.line[i] !== undefined && o.line[i] < 0.5 ? '#ff3b30' : '#7cfc00'; g.fill();
      });
      var s2 = o.displayId && screen2d(o);
      if (s2) {
        var c = toWorld(o, s2.cx, 0);
        g.save();
        g.translate(sx(c[0]), sy(c[1]));
        g.rotate(-(o.rot - 90) * DEG);
        var sw = s2.sc.width * k, shh = s2.sc.height * k;
        g.fillStyle = '#111'; g.fillRect(-sw / 2 - 3, -shh / 2 - 3, sw + 6, shh + 6);
        g.drawImage(s2.sc.canvas, -sw / 2, -shh / 2, sw, shh);
        g.restore();
      }
      if (o.bind.sonar && o.sonarCm !== null) {
        var nose = toWorld(o, p.L / 2, 0), a = o.rot + o.sonarAngle, d = o.sonarCm / 100;
        g.strokeStyle = 'rgba(0,200,255,.6)'; g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(sx(nose[0]), sy(nose[1])); g.lineTo(sx(nose[0] + cosd(a) * d), sy(nose[1] + sind(a) * d)); g.stroke();
        g.setLineDash([]);
      }
    }
    function drawArm2d(o, k) {
      var A = armPose(o);
      g.beginPath(); g.arc(sx(o.x), sy(o.y), 0.05 * k, 0, 2 * Math.PI); g.fillStyle = o.color || '#444c56'; g.fill();
      g.strokeStyle = '#f2c230'; g.lineWidth = Math.max(3, 0.018 * k); g.lineCap = 'round';
      g.beginPath(); g.moveTo(sx(A.base[0]), sy(A.base[1])); g.lineTo(sx(A.elbow[0]), sy(A.elbow[1])); g.lineTo(sx(A.wrist[0]), sy(A.wrist[1])); g.stroke();
      g.lineWidth = 1; g.lineCap = 'butt';
      g.beginPath(); g.arc(sx(A.wrist[0]), sy(A.wrist[1]), Math.max(3, (0.01 + 0.012 * A.open) * k), 0, 2 * Math.PI);
      g.strokeStyle = '#ddd'; g.stroke();
    }
    function frame() { if (!raf && alive) raf = requestAnimationFrame(draw); }
    function screenAt2d(cx, cy) {
      var w = floorAt(cx, cy);
      for (var i = objs.length - 1; i >= 0; i--) {
        var o = objs[i], s2 = o.type === 'robot' && o.displayId && screen2d(o);
        if (!s2) continue;
        var l = toLocal(o, w[0], w[1]);
        // image x runs to the robot's right (-y), image y from its nose (+x) back
        var u = 0.5 - l[1] / s2.sc.width, v = 0.5 - (l[0] - s2.cx) / s2.sc.height;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return { id: o.displayId, u: u, v: v };
      }
      return null;
    }
    bindPointer(cv, floorAt, function (dx, dy) { cam.x -= dx / scale(); cam.y += dy / scale(); need = true; frame(); },
      function (d) { cam.s = clamp(cam.s * (d > 0 ? 0.9 : 1.1), 0.3, 8); need = true; frame(); }, screenAt2d);
    var onResize = function () { fit(); frame(); };
    window.addEventListener('resize', onResize);
    fit(); frame();
    return {
      dirty: function () { need = true; frame(); },
      follow: function (o) { if (o) cam.s = Math.max(cam.s, 3); else { cam.s = 1; cam.x = cam.y = 0; } need = true; frame(); },
      destroy: function () { alive = false; window.removeEventListener('resize', onResize); cv.remove(); }
    };
  }

  /** The arm's joints in world coordinates (plan) and heights. */
  function armPose(o) {
    var a = o.angles, yaw = o.rot + (a.base - 90);
    var sh = clamp(a.shoulder, 0, 180) * DEG;              // 0 forward flat, 90 straight up
    var el = sh + (clamp(a.elbow, 0, 180) - 90) * DEG;     // the forearm, bent from the upper arm
    var L1 = 0.12, L2 = 0.10, H0 = 0.06;
    var r1 = L1 * Math.cos(sh), z1 = H0 + L1 * Math.sin(sh);
    var r2 = r1 + L2 * Math.cos(el), z2 = z1 + L2 * Math.sin(el);
    return {
      yaw: yaw, sh: sh, el: el, L1: L1, L2: L2, H0: H0,
      base: [o.x, o.y, H0],
      elbow: [o.x + r1 * cosd(yaw), o.y + r1 * sind(yaw), z1],
      wrist: [o.x + r2 * cosd(yaw), o.y + r2 * sind(yaw), Math.max(0.005, z2)],
      open: clamp(a.gripper, 0, 180) / 180
    };
  }

  // ── 3D view ──────────────────────────────────────────────────────────────
  function make3d(THREE) {
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.shadowMap.enabled = true;
    root.appendChild(renderer.domElement);
    var sc = new THREE.Scene();
    var cam = new THREE.PerspectiveCamera(45, 1, 0.01, 60);
    var orbit = { theta: -90, phi: 52, dist: 0, tx: 0, ty: 0, off: 0 };
    var f = scene.floor;
    orbit.dist = Math.max(f.w, f.h) * 1.25;
    sc.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.9));
    var sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-1.2, 3, 1.5); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.003;
    var ext = Math.max(f.w, f.h);
    sun.shadow.camera.left = -ext; sun.shadow.camera.right = ext; sun.shadow.camera.top = ext; sun.shadow.camera.bottom = -ext;
    sc.add(sun);

    // floor: the raster as a texture, on a table
    var tex = new THREE.CanvasTexture(raster.canvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; sc.add(floor);
    var table = new THREE.Mesh(new THREE.PlaneGeometry(f.w + 1.2, f.h + 1.2), new THREE.MeshStandardMaterial({ color: 0x3a3330, roughness: 1 }));
    table.rotation.x = -Math.PI / 2; table.position.y = -0.001; table.receiveShadow = true; sc.add(table);
    var rasterVersion = raster.version;

    function W(x, y, z) { return new THREE.Vector3(x, z || 0, -y); }
    function mat(c) { return new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.7, metalness: 0.05 }); }
    var meshes = {};     // id -> Object3D
    var selBox = new THREE.BoxHelper(undefined, 0xffb020);
    selBox.visible = false; sc.add(selBox);

    function rampGeometry(o) {
      var nx = o.profile === 'wedge' ? 2 : 24, ny = o.profile === 'hill' ? 24 : 2;
      var g = new THREE.PlaneGeometry(o.w, o.d, nx - 1 < 1 ? 1 : nx - 1, ny - 1 < 1 ? 1 : ny - 1);
      var pos = g.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        var lx = pos.getX(i), ly = pos.getY(i);
        pos.setZ(i, rampHeight(o, clamp(lx, -o.w / 2 + 1e-6, o.w / 2 - 1e-6), clamp(ly, -o.d / 2 + 1e-6, o.d / 2 - 1e-6)));
      }
      g.computeVertexNormals();
      return g;
    }
    function build(o) {
      var grp = new THREE.Group(), m;
      if (o.type === 'box' || o.type === 'wall') {
        m = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), mat(o.color || (o.type === 'wall' ? '#8a8f98' : '#b0723a')));
        m.position.y = o.h / 2; m.castShadow = m.receiveShadow = true; grp.add(m);
      } else if (o.type === 'cylinder') {
        m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, o.h, 32), mat(o.color || '#6a8fb0'));
        m.position.y = o.h / 2; m.castShadow = m.receiveShadow = true; grp.add(m);
      } else if (o.type === 'ramp') {
        m = new THREE.Mesh(rampGeometry(o), mat(o.color || '#c8b48a'));
        m.material.side = THREE.DoubleSide;
        m.rotation.x = -Math.PI / 2; m.castShadow = m.receiveShadow = true; grp.add(m);
      } else if (o.type === 'robot') buildRobot(o, grp);
      else if (o.type === 'arm') buildArm(o, grp);
      else return null;
      grp.traverse(function (c) { c.userData.kitId = o.id; });
      sc.add(grp);
      return grp;
    }
    function buildRobot(o, grp) {
      var p = o.p, body = mat(o.color || p.color), black = mat('#1b1b1b'), clear = p.r * 0.55;
      var chassis = new THREE.Group(); grp.add(chassis); grp.userData.chassis = chassis;
      var bodyW = o.preset === 'tank' ? p.W * 0.72 : p.W;
      var b = new THREE.Mesh(new THREE.BoxGeometry(p.L, 0.022, bodyW), body);
      b.position.y = clear + 0.011; b.castShadow = true; chassis.add(b);
      var top = new THREE.Mesh(new THREE.BoxGeometry(p.L * 0.55, 0.025, bodyW * 0.7), mat('#2a2f36'));
      top.position.set(-p.L * 0.1, clear + 0.035, 0); top.castShadow = true; chassis.add(top);
      var wheels = [];
      if (o.preset === 'tank') {
        [1, -1].forEach(function (s) {
          var t = new THREE.Mesh(new THREE.BoxGeometry(p.L, p.r * 2, (p.W - bodyW) / 2), black);
          t.position.set(0, p.r, s * (p.W / 2 - (p.W - bodyW) / 4)); t.castShadow = true; chassis.add(t);
        });
      } else {
        var xs = p.wheels === 4 ? [p.L * 0.3, -p.L * 0.3] : [0];
        xs.forEach(function (x) {
          [1, -1].forEach(function (s) {
            var wgeo = new THREE.CylinderGeometry(p.r, p.r, 0.022, 24);
            var w = new THREE.Mesh(wgeo, black);
            w.rotation.x = Math.PI / 2; w.position.set(x, p.r, s * p.track / 2); w.castShadow = true;
            var hub = new THREE.Mesh(new THREE.BoxGeometry(p.r * 1.4, 0.004, 0.024), mat('#f2c230'));
            w.add(hub); w.userData.side = s; chassis.add(w); wheels.push(w);
          });
        });
        if (p.wheels === 2) {
          var caster = new THREE.Mesh(new THREE.SphereGeometry(clear * 0.9, 16, 12), mat('#999'));
          caster.position.set(-p.L * 0.38, clear * 0.9, 0); chassis.add(caster);
        }
      }
      grp.userData.wheels = wheels;
      var sc = o.displayId && screenOf(o.displayId);
      if (sc) {
        var mount = new THREE.Group();
        mount.position.set(-p.L * 0.3, clear + 0.04, 0);
        var post = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.03), mat('#2a2f36'));
        post.position.y = 0.015; mount.add(post);
        var pivot = new THREE.Group(); pivot.position.y = 0.03;
        pivot.rotation.z = -o.displayTilt * DEG;        // leans back, toward the nose
        mount.add(pivot);
        var bez = new THREE.Mesh(new THREE.BoxGeometry(0.006, sc.height + 0.012, sc.width + 0.012), mat('#111'));
        bez.position.set(0.004, sc.height / 2 + 0.004, 0); bez.castShadow = true; pivot.add(bez);
        var tex = new THREE.CanvasTexture(sc.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        var glass = new THREE.Mesh(new THREE.PlaneGeometry(sc.width, sc.height), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
        glass.rotation.y = -Math.PI / 2;               // faces behind the robot (-x)
        glass.position.set(0, sc.height / 2 + 0.004, 0);
        glass.userData.screenOf = o.displayId;
        pivot.add(glass);
        chassis.add(mount);
        grp.userData.screen = { tex: tex, sc: sc, version: -1 };
      }
      var ids = asList(o.bind.line), n = ids.length, spacing = o.lineSpacing;
      grp.userData.leds = ids.map(function (id, i) {
        var led = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.008), new THREE.MeshBasicMaterial({ color: 0x7cfc00 }));
        led.position.set(p.ahead, clear * 0.5, -((n - 1) / 2 - i) * spacing); chassis.add(led);
        return led;
      });
      if (o.bind.sonar) {
        var head = new THREE.Group();
        var board = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.02, 0.045), mat('#1d4f91')); head.add(board);
        [-0.013, 0.013].forEach(function (z) {
          var eye = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 16), mat('#c8ccd0'));
          eye.rotation.z = Math.PI / 2; eye.position.set(0.007, 0, z); head.add(eye);
        });
        head.position.set(p.L / 2 - 0.01, clear + 0.04, 0);
        chassis.add(head); grp.userData.head = head;
        var beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
          new THREE.LineBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.5 }));
        head.add(beam); grp.userData.beam = beam;
      }
    }
    function buildArm(o, grp) {
      var yellow = mat('#f2c230'), dark = mat(o.color || '#444c56');
      var base = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.04, 32), dark);
      base.position.y = 0.02; base.castShadow = true; grp.add(base);
      var turret = new THREE.Group(); turret.position.y = 0.06; grp.add(turret);
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.04, 16), dark); post.position.y = -0.01; turret.add(post);
      var upper = new THREE.Group(); turret.add(upper);
      var l1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.018, 0.022), yellow); l1.position.x = 0.06; l1.castShadow = true; upper.add(l1);
      var fore = new THREE.Group(); fore.position.x = 0.12; upper.add(fore);
      var l2 = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.015, 0.018), yellow); l2.position.x = 0.05; l2.castShadow = true; fore.add(l2);
      var hand = new THREE.Group(); hand.position.x = 0.10; fore.add(hand);
      var fingers = [1, -1].map(function (s) {
        var fm = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.008, 0.004), mat('#ddd'));
        fm.position.set(0.017, 0, s * 0.01); hand.add(fm); return fm;
      });
      grp.userData.arm = { turret: turret, upper: upper, fore: fore, fingers: fingers };
    }
    function place(o, m) {
      m.position.copy(W(o.x, o.y, 0));
      m.rotation.set(0, o.rot * DEG, 0);
      if (o.type === 'robot') {
        var ch = m.userData.chassis;
        ch.position.y = o.z;
        ch.rotation.set(o.roll * DEG, 0, o.pitch * DEG, 'YXZ');
        m.userData.wheels.forEach(function (w) {
          var v = w.userData.side > 0 ? o.vl : o.vr;
          w.userData.spin = (w.userData.spin || 0) + (v / o.p.r) * (1 / 60);
          w.rotation.y = -w.userData.spin;
        });
        m.userData.leds.forEach(function (led, i) {
          led.material.color.set(o.line[i] !== undefined && o.line[i] < 0.5 ? 0xff3b30 : 0x7cfc00);
        });
        var su = m.userData.screen;
        if (su && su.version !== su.sc.version) {
          var cw = su.sc.canvas.width, chh = su.sc.canvas.height;
          // a board may send frames at another size than its panel (the RP2350's
          // are 240x240, shown 2x): a texture cannot change size, so make it again
          if (su.cw !== cw || su.ch !== chh) { su.tex.dispose(); su.cw = cw; su.ch = chh; }
          su.tex.needsUpdate = true; su.version = su.sc.version;
        }
        if (m.userData.head) {
          m.userData.head.rotation.y = o.sonarAngle * DEG;
          var d = o.sonarCm !== null ? o.sonarCm / 100 : 0;
          m.userData.beam.scale.set(Math.max(0.001, d), 1, 1);
          m.userData.beam.visible = d > 0;
        }
      } else if (o.type === 'arm') {
        var A = armPose(o), q = m.userData.arm;
        q.turret.rotation.y = (A.yaw - o.rot) * DEG;
        q.upper.rotation.z = A.sh;
        q.fore.rotation.z = A.el - A.sh;
        q.fingers.forEach(function (fm, i) { fm.position.z = (i ? -1 : 1) * (0.004 + 0.014 * A.open); });
      }
    }
    function sync() {
      var ids = {};
      objs.forEach(function (o) {
        ids[o.id] = 1;
        if (o.type === 'track') return;
        var m = meshes[o.id];
        if (!m) { m = build(o); if (!m) return; meshes[o.id] = m; }
        place(o, m);
      });
      Object.keys(meshes).forEach(function (id) { if (!ids[id]) { sc.remove(meshes[id]); delete meshes[id]; } });
      if (raster.version !== rasterVersion) { tex.needsUpdate = true; rasterVersion = raster.version; }
      var sel = selected && meshes[selected.id];
      if (sel) { selBox.setFromObject(sel); selBox.visible = true; } else selBox.visible = false;
    }
    function aim() {
      var fo = followed();
      if (fo) { orbit.tx = fo.x; orbit.ty = fo.y; orbit.theta = fo.rot + 180 + orbit.off; }   // behind it
      var th = orbit.theta * DEG, ph = orbit.phi * DEG;
      cam.position.set(orbit.tx + orbit.dist * Math.sin(ph) * Math.cos(th), orbit.dist * Math.cos(ph), -orbit.ty - orbit.dist * Math.sin(ph) * Math.sin(th));
      cam.lookAt(orbit.tx, fo ? 0.07 : 0, -orbit.ty);
    }
    var ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitV = new THREE.Vector3();
    function floorAt(cx, cy) {
      var r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), cam);
      if (!ray.ray.intersectPlane(plane, hitV)) return null;
      var under = null;
      if (!dragging) {
        // an object hit by the ray wins over the floor under it (its top is above the floor)
        var hits = ray.intersectObjects(Object.keys(meshes).map(function (k) { return meshes[k]; }), true);
        for (var i = 0; i < hits.length && !under; i++) under = byId[hits[i].object.userData.kitId] || null;
      }
      return [hitV.x, -hitV.z, under];
    }
    var need = true, raf = 0, alive = true;
    function draw() {
      raf = 0;
      if (!alive || !visible) return;
      if (!need) return;
      need = false;
      var th = theme();
      sc.background = new THREE.Color(th.bg);
      sync(); aim();
      renderer.render(sc, cam);
      if (running) frame();
    }
    function frame() { if (!raf && alive) raf = requestAnimationFrame(draw); }
    function resize() {
      var w = root.clientWidth, h = root.clientHeight;
      renderer.setSize(w, h, false); cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); need = true; frame();
    }
    function screenAt3d(cx, cy) {
      var r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), cam);
      var hits = ray.intersectObjects(Object.keys(meshes).map(function (k) { return meshes[k]; }), true);
      if (!hits.length || !hits[0].object.userData.screenOf || !hits[0].uv) return null;
      return { id: hits[0].object.userData.screenOf, u: hits[0].uv.x, v: 1 - hits[0].uv.y };
    }
    bindPointer(renderer.domElement, floorAt, function (dx, dy, pan) {
      if (pan) {
        // the camera looks along (-cos th, -sin th) on the floor; its right is (-sin th, cos th)
        var k = orbit.dist / 700, th = orbit.theta * DEG, c = Math.cos(th), sn = Math.sin(th);
        orbit.tx += (sn * dx - c * dy) * k;
        orbit.ty += (-c * dx - sn * dy) * k;
      } else {
        if (followed()) orbit.off -= dx * 0.4; else orbit.theta -= dx * 0.4;
        orbit.phi = clamp(orbit.phi - dy * 0.3, 5, 88);
      }
      need = true; frame();
    }, function (d) { orbit.dist = clamp(orbit.dist * (d > 0 ? 1.1 : 0.9), 0.2, 20); need = true; frame(); }, screenAt3d);
    window.addEventListener('resize', resize);
    resize();
    return {
      follow: function (o) {
        if (o) { orbit.dist = 0.42; orbit.off = 0; orbit.phi = 58; }
        else { var f = scene.floor; orbit.dist = Math.max(f.w, f.h) * 1.25; orbit.tx = orbit.ty = 0; orbit.theta = -90; orbit.phi = 52; }
        need = true; frame();
      },
      dirty: function () { need = true; frame(); },
      destroy: function () {
        alive = false; window.removeEventListener('resize', resize);
        renderer.dispose(); renderer.domElement.remove();
      }
    };
  }

  // ── start ────────────────────────────────────────────────────────────────
  function start(opts) {
    if (started) return api;
    started = true;
    opts = opts || {};
    var s = opts.scene;
    if (!s) {
      var el = document.getElementById('velxio-scene');
      if (!el) warn('no <script type="application/json" id="velxio-scene"> in the page');
      else {
        try { s = JSON.parse(el.textContent || '{}'); }
        catch (e) { warn('the velxio-scene JSON does not parse: ' + e.message); }
      }
    }
    scene = normalize(s);
    var go = function () {
      buildPage();
      rebuild();
      velxio.ready().then(function (inf) {
        setInfo(inf);
        openView();
        updateHud();
      });
      velxio.on('parts', setInfo);
      velxio.on('reset', resetWorld);
      velxio.on('theme', function (t) { info.theme = t; if (view) view.dirty(); });
      velxio.on('visibility', function (v) { visible = !!v; if (visible && view) view.dirty(); });
      velxio.onFrame(onFrame);
    };
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
    return api;
  }
  function setInfo(inf) {
    info = inf || info;
    partsById = {};
    (info.parts || []).forEach(function (p) { partsById[p.id] = p; });
    warnings = warnings.filter(function (w) { return w.indexOf(' is not on the canvas') < 0 && w.indexOf(') is not a ') < 0; });
    checkBinds();
    showWarnings();
  }

  var api = {
    start: start,
    reset: function () { resetWorld(); },
    get scene() { return scene ? JSON.parse(JSON.stringify(scene)) : null; },
    get objects() {
      return objs.map(function (o) {
        var r = { id: o.id, type: o.type, x: o.x, y: o.y, rot: o.rot };
        if (o.type === 'robot') { r.z = o.z; r.speed = o.v; r.line = o.line.slice(); r.sonar = o.sonarCm; r.bumped = o.bumped; }
        return r;
      });
    },
    // for tests: the floor seen by a line sensor at (x, y), 0..1
    reflectance: function (x, y) { return reflectance(x, y); }
  };
  return api;
}`;

/** The kit's source, with the three.js module it loads for the 3D view. */
export function worldKitJs(threeUrl: string): string {
  return KIT_SOURCE.replace('__THREE_URL__', threeUrl);
}
