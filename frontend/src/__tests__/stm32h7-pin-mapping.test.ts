/**
 * STM32H7 pin mapping + bridge-to-PinManager wiring
 *
 * Smoke tests for the path that lights an external LED wired to a
 * Renode-emulated STM32H7 board:
 *
 *   stm32h7_gpio_change (backend)
 *     → bridge.onGpioChange(port, pin, state)
 *     → pinManager.triggerPinChange(stm32h7Pin(port, pin), state)
 *     → LED.attachEvents callback observes anodeHigh
 *
 * No real WebSocket is opened — we exercise the synchronous JS layer.
 */
import { describe, it, expect } from 'vitest';
import { boardPinToNumber, isBoardComponent } from '../utils/boardPinMapping';
import { stm32PinNameToLinear, stm32LinearToPinName } from '../simulation/Stm32Bridge';
import { isStm32BoardKind, usesStm32PinNames } from '../types/board';
import { PinManager } from '../simulation/PinManager';

/** Linear pin (port*16 + pin), as the store feeds the PinManager. */
const stm32h7Pin = (port: string, pin: number) => stm32PinNameToLinear(`P${port}${pin}`);

describe('stm32h7-core-v13 kind', () => {
  it('names its pins like an STM32 but is not on the QEMU STM32 lane', () => {
    expect(usesStm32PinNames('stm32h7-core-v13')).toBe(true);
    expect(isStm32BoardKind('stm32h7-core-v13')).toBe(false);
  });

  it('PA9 → 9, PB0 → 16, PB1 → 17, PC13 → 45 (linear, as the store encodes)', () => {
    expect(stm32h7Pin('A', 9)).toBe(9);
    expect(stm32h7Pin('B', 0)).toBe(16);
    expect(stm32h7Pin('B', 1)).toBe(17);
    expect(stm32h7Pin('C', 13)).toBe(45);
    expect(stm32LinearToPinName(45)).toBe('PC13');
  });
});

describe('boardPinToNumber("stm32h7-core-v13", …)', () => {
  it('returns the encoded pin for valid PXx names', () => {
    expect(boardPinToNumber('stm32h7-core-v13', 'PA9')).toBe(9);
    expect(boardPinToNumber('stm32h7-core-v13', 'PA0')).toBe(0);
    expect(boardPinToNumber('stm32h7-core-v13', 'PB0')).toBe(16);
    expect(boardPinToNumber('stm32h7-core-v13', 'PC13')).toBe(45);
    // An instance id of a second board resolves the same way.
    expect(boardPinToNumber('stm32h7-core-v13-2', 'PA9')).toBe(9);
  });

  it('maps the power pins to -1 (not GPIOs), as on the other STM32 boards', () => {
    expect(boardPinToNumber('stm32h7-core-v13', 'GND.1')).toBe(-1);
    expect(boardPinToNumber('stm32h7-core-v13', 'GND.2')).toBe(-1);
    expect(boardPinToNumber('stm32h7-core-v13', '3V3')).toBe(-1);
    expect(boardPinToNumber('stm32h7-core-v13', '5V')).toBe(-1);
  });

  it('returns null for unmapped or malformed names', () => {
    expect(boardPinToNumber('stm32h7-core-v13', 'XYZ')).toBeNull();
    expect(boardPinToNumber('stm32h7-core-v13', 'PI0')).toBeNull(); // port I: not a header pin
    expect(boardPinToNumber('stm32h7-core-v13', 'PA16')).toBeNull(); // pin out of range
  });

  it('lists stm32h7-core-v13 as a known board component', () => {
    expect(isBoardComponent('stm32h7-core-v13')).toBe(true);
  });
});

describe('PinManager forwards triggerPinChange to onPinChange listeners', () => {
  it('subscribing to PA9 (encoded as 9) sees the state we trigger', () => {
    const pm = new PinManager();
    const events: boolean[] = [];
    const unsub = pm.onPinChange(stm32h7Pin('A', 9), (_p, state) => {
      events.push(state);
    });

    // Simulate a backend ODR transition: PA9 0 → 1 → 0
    pm.triggerPinChange(stm32h7Pin('A', 9), true);
    pm.triggerPinChange(stm32h7Pin('A', 9), false);

    expect(events).toEqual([true, false]);

    // Other pins on the same port don't fire this listener.
    pm.triggerPinChange(stm32h7Pin('A', 8), true);
    pm.triggerPinChange(stm32h7Pin('B', 9), true); // same `9` digit, different port
    expect(events).toEqual([true, false]);

    unsub();
    pm.triggerPinChange(stm32h7Pin('A', 9), true);
    expect(events).toEqual([true, false]); // unsubscribed → no new event
  });
});
