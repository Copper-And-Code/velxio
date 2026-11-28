"""
test_stm32h7_renode.py: the STM32H7_CORE VELXIO firmware in Renode, through
the lane the page uses (app/services/renode_manager.py), on the repo's own
platform file and binary server.

 - The clock. Renode's RCC keeps no PLL dividers, so the firmware counts
   5 MHz and sets SysTick and its timers for that, while the stock platform
   clocked them at 96 and 250 MHz: a millisecond of the firmware lasted 52 us
   (time.sleep_ms(2000) took 0.1 s, a 10 Hz timer fired 500 times a second).
   The platform now clocks them at 5 MHz: the firmware's time is Renode's
   virtual time, and the lane tells the page what it reads (`guest_clock`).
 - The boot. With the clock right, HAL_PWREx_EnableBkUpReg waited its full
   second, thirty times over, for a ready bit the platform did not set: 40 s
   to the prompt. PWR_CR2 has the bit now.
 - PWM. machine.PWM on a header pad is a timer channel: the lane says its
   duty (it said a pad stuck low), and that it stopped.
 - The pads. The lane says which pads the firmware drives, so the page can
   drive the others: a level on PB10 reaches Pin.value(). It said all 48 of
   three ports were outputs.

Needs `renode` in the PATH and the firmware (prebuilt/stm32h7/firmware.elf,
`scripts/fetch-prebuilt.sh`). Skipped when either is missing. One boot, about
half a minute in all.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time

import pytest

from app.services import renode_manager as rm

pytestmark = pytest.mark.skipif(
    not (shutil.which(rm.RENODE_BIN) and os.path.exists(rm.DEFAULT_FW)),
    reason='no renode in the PATH or no STM32H7 firmware (scripts/fetch-prebuilt.sh)')


class Board:
    """The lane, as the simulation WebSocket drives it."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        self.serial = ''
        self.mgr = rm.RenodeManager()
        self.id = 'h7-test-%d' % os.getpid()

    async def _on_event(self, kind: str, data: dict) -> None:
        if kind == 'serial_output':
            self.serial += data['data']
        else:
            self.events.append((kind, data))

    async def start(self) -> float:
        t0 = time.monotonic()
        self.mgr.start_instance(self.id, 'stm32h7-core-v13', self._on_event)
        await self.until(lambda: '>>> ' in self.serial, 120, 'the REPL prompt')
        boot = time.monotonic() - t0
        await asyncio.sleep(0.5)
        await self.mgr.send_serial_bytes(self.id, b'\x03\r\n')
        await asyncio.sleep(0.5)
        return boot

    async def stop(self) -> None:
        inst = self.mgr._instances.get(self.id)
        self.mgr.stop_instance(self.id)
        if inst:
            for _ in range(100):
                if inst.process is None or inst.process.poll() is not None:
                    break
                await asyncio.sleep(0.1)

    async def until(self, cond, timeout: float, what: str) -> None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if cond():
                return
            await asyncio.sleep(0.02)
        raise AssertionError('no %s; serial tail %r; last events %r'
                             % (what, self.serial[-200:], self.events[-6:]))

    async def run(self, line: str, timeout: float = 30) -> str:
        n = len(self.serial)
        await self.mgr.send_serial_bytes(self.id, line.encode() + b'\r\n')
        await self.until(lambda: '>>> ' in self.serial[n:], timeout, 'answer to %r' % line)
        return self.serial[n:].replace(line, '', 1).replace('>>> ', '').strip()

    def clock(self) -> int:
        return next(d['us'] for k, d in reversed(self.events) if k == 'guest_clock')

    def last(self, kind: str, pin: int, port: str = 'B'):
        return next((d for k, d in reversed(self.events)
                     if k == kind and d['port'] == port and d['pin'] == pin), None)

    async def event(self, kind: str, pin: int, field: str, want, port: str = 'B') -> None:
        def seen() -> bool:
            d = self.last(kind, pin, port)
            if d is None:
                return False
            got = d[field]
            if isinstance(want, float):
                return got is not None and abs(got - want) < 0.001
            return got == want
        await self.until(seen, 5, '%s %s%d %s=%r' % (kind, port, pin, field, want))


async def _scenario() -> dict:
    b = Board()
    out: dict = {}
    try:
        out['boot'] = await b.start()
        await b.run('import time, pyb; from machine import Pin, PWM')

        # ── the clock ────────────────────────────────────────────────────
        g0, w0 = b.clock(), time.monotonic()
        out['slept'] = int((await b.run(
            't=time.ticks_ms(); time.sleep_ms(2000); print(time.ticks_diff(time.ticks_ms(), t))')).split()[-1])
        await asyncio.sleep(0.1)
        out['sleep_guest'] = (b.clock() - g0) / 1e6
        out['sleep_wall'] = time.monotonic() - w0
        out['timer_calls'] = int((await b.run(
            'exec("n=[0]\\ndef cb(t): n[0]+=1\\ntm=pyb.Timer(6, freq=20, callback=cb)\\n'
            'time.sleep_ms(1000)\\ntm.deinit()\\nprint(n[0])")')).split()[-1])
        out['beacons'] = sum(1 for k, _ in b.events if k == 'guest_clock')
        clocks = [d['us'] for k, d in b.events if k == 'guest_clock']
        out['monotonic'] = all(a <= c for a, c in zip(clocks, clocks[1:]))

        # ── the pads the firmware drives ─────────────────────────────────
        out['driven_at_boot'] = sorted((d['port'], d['pin']) for k, d in b.events
                                       if k == 'stm32h7_gpio_dir' and d['dir'])
        await b.run('p = PWM(Pin("B8"), freq=1000, duty_u16=16384)')
        await b.event('stm32h7_pwm', 8, 'duty', 0.25)
        await b.event('stm32h7_gpio_dir', 8, 'dir', 1)
        await b.run('p.duty_u16(39322)')
        await b.event('stm32h7_pwm', 8, 'duty', 0.6)
        await b.run('p.deinit()')
        await b.event('stm32h7_pwm', 8, 'duty', None)
        await b.event('stm32h7_gpio_dir', 8, 'dir', 0)

        await b.run('o = Pin("B7", Pin.OUT, value=1)')
        await b.event('stm32h7_gpio_change', 7, 'value', True)
        await b.event('stm32h7_gpio_dir', 7, 'dir', 1)
        await b.run('o.value(0)')
        await b.event('stm32h7_gpio_change', 7, 'value', False)

        # ── a level from the circuit ─────────────────────────────────────
        await b.run('i = Pin("B10", Pin.IN); u = Pin("B11", Pin.IN, Pin.PULL_UP)')
        await b.event('stm32h7_gpio_pull', 11, 'pull', 'up')
        out['low'] = (await b.run('print(i.value())')).split()[-1]
        await b.mgr.set_gpio_input(b.id, 'B', 10, True)
        out['high'] = (await b.run('print(i.value())')).split()[-1]
        await b.mgr.set_gpio_input(b.id, 'B', 10, False)
        out['low_again'] = (await b.run('print(i.value())')).split()[-1]
        out['b10_said_driven'] = b.last('stm32h7_gpio_dir', 10) is not None
    finally:
        await b.stop()
    return out


@pytest.fixture(scope='module')
def run():
    return asyncio.run(_scenario())


def test_the_firmware_boots_without_waiting_for_the_backup_regulator(run):
    # 40 s with the ready bit missing; about 11 s, most of it Renode starting
    assert run['boot'] < 30


def test_a_millisecond_of_the_firmware_is_a_millisecond(run):
    assert run['slept'] in range(1999, 2010)
    # the lane's clock is the one the firmware slept on (it read 0.1 s)
    assert 1.9 < run['sleep_guest'] < 2.6
    # Renode holds it to the wall clock, less what it is making up for: after
    # a busy stretch (the boot) its virtual time runs up to two or three times
    # as fast until it has caught up. It took 0.1 s of wall time before.
    assert run['sleep_wall'] > 0.6


def test_a_timer_fires_at_its_frequency(run):
    assert run['timer_calls'] in (19, 20, 21)          # 1000 with the timers at 250 MHz


def test_the_lane_tells_the_page_the_clock(run):
    assert run['beacons'] > 50
    assert run['monotonic']


def test_only_the_pads_the_firmware_drives_are_said_driven(run):
    # the two LEDs; the lane said all 48 pads of ports A, B and C
    assert run['driven_at_boot'] == [('B', 0), ('B', 1)]
    assert not run['b10_said_driven']


def test_a_level_from_the_circuit_reaches_the_firmware(run):
    assert (run['low'], run['high'], run['low_again']) == ('0', '1', '0')
