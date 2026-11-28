/**
 * The STM32H7's pads, as its Renode lane says them.
 *
 * The lane sent the ODR bit of every pin of ports A, B and C as a level, so
 * the page took all 48 pads for outputs: a level the circuit drove on one (a
 * line sensor on PB10) was dropped by the shim and never reached Renode, and
 * a timer channel in PWM (a motor's enable on PB8) was a pad stuck low.
 *
 * Now it says what each pad is (backend/app/services/stm32h7_pads.py):
 * `stm32h7_gpio_dir`, `stm32h7_gpio_change`, `stm32h7_pwm` and
 * `stm32h7_gpio_pull`, by port and pin, and the machine's clock
 * (`guest_clock`: Renode's virtual time, behind the wall clock on a busy
 * host). The PinManager knows a pad as port * 16 + pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: MockWebSocket | null = null;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() {
    MockWebSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  receive(type: string, data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
  inputs(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'stm32h7_gpio_input').map((m) => m.data);
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import {
  getBoardPinManager,
  getBoardSimulator,
  getStm32H7Bridge,
  useSimulatorStore,
} from '../store/useSimulatorStore';
import { guestMillis } from '../simulation/parts/partUtils';

const PB7 = 16 + 7, PB8 = 16 + 8, PB10 = 16 + 10, PB11 = 16 + 11, PA0 = 0;

function board(id: string) {
  useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
  useSimulatorStore.getState().addBoard('stm32h7-core-v13' as never, 0, 0, id);
  const bridge = getStm32H7Bridge(id)!;
  bridge.connect();
  const socket = MockWebSocket.last!;
  socket.open();
  const sim = getBoardSimulator(id) as unknown as { setPinState: (pin: number, v: boolean) => void };
  return { socket, bridge, sim, pm: getBoardPinManager(id)! };
}

beforeEach(() => {
  MockWebSocket.last = null;
});

describe('STM32H7: what the firmware does with its pads', () => {
  it('a timer channel in PWM is the pad\'s duty', () => {
    const { socket, pm } = board('h7-pwm');
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: 8, dir: 1 });
    socket.receive('stm32h7_pwm', { port: 'B', pin: 8, duty: 0.38 });
    expect(pm.getOutputPins().has(PB8)).toBe(true);
    expect(pm.getPwmValue(PB8)).toBeCloseTo(0.38);
    // PWM.deinit(): the channel stops, the pad is let go
    socket.receive('stm32h7_pwm', { port: 'B', pin: 8, duty: null });
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: 8, dir: 0 });
    expect(pm.getPwmValue(PB8)).toBe(0);
    expect(pm.getOutputPins().has(PB8)).toBe(false);
  });

  it('an output\'s level reaches the parts on port * 16 + pin', () => {
    const { socket, pm } = board('h7-out');
    const seen: Array<[number, boolean]> = [];
    pm.onPinChange(PB7, (pin, high) => seen.push([pin, high]));
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: 7, dir: 1 });
    socket.receive('stm32h7_gpio_change', { port: 'B', pin: 7, value: true });
    socket.receive('stm32h7_gpio_change', { port: 'B', pin: 7, value: false });
    expect(seen).toEqual([[PB7, true], [PB7, false]]);
  });

  it('a pad\'s pull is known to the circuit', () => {
    const { socket, pm } = board('h7-pull');
    socket.receive('stm32h7_gpio_pull', { port: 'B', pin: 11, pull: 'up' });
    socket.receive('stm32h7_gpio_pull', { port: 'A', pin: 0, pull: 'down' });
    expect(pm.getPinPull(PB11)).toBe(1);
    expect(pm.getPinPull(PA0)).toBe(2);
    socket.receive('stm32h7_gpio_pull', { port: 'B', pin: 11, pull: null });
    expect(pm.getPinPull(PB11)).toBe(0);
  });

  it('a pad that is not one is ignored', () => {
    const { socket, pm } = board('h7-bad');
    socket.receive('stm32h7_pwm', { port: 'Z', pin: 1, duty: 0.5 });
    socket.receive('stm32h7_pwm', { port: 'B', pin: 16, duty: 0.5 });
    socket.receive('stm32h7_gpio_dir', { port: 'BB', pin: 1, dir: 1 });
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: -1, dir: 1 });
    expect(pm.getOutputPins().size).toBe(0);
  });
});

describe('STM32H7: a level from the circuit', () => {
  it('reaches Renode on a pad the firmware does not drive', () => {
    const { socket, sim, pm } = board('h7-in');
    // the boot: the lane says the two LEDs are driven, and nothing of PB10
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: 0, dir: 1 });
    socket.receive('stm32h7_gpio_change', { port: 'B', pin: 0, value: true });
    sim.setPinState(PB10, true);                       // the line sensor says "dark"
    expect(socket.inputs()).toEqual([{ port: 'B', pin: 10, value: true }]);
    expect(pm.getPinState(PB10)).toBe(true);
  });

  it('written while the firmware drives the pad, is the pad\'s level once it is let go', () => {
    const { socket, sim, pm } = board('h7-release');
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: 10, dir: 1 });
    socket.receive('stm32h7_gpio_change', { port: 'B', pin: 10, value: false });
    sim.setPinState(PB10, true);
    // Renode is given the level all the same: it keeps it for when the pad is an input
    expect(socket.inputs()).toEqual([{ port: 'B', pin: 10, value: true }]);
    expect(pm.getPinState(PB10)).toBe(false);          // the parts see the firmware's level
    socket.receive('stm32h7_gpio_dir', { port: 'B', pin: 10, dir: 0 });
    expect(pm.getOutputPins().has(PB10)).toBe(false);
    expect(pm.getPinState(PB10)).toBe(true);
  });
});

describe('STM32H7: the machine\'s clock', () => {
  it('guestMillis follows guest_clock, and a new run starts without one', () => {
    const now = vi.spyOn(performance, 'now');
    const { socket, bridge } = board('h7-clock');
    const sim = getBoardSimulator('h7-clock')!;
    expect(guestMillis(sim as never)).toBeNull();
    // Renode at half speed: 10 ms of virtual time every 20 ms of the page's
    for (let i = 0; i < 12; i++) {
      now.mockReturnValue(9000 + i * 20);
      socket.receive('guest_clock', { us: 7_000_000 + i * 10_000 });
    }
    now.mockReturnValue(9000 + 11 * 20 + 16);          // one World frame after the last beacon
    expect(guestMillis(sim as never)).toBeCloseTo(7118, 0);
    bridge.disconnect();
    expect(guestMillis(sim as never)).toBeNull();
    now.mockRestore();
  });
});
