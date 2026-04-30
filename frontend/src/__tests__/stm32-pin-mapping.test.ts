/**
 * STM32H7 pin mapping + bridge-to-PinManager wiring
 *
 * Smoke tests for the path that lights an external LED wired to a
 * Renode-emulated STM32H7 board:
 *
 *   stm32_gpio_change (backend)
 *     → bridge.onGpioChange(port, pin, state)
 *     → pinManager.triggerPinChange(stm32EncodePin(port, pin), state)
 *     → LED.attachEvents callback observes anodeHigh
 *
 * No real WebSocket is opened — we exercise the synchronous JS layer.
 */
import { describe, it, expect } from 'vitest';
import {
  boardPinToNumber,
  stm32EncodePin,
  stm32DecodePin,
  isBoardComponent,
} from '../utils/boardPinMapping';
import { PinManager } from '../simulation/PinManager';

describe('stm32EncodePin / stm32DecodePin', () => {
  it('PA0…PH15 each encode to a unique 0..127 slot', () => {
    const seen = new Set<number>();
    for (const p of 'ABCDEFGH') {
      for (let i = 0; i < 16; i++) {
        const num = stm32EncodePin(p, i);
        expect(num).toBeGreaterThanOrEqual(0);
        expect(num).toBeLessThan(128);
        expect(seen.has(num)).toBe(false);
        seen.add(num);
        const back = stm32DecodePin(num);
        expect(back).toEqual({ port: p, pin: i });
      }
    }
    expect(seen.size).toBe(128);
  });

  it('PA9 → 9, PB0 → 16, PB1 → 17 (matches STM32H7_PINS layout)', () => {
    expect(stm32EncodePin('A', 9)).toBe(9);
    expect(stm32EncodePin('B', 0)).toBe(16);
    expect(stm32EncodePin('B', 1)).toBe(17);
    expect(stm32EncodePin('C', 13)).toBe(45);
  });
});

describe('boardPinToNumber("stm32-h7-core-v13", …)', () => {
  it('returns the encoded pin for valid PXx names', () => {
    expect(boardPinToNumber('stm32-h7-core-v13', 'PA9')).toBe(9);
    expect(boardPinToNumber('stm32-h7-core-v13', 'PA0')).toBe(0);
    expect(boardPinToNumber('stm32-h7-core-v13', 'PB0')).toBe(16);
    expect(boardPinToNumber('stm32-h7-core-v13', 'PH15')).toBe(127);
  });

  it('distinguishes GND (-1) from positive rails (-2) for LED biasing', () => {
    // GND-style → -1 (negative rail / always LOW)
    expect(boardPinToNumber('stm32-h7-core-v13', 'GND.1')).toBe(-1);
    expect(boardPinToNumber('stm32-h7-core-v13', 'GND.2')).toBe(-1);
    // VCC-style → -2 (positive rail / always HIGH)
    expect(boardPinToNumber('stm32-h7-core-v13', '3V3')).toBe(-2);
    expect(boardPinToNumber('stm32-h7-core-v13', '5V')).toBe(-2);
  });

  it('returns null for unmapped or malformed names', () => {
    expect(boardPinToNumber('stm32-h7-core-v13', 'XYZ')).toBeNull();
    expect(boardPinToNumber('stm32-h7-core-v13', 'PI0')).toBeNull(); // port I out of A..H
    expect(boardPinToNumber('stm32-h7-core-v13', 'PA16')).toBeNull(); // pin out of range
  });

  it('lists stm32-h7-core-v13 as a known board component', () => {
    expect(isBoardComponent('stm32-h7-core-v13')).toBe(true);
  });
});

describe('PinManager forwards triggerPinChange to onPinChange listeners', () => {
  it('subscribing to PA9 (encoded as 9) sees the state we trigger', () => {
    const pm = new PinManager();
    const events: boolean[] = [];
    const unsub = pm.onPinChange(stm32EncodePin('A', 9), (_p, state) => {
      events.push(state);
    });

    // Simulate a backend ODR transition: PA9 0 → 1 → 0
    pm.triggerPinChange(stm32EncodePin('A', 9), true);
    pm.triggerPinChange(stm32EncodePin('A', 9), false);

    expect(events).toEqual([true, false]);

    // Other pins on the same port don't fire this listener.
    pm.triggerPinChange(stm32EncodePin('A', 8), true);
    pm.triggerPinChange(stm32EncodePin('B', 9), true); // same `9` digit, different port
    expect(events).toEqual([true, false]);

    unsub();
    pm.triggerPinChange(stm32EncodePin('A', 9), true);
    expect(events).toEqual([true, false]); // unsubscribed → no new event
  });
});
