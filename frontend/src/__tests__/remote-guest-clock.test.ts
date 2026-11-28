/**
 * The clock of a board that runs in another process (RemoteGuestClock).
 *
 * A QEMU run under -icount counts instructions: a 4848S040 app at shift 4
 * runs at about half the wall clock's rate, and its clock stands still when
 * the emulator does. The World stepped its scene on the wall clock for such
 * a board, so a robot covered twice the ground between two looks of the
 * firmware that the firmware thought, and ran on while the emulator stood
 * still. The worker now says what the guest's clock reads (`guest_clock`,
 * every 20 ms) and the page goes on from there: through the bridge's
 * getGuestMicros(), which guestMillis() already asks first.
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
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { RemoteGuestClock } from '../simulation/RemoteGuestClock';
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import { guestMillis } from '../simulation/parts/partUtils';

/** Beacons 20 ms apart from page time `from`, the guest at `rate` of the wall clock. */
function feed(clock: RemoteGuestClock, from: number, count: number, rate: number, guestFrom = 1_000_000): number {
  let us = guestFrom;
  for (let i = 0; i < count; i++) {
    clock.update(us, from + i * 20);
    us += 20_000 * rate;
  }
  return us - 20_000 * rate; // the last value said
}

describe('RemoteGuestClock', () => {
  it('reads nothing until the board says its clock', () => {
    const clock = new RemoteGuestClock();
    expect(clock.read(0)).toBe(-1);
    clock.update(250_000, 10);
    expect(clock.read(10)).toBe(250_000);
  });

  it('goes on between two beacons at the rate the guest runs', () => {
    const clock = new RemoteGuestClock();
    const last = feed(clock, 1000, 10, 0.5); // half speed: 10 ms of guest a beacon
    // 10 ms of page time after the last beacon: 5 ms of guest time
    expect(clock.read(1000 + 9 * 20 + 10)).toBeCloseTo(last + 5_000, -1);
    // a scene stepped every 8 ms advances 4 ms a frame, and not 0, 0, 10
    const a = clock.read(1000 + 9 * 20 + 12);
    const b = clock.read(1000 + 9 * 20 + 20);
    expect(b - a).toBeCloseTo(4_000, -1);
  });

  it('stops with the emulator', () => {
    const clock = new RemoteGuestClock();
    const last = feed(clock, 0, 20, 1);
    // the same value again and again: the guest stands still
    for (let i = 0; i < 30; i++) clock.update(last, 400 + i * 20);
    const now = 400 + 29 * 20;
    const held = clock.read(now);
    expect(clock.read(now + 15)).toBe(held);
    // it ran on no further than a beacon past the last value that moved
    expect(held - last).toBeLessThanOrEqual(20_000);
  });

  it('stops when the board stops talking', () => {
    const clock = new RemoteGuestClock();
    const last = feed(clock, 0, 20, 1);
    const at = 19 * 20;
    expect(clock.read(at + 5_000)).toBe(clock.read(at + 80));
    expect(clock.read(at + 5_000) - last).toBeCloseTo(80_000, -2);
  });

  it('never goes back', () => {
    const clock = new RemoteGuestClock();
    feed(clock, 0, 20, 1);
    const shown = clock.read(19 * 20 + 19);
    // the next beacon says a little less than what the page had reckoned
    clock.update(1_000_000 + 19 * 20_000 + 15_000, 19 * 20 + 20);
    expect(clock.read(19 * 20 + 20)).toBeGreaterThanOrEqual(shown);
  });

  it('takes two beacons the network delivered together as one', () => {
    const clock = new RemoteGuestClock();
    feed(clock, 0, 10, 1);
    const at = 9 * 20;
    // 60 ms of silence, then three beacons in the same instant
    clock.update(1_000_000 + 10 * 20_000, at + 60);
    clock.update(1_000_000 + 11 * 20_000, at + 60);
    clock.update(1_000_000 + 12 * 20_000, at + 60);
    const a = clock.read(at + 60);
    const b = clock.read(at + 70);
    expect(a).toBe(1_000_000 + 12 * 20_000);
    expect(b - a).toBeGreaterThan(8_000); // about its real rate: 10 ms in 10 ms
    expect(b - a).toBeLessThan(12_000);
  });

  it('starts again with a board that was reset', () => {
    const clock = new RemoteGuestClock();
    feed(clock, 0, 20, 1, 30_000_000);
    clock.update(2_000, 500); // the machine started again: its clock is near 0
    expect(clock.read(500)).toBe(2_000);
    clock.update(22_000, 520);
    expect(clock.read(530)).toBeCloseTo(32_000, -2);
  });
});

describe('a QEMU board under -icount tells the page its clock', () => {
  beforeEach(() => {
    MockWebSocket.last = null;
  });

  it('none on host time: the page keeps its own clock', () => {
    const bridge = new Esp32Bridge('esp32', 'esp32');
    bridge.connect();
    MockWebSocket.last!.open();
    expect(bridge.getGuestMicros()).toBe(-1);
    expect(guestMillis(bridge as never)).toBeNull();
    bridge.disconnect();
  });

  it('guestMillis follows guest_clock', () => {
    const now = vi.spyOn(performance, 'now');
    const bridge = new Esp32Bridge('esp32c3', 'esp32-c3');
    bridge.connect();
    const ws = MockWebSocket.last!;
    ws.open();
    // the guest at half speed: 10 ms of its clock every 20 ms of the page's
    for (let i = 0; i < 12; i++) {
      now.mockReturnValue(5000 + i * 20);
      ws.receive('guest_clock', { us: 3_000_000 + i * 10_000 });
    }
    now.mockReturnValue(5000 + 11 * 20);
    expect(guestMillis(bridge as never)).toBeCloseTo(3110, 0);
    now.mockReturnValue(5000 + 11 * 20 + 16); // one World frame later
    expect(guestMillis(bridge as never)).toBeCloseTo(3118, 0);
    bridge.disconnect();
    now.mockRestore();
  });

  it('a new run starts with no clock', () => {
    const bridge = new Esp32Bridge('esp32c3', 'esp32-c3');
    bridge.connect();
    MockWebSocket.last!.open();
    MockWebSocket.last!.receive('guest_clock', { us: 9_000_000 });
    expect(bridge.getGuestMicros()).toBeGreaterThanOrEqual(9_000_000);
    bridge.disconnect();
    expect(bridge.getGuestMicros()).toBe(-1);
    bridge.connect();
    MockWebSocket.last!.open();
    expect(bridge.getGuestMicros()).toBe(-1);
    bridge.disconnect();
  });
});
