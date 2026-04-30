/**
 * STM32H7 → external LED end-to-end (no WebSocket).
 *
 * Exercises the chain that lights an LED wired to an STM32 GPIO when the
 * firmware toggles ODR:
 *
 *   bridge.onGpioChange   ← what RenodeManager calls on the FE side
 *     → store handler installed in addBoard
 *     → pinManager.triggerPinChange(stm32EncodePin)
 *     → BasicParts 'led' attachEvents callback
 *     → element.value = anodeHigh && cathodeLow
 *
 * We bypass the bridge socket and call the handler directly. Goal: pin the
 * regression that left LEDs dark when the active simulator was a different
 * board than the one the LED's wire reached.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import { stm32EncodePin } from '../utils/boardPinMapping';
import '../simulation/parts/BasicParts'; // registers 'led'
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';

// Minimal stand-in for a Stm32BridgeShim — only the surface 'led'
// attachEvents touches: pinManager, isRunning, getCurrentCycles, …
function makeShim(pm: PinManager) {
  return {
    pinManager: pm,
    setPinState() {},
    isRunning: () => true,
    getCurrentCycles: () => -1,
    getClockHz: () => 480_000_000,
    getADC: () => null,
    getMCU: () => null,
    serialWrite: () => {},
    start: () => {},
    stop: () => {},
    reset: () => {},
    setSpeed: () => {},
    getSpeed: () => 1,
    loadHex: () => {},
    loadBinary: () => {},
  };
}

// Lightweight LED element double — `BasicParts.attachEvents('led')` writes
// `el.value` and `el.brightness`, which is all we observe.
function makeLedElement() {
  return { value: false, brightness: 0 };
}

describe('STM32 GPIO → LED blink (single board)', () => {
  let pm: PinManager;
  let bridgeOnGpioChange: ((p: string, n: number, v: boolean) => void) | null;

  beforeEach(() => {
    pm = new PinManager();
    // Replicates exactly what `addBoard` does for boardKind === 'stm32-h7-core-v13':
    bridgeOnGpioChange = (port, pin, state) => {
      pm.triggerPinChange(stm32EncodePin(port, pin), state);
    };
  });

  it('toggling PA9 lights the LED whose anode is wired to PA9 and cathode to GND', () => {
    const led = makeLedElement();
    const logic = PartSimulationRegistry.get('led');
    expect(logic?.attachEvents).toBeDefined();

    // Wire trace surrogate: anode 'A' → STM32 PA9 (encoded 9), cathode 'C' → GND (-1).
    const getArduinoPin = (pinName: string): number | null => {
      if (pinName === 'A') return stm32EncodePin('A', 9);
      if (pinName === 'C') return -1;
      return null;
    };

    const cleanup = logic!.attachEvents!(
      led as unknown as HTMLElement,
      makeShim(pm) as never,
      getArduinoPin,
      'led-1',
    );

    // Boot state: PA9 low → LED dark.
    expect(led.value).toBe(false);

    // Firmware drives PA9 HIGH (Pin('A9', Pin.OUT).on()).
    bridgeOnGpioChange!('A', 9, true);
    expect(led.value).toBe(true);

    // …and back to LOW (.off()).
    bridgeOnGpioChange!('A', 9, false);
    expect(led.value).toBe(false);

    // PB0 toggles must NOT bleed into PA9's listener (port-aware encoding).
    bridgeOnGpioChange!('B', 0, true);
    expect(led.value).toBe(false);

    cleanup?.();
  });

  it('LED with floating cathode never lights, even when PA9 is HIGH', () => {
    const led = makeLedElement();
    const logic = PartSimulationRegistry.get('led');

    // No 'C' wire at all — getArduinoPin returns null for cathode.
    const getArduinoPin = (pinName: string): number | null => {
      if (pinName === 'A') return stm32EncodePin('A', 9);
      return null;
    };

    const cleanup = logic!.attachEvents!(
      led as unknown as HTMLElement,
      makeShim(pm) as never,
      getArduinoPin,
      'led-2',
    );

    bridgeOnGpioChange!('A', 9, true);
    expect(led.value).toBe(false); // mirrors real hardware: open cathode = dark

    cleanup?.();
  });
});
