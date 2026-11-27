/**
 * RobotParts.ts — simulation of the parts a World kit robot is built from
 * (elements in components/velxio-components/RobotPartElements.ts).
 *
 * dc-motor     drive = level(M+) - level(M-), each terminal's level the
 *              time-average of what it is wired to: a pin (its PWM duty or
 *              its state), a supply rail (1), ground (0), or the output of a
 *              driver chip (the L293D's chip-like pads), open = 0. A motor
 *              straight on one pin with the other end on GND turns one way;
 *              across a bridge it turns both. `rpm` = drive x the no-load
 *              speed (property `rpm`, 200 by default: a TT gear motor at
 *              its rated voltage). The World reads both (worldCatalog).
 *
 * line-sensor  the World (or the sensor panel) writes `reflectance`, 0 for
 *              black tape to 100 for a white mat. DO is HIGH over a dark
 *              surface (below the `threshold` property, 50 by default) and
 *              LOW over a light one, as a TCRT5000 module's comparator
 *              drives it; AO falls from the rail toward 0 V as the surface
 *              gets lighter (the phototransistor pulls it down).
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { traceDetailed } from '../PinTrace';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { setAdcVoltage, analogRailVolts, elementNumber } from './partUtils';
import { sensorControlDefault } from '../sensorControlConfig';

const GROUND_RAIL = /^(GND|AGND|DGND|PGND|VSS|0V)/i;

PartSimulationRegistry.register('dc-motor', {
  attachEvents: (element, simulator, _getArduinoPinHelper, componentId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinManager = (simulator as any).pinManager;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = element as any;
    const unsubs: (() => void)[] = [];
    const level = new Map<string, number>();

    const component = useSimulatorStore.getState().components.find((c) => c.id === componentId);
    const noLoadRpm = elementNumber(component?.properties?.rpm, 200);

    const update = () => {
      const drive = Math.max(-1, Math.min(1, (level.get('M+') ?? 0) - (level.get('M-') ?? 0)));
      el.rpm = drive * noLoadRpm;
      el.drive = drive;
    };

    const watch = (name: string) => {
      let hit: { arduinoPin: number | null; railName?: string };
      try {
        hit = traceDetailed(useSimulatorStore.getState(), componentId, name, 0);
      } catch {
        hit = { arduinoPin: null };
      }
      const pin = hit.arduinoPin;
      if (pin === null) {
        level.set(name, 0); // open: no current through the winding
        return;
      }
      if (pin < 0) {
        level.set(name, GROUND_RAIL.test(hit.railName ?? '') ? 0 : 1);
        return;
      }
      if (!pinManager) return;
      // A chopped pin is its duty (the edges it also reports must not set
      // the level to 1 or 0 one by one); a pin that is not chopped is its
      // state. A driver chip publishes its outputs' duty the same way.
      const chopped = (): number | null => {
        const d = typeof pinManager.getPwmValue === 'function' ? Number(pinManager.getPwmValue(pin)) || 0 : 0;
        return d > 0 && d < 1 ? d : null;
      };
      level.set(name, chopped() ?? (pinManager.getPinState(pin) ? 1 : 0));
      unsubs.push(
        pinManager.onPinChange(pin, (_p: number, high: boolean) => {
          level.set(name, chopped() ?? (high ? 1 : 0));
          update();
        }),
      );
      if (typeof pinManager.onPwmChange === 'function') {
        unsubs.push(
          pinManager.onPwmChange(pin, (_p: number, d: number) => {
            const v = Number(d) || 0;
            level.set(name, v > 0 && v < 1 ? v : pinManager.getPinState(pin) ? 1 : 0);
            update();
          }),
        );
      }
    };

    watch('M+');
    watch('M-');
    update();
    return () => {
      unsubs.forEach((u) => u());
      el.drive = 0;
      el.rpm = 0;
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
    let lastDark: boolean | null = null;

    const apply = (reflectance: number) => {
      const r = Math.max(0, Math.min(100, reflectance));
      el.reflectance = r;
      const dark = r < threshold;
      el.out = dark;
      if (pinDO !== null && dark !== lastDark) simulator.setPinState(pinDO, dark);
      lastDark = dark;
      if (pinAO !== null) setAdcVoltage(simulator, pinAO, rail * (1 - r / 100));
    };

    apply(sensorControlDefault('line-sensor', 'reflectance', 100));
    registerSensorUpdate(componentId, (values) => {
      if (typeof values.reflectance === 'number') apply(values.reflectance);
    });
    return () => unregisterSensorUpdate(componentId);
  },
});
