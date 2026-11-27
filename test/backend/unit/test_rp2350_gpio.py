"""The RP2350 lane's GPIO block (rp2350_qemu.py; layout in hw/arm/rp2350.c).

The machine publishes the pads it drives and their PWM duty in its panel
file; the lane turns them into `rp2350_gpio_dir`, `rp2350_gpio_change` and
`rp2350_pwm` events, and writes the levels the circuit drives back into it.

The first levels arrive before the machine has made its file (a line sensor
on the tape at Run): they must be kept and written once the file is mapped,
or the guest reads 0 until the level changes again, and a robot never sees
the tape it starts on. Imports the real production module.
"""

from __future__ import annotations

import asyncio
import mmap
import struct

from app.services import rp2350_qemu as rq

OFF = rq._GPIO_OFFSET


def _instance(tmp_path, events):
    async def cb(kind, data):
        events.append((kind, data))

    inst = rq.Rp2350Instance('c', cb, psram=False)
    path = tmp_path / 'panel.fb'
    path.write_bytes(bytes(OFF + rq._GPIO_SIZE))
    f = open(path, 'r+b')
    return inst, f


def _map(inst, f):
    inst.panel = mmap.mmap(f.fileno(), OFF + rq._GPIO_SIZE)
    inst.gpio_ok = True


def test_inputs_before_the_file_are_kept(tmp_path):
    mgr = rq.Rp2350Manager()
    inst, f = _instance(tmp_path, [])
    mgr._instances['c'] = inst
    mgr.gpio_input('c', 10, True)       # before the machine made its file
    mgr.gpio_input('c', 11, True)
    mgr.gpio_input('c', 11, False)
    _map(inst, f)
    for pin, value in inst.inputs.items():
        mgr._write_input(inst, pin, value)
    level, mask = struct.unpack_from('<I', inst.panel, OFF + 24)[0], struct.unpack_from('<I', inst.panel, OFF + 32)[0]
    assert level == 1 << 10
    assert mask == (1 << 10) | (1 << 11)
    mgr.gpio_input('c', 10, None)       # let it go
    assert struct.unpack_from('<I', inst.panel, OFF + 32)[0] == 1 << 11
    mgr.gpio_input('c', 40, True)       # the high word
    assert struct.unpack_from('<I', inst.panel, OFF + 28)[0] == 1 << 8
    f.close()


def test_poll_reports_direction_level_and_duty(tmp_path):
    events = []
    mgr = rq.Rp2350Manager()
    inst, f = _instance(tmp_path, events)
    _map(inst, f)
    p = inst.panel
    struct.pack_into('<I', p, OFF, rq._GPIO_MAGIC)
    struct.pack_into('<%dI' % rq._GPIO_COUNT, p, OFF + 64, *([0xFFFFFFFF] * rq._GPIO_COUNT))
    # GP8 a PWM channel at 45 %, GP9 an SIO output high, GP10 an SD pin the boot drove
    struct.pack_into('<I', p, OFF + 64 + 4 * 8, int(0.45 * 65536))
    struct.pack_into('<4I', p, OFF + 8, (1 << 9), 0, (1 << 8) | (1 << 9) | (1 << 10), 0)
    struct.pack_into('<I', p, OFF + 4, 1)
    inst.running = True

    async def run():
        task = asyncio.create_task(mgr._poll_gpio(inst))
        await asyncio.sleep(0.05)
        # the app makes GP10 an input: the pad is released
        struct.pack_into('<I', p, OFF + 16, (1 << 8) | (1 << 9))
        struct.pack_into('<I', p, OFF + 4, 2)
        await asyncio.sleep(0.05)
        inst.running = False
        await asyncio.sleep(0.02)
        task.cancel()

    asyncio.run(run())
    f.close()
    assert ('rp2350_pwm', {'pin': 8, 'duty': int(0.45 * 65536) / 65536}) in events
    assert ('rp2350_gpio_change', {'pin': 9, 'value': True}) in events
    assert ('rp2350_gpio_dir', {'pin': 10, 'dir': 1}) in events
    assert ('rp2350_gpio_dir', {'pin': 10, 'dir': 0}) in events
    assert events.index(('rp2350_gpio_dir', {'pin': 10, 'dir': 1})) < events.index(('rp2350_gpio_dir', {'pin': 10, 'dir': 0}))
    assert not any(k == 'rp2350_pwm' and d['pin'] != 8 for k, d in events)
