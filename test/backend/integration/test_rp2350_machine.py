"""
test_rp2350_machine.py: the raspi-pico2 machine of our QEMU under the VELXIO
firmware, through the GPIO block of its panel file (the block the RP2350
lane reads, app/services/rp2350_qemu.py; layout in hw/arm/rp2350.c).

 - PWM on GPIO32-47. The pads sit on slices 8-11 and wrap at 8, as the SDK's
   PWM_GPIO_SLICE_NUM says; the machine put GPIO40-47 on slices 12-15, which
   do not exist, and published a duty of 0: a motor on GP40 never turned.
 - machine.reset(). MicroPython resets through the watchdog (CTRL.TRIGGER),
   which the machine did not model: the board hung, with its PWM pads still
   published at their duty, so a robot's motors ran on with no firmware.
   A reset now restarts the firmware and lets every pad go.
 - machine.WDT: a fed watchdog leaves the app alone, a starved one resets.

Needs qemu-system-arm with the raspi-pico2 machine (RP2350_QEMU_BIN, else
prebuilt/qemu/) and the firmware (RP2350_FIRMWARE, else prebuilt/rp2350/):
`scripts/fetch-prebuilt.sh` gets both. Skipped when either is missing.
"""
from __future__ import annotations

import mmap
import os
import struct
import subprocess
import threading
import time

import pytest

from app.services import rp2350_qemu as rq

pytestmark = pytest.mark.skipif(
    not (os.path.exists(rq.QEMU_BIN) and os.path.exists(rq.DEFAULT_FW)),
    reason='no RP2350 qemu-system-arm or firmware (scripts/fetch-prebuilt.sh)')

OFF = rq._GPIO_OFFSET
NOT_PWM = 0xFFFFFFFF


class Board:
    """The machine on a pipe: the REPL on its stdio, the pads in its file."""

    def __init__(self, path: str):
        self.path = path
        self.buf = bytearray()
        self.proc = subprocess.Popen(
            [rq.QEMU_BIN, '-M', 'raspi-pico2,panel-file=' + path, '-kernel', rq.DEFAULT_FW,
             '-nographic', '-serial', 'stdio', '-monitor', 'none'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=self._read, daemon=True).start()
        self.prompt()

    def _read(self) -> None:
        while True:
            chunk = self.proc.stdout.read1(4096)
            if not chunk:
                return
            self.buf.extend(chunk)

    def wait(self, marker: bytes, start: int = 0, timeout: float = 40) -> int:
        end = time.time() + timeout
        while time.time() < end:
            i = self.buf.find(marker, start)
            if i >= 0:
                return i
            time.sleep(0.02)
        raise AssertionError('no %r from the board; last output: %r' % (marker, bytes(self.buf[-300:])))

    def prompt(self, start: int = 0) -> None:
        """Wait for a REPL prompt after `start` and leave a clean line."""
        self.wait(b'>>> ', start)
        time.sleep(0.5)
        self.write(b'\x03\r\n')
        time.sleep(0.4)

    def write(self, data: bytes) -> None:
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def run(self, line: str, timeout: float = 20) -> str:
        n = len(self.buf)
        self.write(line.encode() + b'\r\n')
        self.wait(b'>>> ', n, timeout)
        return bytes(self.buf[n:]).decode(errors='replace')

    def pads(self) -> tuple[int, tuple[int, ...]]:
        """(the pads the firmware drives, each pad's PWM duty or NOT_PWM)."""
        with open(self.path, 'rb') as f:
            m = mmap.mmap(f.fileno(), OFF + rq._GPIO_SIZE, prot=mmap.PROT_READ)
            _out, _out_hi, oe, oe_hi = struct.unpack_from('<4I', m, OFF + 8)
            duty = struct.unpack_from('<%dI' % rq._GPIO_COUNT, m, OFF + 64)
            m.close()
        return oe | (oe_hi << 32), duty

    def close(self) -> None:
        self.proc.kill()
        self.proc.wait(5)


@pytest.fixture
def board(tmp_path):
    b = Board(str(tmp_path / 'panel.fb'))
    yield b
    b.close()


# Pads on different slices and channels: 4A, 8B, 8A, 9A, 11A, 11B.
PWM_PADS = ((8, 32768), (33, 49152), (40, 32768), (42, 8192), (46, 16384), (47, 60000))


def test_pwm_duty_of_the_high_pads(board):
    board.run('from machine import Pin, PWM')
    for pin, duty in PWM_PADS:
        board.run('p%d = PWM(Pin(%d)); p%d.freq(1000); p%d.duty_u16(%d)' % (pin, pin, pin, pin, duty))
    time.sleep(0.2)
    driven, duty = board.pads()
    for pin, want in PWM_PADS:
        assert (driven >> pin) & 1, 'GP%d is not driven' % pin
        assert abs(duty[pin] - want) <= 40, 'GP%d: duty %d, asked %d' % (pin, duty[pin], want)


def test_reset_restarts_the_firmware_and_lets_the_pads_go(board):
    board.run('from machine import Pin, PWM')
    board.run('import machine')
    board.run('m = PWM(Pin(8)); m.freq(1000); m.duty_u16(30000)')
    board.run('led = Pin(9, Pin.OUT, value=1)')
    time.sleep(0.2)
    driven, duty = board.pads()
    assert duty[8] != NOT_PWM and (driven >> 9) & 1

    n = len(board.buf)
    board.write(b'machine.reset()\r\n')
    banner = board.wait(b'MicroPython v', n, 30)       # it hung here for ever
    board.prompt(banner)
    driven, duty = board.pads()
    assert driven == 0
    assert all(d == NOT_PWM for d in duty)
    out = board.run('import machine, time; print("cause", machine.reset_cause() == machine.WDT_RESET, time.ticks_ms() < 20000)')
    assert 'cause True True' in out


def test_watchdog_fed_and_starved(board):
    board.run('import machine, time')
    board.run('w = machine.WDT(timeout=1500)')
    banners = board.buf.count(b'MicroPython v')
    board.run('exec("for i in range(6):\\n time.sleep_ms(500)\\n w.feed()")', 30)
    assert 'alive 2' in board.run('print("alive", 1 + 1)')
    assert board.buf.count(b'MicroPython v') == banners          # 3 s past a 1.5 s timeout, fed

    n = len(board.buf)
    started = time.time()
    board.write(b'time.sleep(20)\r\n')
    banner = board.wait(b'MicroPython v', n, 30)
    assert time.time() - started < 10
    board.prompt(banner)
    assert 'up 42' in board.run('print("up", 6 * 7)')
