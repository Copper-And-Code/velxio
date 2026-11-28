"""The STM32H743's pads, from its registers, as the page needs them.

Renode models the chip's registers and no pads: nothing there says a pin went
high, that a timer channel chops it, or that the firmware made it an input.
The lane reads the GPIO and timer registers many times a second (the `VXPK`
command of renode/extensions/velxio_framebuffer_server.py) and this module
turns two successive reads into what changed:

  stm32h7_gpio_dir     {port, pin, dir}    1: the firmware drives the pad (a
                                           push-pull output, or a timer
                                           channel in PWM), 0: it let it go
  stm32h7_gpio_change  {port, pin, value}  the level of an output pad (ODR)
  stm32h7_pwm          {port, pin, duty}   0..1: the share of time a timer
                                           channel holds the pad high; null
                                           when it stops
  stm32h7_gpio_pull    {port, pin, pull}   'up', 'down' or null (PUPDR)

A pad in input, analog or another alternate function is not driven and has no
level here: the level on it is the circuit's (stm32h7_gpio_input). The lane
used to send the ODR bit of all sixteen pins of each port as levels, so the
page took every pad for an output and sent it no input at all.

Register layout: RM0433 (GPIO: 11.4, timers: 38.4 and 39.4). The timer
channel on each pad by alternate function: DS12110 tables 10 to 12, taken
from MicroPython's ports/stm32/boards/stm32h743_af.csv (the firmware's own
table), CHx only: a complementary output (CHxN) is not followed.
"""
from __future__ import annotations

from typing import Sequence

PORTS = ('A', 'B', 'C')
GPIO_BASE = {'A': 0x58020000, 'B': 0x58020400, 'C': 0x58020800}
# MODER, PUPDR, ODR, AFRL, AFRH
GPIO_REGS = (0x00, 0x0C, 0x14, 0x20, 0x24)

TIM_BASE = {
    1: 0x40010000, 2: 0x40000000, 3: 0x40000400, 4: 0x40000800,
    5: 0x40000C00, 8: 0x40010400, 12: 0x40001800, 13: 0x40001C00,
    14: 0x40002000, 15: 0x40014000, 16: 0x40014400, 17: 0x40014800,
}
# CR1, CCMR1, CCMR2, CCER, ARR, CCR1, CCR2, CCR3, CCR4
TIM_REGS = (0x00, 0x18, 0x1C, 0x20, 0x2C, 0x34, 0x38, 0x3C, 0x40)

# (port, pin) -> {alternate function: (timer, channel)}
PWM_AF: dict[tuple[str, int], dict[int, tuple[int, int]]] = {
    ('A', 0): {1: (2, 1), 2: (5, 1)},
    ('A', 1): {1: (2, 2), 2: (5, 2)},
    ('A', 2): {1: (2, 3), 2: (5, 3), 4: (15, 1)},
    ('A', 3): {1: (2, 4), 2: (5, 4), 4: (15, 2)},
    ('A', 5): {1: (2, 1)},
    ('A', 6): {2: (3, 1), 9: (13, 1)},
    ('A', 7): {2: (3, 2), 9: (14, 1)},
    ('A', 8): {1: (1, 1)},
    ('A', 9): {1: (1, 2)},
    ('A', 10): {1: (1, 3)},
    ('A', 11): {1: (1, 4)},
    ('A', 15): {1: (2, 1)},
    ('B', 0): {2: (3, 3)},
    ('B', 1): {2: (3, 4)},
    ('B', 3): {1: (2, 2)},
    ('B', 4): {2: (3, 1)},
    ('B', 5): {2: (3, 2)},
    ('B', 6): {2: (4, 1)},
    ('B', 7): {2: (4, 2)},
    ('B', 8): {1: (16, 1), 2: (4, 3)},
    ('B', 9): {1: (17, 1), 2: (4, 4)},
    ('B', 10): {1: (2, 3)},
    ('B', 11): {1: (2, 4)},
    ('B', 14): {2: (12, 1)},
    ('B', 15): {2: (12, 2)},
    ('C', 6): {2: (3, 1), 3: (8, 1)},
    ('C', 7): {2: (3, 2), 3: (8, 2)},
    ('C', 8): {2: (3, 3), 3: (8, 3)},
    ('C', 9): {2: (3, 4), 3: (8, 4)},
}

_MODE_OUTPUT = 1
_MODE_AF = 2
_PULLS = {1: 'up', 2: 'down'}
# A duty that moved by less than this is the same duty (a 16-bit timer's step).
_DUTY_STEP = 1.0 / 65536

GpioRegs = Sequence[int]    # MODER, PUPDR, ODR, AFRL, AFRH
TimerRegs = Sequence[int]   # CR1, CCMR1, CCMR2, CCER, ARR, CCR1..CCR4


def gpio_addresses() -> list[int]:
    """The GPIO registers of a look, port after port in PORTS' order."""
    return [GPIO_BASE[port] + off for port in PORTS for off in GPIO_REGS]


def timer_addresses(timers: Sequence[int]) -> list[int]:
    """The registers of `timers`, timer after timer."""
    return [TIM_BASE[t] + off for t in timers for off in TIM_REGS]


def pwm_channels(port: str, regs: GpioRegs) -> dict[int, tuple[int, int]]:
    """pin -> (timer, channel) for the pads of `port` handed to a timer channel."""
    moder, _pupdr, _odr, afrl, afrh = regs
    out: dict[int, tuple[int, int]] = {}
    for pin in range(16):
        if (moder >> (2 * pin)) & 3 != _MODE_AF:
            continue
        af = ((afrl >> (4 * pin)) if pin < 8 else (afrh >> (4 * (pin - 8)))) & 0xF
        channel = PWM_AF.get((port, pin), {}).get(af)
        if channel:
            out[pin] = channel
    return out


def pwm_duty(regs: TimerRegs, channel: int) -> float | None:
    """The share of time `channel` holds its pad high, or None when the timer
    does not drive the pad: the counter stopped (CEN), the output off (CCxE),
    an input capture, an output mode that is not a level in time."""
    cr1, ccmr1, ccmr2, ccer, arr = regs[:5]
    if not cr1 & 1 or not (ccer >> (4 * (channel - 1))) & 1:
        return None
    ccmr = (ccmr1 if channel <= 2 else ccmr2) >> (8 * ((channel - 1) % 2))
    if ccmr & 3:
        return None                         # CCxS: the channel is an input
    mode = (ccmr >> 4) & 7                  # OCxM
    period = arr + 1
    high = min(regs[4 + channel], period) / period
    if mode == 6:                           # PWM mode 1: high while CNT < CCR
        duty = high
    elif mode == 7:                         # PWM mode 2
        duty = 1.0 - high
    elif mode == 5:                         # forced active
        duty = 1.0
    elif mode == 4:                         # forced inactive
        duty = 0.0
    else:
        return None
    if (ccer >> (4 * (channel - 1) + 1)) & 1:   # CCxP: active low
        duty = 1.0 - duty
    return duty


class PadTracker:
    """What changed on the pads between two looks at the registers."""

    def __init__(self) -> None:
        self._driven: set[tuple[str, int]] = set()
        self._level: dict[tuple[str, int], bool] = {}
        self._duty: dict[tuple[str, int], float] = {}
        self._pull: dict[tuple[str, int], str] = {}

    @staticmethod
    def timers_in_use(gpio: dict[str, GpioRegs]) -> list[int]:
        """The timers a pad is handed to: the ones whose registers a look needs."""
        timers = {timer for port, regs in gpio.items()
                  for timer, _ch in pwm_channels(port, regs).values()}
        return sorted(timers)

    def update(self, gpio: dict[str, GpioRegs],
               timers: dict[int, TimerRegs]) -> list[tuple[str, dict]]:
        """The events of a look: `gpio` has a port's registers by its letter,
        `timers` those of each timer in use by its number."""
        events: list[tuple[str, dict]] = []
        for port in PORTS:
            regs = gpio.get(port)
            if regs is None:
                continue
            moder, pupdr, odr = regs[0], regs[1], regs[2]
            channels = pwm_channels(port, regs)
            for pin in range(16):
                pad = (port, pin)
                where = {'port': port, 'pin': pin}
                output = (moder >> (2 * pin)) & 3 == _MODE_OUTPUT
                duty = None
                if pin in channels:
                    timer, channel = channels[pin]
                    treg = timers.get(timer)
                    duty = pwm_duty(treg, channel) if treg is not None else None

                driven = output or duty is not None
                if driven != (pad in self._driven):
                    (self._driven.add if driven else self._driven.discard)(pad)
                    events.append(('stm32h7_gpio_dir', {**where, 'dir': 1 if driven else 0}))

                if output:
                    level = bool((odr >> pin) & 1)
                    if self._level.get(pad) != level:
                        self._level[pad] = level
                        events.append(('stm32h7_gpio_change', {**where, 'value': level}))
                else:
                    self._level.pop(pad, None)   # said again when it is an output again

                last = self._duty.get(pad)
                if duty is None:
                    if last is not None:
                        del self._duty[pad]
                        events.append(('stm32h7_pwm', {**where, 'duty': None}))
                elif last is None or abs(duty - last) >= _DUTY_STEP:
                    self._duty[pad] = duty
                    events.append(('stm32h7_pwm', {**where, 'duty': duty}))

                pull = _PULLS.get((pupdr >> (2 * pin)) & 3)
                if pull != self._pull.get(pad):
                    if pull is None:
                        del self._pull[pad]
                    else:
                        self._pull[pad] = pull
                    events.append(('stm32h7_gpio_pull', {**where, 'pull': pull}))
        return events
