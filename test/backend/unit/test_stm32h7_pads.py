"""The STM32H7's pads, from its registers (app/services/stm32h7_pads.py), and
the Renode lane that reads them (renode_manager._poll_pads_once).

Renode has the chip's registers and no pads. The lane read the ODR of three
ports through the monitor's text every 50 ms and sent each of the 48 bits as
a level: the page took every pad for an output, so it sent the board no
input at all (a line sensor on PB10 never reached the firmware), and a timer
channel in PWM was a pad stuck low (a motor on PB8 never turned).

Now the lane looks at MODER, PUPDR, ODR and AFR of each port, and at the
registers of the timers a pad is handed to, over the binary socket, and says
what each pad is: driven or not, its level, its PWM duty, its pull. The same
look carries the machine's clock (`guest_clock`): the firmware's time is
Renode's virtual time, which falls behind the wall clock on a busy host.

The register values below are the ones read back from Renode under the
VELXIO firmware (machine.PWM on PB8 at 25 %: TIM4 channel 3, ARR 4999).
"""

from __future__ import annotations

import asyncio

from app.services import renode_manager as rm
from app.services import stm32h7_pads as pads

# MODER, PUPDR, ODR, AFRL, AFRH
PORT_A = (0xABFFFFFF, 0x64000000, 0, 0, 0)         # reset: analog, the SWD pins in AF
PORT_C = (0xFFFFFFFF, 0, 0, 0, 0)
# PB0, PB1 outputs (the LEDs), PB2 and PB6 the QSPI flash, PB8 on AF2
PORT_B_PWM = (0x22025, 0, 0x3, 0, 0x2)
# CR1, CCMR1, CCMR2, CCER, ARR, CCR1..4: channel 3 in PWM mode 1, enabled, 1250 of 5000
TIM4 = (0x81, 0, 0x60, 0x100, 4999, 0xFFFF, 0xFFFF, 1250, 0xFFFF)


def _moder(**modes: int) -> int:
    """MODER with the given pins (p8=2) and every other in analog."""
    value = 0xFFFFFFFF
    for name, mode in modes.items():
        pin = int(name[1:])
        value = (value & ~(3 << (2 * pin))) | (mode << (2 * pin))
    return value


# ── the duty of a timer channel ──────────────────────────────────────────────

def test_pwm_mode_1_is_ccr_over_the_period():
    assert pads.pwm_duty(TIM4, 3) == 0.25


def test_a_ccr_above_the_period_is_full_on():
    regs = (0x81, 0, 0x60, 0x100, 4999, 0, 0, 0xFFFF, 0)
    assert pads.pwm_duty(regs, 3) == 1.0


def test_pwm_mode_2_and_the_polarity_bit_invert():
    mode2 = (0x81, 0, 0x70, 0x100, 4999, 0, 0, 1250, 0)
    assert pads.pwm_duty(mode2, 3) == 0.75
    active_low = (0x81, 0, 0x60, 0x300, 4999, 0, 0, 1250, 0)
    assert pads.pwm_duty(active_low, 3) == 0.75


def test_each_channel_reads_its_own_fields():
    # channel 2: CCMR1 bits 12-14, CCER bit 4, CCR2; channel 4: CCMR2 bits 12-14, CCER bit 12
    regs = (0x81, 0x6000, 0x6000, 0x1010, 999, 0, 100, 0, 900)
    assert pads.pwm_duty(regs, 2) == 0.1
    assert pads.pwm_duty(regs, 4) == 0.9
    assert pads.pwm_duty(regs, 1) is None       # not enabled
    assert pads.pwm_duty(regs, 3) is None


def test_a_channel_that_does_not_drive_the_pad_has_no_duty():
    stopped = (0x80,) + TIM4[1:]                 # CEN clear
    assert pads.pwm_duty(stopped, 3) is None
    output_off = TIM4[:3] + (0,) + TIM4[4:]      # CC3E clear: what PWM.deinit() leaves
    assert pads.pwm_duty(output_off, 3) is None
    capture = (0x81, 0, 0x61, 0x100, 4999, 0, 0, 1250, 0)   # CC3S: an input capture
    assert pads.pwm_duty(capture, 3) is None
    toggle = (0x81, 0, 0x30, 0x100, 4999, 0, 0, 1250, 0)    # toggle on match: not a level in time
    assert pads.pwm_duty(toggle, 3) is None


def test_forced_levels():
    assert pads.pwm_duty((0x81, 0, 0x50, 0x100, 4999, 0, 0, 0, 0), 3) == 1.0
    assert pads.pwm_duty((0x81, 0, 0x40, 0x100, 4999, 0, 0, 4000, 0), 3) == 0.0


# ── which timer channel a pad is handed to ───────────────────────────────────

def test_the_timer_channel_of_a_pad_by_its_alternate_function():
    # what machine.PWM picks on the board's header, read back from the firmware
    picked = {('B', 8): (2, (4, 3)), ('B', 9): (2, (4, 4)), ('A', 6): (9, (13, 1)),
              ('A', 7): (9, (14, 1)), ('B', 10): (1, (2, 3)), ('B', 11): (1, (2, 4)),
              ('A', 0): (2, (5, 1)), ('A', 3): (2, (5, 4)), ('A', 5): (1, (2, 1)),
              ('B', 7): (2, (4, 2)), ('B', 15): (2, (12, 2))}
    for (port, pin), (af, channel) in picked.items():
        afrl = af << (4 * pin) if pin < 8 else 0
        afrh = af << (4 * (pin - 8)) if pin >= 8 else 0
        regs = (_moder(**{'p%d' % pin: 2}), 0, 0, afrl, afrh)
        assert pads.pwm_channels(port, regs) == {pin: channel}, (port, pin)


def test_another_alternate_function_is_not_a_timer():
    # PB8 on AF4 (I2C1 SCL), PB6 on AF10 (the QSPI flash's chip select)
    regs = (_moder(p8=2, p6=2), 0, 0, 0xA << 24, 0x4)
    assert pads.pwm_channels('B', regs) == {}
    # in output mode the AF field means nothing
    assert pads.pwm_channels('B', (_moder(p8=1), 0, 0, 0, 0x2)) == {}


def test_only_the_timers_in_use_are_read():
    gpio = {'A': PORT_A, 'B': PORT_B_PWM, 'C': PORT_C}
    assert pads.PadTracker.timers_in_use(gpio) == [4]
    assert pads.PadTracker.timers_in_use({'A': PORT_A, 'C': PORT_C}) == []
    assert pads.timer_addresses([4])[:2] == [0x40000800, 0x40000818]
    assert len(pads.gpio_addresses()) == 15 and pads.gpio_addresses()[5] == 0x58020400


# ── what changed between two looks ───────────────────────────────────────────

def test_the_first_look_says_only_what_the_firmware_drives():
    t = pads.PadTracker()
    events = t.update({'A': PORT_A, 'B': PORT_B_PWM, 'C': PORT_C}, {4: TIM4})
    assert events == [
        ('stm32h7_gpio_pull', {'port': 'A', 'pin': 13, 'pull': 'up'}),
        ('stm32h7_gpio_pull', {'port': 'A', 'pin': 14, 'pull': 'down'}),
        ('stm32h7_gpio_pull', {'port': 'A', 'pin': 15, 'pull': 'up'}),
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 0, 'dir': 1}),
        ('stm32h7_gpio_change', {'port': 'B', 'pin': 0, 'value': True}),
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 1, 'dir': 1}),
        ('stm32h7_gpio_change', {'port': 'B', 'pin': 1, 'value': True}),
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 8, 'dir': 1}),
        ('stm32h7_pwm', {'port': 'B', 'pin': 8, 'duty': 0.25}),
    ]
    # nothing about the 45 pads it does not drive: the page can drive them
    assert not any(d['port'] == 'C' for _k, d in events)
    assert t.update({'A': PORT_A, 'B': PORT_B_PWM, 'C': PORT_C}, {4: TIM4}) == []


def test_a_level_a_duty_and_a_release():
    t = pads.PadTracker()
    gpio = {'A': PORT_A, 'B': PORT_B_PWM, 'C': PORT_C}
    t.update(gpio, {4: TIM4})
    # the LED on PB1 goes off, the duty to 60 %
    led_off = (PORT_B_PWM[0], 0, 0x1, 0, 0x2)
    faster = TIM4[:7] + (3000,) + TIM4[8:]
    assert t.update({**gpio, 'B': led_off}, {4: faster}) == [
        ('stm32h7_gpio_change', {'port': 'B', 'pin': 1, 'value': False}),
        ('stm32h7_pwm', {'port': 'B', 'pin': 8, 'duty': 0.6}),
    ]
    # PWM.deinit(): the channel's output off, the pad still in AF
    off = faster[:3] + (0,) + faster[4:]
    assert t.update({**gpio, 'B': led_off}, {4: off}) == [
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 8, 'dir': 0}),
        ('stm32h7_pwm', {'port': 'B', 'pin': 8, 'duty': None}),
    ]


def test_an_output_made_an_input_and_an_output_again():
    t = pads.PadTracker()
    out_high = (_moder(p10=1), 0, 1 << 10, 0, 0)
    assert t.update({'B': out_high}, {}) == [
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 10, 'dir': 1}),
        ('stm32h7_gpio_change', {'port': 'B', 'pin': 10, 'value': True}),
    ]
    # Pin.IN with a pull-up: ODR keeps its bit, which is no level of the pad now
    pulled_input = (_moder(p10=0), 1 << 20, 1 << 10, 0, 0)
    assert t.update({'B': pulled_input}, {}) == [
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 10, 'dir': 0}),
        ('stm32h7_gpio_pull', {'port': 'B', 'pin': 10, 'pull': 'up'}),
    ]
    # an output again, at the same level: the page is told the level again
    assert t.update({'B': out_high}, {}) == [
        ('stm32h7_gpio_dir', {'port': 'B', 'pin': 10, 'dir': 1}),
        ('stm32h7_gpio_change', {'port': 'B', 'pin': 10, 'value': True}),
        ('stm32h7_gpio_pull', {'port': 'B', 'pin': 10, 'pull': None}),
    ]


def test_a_timer_that_was_not_read_drives_nothing():
    t = pads.PadTracker()
    assert not any(k == 'stm32h7_pwm' for k, _d in t.update({'B': PORT_B_PWM}, {}))


# ── the lane ─────────────────────────────────────────────────────────────────

class _Renode:
    """The binary socket of a Renode that is up: registers and a clock."""

    def __init__(self, inst: rm.RenodeInstance) -> None:
        self.regs: dict[int, int] = {}
        self.micros = 5_000_000
        self.peeks: list[int] = []
        self.inputs: list[tuple[str, int, bool]] = []
        self.monitor: list[str] = []
        self.binary = True
        inst._mon_writer = object()          # the monitor is connected: Renode listens

    def set(self, base: int, offsets, values) -> None:
        for off, value in zip(offsets, values):
            self.regs[base + off] = value

    def attach(self, mgr: rm.RenodeManager) -> None:
        async def peek(_inst, addrs):
            if not self.binary:
                return None
            self.peeks.append(len(addrs))
            self.micros += 20_000
            return self.micros, tuple(self.regs.get(a, 0) for a in addrs)

        async def gpio_input(_inst, port, pin, value):
            if self.binary:
                self.inputs.append((port, pin, value))
            return self.binary

        async def monitor(_inst, line, timeout=5.0, max_bytes=0):
            self.monitor.append(line)
            return ''

        mgr._peek = peek
        mgr._gpio_input_binary = gpio_input
        mgr._monitor_cmd = monitor


def _lane():
    events: list[tuple[str, dict]] = []

    async def callback(kind, data):
        events.append((kind, data))

    mgr = rm.RenodeManager()
    inst = rm.RenodeInstance('c', callback)
    mgr._instances['c'] = inst
    return mgr, inst, events


def test_a_look_says_the_pads_and_the_clock():
    mgr, inst, events = _lane()
    renode = _Renode(inst)
    renode.attach(mgr)
    renode.set(pads.GPIO_BASE['B'], pads.GPIO_REGS, PORT_B_PWM)
    renode.set(pads.TIM_BASE[4], pads.TIM_REGS, TIM4)

    assert asyncio.run(mgr._poll_pads_once(inst)) is True
    assert renode.peeks == [15, 9]                       # the ports, then timer 4 alone
    assert ('stm32h7_pwm', {'port': 'B', 'pin': 8, 'duty': 0.25}) in events
    assert ('stm32h7_gpio_change', {'port': 'B', 'pin': 0, 'value': True}) in events
    # the clock of the last trip, after the pads it was read with
    assert events[-1] == ('guest_clock', {'us': 5_040_000})

    events.clear()
    asyncio.run(mgr._poll_pads_once(inst))
    assert events == [('guest_clock', {'us': 5_080_000})]


def test_no_timer_in_use_is_one_trip():
    mgr, inst, events = _lane()
    renode = _Renode(inst)
    renode.attach(mgr)
    asyncio.run(mgr._poll_pads_once(inst))
    assert renode.peeks == [15]
    assert events == [('guest_clock', {'us': 5_020_000})]


def test_without_the_binary_socket_the_look_says_so():
    mgr, inst, events = _lane()
    renode = _Renode(inst)
    renode.binary = False
    renode.attach(mgr)
    assert asyncio.run(mgr._poll_pads_once(inst)) is False     # the lane falls back to ODR
    assert events == []


def test_a_level_asked_before_renode_listens_is_kept():
    mgr, inst, _events = _lane()
    renode = _Renode(inst)
    renode.attach(mgr)
    inst._mon_writer = None                              # Renode is still starting

    async def run():
        # a line sensor on the tape at Run: said once, within milliseconds
        await mgr.set_gpio_input('c', 'b', 10, True)
        await mgr.set_gpio_input('c', 'B', 11, False)
        early = list(renode.inputs)
        inst._mon_writer = object()                      # Renode is up
        await mgr._poll_pads_once(inst)
        return early

    assert asyncio.run(run()) == []
    assert renode.inputs == [('B', 10, True), ('B', 11, False)]


def test_a_level_said_again_unchanged_is_written_once():
    mgr, inst, _events = _lane()
    renode = _Renode(inst)
    renode.attach(mgr)

    async def run():
        for _ in range(5):                               # a sensor says it on every frame
            await mgr.set_gpio_input('c', 'B', 10, True)
        await mgr.set_gpio_input('c', 'B', 10, False)
        await mgr.set_gpio_input('c', 'B', 10, False)
        await mgr.set_gpio_input('c', 'Z', 1, True)      # not a port
        await mgr.set_gpio_input('c', 'B', 16, True)     # not a pin

    asyncio.run(run())
    assert renode.inputs == [('B', 10, True), ('B', 10, False)]


def test_a_level_goes_through_the_monitor_without_the_binary_socket():
    mgr, inst, _events = _lane()
    renode = _Renode(inst)
    renode.binary = False
    renode.attach(mgr)
    asyncio.run(mgr.set_gpio_input('c', 'A', 0, True))
    assert renode.monitor == ['sysbus.gpioPortA OnGPIO 0 true']
