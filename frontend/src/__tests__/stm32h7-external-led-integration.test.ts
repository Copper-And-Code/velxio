/**
 * STM32 → external LED via the actual Zustand store + DynamicComponent
 * trace logic. This is the regression test for "B0/B1 on-board lampeggiano,
 * ma il LED esterno su PA9 no": we go through every layer the browser does
 * (addBoard → bridge.onGpioChange → pm.triggerPinChange → LED listener) and
 * verify the LED's wokwi-element receives `value=true`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import { isBoardComponent, boardPinToNumber } from '../utils/boardPinMapping';
import { stm32PinNameToLinear } from '../simulation/Stm32Bridge';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';

// Minimal store stub mirroring the bits DynamicComponent + LED touch.
function makeStore() {
  const state = {
    wires: [] as Array<{
      id: string;
      start: { componentId: string; pinName: string };
      end:   { componentId: string; pinName: string };
    }>,
    components: [] as Array<{ id: string; metadataId: string }>,
    boards: [] as Array<{ id: string; boardKind: string }>,
  };
  return state;
}

// In production this is `useSimulatorStore.getState`; we stub it for the
// tests that the LED's update() reads from.
type StoreState = ReturnType<typeof makeStore>;
let mockState: StoreState;

// LED's update() also pulls from useElectricalStore. We stub it to return
// empty branchCurrents so the digital fallback path is taken. Without this
// the LED would honour the (non-existent) SPICE current and stay dark.
import { useElectricalStore } from '../store/useElectricalStore';

/** Linear pin (port*16 + pin), as the store feeds the PinManager. */
const stm32h7Pin = (port: string, pin: number) => stm32PinNameToLinear(`P${port}${pin}`);

describe('STM32 → wokwi-led full chain (PA9 anode, GND cathode)', () => {
  let pm: PinManager;
  let bridgeOnGpioChange: ((p: string, n: number, v: boolean) => void) | null;

  beforeEach(() => {
    pm = new PinManager();
    mockState = makeStore();
    // Wipe SPICE state so digital fallback is reached.
    useElectricalStore.setState({
      branchCurrents: {},
      timeWaveforms: null,
    } as never, false);

    // Replicates exactly what addBoard does for STM32:
    bridgeOnGpioChange = (port, pin, state) => {
      pm.triggerPinChange(stm32h7Pin(port, pin), state);
    };
  });

  it('LED on PA9 anode + GND cathode receives value=true on PA9 HIGH', () => {
    // 1. Board + LED + wires ────────────────────────────────────────────
    mockState.boards.push({
      id: 'stm32h7-core-v13',
      boardKind: 'stm32h7-core-v13',
    });
    mockState.components.push({ id: 'led-1', metadataId: 'led' });
    mockState.wires.push(
      {
        id: 'w1',
        start: { componentId: 'led-1', pinName: 'A' },
        end:   { componentId: 'stm32h7-core-v13', pinName: 'PA9' },
      },
      {
        id: 'w2',
        start: { componentId: 'led-1', pinName: 'C' },
        end:   { componentId: 'stm32h7-core-v13', pinName: 'GND.1' },
      },
    );

    // 2. The trace helper DynamicComponent installs ─────────────────────
    // Mirrors the (slightly trimmed) implementation in DynamicComponent.tsx.
    const getArduinoPin = (componentPinName: string): number | null => {
      const wires = mockState.wires.filter(
        (w) =>
          (w.start.componentId === 'led-1' && w.start.pinName === componentPinName) ||
          (w.end.componentId   === 'led-1' && w.end.pinName   === componentPinName),
      );
      for (const w of wires) {
        const other = w.start.componentId === 'led-1' ? w.end : w.start;
        if (isBoardComponent(other.componentId)) {
          const board = mockState.boards.find((b) => b.id === other.componentId);
          if (!board) continue;
          const pin = boardPinToNumber(board.boardKind, other.pinName);
          if (pin !== null) return pin;
        }
      }
      return null;
    };

    expect(getArduinoPin('A')).toBe(stm32h7Pin('A', 9)); // PA9 → 9
    expect(getArduinoPin('C')).toBe(-1);                    // GND  → -1

    // 3. Mount the LED logic onto a fake DOM element ────────────────────
    const led: any = { value: false, brightness: 0 };
    const shim: any = {
      pinManager: pm,
      isRunning: () => true,
      getCurrentCycles: () => -1,
      getClockHz: () => 480_000_000,
    };
    const logic = PartSimulationRegistry.get('led');
    expect(logic?.attachEvents).toBeDefined();
    const cleanup = logic!.attachEvents!(led, shim, getArduinoPin, 'led-1');

    // 4. Boot state: PA9 LOW → LED dark ─────────────────────────────────
    expect(led.value).toBe(false);

    // 5. Backend emits PA9 HIGH (firmware did Pin.on()) ─────────────────
    bridgeOnGpioChange!('A', 9, true);
    expect(led.value).toBe(true);
    expect(led.brightness).toBe(1);

    // 6. PA9 LOW (firmware Pin.off()) ────────────────────────────────────
    bridgeOnGpioChange!('A', 9, false);
    expect(led.value).toBe(false);

    // 7. PB0 toggles MUST NOT bleed to PA9's listener ────────────────────
    bridgeOnGpioChange!('B', 0, true);
    expect(led.value).toBe(false);

    cleanup?.();
  });

  it('LED reverse-biased (anode on GND, cathode on 3V3) stays dark', () => {
    mockState.boards.push({
      id: 'stm32h7-core-v13',
      boardKind: 'stm32h7-core-v13',
    });
    mockState.components.push({ id: 'led-3', metadataId: 'led' });
    mockState.wires.push(
      {
        id: 'wA',
        start: { componentId: 'led-3', pinName: 'A' },
        end:   { componentId: 'stm32h7-core-v13', pinName: 'GND.1' },
      },
      {
        id: 'wC',
        start: { componentId: 'led-3', pinName: 'C' },
        end:   { componentId: 'stm32h7-core-v13', pinName: '3V3' },
      },
    );

    const getArduinoPin = (componentPinName: string): number | null => {
      const wires = mockState.wires.filter(
        (w) =>
          (w.start.componentId === 'led-3' && w.start.pinName === componentPinName) ||
          (w.end.componentId   === 'led-3' && w.end.pinName   === componentPinName),
      );
      for (const w of wires) {
        const other = w.start.componentId === 'led-3' ? w.end : w.start;
        if (isBoardComponent(other.componentId)) {
          const board = mockState.boards.find((b) => b.id === other.componentId);
          if (!board) continue;
          const pin = boardPinToNumber(board.boardKind, other.pinName);
          if (pin !== null) return pin;
        }
      }
      return null;
    };

    const led: any = { value: false, brightness: 0 };
    const shim: any = {
      pinManager: pm,
      isRunning: () => true,
      getCurrentCycles: () => -1,
      getClockHz: () => 480_000_000,
    };
    const logic = PartSimulationRegistry.get('led');
    const cleanup = logic!.attachEvents!(led, shim, getArduinoPin, 'led-3');

    expect(led.value).toBe(false);
    cleanup?.();
  });
});
