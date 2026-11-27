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
  // f.dt      simulated seconds since the previous frame (0 while stopped): step physics
  //           with this. It is the board's own clock where this tab has it (AVR, RP2040),
  //           so the scene keeps step with a firmware emulated slower than real time;
  //           the wall clock for the QEMU and Renode boards.
  // f.running true while a board runs
  // f.parts   { [id]: {on, brightness} LEDs, {on, r, g, b} RGB LEDs,
  //             {angle} servos and steppers, {on} buzzers,
  //             {drive, rpm} DC motors: drive -1..1, the duty across M+/M- }
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

## Kit scenes: `velxio.kit`

For robots on a mat there is no code to write: the page is a JSON scene, and
the kit draws it (3D with three.js, or 2D), runs the physics and the sensors on
the frames' simulated time, and lets you edit it with the mouse.

```html
<!doctype html>
<html><body>
<script type="application/json" id="velxio-scene">
{ "version": 1, "view": "3d", "floor": { "w": 2.4, "h": 1.6, "grid": true },
  "objects": [
    { "id": "track1", "type": "track", "shape": "loop", "x": 0, "y": 0, "w": 2.1, "h": 0.9, "tape": 0.022 },
    { "id": "robot1", "type": "robot", "preset": "diff2", "x": -0.3, "y": -0.439, "rot": 0,
      "bind": { "left": ["motorL"], "right": ["motorR"], "line": ["lineL", "lineR"], "sonar": "sonar1" } },
    { "id": "box1", "type": "box", "x": 0.7, "y": 0, "w": 0.15, "d": 0.15, "h": 0.15 }
  ] }
</script>
<script>velxio.kit.start();</script>
</body></html>
```

The format is the one of velxio.dev's World prompt; the kit is this fork's
own implementation (`frontend/src/world/worldKit.ts`). Metres and degrees; the
mat (`floor`, w x h, optional `color`) is centred on the origin, x to the
right, y away from the viewer, `rot` counter-clockwise from +x. Every object
has a unique `id`, `x`, `y`, and optional `rot`, `color`, `label`.

| type | fields | what it does |
|---|---|---|
| `robot` | `preset` `diff2` (15 x 10.5 cm), `diff4` (20 x 11.5, skid steer), `tank` (22.5 x 22, tracks), `maqueen-lite` (8.5 x 8.1); `bind` | drives from its motors, stops against solids, climbs steps up to 1 / 1.5 / 3 / 0.6 cm and ramps up to 17 / 20 / 30 / 14 degrees |
| `track` | `shape` `loop`, `oval`, `figure8`, `line`; `w`, `h` (the tape's outer edge), `tape` (width, ~0.022) | black tape on the mat, what line sensors read |
| `box`, `wall` | `w`, `d`, `h` | solid; the sonar sees it (lower than a robot's climb: drives onto it) |
| `cylinder` | `r`, `h` | solid, round |
| `ramp` | `profile` `wedge` (rises toward +x), `bridge` (up, flat, down), `hill`; `w`, `d`, `h` | robots ride it if gentle enough, else it stops them |
| `arm` | `bind`: `base`, `shoulder`, `elbow`, `gripper` servo ids | a four-servo arm that follows the servos |

A robot's `bind`: `left`, `right` (motor ids per side: `dc-motor` parts, or
any part with a `drive` output), `invertLeft` / `invertRight` (a side whose
forward is a negative drive), `line` (line sensor ids, left to right across
the front: 3 cm apart for two, 1.6 cm for more; the kit writes each one's
first input, `reflectance` 0..100 on the `line-sensor`), `sonar` (an HC-SR04:
`distance` in cm, every 30 ms of simulated time, three rays over +-7 degrees,
over objects lower than the sensor), `sonarServo` (a servo that turns the
sonar, 90 = ahead), `imu` (an MPU6050: acceleration with gravity and the
yaw rate on `gyroZ`), `display` (this fork: a board with a screen, or a
part with one, that rides on the robot; see below). A line follower starts on
the tape's centre line: on a loop centred at the origin, `y: -(h/2 - tape/2)`.

**A board on the robot.** `"display": "esp32-4848s040"` (a board id) mounts
that board's screen on the robot, at its real size (the 4" panels 8.6 cm, the
7" one 16.5 cm), on a post at the back, facing behind the robot and leaning
back by the robot's `displayTilt` (degrees from upright, 50 by default). It
shows the live picture and takes touches, in 3D and in 2D (where it is drawn on
top of the robot, its top toward the nose), so the app running on the board
is the robot's dashboard. The board's own GPIOs drive the robot, through pads
on its canvas frame (which of them the real boards' connectors break out is
still to be checked):

- ESP32-4848S040: IO1, IO2, IO40, IO41 (the QEMU worker: GPIO, LEDC PWM);
- RP2350-Touch-LCD-4: GP8, GP9 (UART1 on the board, PWM slice 4), GP10,
  GP11 (the TF slot's CLK and CMD, free without a card). The raspi-pico2
  machine publishes its pads in the GPIO block of its panel file (levels,
  direction, PWM duty from the PWM slices) and reads the levels the circuit
  drives from it; the lane sends `rp2350_gpio_change`, `rp2350_gpio_dir` and
  `rp2350_pwm`, and takes `rp2350_gpio_input`. `machine.reset()` and
  `machine.WDT` reset the board through its watchdog: the firmware starts
  again and every pad is let go, so the motors stop.

A level the circuit drives reaches a backend board whenever it is written: one
written while the WebSocket of the run is still opening is sent after the
start message, and on the RP2350 one written while the firmware still drives
the pad is the pad's level once it is let go.

A line sensor pair sits 1.6 cm apart by default (`lineSpacing` on the robot),
inside a 2.2 cm tape: on the tape both read black, and a robot that sees
neither has lost it.

**Follow.** The **Follow** button, or `"follow": "<robot id>"` at the top of
the scene, puts the camera close behind that robot and keeps it there (drag to
look from another side); in 2D it centres and zooms on it.

With the mouse: drag an object to move it, shift+drag (or Q / E on the
selected one) to turn it, drag empty space to orbit (3D) or pan (2D), right
or ctrl+drag to pan in 3D, the wheel to zoom. **3D** / **2D** switch the
view, **Reset** puts every robot back. A move goes back into the page's
JSON block (the HTML tab shows it), so it is saved with the project; robots
keep their start place, not where they drove to (Q / E turn the start
heading by the same step). The block keeps the keys the kit does not know.
An edit is written only over the scene the running page loaded: when the
JSON in the HTML tab was changed since the last Run, or does not parse, the
scene says so and leaves the page alone until the next Run. Missing or wrong
bindings are listed in the top right corner of the scene.

`velxio.kit.objects` (live places, speeds and readings), `velxio.kit.scene`
(the scene as written) and `velxio.kit.reset()` are there for a page that
adds its own code around the kit.

The parts a kit robot is made of:

- **DC Gear Motor** (`dc-motor`, pins `M+`, `M-`): turns at the duty across
  its pins, straight on a pin or behind a driver (the L293D); property `rpm`,
  the no-load speed at full drive (200). A terminal left open stops it. A
  terminal on a transistor's collector or drain is switched by the base or
  gate (the BJTs and MOSFETs of the picker: on with the pin HIGH for an NPN
  or N-channel part, LOW for a PNP or P-channel one), so a motor between 5 V
  and a 2N2222 runs at the PWM duty of the pin on the base.
- **IR Line Sensor** (`line-sensor`, pins `VCC`, `GND`, `DO`, `AO`): DO HIGH
  over a dark surface (below `threshold`, 50 %), AO falling toward 0 V as the
  surface gets lighter; its panel has the surface slider.

The gallery examples put them together:

- **Uno: Line Follower Robot (World kit)**: an L293D, two motors, two line
  sensors and an HC-SR04 on an Arduino Uno;
- **ESP32-4848S040: Line Robot with its screen (World kit)**: the panel board
  rides on a four-wheel robot; a MicroPython app drives the motors (PWM on IO1
  and IO2 into the L293D enables), reads the line sensors (IO40, IO41) and
  shows them on an LVGL dashboard with a STOP / START button;
- **RP2350-Touch-LCD-4: Line Robot with its screen (World kit)**: the same on
  the Waveshare board, GP8 / GP9 for the motors and GP10 / GP11 for the
  sensors.

Frames of a board whose clock this tab has (AVR, RP2040) carry its guest time;
for the QEMU and Renode boards a frame advances the scene by the wall time, at
most 20 ms, so a busy page slows the scene instead of letting it run ahead of
the sensor and motor messages.

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
- `frontend/src/world/worldKit.ts`: `velxio.kit`, the kit scenes.
- `frontend/src/world/WorldHost.ts`: the Velxio side: frames, sensors,
  buttons, screens, touch, files.
- `frontend/src/world/worldCatalog.ts`: what the World sees of the circuit.
- `frontend/src/world/useWorldStore.ts`: the World of the project.
- `frontend/src/world/starterWorld.html`: the starter World.
- `frontend/src/components/world/WorldPanel.tsx`: the panel.
- `frontend/src/simulation/parts/RobotParts.ts` and
  `frontend/src/components/velxio-components/RobotPartElements.ts`: the DC
  motor and the line sensor.
