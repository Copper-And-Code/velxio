/**
 * The 3D view, on three.js. The library comes from a CDN when the view is
 * first asked for (index.ts), so it is not in the kit's bundle and has no
 * types here: everything of it is `Three`.
 */
import { DEG, asList, clamp } from './math';
import { armPose, rampHeight } from './geometry';
import type { Arm, Obj, Ramp, Robot } from './types';
import type { FloorHit, ScreenHit, View, ViewHost } from './view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Three = any;

export function make3d(THREE: Three, host: ViewHost): View {
  const root = host.root;
  const renderer: Three = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.shadowMap.enabled = true;
  root.appendChild(renderer.domElement);
  const stage: Three = new THREE.Scene();
  const cam: Three = new THREE.PerspectiveCamera(45, 1, 0.01, 60);
  const orbit = { theta: -90, phi: 52, dist: 0, tx: 0, ty: 0, off: 0 };
  const f = host.world.scene.floor;
  orbit.dist = Math.max(f.w, f.h) * 1.25;
  stage.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.9));
  const sun: Three = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-1.2, 3, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.003;
  const ext = Math.max(f.w, f.h);
  sun.shadow.camera.left = -ext;
  sun.shadow.camera.right = ext;
  sun.shadow.camera.top = ext;
  sun.shadow.camera.bottom = -ext;
  stage.add(sun);

  // floor: the raster as a texture, on a table
  const tex: Three = new THREE.CanvasTexture(host.raster.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const floor: Three = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  stage.add(floor);
  const table: Three = new THREE.Mesh(new THREE.PlaneGeometry(f.w + 1.2, f.h + 1.2), new THREE.MeshStandardMaterial({ color: 0x3a3330, roughness: 1 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.001;
  table.receiveShadow = true;
  stage.add(table);
  let rasterVersion = host.raster.version;

  /** A point of the mat (x, y, height z) in three's frame: y up, -y of the mat toward the viewer. */
  const W = (x: number, y: number, z?: number): Three => new THREE.Vector3(x, z || 0, -y);
  const mat = (c: string): Three => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.7, metalness: 0.05 });
  const meshes: Record<string, Three> = {}; // id -> Object3D
  const selBox: Three = new THREE.BoxHelper(undefined, 0xffb020);
  selBox.visible = false;
  stage.add(selBox);

  function rampGeometry(o: Ramp): Three {
    const nx = o.profile === 'wedge' ? 2 : 24;
    const ny = o.profile === 'hill' ? 24 : 2;
    const g: Three = new THREE.PlaneGeometry(o.w, o.d, nx - 1 < 1 ? 1 : nx - 1, ny - 1 < 1 ? 1 : ny - 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const ly = pos.getY(i);
      pos.setZ(i, rampHeight(o, clamp(lx, -o.w / 2 + 1e-6, o.w / 2 - 1e-6), clamp(ly, -o.d / 2 + 1e-6, o.d / 2 - 1e-6)));
    }
    g.computeVertexNormals();
    return g;
  }

  function build(o: Obj): Three | null {
    const grp: Three = new THREE.Group();
    let m: Three;
    if (o.type === 'box' || o.type === 'wall') {
      m = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), mat(o.color || (o.type === 'wall' ? '#8a8f98' : '#b0723a')));
      m.position.y = o.h / 2;
      m.castShadow = m.receiveShadow = true;
      grp.add(m);
    } else if (o.type === 'cylinder') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, o.h, 32), mat(o.color || '#6a8fb0'));
      m.position.y = o.h / 2;
      m.castShadow = m.receiveShadow = true;
      grp.add(m);
    } else if (o.type === 'ramp') {
      m = new THREE.Mesh(rampGeometry(o), mat(o.color || '#c8b48a'));
      m.material.side = THREE.DoubleSide;
      m.rotation.x = -Math.PI / 2;
      m.castShadow = m.receiveShadow = true;
      grp.add(m);
    } else if (o.type === 'robot') buildRobot(o, grp);
    else if (o.type === 'arm') buildArm(o, grp);
    else return null;
    grp.traverse((c: Three) => {
      c.userData.kitId = o.id;
    });
    stage.add(grp);
    return grp;
  }

  function buildRobot(o: Robot, grp: Three): void {
    const p = o.p;
    const body = mat(o.color || p.color);
    const black = mat('#1b1b1b');
    const clear = p.r * 0.55;
    const chassis: Three = new THREE.Group();
    grp.add(chassis);
    grp.userData.chassis = chassis;
    const bodyW = o.preset === 'tank' ? p.W * 0.72 : p.W;
    const b: Three = new THREE.Mesh(new THREE.BoxGeometry(p.L, 0.022, bodyW), body);
    b.position.y = clear + 0.011;
    b.castShadow = true;
    chassis.add(b);
    const top: Three = new THREE.Mesh(new THREE.BoxGeometry(p.L * 0.55, 0.025, bodyW * 0.7), mat('#2a2f36'));
    top.position.set(-p.L * 0.1, clear + 0.035, 0);
    top.castShadow = true;
    chassis.add(top);
    const wheels: Three[] = [];
    if (o.preset === 'tank') {
      [1, -1].forEach((s) => {
        const t: Three = new THREE.Mesh(new THREE.BoxGeometry(p.L, p.r * 2, (p.W - bodyW) / 2), black);
        t.position.set(0, p.r, s * (p.W / 2 - (p.W - bodyW) / 4));
        t.castShadow = true;
        chassis.add(t);
      });
    } else {
      const xs = p.wheels === 4 ? [p.L * 0.3, -p.L * 0.3] : [0];
      xs.forEach((x) => {
        [1, -1].forEach((s) => {
          const w: Three = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 0.022, 24), black);
          w.rotation.x = Math.PI / 2;
          w.position.set(x, p.r, (s * p.track) / 2);
          w.castShadow = true;
          const hub: Three = new THREE.Mesh(new THREE.BoxGeometry(p.r * 1.4, 0.004, 0.024), mat('#f2c230'));
          w.add(hub);
          w.userData.side = s;
          chassis.add(w);
          wheels.push(w);
        });
      });
      if (p.wheels === 2) {
        const caster: Three = new THREE.Mesh(new THREE.SphereGeometry(clear * 0.9, 16, 12), mat('#999'));
        caster.position.set(-p.L * 0.38, clear * 0.9, 0);
        chassis.add(caster);
      }
    }
    grp.userData.wheels = wheels;
    const sc = o.displayId ? host.screenOf(o.displayId) : null;
    if (sc) {
      const mount: Three = new THREE.Group();
      mount.position.set(-p.L * 0.3, clear + 0.04, 0);
      const post: Three = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.03), mat('#2a2f36'));
      post.position.y = 0.015;
      mount.add(post);
      const pivot: Three = new THREE.Group();
      pivot.position.y = 0.03;
      pivot.rotation.z = -o.displayTilt * DEG; // leans back, toward the nose
      mount.add(pivot);
      const bez: Three = new THREE.Mesh(new THREE.BoxGeometry(0.006, sc.height + 0.012, sc.width + 0.012), mat('#111'));
      bez.position.set(0.004, sc.height / 2 + 0.004, 0);
      bez.castShadow = true;
      pivot.add(bez);
      const stex: Three = new THREE.CanvasTexture(sc.canvas);
      stex.colorSpace = THREE.SRGBColorSpace;
      const glass: Three = new THREE.Mesh(new THREE.PlaneGeometry(sc.width, sc.height), new THREE.MeshBasicMaterial({ map: stex, toneMapped: false }));
      glass.rotation.y = -Math.PI / 2; // faces behind the robot (-x)
      glass.position.set(0, sc.height / 2 + 0.004, 0);
      glass.userData.screenOf = o.displayId;
      pivot.add(glass);
      chassis.add(mount);
      grp.userData.screen = { tex: stex, sc, version: -1 };
    }
    const ids = asList(o.bind.line);
    const n = ids.length;
    grp.userData.leds = ids.map((_id, i) => {
      const led: Three = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.008), new THREE.MeshBasicMaterial({ color: 0x7cfc00 }));
      led.position.set(p.ahead, clear * 0.5, -((n - 1) / 2 - i) * o.lineSpacing);
      chassis.add(led);
      return led;
    });
    if (o.bind.sonar) {
      const head: Three = new THREE.Group();
      const board: Three = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.02, 0.045), mat('#1d4f91'));
      head.add(board);
      [-0.013, 0.013].forEach((z) => {
        const eye: Three = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 16), mat('#c8ccd0'));
        eye.rotation.z = Math.PI / 2;
        eye.position.set(0.007, 0, z);
        head.add(eye);
      });
      head.position.set(p.L / 2 - 0.01, clear + 0.04, 0);
      chassis.add(head);
      grp.userData.head = head;
      const beam: Three = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
        new THREE.LineBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.5 }),
      );
      head.add(beam);
      grp.userData.beam = beam;
    }
  }

  function buildArm(o: Arm, grp: Three): void {
    const yellow = mat('#f2c230');
    const dark = mat(o.color || '#444c56');
    const base: Three = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.04, 32), dark);
    base.position.y = 0.02;
    base.castShadow = true;
    grp.add(base);
    const turret: Three = new THREE.Group();
    turret.position.y = 0.06;
    grp.add(turret);
    const post: Three = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.04, 16), dark);
    post.position.y = -0.01;
    turret.add(post);
    const upper: Three = new THREE.Group();
    turret.add(upper);
    const l1: Three = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.018, 0.022), yellow);
    l1.position.x = 0.06;
    l1.castShadow = true;
    upper.add(l1);
    const fore: Three = new THREE.Group();
    fore.position.x = 0.12;
    upper.add(fore);
    const l2: Three = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.015, 0.018), yellow);
    l2.position.x = 0.05;
    l2.castShadow = true;
    fore.add(l2);
    const hand: Three = new THREE.Group();
    hand.position.x = 0.1;
    fore.add(hand);
    const fingers = [1, -1].map((s) => {
      const fm: Three = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.008, 0.004), mat('#ddd'));
      fm.position.set(0.017, 0, s * 0.01);
      hand.add(fm);
      return fm;
    });
    grp.userData.arm = { turret, upper, fore, fingers };
  }

  function place(o: Obj, m: Three): void {
    m.position.copy(W(o.x, o.y, 0));
    m.rotation.set(0, o.rot * DEG, 0);
    if (o.type === 'robot') {
      const ch = m.userData.chassis;
      ch.position.y = o.z;
      ch.rotation.set(o.roll * DEG, 0, o.pitch * DEG, 'YXZ');
      m.userData.wheels.forEach((w: Three) => {
        const v = w.userData.side > 0 ? o.vr : o.vl; // +z is the robot's right
        w.userData.spin = (w.userData.spin || 0) + (v / o.p.r) * (1 / 60);
        w.rotation.y = -w.userData.spin;
      });
      m.userData.leds.forEach((led: Three, i: number) => {
        led.material.color.set(o.line[i] !== undefined && o.line[i] < 0.5 ? 0xff3b30 : 0x7cfc00);
      });
      const su = m.userData.screen;
      if (su && su.version !== su.sc.version) {
        const cw = su.sc.canvas.width;
        const ch2 = su.sc.canvas.height;
        // a board may send frames at another size than its panel (the RP2350's
        // are 240x240, shown 2x): a texture cannot change size, so make it again
        if (su.cw !== cw || su.ch !== ch2) {
          su.tex.dispose();
          su.cw = cw;
          su.ch = ch2;
        }
        su.tex.needsUpdate = true;
        su.version = su.sc.version;
      }
      if (m.userData.head) {
        m.userData.head.rotation.y = o.sonarAngle * DEG;
        const d = o.sonarCm !== null ? o.sonarCm / 100 : 0;
        m.userData.beam.scale.set(Math.max(0.001, d), 1, 1);
        m.userData.beam.visible = d > 0;
      }
    } else if (o.type === 'arm') {
      const A = armPose(o);
      const q = m.userData.arm;
      q.turret.rotation.y = (A.yaw - o.rot) * DEG;
      q.upper.rotation.z = A.sh;
      q.fore.rotation.z = A.el - A.sh;
      q.fingers.forEach((fm: Three, i: number) => {
        fm.position.z = (i ? -1 : 1) * (0.004 + 0.014 * A.open);
      });
    }
  }

  function sync(): void {
    const ids: Record<string, boolean> = {};
    host.world.objs.forEach((o) => {
      ids[o.id] = true;
      if (o.type === 'track') return;
      let m = meshes[o.id];
      if (!m) {
        m = build(o);
        if (!m) return;
        meshes[o.id] = m;
      }
      place(o, m);
    });
    Object.keys(meshes).forEach((id) => {
      if (!ids[id]) {
        stage.remove(meshes[id]);
        delete meshes[id];
      }
    });
    if (host.raster.version !== rasterVersion) {
      tex.needsUpdate = true;
      rasterVersion = host.raster.version;
    }
    const sel = host.selected && meshes[host.selected.id];
    if (sel) {
      selBox.setFromObject(sel);
      selBox.visible = true;
    } else selBox.visible = false;
  }

  function aim(): void {
    const fo = host.followed();
    // behind it; held still while it is dragged (see the 2D view's track())
    if (fo && fo !== host.dragging) {
      orbit.tx = fo.x;
      orbit.ty = fo.y;
      orbit.theta = fo.rot + 180 + orbit.off;
    }
    const th = orbit.theta * DEG;
    const ph = orbit.phi * DEG;
    cam.position.set(orbit.tx + orbit.dist * Math.sin(ph) * Math.cos(th), orbit.dist * Math.cos(ph), -orbit.ty - orbit.dist * Math.sin(ph) * Math.sin(th));
    cam.lookAt(orbit.tx, fo ? 0.07 : 0, -orbit.ty);
  }

  const ray: Three = new THREE.Raycaster();
  const plane: Three = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitV: Three = new THREE.Vector3();
  const allMeshes = (): Three[] => Object.keys(meshes).map((k) => meshes[k]);
  function aimRay(cx: number, cy: number): void {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), cam);
  }
  function floorAt(cx: number, cy: number): FloorHit | null {
    aimRay(cx, cy);
    if (!ray.ray.intersectPlane(plane, hitV)) return null;
    let under: Obj | null = null;
    if (!host.dragging) {
      // an object hit by the ray wins over the floor under it (its top is above the floor)
      const hits = ray.intersectObjects(allMeshes(), true);
      for (let i = 0; i < hits.length && !under; i++) under = host.byId[hits[i].object.userData.kitId] || null;
    }
    return [hitV.x, -hitV.z, under];
  }

  let need = true;
  let raf = 0;
  let alive = true;
  function draw(): void {
    raf = 0;
    if (!alive || !host.visible) return;
    if (!need) return;
    need = false;
    stage.background = new THREE.Color(host.theme().bg);
    sync();
    aim();
    renderer.render(stage, cam);
    if (host.running) frame();
  }
  function frame(): void {
    if (!raf && alive) raf = requestAnimationFrame(draw);
  }
  function resize(): void {
    const w = root.clientWidth;
    const h = root.clientHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / Math.max(1, h);
    cam.updateProjectionMatrix();
    need = true;
    frame();
  }
  function screenAt(cx: number, cy: number): ScreenHit | null {
    aimRay(cx, cy);
    const hits = ray.intersectObjects(allMeshes(), true);
    if (!hits.length || !hits[0].object.userData.screenOf || !hits[0].uv) return null;
    return { id: hits[0].object.userData.screenOf, u: hits[0].uv.x, v: 1 - hits[0].uv.y };
  }

  host.bindPointer(
    renderer.domElement,
    floorAt,
    (dx, dy, pan) => {
      if (pan) {
        // the camera looks along (-cos th, -sin th) on the floor; its right is (-sin th, cos th)
        const k = orbit.dist / 700;
        const th = orbit.theta * DEG;
        const c = Math.cos(th);
        const sn = Math.sin(th);
        orbit.tx += (sn * dx - c * dy) * k;
        orbit.ty += (-c * dx - sn * dy) * k;
      } else {
        if (host.followed()) orbit.off -= dx * 0.4;
        else orbit.theta -= dx * 0.4;
        orbit.phi = clamp(orbit.phi - dy * 0.3, 5, 88);
      }
      need = true;
      frame();
    },
    (d) => {
      orbit.dist = clamp(orbit.dist * (d > 0 ? 1.1 : 0.9), 0.2, 20);
      need = true;
      frame();
    },
    screenAt,
  );
  window.addEventListener('resize', resize);
  resize();
  return {
    follow(o) {
      if (o) {
        orbit.dist = 0.42;
        orbit.off = 0;
        orbit.phi = 58;
      } else {
        const fl = host.world.scene.floor;
        orbit.dist = Math.max(fl.w, fl.h) * 1.25;
        orbit.tx = orbit.ty = 0;
        orbit.theta = -90;
        orbit.phi = 52;
      }
      need = true;
      frame();
    },
    dirty() {
      need = true;
      frame();
    },
    destroy() {
      alive = false;
      window.removeEventListener('resize', resize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
