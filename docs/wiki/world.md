# World: the circuit in a 3D or 2D scene

A **World** is one HTML page of the project, `world.html`, that puts the
circuit in a scene: the firmware lights the LEDs and turns the servos, the
scene shows it, and what happens in the scene (a button pressed, a finger
on a screen, a distance measured) goes back to the firmware.

Press **3D** in the canvas header to open it over the canvas. **Scene** runs
the page, **HTML** edits it, **Run** reloads it with the HTML as it is now,
**Files** holds the models and textures it loads, **Log** shows its
`console.*` and errors. With no HTML of its own the project runs the starter
World: every board screen on a stand (touch it with the mouse), LEDs, servos
and pushbuttons on a desk, and the first `.glb` among the Files.

The World travels with the project in the `.vlx` file (`world`: `html` and
`assets`, base64) and in examples (`world` field of `ExampleProject`, with
`open: true` to show it on load). Projects saved on the server carry no World
yet.

## Where it runs

- A sandboxed iframe (`sandbox="allow-scripts"`), so the page has an opaque
  origin: no cookies, no Velxio storage, no access to the editor.
  `localStorage` is a memory-only stand-in.
- Scripts, styles and files load only from `cdn.jsdelivr.net`, `unpkg.com`
  and `cdnjs.cloudflare.com`, plus inline code and `blob:` URLs (the
  Content-Security-Policy is in `frontend/src/world/worldRuntime.ts`).
  three.js: `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`
  (an import map for `three` and `three/addons/` is fine).
- `window.velxio` exists before the page's scripts run. It is the only link
  to the circuit.

## The velxio API

The API follows the public World spec of velxio.dev (`world/1`), so a World
written for velxio.dev runs here as long as it uses these calls; this fork
implements it from that description, and adds `touch`, `asset` and `assets`.

```js
const info = await velxio.ready();
// { boards: [{id, kind, name?, display?: {w, h, touch?}}],
//   parts:  [{id, type, board, outputs: [...], inputs: [{key, kind, min, max, unit, options?}],
//             display?: {w, h}, press?: true}],
//   theme: 'dark' | 'light' }

velxio.onFrame((f) => {          // about 125 times per second
  // f.t       seconds the boards have run since Run (null while stopped)
  // f.dt      seconds since the previous frame (0 while stopped): step physics with this
  // f.running true while a board runs
  // f.parts   { [id]: {on, brightness} LEDs, {on, r, g, b} RGB LEDs,
  //             {angle} servos and steppers, {on} buzzers }
});
velxio.set(partId, values);      // a sensor's inputs (the keys it lists, clamped):
                                 // the same values as its sensor panel's sliders
velxio.press(partId); velxio.release(partId);    // pushbuttons
const screen = velxio.display(id, { fps: 15 });  // a <canvas> following a screen:
                                                 // a panel board's or an ILI9341/SSD1306's
velxio.on('display:' + id, ({ canvas }) => { texture.needsUpdate = true; });
velxio.touch(boardId, x, y, pressed);            // touch a panel board's screen, in its pixels
const url = await velxio.asset('robot.glb');     // a file of the World, as a blob: URL
const files = await velxio.assets();             // [{name, mime, size}]
velxio.on('reset', fn);          // a board started: put the scene back
velxio.on('theme', fn);          // Velxio's dark/light theme changed
velxio.on('visibility', fn);     // the Scene tab was hidden or shown
velxio.on('parts', fn);          // parts were added or removed (the new info)
velxio.telemetry({ speed: 1.2 }); // shown in the World bar
```

The panel boards with a screen are `stm32h7-core-v13` (1024x600),
`esp32-4848s040` and `waveshare-rp2350-lcd4` (480x480).

## A model from a file

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }
</script>
<script type="module">
  import * as THREE from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  const gltf = await new GLTFLoader().loadAsync(await velxio.asset('robot.glb'));
  scene.add(gltf.scene);
</script>
```

Add `robot.glb` with **Files** (up to 24 MB per file).

## Code

- `frontend/src/world/worldRuntime.ts`: the page side (`window.velxio`), the
  CSP and the srcdoc.
- `frontend/src/world/WorldHost.ts`: the Velxio side: frames, sensors,
  buttons, screens, touch, files.
- `frontend/src/world/worldCatalog.ts`: what the World sees of the circuit.
- `frontend/src/world/useWorldStore.ts`: the World of the project.
- `frontend/src/world/starterWorld.html`: the starter World.
- `frontend/src/components/world/WorldPanel.tsx`: the panel.
