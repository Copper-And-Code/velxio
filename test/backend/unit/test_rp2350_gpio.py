"""The RP2350 lane's GPIO block (rp2350_qemu.py; layout in hw/arm/rp2350.c).

The machine publishes the pads it drives and their PWM duty in its panel
file; the lane turns them into `rp2350_gpio_dir`, `rp2350_gpio_change` and
`rp2350_pwm` events, and writes the levels the circuit drives back into it.

The first levels arrive before the machine has made its file (a line sensor
on the tape at Run): they must be kept and written once the file is mapped,
or the guest reads 0 until the level changes again, and a robot never sees
the tape it starts on. The machine also gives the file its size before it
clears the GPIO block and writes its magic: a lane that took the file on its
size alone could write the inputs too early (wiped by the clear) and start a
poll that found no block and gave up, leaving a run with no GPIO at all.
Imports the real production module.

From layout v3 the machine also keeps an edge log after the block. A look
every few milliseconds at the block alone sees the level a pad has then: the
edges of a bit-banged line between two looks were lost (a shift register's
clock read as nothing at all). The lane sends the log's records in order, as
one `rp2350_gpio_batch` a look, and goes back to the block when it has fallen
further behind than the log is long. The pads' pulls come from the block.
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


def test_the_block_is_used_only_once_the_machine_has_filled_it(tmp_path):
    events = []
    mgr = rq.Rp2350Manager()
    inst, f = _instance(tmp_path, events)   # the file has its size, and nothing in it yet
    inst.panel_path = str(tmp_path / 'panel.fb')
    mgr._instances['c'] = inst
    mgr.gpio_input('c', 10, True)
    inst.running = True
    qemu = mmap.mmap(f.fileno(), OFF + rq._GPIO_SIZE)   # the machine's own mapping

    async def run():
        task = asyncio.create_task(mgr._poll_panel(inst))
        await asyncio.sleep(0.08)
        early = (inst.gpio_ok, struct.unpack_from('<I', qemu, OFF + 24)[0], len(inst.tasks))
        # the machine clears the block, then writes its magic
        qemu[OFF:OFF + rq._GPIO_SIZE] = bytes(rq._GPIO_SIZE)
        struct.pack_into('<I', qemu, OFF, rq._GPIO_MAGIC)
        await asyncio.sleep(0.08)
        struct.pack_into('<%dI' % rq._GPIO_COUNT, qemu, OFF + 64, *([0xFFFFFFFF] * rq._GPIO_COUNT))
        struct.pack_into('<4I', qemu, OFF + 8, 1 << 9, 0, 1 << 9, 0)
        struct.pack_into('<I', qemu, OFF + 4, 1)
        await asyncio.sleep(0.08)
        inst.running = False
        await asyncio.sleep(0.06)
        for t in [task, *inst.tasks]:
            t.cancel()
        return early

    early = asyncio.run(run())
    assert early == (False, 0, 0)           # nothing written, no poll started, before the magic
    assert inst.gpio_ok
    assert struct.unpack_from('<I', qemu, OFF + 24)[0] == 1 << 10   # the input kept from before
    assert struct.unpack_from('<I', qemu, OFF + 32)[0] == 1 << 10
    assert ('rp2350_gpio_change', {'pin': 9, 'value': True}) in events
    qemu.close()
    f.close()


EDGE = rq._EDGE_OFFSET


def _v3(tmp_path, events, capacity=8):
    """An instance on a layout v3 file the "machine" has filled: the block, the log."""
    async def cb(kind, data):
        events.append((kind, data))

    inst = rq.Rp2350Instance('c', cb, psram=False)
    size = EDGE + rq._EDGE_HEADER + 8 * capacity
    path = tmp_path / 'panel3.fb'
    path.write_bytes(bytes(size))
    f = open(path, 'r+b')
    inst.panel = mmap.mmap(f.fileno(), size)
    p = inst.panel
    struct.pack_into('<I', p, OFF, rq._GPIO_MAGIC)
    struct.pack_into('<%dI' % rq._GPIO_COUNT, p, OFF + 64, *([0xFFFFFFFF] * rq._GPIO_COUNT))
    struct.pack_into('<2I', p, EDGE, rq._EDGE_MAGIC, capacity)
    inst.gpio_ok = True
    inst.edge_capacity = capacity
    inst.running = True
    return inst, f, p


def _log(p, capacity, pad, direction, value, t_us):
    """What the machine does for one record: the record, then the count."""
    count = struct.unpack_from('<I', p, EDGE + 8)[0]
    rec = pad | (0x40 if value else 0) | (0x80 if direction else 0) | (t_us << 8)
    struct.pack_into('<Q', p, EDGE + rq._EDGE_HEADER + 8 * (count % capacity), rec)
    struct.pack_into('<I', p, EDGE + 8, (count + 1) & 0xFFFFFFFF)


def _run(mgr, inst, steps):
    async def run():
        task = asyncio.create_task(mgr._poll_gpio(inst))
        for step in steps:
            await asyncio.sleep(0.04)
            step()
        await asyncio.sleep(0.04)
        inst.running = False
        await asyncio.sleep(0.02)
        task.cancel()

    asyncio.run(run())


def test_every_edge_between_two_looks_is_sent_in_order(tmp_path):
    events = []
    inst, f, p = _v3(tmp_path, events)

    def pulses():
        # GP9 starts being driven, low, then two pulses and GP3 in between
        _log(p, 8, 9, True, True, 100)
        _log(p, 8, 9, False, False, 100)
        _log(p, 8, 9, False, True, 110)
        _log(p, 8, 3, True, True, 112)
        _log(p, 8, 3, False, True, 112)
        _log(p, 8, 9, False, False, 120)
        _log(p, 8, 9, False, True, 130)
        # the block as it is after them: all the old look could see
        struct.pack_into('<4I', p, OFF + 8, (1 << 9) | (1 << 3), 0, (1 << 9) | (1 << 3), 0)
        struct.pack_into('<I', p, OFF + 4, 1)

    _run(rq.Rp2350Manager(), inst, [pulses])
    f.close()
    batches = [d['events'] for k, d in events if k == 'rp2350_gpio_batch']
    assert batches == [[
        [1, 9, 1, 100], [0, 9, False, 100], [0, 9, True, 110],
        [1, 3, 1, 112], [0, 3, True, 112],
        [0, 9, False, 120], [0, 9, True, 130],
    ]]
    # nothing is said twice from the block
    assert not any(k in ('rp2350_gpio_change', 'rp2350_gpio_dir') for k, _ in events)


def test_a_lane_that_fell_behind_takes_the_block(tmp_path):
    events = []
    inst, f, p = _v3(tmp_path, events, capacity=8)

    def flood():
        for i in range(20):                 # more than the log holds between two looks
            _log(p, 8, 9, False, bool(i & 1), 100 + i)
        struct.pack_into('<4I', p, OFF + 8, 1 << 9, 0, 1 << 9, 0)
        struct.pack_into('<I', p, OFF + 4, 1)

    def one_more():
        _log(p, 8, 9, False, False, 500)

    _run(rq.Rp2350Manager(), inst, [flood, one_more])
    f.close()
    assert ('rp2350_gpio_dir', {'pin': 9, 'dir': 1}) in events
    assert ('rp2350_gpio_change', {'pin': 9, 'value': True}) in events
    # and follows the log again from there
    assert [d['events'] for k, d in events if k == 'rp2350_gpio_batch'] == [[[0, 9, False, 500]]]


def test_pulls_come_from_the_block(tmp_path):
    events = []
    inst, f, p = _v3(tmp_path, events)

    def pulled():
        struct.pack_into('<4I', p, OFF + 40, 1 << 20, 1 << (41 - 32), 1 << 21, 0)
        struct.pack_into('<I', p, OFF + 4, 1)

    def released():
        struct.pack_into('<4I', p, OFF + 40, 0, 1 << (41 - 32), 1 << 21, 0)
        struct.pack_into('<I', p, OFF + 4, 2)

    _run(rq.Rp2350Manager(), inst, [pulled, released])
    f.close()
    pulls = [(d['pin'], d['pull']) for k, d in events if k == 'rp2350_gpio_pull']
    assert pulls == [(20, 'up'), (21, 'down'), (41, 'up'), (20, None)]
