"""The guest clock a QEMU ESP32 worker tells the page (esp32_worker.guest_clock_beacon),
and the pace it is held to (esp32_worker.GuestPace).

A run under -icount (every ESP32-C3 run, a MicroPython run timing a sensor's
pulses) has a clock that counts instructions: on a 4848S040 app at shift 4 it
runs at about half the wall clock's rate, and it stands still when the
emulator does. A World scene stepped on the page's wall clock then moved its
robot twice as far between two looks of the firmware as the firmware thought.
The worker says what the clock reads and the page steps on that
(frontend/src/simulation/RemoteGuestClock.ts).

QEMU holds such a clock to the wall clock only while the guest is idle. A
guest that computes runs it as fast as the host executes: the C3 at shift 6
ran a loop at 2.67 times the wall clock, so a sketch's millis() outran real
time. GuestPace holds the emulator when the guest is ahead, and does not make
a guest that fell behind catch up.
"""

from __future__ import annotations

import threading
import time

from app.services.esp32_worker import GUEST_CLOCK_BEACON_S, GuestPace, guest_clock_beacon, guest_pace_loop


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


# ── the pace ─────────────────────────────────────────────────────────────────

MS = 1_000_000


def test_a_guest_on_time_is_left_alone():
    pace = GuestPace()
    assert pace.step(0, 1000 * MS) == 0
    for t in range(1, 50):                       # 4 ms a look, the guest at the wall clock's rate
        assert pace.step(4 * t * MS, (1000 + 4 * t) * MS) == 0
    # a little ahead (the vCPU ran to its next timer): not worth a hold
    assert pace.step(201 * MS + MS, (1000 + 200) * MS) == 0


def test_a_guest_ahead_is_held_for_what_it_is_ahead():
    pace = GuestPace()
    pace.step(0, 0)
    # it computed 10 ms of its clock in 4 ms of the wall clock
    assert pace.step(10 * MS, 4 * MS) == 6 * MS
    # after the hold it is on time: 10 ms each
    assert pace.step(10 * MS, 10 * MS) == 0


def test_a_hold_is_bounded():
    pace = GuestPace()
    pace.step(0, 0)
    # a clock that jumped far ahead: one hold does not freeze the emulator for long
    assert pace.step(500 * MS, 4 * MS) == GuestPace.MAX_HOLD_NS
    assert GuestPace.MAX_HOLD_NS <= 50 * MS


def test_a_guest_that_fell_behind_does_not_catch_up():
    pace = GuestPace()
    pace.step(0, 0)
    # a busy-wait the emulator runs slowly: 100 ms of its clock in a second
    assert pace.step(100 * MS, 1000 * MS) == 0
    # then it computes at twice the wall clock's rate: held at once, not after
    # it has made up the 900 ms it lost
    assert pace.step(108 * MS, 1004 * MS) == 4 * MS
    assert pace.step(108 * MS, 1008 * MS) == 0   # held 4 ms: on time again


def test_a_guest_a_little_behind_may_make_it_up():
    pace = GuestPace()
    pace.step(0, 0)
    assert pace.step(90 * MS, 100 * MS) == 0     # 10 ms behind: the clocks stay tied
    assert pace.step(104 * MS, 104 * MS) == 0    # it made them up, no hold
    assert pace.step(112 * MS, 106 * MS) == 6 * MS


def test_a_reset_ties_the_clocks_again():
    pace = GuestPace()
    pace.step(60_000 * MS, 0)
    assert pace.step(5 * MS, 4 * MS) == 0        # the machine started again near 0
    assert pace.step(15 * MS, 8 * MS) == 6 * MS


def test_the_loop_holds_the_emulator():
    clock = iter([0, 10 * MS, 10 * MS, 14 * MS])
    wall = iter([0, 4 * MS, 10 * MS, 14 * MS])
    held: list[float] = []
    stopped = threading.Event()

    def hold(seconds: float) -> None:
        held.append(seconds)

    def clock_ns() -> int:
        try:
            return next(clock)
        except StopIteration:
            stopped.set()
            raise

    t = threading.Thread(target=guest_pace_loop, args=(stopped, clock_ns, hold, 0.001, lambda: next(wall)))
    t.start()
    t.join(2)
    assert not t.is_alive()
    assert held == [0.006]
