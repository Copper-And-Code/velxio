/**
 * A level the circuit drives on a backend board's pad must reach the board.
 *
 * A part writes its level once: a line sensor on the tape at Run says "dark"
 * and nothing more until the robot moves. Two places lost that one write:
 *
 *  - the bridges dropped whatever was sent while the WebSocket of the run was
 *    still opening (the write comes within a few ms of Run, the handshake of
 *    a remote host takes longer), so the firmware read 0 on the tape;
 *  - the RP2350 shim dropped a level written while the firmware drove the pad
 *    (the boot uses GP10/GP11 for the SD card before the app makes them
 *    inputs), and nothing wrote it again when the pad was let go.
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
  get messages(): Array<{ type: string; data: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { Stm32H7Bridge } from '../simulation/Stm32H7Bridge';
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import {
  getBoardPinManager,
  getBoardSimulator,
  getStm32H7Bridge,
  useSimulatorStore,
} from '../store/useSimulatorStore';

const inputs = (s: MockWebSocket, type: string) => s.messages.filter((m) => m.type === type).map((m) => m.data);

beforeEach(() => {
  MockWebSocket.last = null;
});

describe('levels driven while the socket is opening', () => {
  it('RP2350: the last level of each pad follows the start message', () => {
    const bridge = new Stm32H7Bridge('b1', null, { prefix: 'rp2350_', board: 'waveshare-rp2350-lcd4' });
    bridge.connect();
    const socket = MockWebSocket.last!;
    bridge.setGpioInputPin(10, true);
    bridge.setGpioInputPin(11, true);
    bridge.setGpioInputPin(11, false);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.messages.map((m) => m.type)).toEqual(['rp2350_start', 'rp2350_gpio_input', 'rp2350_gpio_input']);
    expect(inputs(socket, 'rp2350_gpio_input')).toEqual([
      { pin: 10, value: true },
      { pin: 11, value: false },
    ]);
    // once open a level goes straight out, and is not sent twice
    bridge.setGpioInputPin(10, false);
    expect(inputs(socket, 'rp2350_gpio_input')).toHaveLength(3);
  });

  it('RP2350: a level set with no run in flight is not kept for the next one', () => {
    const bridge = new Stm32H7Bridge('b2', null, { prefix: 'rp2350_', board: 'waveshare-rp2350-lcd4' });
    bridge.setGpioInputPin(10, true);      // stopped: nothing to send it to
    bridge.connect();
    MockWebSocket.last!.open();
    expect(inputs(MockWebSocket.last!, 'rp2350_gpio_input')).toEqual([]);
    // a run that never opened leaves nothing behind either
    bridge.disconnect();
    bridge.connect();
    bridge.setGpioInputPin(11, true);
    bridge.disconnect();
    bridge.connect();
    MockWebSocket.last!.open();
    expect(inputs(MockWebSocket.last!, 'rp2350_gpio_input')).toEqual([]);
  });

  it('STM32H7: the same, by port and pin', () => {
    const bridge = new Stm32H7Bridge('b3');
    bridge.connect();
    const socket = MockWebSocket.last!;
    bridge.setGpioInput('A', 0, true);
    socket.open();
    expect(inputs(socket, 'stm32h7_gpio_input')).toEqual([{ port: 'A', pin: 0, value: true }]);
  });

  it('ESP32: the last level of each pin follows start_esp32', () => {
    const bridge = new Esp32Bridge('b4', 'esp32-4848s040' as never);
    bridge.connect();
    const socket = MockWebSocket.last!;
    bridge.sendPinEvent(40, true);
    bridge.sendPinEvent(41, false);
    bridge.sendPinEvent(40, false);
    bridge.sendPinEvent(40, true);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.messages[0].type).toBe('start_esp32');
    expect(inputs(socket, 'esp32_gpio_in')).toEqual([
      { pin: 40, state: 1 },
      { pin: 41, state: 0 },
    ]);
  });
});

describe('RP2350: a level written while the firmware drives the pad', () => {
  it('reaches the machine, and is the pad\'s level once it is let go', () => {
    const id = 'rp2350-inputs';
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard('waveshare-rp2350-lcd4' as never, 0, 0, id);
    const bridge = getStm32H7Bridge(id)!;
    const pm = getBoardPinManager(id)!;
    const sim = getBoardSimulator(id) as unknown as { setPinState: (pin: number, v: boolean) => void };
    bridge.connect();
    const socket = MockWebSocket.last!;
    socket.open();

    // the boot drives GP10 (the SD card), low
    socket.receive('rp2350_gpio_dir', { pin: 10, dir: 1 });
    socket.receive('rp2350_gpio_change', { pin: 10, value: false });
    expect(pm.getOutputPins().has(10)).toBe(true);

    // the line sensor on GP10 says "dark" meanwhile
    sim.setPinState(10, true);
    expect(inputs(socket, 'rp2350_gpio_input')).toEqual([{ pin: 10, value: true }]);
    expect(pm.getPinState(10)).toBe(false);          // the parts still see the firmware's level

    // the app makes GP10 an input
    socket.receive('rp2350_gpio_dir', { pin: 10, dir: 0 });
    expect(pm.getOutputPins().has(10)).toBe(false);
    expect(pm.getPinState(10)).toBe(true);
  });
});
