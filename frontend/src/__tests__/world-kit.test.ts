/**
 * The World kit and the two parts its robots are built from.
 *
 *  - dc-motor: drive = level(M+) - level(M-), a chopped pin counting as its
 *    duty. Behind an L293D whose enable is chopped by analogWrite, the edges
 *    the outputs also report used to set the level to 1 or 0 one by one, so
 *    the motor flapped between full speed and off and a robot drove at full
 *    speed whatever the sketch wrote.
 *    A duty of exactly 1 is a steady HIGH whatever the pin's latch says: on
 *    a board with hardware PWM (ESP32 LEDC) the latch stays LOW, and the
 *    motor stopped when the firmware asked for full speed. An open terminal
 *    carries no current (M+ on 5 V alone ran the motor), and a terminal on a
 *    transistor is switched by its base or gate, not at the base's level
 *    (the motor ran while the pin was LOW).
 *  - line-sensor: DO HIGH over a dark surface, from the reflectance the World
 *    (or the sensor panel) writes; written again on every write and when a
 *    board starts, since Stop and Run boot a board that has lost its inputs
 *    with the parts still attached.
 *  - replaceKitScene: an edit made with the mouse goes back into the page,
 *    unless the page's scene was edited since the page loaded it.
 *  - the runtime with the kit in it parses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/MotorDriverParts';
import '../simulation/parts/RobotParts';
import { PinManager } from '../simulation/PinManager';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { traceDetailed } from '../simulation/PinTrace';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { describeWorld, readPartOutputs } from '../world/worldCatalog';
import { kitSceneText, replaceKitScene, sameKitScene } from '../world/WorldHost';
import { choppedPinLevel } from '../simulation/parts/partUtils';
import { WORLD_RUNTIME_JS } from '../world/worldRuntime';

const UNO = 'arduino-uno';
const at = (componentId: string, pinName: string) => ({ componentId, pinName });

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

function attach(id: string, metadataId: string, el: Record<string, unknown>, sim: Record<string, unknown>): void {
  const logic = PartSimulationRegistry.get(metadataId);
  if (!logic?.attachEvents) throw new Error('no logic for ' + metadataId);
  const getPin = (pin: string) => traceDetailed(useSimulatorStore.getState(), id, pin, 0).arduinoPin;
  stops.push(logic.attachEvents(el as never, sim as never, getPin, id));
}

/** An L293D on an Uno (EN1 on 5, IN1 on 7, IN2 on 8) with a motor on OUT1/OUT2. */
function motorBehindL293d(pm: PinManager) {
  const links: Array<[ReturnType<typeof at>, ReturnType<typeof at>]> = [
    [at(UNO, '5'), at('u1', 'EN1')],
    [at(UNO, '7'), at('u1', 'IN1')],
    [at(UNO, '8'), at('u1', 'IN2')],
    [at(UNO, '5V'), at('u1', 'VCC1')],
    [at('u1', 'GND.1'), at(UNO, 'GND')],
    [at('u1', 'OUT1'), at('m1', 'M+')],
    [at('u1', 'OUT2'), at('m1', 'M-')],
  ];
  useSimulatorStore.setState({
    boards: [{ id: UNO, boardKind: UNO }],
    components: [
      { id: 'u1', metadataId: 'motor-driver-l293d', properties: {} },
      { id: 'm1', metadataId: 'dc-motor', properties: { rpm: 200 } },
    ],
    wires: links.map(([a, b], i) => ({ id: `w${i}`, start: a, end: b })),
  } as never);
  const motor: Record<string, unknown> = {};
  attach('u1', 'motor-driver-l293d', {}, { pinManager: pm });
  attach('m1', 'dc-motor', motor, { pinManager: pm });
  return motor;
}

describe('dc-motor', () => {
  it('turns at the duty of a chopped enable, through the PWM edges', () => {
    const pm = new PinManager();
    const motor = motorBehindL293d(pm);
    pm.triggerPinChange(7, true, 'mcu');   // IN1 high, IN2 low: forward
    pm.triggerPinChange(8, false, 'mcu');
    pm.updatePwm(5, 150 / 255);            // analogWrite(5, 150)
    for (let i = 0; i < 9; i++) pm.triggerPinChange(5, i % 2 === 0, 'mcu');   // the edges
    expect(motor.drive).toBeCloseTo(150 / 255, 3);
    expect(motor.speed).toBeCloseTo((150 / 255) * 200, 1);
  });

  it('runs at full drive at a duty of 1 with the latch low (hardware PWM)', () => {
    const pm = new PinManager();
    const motor = motorBehindL293d(pm);
    pm.triggerPinChange(7, true, 'mcu');
    pm.triggerPinChange(8, false, 'mcu');
    pm.updatePwm(5, 0.6);                  // LEDC: the duty alone, pin 5's latch stays LOW
    expect(motor.drive).toBeCloseTo(0.6, 3);
    pm.updatePwm(5, 1);                    // analogWrite(EN, 255) on an ESP32
    expect(pm.getPinState(5)).toBe(false);
    expect(motor.drive).toBe(1);
    pm.updatePwm(5, 0);
    expect(motor.drive).toBe(0);
    expect(choppedPinLevel(pm, 5)).toBe(0);
    pm.updatePwm(5, 1.5);
    expect(choppedPinLevel(pm, 5)).toBe(1);
  });

  it('turns backwards, stops and runs at full drive', () => {
    const pm = new PinManager();
    const motor = motorBehindL293d(pm);
    pm.updatePwm(5, 0.5);
    pm.triggerPinChange(5, true, 'mcu');
    pm.triggerPinChange(7, false, 'mcu');
    pm.triggerPinChange(8, true, 'mcu');
    expect(motor.drive).toBeCloseTo(-0.5, 3);
    // analogWrite(5, 0): the compare output off, the pin low
    pm.triggerPinChange(5, false, 'mcu');
    pm.updatePwm(5, 0);
    expect(motor.drive).toBe(0);
    // analogWrite(5, 255): a plain HIGH
    pm.triggerPinChange(5, true, 'mcu');
    expect(motor.drive).toBe(-1);
  });

  it('is a World output', () => {
    // the element's live speed is `speed`; its `rpm` is the no-load property
    expect(readPartOutputs('dc-motor', { drive: 0.4, speed: 80, rpm: 200 })).toEqual({ drive: 0.4, rpm: 80 });
    expect(readPartOutputs('dc-motor', { drive: 3 })).toEqual({ drive: 1, rpm: 0 });
    const info = describeWorld([{ id: UNO, boardKind: UNO }], [
      { id: 'm1', metadataId: 'dc-motor', properties: {} },
      { id: 's1', metadataId: 'line-sensor', properties: {} },
    ], [], 'dark');
    expect(info.parts[0]).toMatchObject({ id: 'm1', outputs: ['drive', 'rpm'], board: UNO });
    expect(info.parts[1].inputs).toEqual([
      expect.objectContaining({ key: 'reflectance', kind: 'number', min: 0, max: 100 }),
    ]);
  });
});

/** A motor on the canvas with `links`, attached to `pm`. */
function motorWired(pm: PinManager, links: Array<[ReturnType<typeof at>, ReturnType<typeof at>]>, extra: Array<Record<string, unknown>> = []) {
  useSimulatorStore.setState({
    boards: [{ id: UNO, boardKind: UNO }],
    components: [{ id: 'm1', metadataId: 'dc-motor', properties: { rpm: 200 } }, ...extra],
    wires: links.map(([a, b], i) => ({ id: `w${i}`, start: a, end: b })),
  } as never);
  const motor: Record<string, unknown> = {};
  attach('m1', 'dc-motor', motor, { pinManager: pm });
  return motor;
}

describe('dc-motor terminals', () => {
  it('stands still with a terminal open', () => {
    const motor = motorWired(new PinManager(), [[at(UNO, '5V'), at('m1', 'M+')]]);
    expect(motor.drive).toBe(0);
    expect(motor.speed).toBe(0);
  });

  it('turns straight on a pin, at its duty, and at the speed the element holds', () => {
    const pm = new PinManager();
    const motor = motorWired(pm, [[at(UNO, '9'), at('m1', 'M+')], [at('m1', 'M-'), at(UNO, 'GND')]]);
    expect(motor.drive).toBe(0);
    pm.triggerPinChange(9, true, 'mcu');
    expect(motor.drive).toBe(1);
    pm.updatePwm(9, 0.25);
    expect(motor.drive).toBeCloseTo(0.25, 3);
    motor.rpm = 120;                       // the property dialog changed the no-load speed
    pm.updatePwm(9, 0.5);
    expect(motor.speed).toBeCloseTo(60, 3);
  });

  it('is switched by an NPN on its low side: on with the pin HIGH', () => {
    const pm = new PinManager();
    const motor = motorWired(pm, [
      [at(UNO, '5V'), at('m1', 'M+')],
      [at('m1', 'M-'), at('q1', 'C')],
      [at('q1', 'E'), at(UNO, 'GND')],
      [at('q1', 'B'), at('r1', '1')],
      [at('r1', '2'), at(UNO, '9')],
    ], [
      { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
      { id: 'r1', metadataId: 'resistor', properties: { value: '1000' } },
    ]);
    expect(motor.drive).toBe(0);           // pin 9 LOW: the transistor is off
    pm.triggerPinChange(9, true, 'mcu');
    expect(motor.drive).toBe(1);
    pm.updatePwm(9, 0.4);
    expect(motor.drive).toBeCloseTo(0.4, 3);
    pm.updatePwm(9, 0);
    pm.triggerPinChange(9, false, 'mcu');
    expect(motor.drive).toBe(0);
  });

  it('is switched by a P-channel MOSFET on its high side: on with the pin LOW', () => {
    const pm = new PinManager();
    const motor = motorWired(pm, [
      [at('q1', 'S'), at(UNO, '5V')],
      [at('q1', 'D'), at('m1', 'M+')],
      [at('m1', 'M-'), at(UNO, 'GND')],
      [at('q1', 'G'), at(UNO, '9')],
    ], [{ id: 'q1', metadataId: 'mosfet-irf9540', properties: {} }]);
    pm.triggerPinChange(9, true, 'mcu');
    expect(motor.drive).toBe(0);
    pm.triggerPinChange(9, false, 'mcu');
    expect(motor.drive).toBe(1);
  });
});

describe('line-sensor', () => {
  it('drives DO HIGH over dark tape and LOW over the mat', () => {
    useSimulatorStore.setState({
      boards: [{ id: UNO, boardKind: UNO }],
      components: [{ id: 's1', metadataId: 'line-sensor', properties: {} }],
      wires: [{ id: 'w0', start: at(UNO, '2'), end: at('s1', 'DO') }],
    } as never);
    const pins: Array<[number, boolean]> = [];
    const el: Record<string, unknown> = {};
    attach('s1', 'line-sensor', el, {
      pinManager: new PinManager(),
      setPinState: (pin: number, v: boolean) => pins.push([pin, v]),
    });
    expect(pins.at(-1)).toEqual([2, false]);   // a white mat by default
    dispatchSensorUpdate('s1', { reflectance: 8 });
    expect(pins.at(-1)).toEqual([2, true]);
    expect(el.out).toBe(true);
    dispatchSensorUpdate('s1', { reflectance: 94 });
    expect(pins.at(-1)).toEqual([2, false]);
  });

  it('writes its level again on a repeated write and when a board starts', () => {
    useSimulatorStore.setState({
      boards: [{ id: UNO, boardKind: UNO, running: true }],
      components: [{ id: 's1', metadataId: 'line-sensor', properties: {} }],
      wires: [{ id: 'w0', start: at(UNO, '2'), end: at('s1', 'DO') }],
    } as never);
    const pins: Array<[number, boolean]> = [];
    attach('s1', 'line-sensor', {}, {
      pinManager: new PinManager(),
      setPinState: (pin: number, v: boolean) => pins.push([pin, v]),
    });
    dispatchSensorUpdate('s1', { reflectance: 7 });      // on the tape
    const before = pins.length;
    // Stop, then Run: the board boots with its inputs low, the parts stay attached
    useSimulatorStore.setState({ boards: [{ id: UNO, boardKind: UNO, running: false }] } as never);
    expect(pins.length).toBe(before);
    useSimulatorStore.setState({ boards: [{ id: UNO, boardKind: UNO, running: true }] } as never);
    expect(pins.length).toBe(before + 1);
    expect(pins.at(-1)).toEqual([2, true]);
    // the kit writes the same value again after its reset: it must reach the board
    dispatchSensorUpdate('s1', { reflectance: 7 });
    expect(pins.length).toBe(before + 2);
    expect(pins.at(-1)).toEqual([2, true]);
  });
});

describe('kit scene in the page', () => {
  const page = '<!doctype html><html><body>\n<script type="application/json" id="velxio-scene">\n{ "version": 1 }\n</script>\n<script>velxio.kit.start();</script>\n</body></html>';

  it('replaces the JSON block and keeps the rest', () => {
    const next = replaceKitScene(page, '{\n  "version": 1,\n  "view": "2d"\n}')!;
    expect(next).toContain('"view": "2d"');
    expect(next).not.toContain('{ "version": 1 }');
    expect(next).toContain('<script>velxio.kit.start();</script>');
    expect(next.startsWith('<!doctype html><html><body>')).toBe(true);
  });

  it('leaves a page without a scene alone, and cannot close the script early', () => {
    expect(replaceKitScene('<html><body>hi</body></html>', '{}')).toBeNull();
    const next = replaceKitScene(page, '{ "label": "</script><b>x</b>" }')!;
    expect(next.match(/<\/script>/g)!.length).toBe(2);
  });

  it('knows the scene the page holds from another one', () => {
    expect(kitSceneText(page)!.trim()).toBe('{ "version": 1 }');
    expect(kitSceneText('<html><body>hi</body></html>')).toBeNull();
    // spelling does not matter, the JSON does
    expect(sameKitScene(kitSceneText(page), '{"version":1}')).toBe(true);
    expect(sameKitScene(kitSceneText(page), '{ "version": 1, "view": "2d" }')).toBe(false);
    // the block keeps </script escaped, the kit sends it plain
    const saved = '{ "label": "</script>" }';
    expect(sameKitScene(kitSceneText(replaceKitScene(page, saved)!), saved)).toBe(true);
    // a block someone is in the middle of editing is not the scene the page loaded
    expect(sameKitScene('{ "version": 1, ', '{ "version": 1 }')).toBe(false);
    expect(sameKitScene('{ broken', '{ broken')).toBe(true);
  });

  it('ships the kit in the runtime, which parses', () => {
    expect(WORLD_RUNTIME_JS).toContain('function makeKit(velxio, send)');
    expect(WORLD_RUNTIME_JS).toContain('https://cdn.jsdelivr.net/npm/three@');
    expect(WORLD_RUNTIME_JS).not.toContain('__THREE_URL__');
    expect(() => new Function(WORLD_RUNTIME_JS)).not.toThrow();
  });
});
