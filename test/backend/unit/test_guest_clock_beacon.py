"""The guest clock a QEMU ESP32 worker tells the page (esp32_worker.guest_clock_beacon).

A run under -icount (every ESP32-C3 run, a MicroPython run timing a sensor's
pulses) has a clock that counts instructions: on a 4848S040 app at shift 4 it
runs at about half the wall clock's rate, and it stands still when the
emulator does. A World scene stepped on the page's wall clock then moved its
robot twice as far between two looks of the firmware as the firmware thought.
The worker says what the clock reads and the page steps on that
(frontend/src/simulation/RemoteGuestClock.ts).
"""

from __future__ import annotations

import threading
import time

from app.services.esp32_worker import GUEST_CLOCK_BEACON_S, guest_clock_beacon


def _run(clock_ns, seconds: float, period_s: float = 0.005) -> list[dict]:
    out: list[dict] = []
    stopped = threading.Event()
    t = threading.Thread(target=guest_clock_beacon, args=(stopped, clock_ns, out.append, period_s))
    t.start()
    time.sleep(seconds)
    stopped.set()
    t.join(1)
    assert not t.is_alive()
    return out


def test_says_the_clock_in_microseconds():
    ticks = iter(range(10_000_000, 10**12, 7_654_321))     # ns: 10 ms, then 7.654321 ms a look
    out = _run(lambda: next(ticks), 0.08)
    assert len(out) >= 4
    assert out[0] == {'type': 'guest_clock', 'us': 10_000}
    assert out[1] == {'type': 'guest_clock', 'us': 17_654}
    assert all(isinstance(e['us'], int) for e in out)


def test_a_clock_that_stands_still_is_said_all_the_same():
    # the emulator has stopped: the page learns it from the same value again
    out = _run(lambda: 5_000_000_000, 0.06)
    assert len(out) >= 3
    assert {e['us'] for e in out} == {5_000_000}


def test_a_clock_that_cannot_be_read_does_not_end_the_beacon():
    calls = []

    def clock():
        calls.append(1)
        if len(calls) == 2:
            raise OSError('the machine is going away')
        return len(calls) * 1_000_000

    out = _run(clock, 0.08)
    assert [e['us'] for e in out[:3]] == [1000, 3000, 4000]


def test_the_period_keeps_the_page_smooth():
    # the page goes on for 80 ms at most past the last beacon (COAST_MS)
    assert GUEST_CLOCK_BEACON_S <= 0.04
