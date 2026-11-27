/**
 * RobotParts.ts — simulation of the parts a World kit robot is built from
 * (elements in components/velxio-components/RobotPartElements.ts).
 *
 * dc-motor     drive = (level(M+) - level(M-)) x the share of the time both
 *              terminals conduct. A terminal's level is the time-average of
 *              what it is wired to: a pin (its PWM duty or its state), a
 *              supply rail (1), ground (0), or the output of a driver chip
 *              (the L293D's chip-like pads). An open terminal carries no
 *              current, so the motor stands still. A terminal on a
 *              transistor's collector or drain is switched: it is at the
 *              level of the emitter / source while the base / gate turns the
 *              transistor on (HIGH for an NPN or an N-channel MOSFET, LOW for
 *              a PNP or a P-channel one), and open otherwise. A motor
 *              straight on one pin with the other end on GND turns one way;
 *              across a bridge it turns both. `speed` = drive x the no-load
 *              speed (property `rpm`, 200 by default: a TT gear motor at its
 *              rated voltage). The World reads `drive` and the speed, as
 *              `rpm` (worldCatalog).
 *
 * line-sensor  the World (or the sensor panel) writes `reflectance`, 0 for
 *              black tape to 100 for a white mat. DO is HIGH over a dark
 *              surface (below the `threshold` property, 50 by default) and
 *              LOW over a light one, as a TCRT5000 module's comparator
 *              drives it; AO falls from the rail toward 0 V as the surface
 *              gets lighter (the phototransistor pulls it down). The level
 *              is written again when a board starts: Stop and Run boot a
 *              board whose inputs are all low, with the parts still attached.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { nodePins, traceDetailed } from '../PinTrace';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { setAdcVoltage, analogRailVolts, choppedPinLevel, elementNumber } from './partUtils';
import { sensorControlDefault } from '../sensorControlConfig';

const GROUND_RAIL = /^(GND|AGND|DGND|PGND|VSS|0V)/i;

/** A transistor a motor terminal can be switched through: the pin the load
 *  is on, the one that turns it on, the one on the rail, and the level of
 *  the control that makes it conduct. */
interface Switch {
  load: string;
  control: string;
  far: string;
  onHigh: boolean;
}
const NPN: Switch = { load: 'C', control: 'B', far: 'E', onHigh: true };
const PNP: Switch = { ...NPN, onHigh: false };
const NMOS: Switch = { load: 'D', control: 'G', far: 'S', onHigh: true };
const PMOS: Switch = { ...NMOS, onHigh: false };
const SWITCHES: Record<string, Switch> = {
  'bjt-2n2222': NPN,
  'bjt-bc547': NPN,
  'bjt-2n3055': NPN,
  'bjt-2n3906': PNP,
  'bjt-bc557': PNP,
  'mosfet-2n7000': NMOS,
  'mosfet-irf540': NMOS,
  'mosfet-fqp27p06': PMOS,
  'mosfet-irf9540': PMOS,
};

/** What a motor terminal is tied to: its level, 0..1, and the share of the
 *  time the path to it conducts (1 for a wire, 0 for an open terminal). */
interface End {
  level: () => number;
  on: () => number;
}
const OPEN: End = { level: () => 0, on: () => 0 };

PartSimulationRegistry.register('dc-motor', {
  attachEvents: (element, simulator, _getArduinoPinHelper, componentId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinManager = (simulator as any).pinManager;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = element as any;
    const unsubs: (() => void)[] = [];
    const state = useSimulatorStore.getState();

    const component = state.components.find((c) => c.id === componentId);
    const attachedRpm = elementNumber(component?.properties?.rpm, 200);
    // The no-load speed as the property dialog last set it: the element holds
    // it (DynamicComponent mirrors the properties onto the element).
    const noLoadRpm = () => {
      const live = Number(el.rpm);
      return Number.isFinite(live) && live > 0 ? live : attachedRpm;
    };

    let ends: [End, End] = [OPEN, OPEN];
    const update = () => {
      const [plus, minus] = ends;
      const drive = Math.max(-1, Math.min(1, (plus.level() - minus.level()) * plus.on() * minus.on()));
      el.drive = drive;
      el.speed = drive * noLoadRpm();
    };

    const watched = new Set<number>();
    /** Where (id, pinName) leads: a rail, a pin (followed from now on) or nothing. */
    const follow = (id: string, pinName: string, acrossDevices: boolean): End => {
      let hit: ReturnType<typeof traceDetailed>;
      try {
        hit = traceDetailed(state, id, pinName, 0);
      } catch {
        return OPEN;
      }
      const pin = hit.arduinoPin;
      // A pin reached across a device this part has no model for says nothing
      // about the terminal's level (a BJT's base is not its collector).
      if (pin === null || (hit.crossedActiveDevice && !acrossDevices)) return OPEN;
      if (pin < 0) {
        const v = GROUND_RAIL.test(hit.railName ?? '') ? 0 : 1;
        return { level: () => v, on: () => 1 };
      }
      if (!pinManager) return OPEN;
      if (!watched.has(pin)) {
        watched.add(pin);
        unsubs.push(pinManager.onPinChange(pin, update));
        if (typeof pinManager.onPwmChange === 'function') unsubs.push(pinManager.onPwmChange(pin, update));
      }
      return { level: () => choppedPinLevel(pinManager, pin), on: () => 1 };
    };

    const terminal = (name: string): End => {
      let pins: ReturnType<typeof nodePins> = [];
      try {
        pins = nodePins(state, componentId, name);
      } catch {
        return OPEN;
      }
      for (const p of pins) {
        const sw = SWITCHES[p.metadataId ?? ''];
        if (!sw || p.pinName !== sw.load) continue;
        // The control is followed across the base resistor only: a pin found
        // across another transistor would not be this one's control.
        const control = follow(p.componentId, sw.control, false);
        const far = follow(p.componentId, sw.far, false);
        return {
          level: far.level,
          on: () => far.on() * control.on() * (sw.onHigh ? control.level() : 1 - control.level()),
        };
      }
      return follow(componentId, name, false);
    };

    ends = [terminal('M+'), terminal('M-')];
    update();
    return () => {
      unsubs.forEach((u) => u());
      el.drive = 0;
      el.speed = 0;
    };
  },
});

PartSimulationRegistry.register('line-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = element as any;
    const pinDO = getArduinoPinHelper('DO');
    const pinAO = getArduinoPinHelper('AO');
    const component = useSimulatorStore.getState().components.find((c) => c.id === componentId);
    const threshold = elementNumber(component?.properties?.threshold, 50);
    const rail = analogRailVolts(simulator);
    let current = sensorControlDefault('line-sensor', 'reflectance', 100);

    // Every write reaches the board, also one that repeats the last level:
    // whoever writes (the World kit, the sensor panel) sends changes only,
    // and a board that restarted has lost what it was told.
    const apply = (reflectance: number) => {
      const r = Math.max(0, Math.min(100, reflectance));
      current = r;
      el.reflectance = r;
      const dark = r < threshold;
      el.out = dark;
      if (pinDO !== null) simulator.setPinState(pinDO, dark);
      if (pinAO !== null) setAdcVoltage(simulator, pinAO, rail * (1 - r / 100));
    };

    apply(current);
    registerSensorUpdate(componentId, (values) => {
      if (typeof values.reflectance === 'number') apply(values.reflectance);
    });
    // A board that starts reads its inputs afresh (Stop and Run do not attach
    // the parts again): give it the level the sensor is at.
    const anyRunning = () => useSimulatorStore.getState().boards.some((b) => b.running);
    let wasRunning = anyRunning();
    const unsubscribe = useSimulatorStore.subscribe(() => {
      const running = anyRunning();
      if (running && !wasRunning) apply(current);
      wasRunning = running;
    });
    return () => {
      unsubscribe();
      unregisterSensorUpdate(componentId);
    };
  },
});
