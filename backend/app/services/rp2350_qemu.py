"""Waveshare RP2350-Touch-LCD-4 on our QEMU: the simulation-WS lane of the
`waveshare-rp2350-lcd4` board.

The board runs the WAVESHARE_RP2350_TOUCH_LCD_4 VELXIO firmware of
copper-and-code-mcu-boards (MicroPython 1.29 + LVGL) on the raspi-pico2
machine of the Copper-And-Code QEMU (qemu-system-arm, hw/arm/rp2350.c), one
process per client:

  - the REPL is the machine's UART0, on the process's stdin/stdout;
  - the panel is a shared file in /dev/shm (`-machine panel-file=`): the
    machine copies each frame there and bumps a serial; this lane polls it and
    sends `framebuffer` events, the same as the STM32H7 lane, so the browser
    reuses its bridge (Stm32H7Bridge with the `rp2350_` prefix);
  - the touch is written into the same file, where the machine's GT911 reads
    it.

    rp2350_start         {board?, psram?: bool}
    rp2350_stop
    rp2350_serial_input  {bytes: [int]}
    rp2350_touch_input   {x, y, pressed}   (panel coordinates, 0-479)
    rp2350_gpio_input    {pin, value}      (GP0-47: a level the circuit drives;
                                            value null lets the pad go)

Events: serial_output {data}, framebuffer {width, height, pitch, source_width,
source_height, scale, format: 'rgb565', bytes_b64}, rp2350_gpio_change {pin,
value} (a pad the firmware drives changed level), rp2350_gpio_dir {pin, dir}
(1: the firmware drives the pad, 0: it let it go), rp2350_pwm {pin, duty}
(0..1 while a PWM channel drives the pad, null when it stops), system {event},
error {message}.

The GPIO block of the same file (version 2 of the layout) carries the pads:
see GPIO_FILE_OFFSET in hw/arm/rp2350.c.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import mmap
import os
import struct
import tempfile
from typing import Awaitable, Callable

from app.core.hooks import register_ws_sim_disconnect, register_ws_sim_handler

logger = logging.getLogger(__name__)

MESSAGE_PREFIX = 'rp2350_'
BOARD_KIND = 'waveshare-rp2350-lcd4'

_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_REPO_ROOT = os.environ.get('VELXIO_REPO_ROOT', os.path.abspath(os.path.join(_BACKEND_DIR, '..')))
# qemu-system-arm with the raspi-pico2 machine (Copper-And-Code qemu, branch rp2350).
QEMU_BIN = os.environ.get(
    'RP2350_QEMU_BIN', os.path.join(_REPO_ROOT, 'prebuilt', 'qemu', 'qemu-system-arm'))
# The VELXIO firmware (`scripts/build.sh rp2 WAVESHARE_RP2350_TOUCH_LCD_4 VELXIO`).
DEFAULT_FW = os.environ.get(
    'RP2350_FIRMWARE',
    os.path.join(_REPO_ROOT, 'prebuilt', 'rp2350', 'waveshare-rp2350-lcd4-velxio.uf2'))
_SHM_DIR = '/dev/shm' if os.path.isdir('/dev/shm') else tempfile.gettempdir()
_FB_POLL_S = float(os.environ.get('VELXIO_RP2350_FB_POLL_MS', '40')) / 1000

# Panel file layout (hw/arm/rp2350.c)
_PANEL_HEADER = 64
_PANEL_SIZE = _PANEL_HEADER + 480 * 480 * 2
_PANEL_MAGIC = 0x42465856
_GPIO_OFFSET = _PANEL_SIZE
_GPIO_SIZE = 256
_GPIO_MAGIC = 0x4f495856
_GPIO_COUNT = 48
_GPIO_POLL_S = 0.005
_GPIO_MAGIC_TRIES = 200       # x 10 ms: how long the machine may take to fill the block
# The edge log after the GPIO block (layout v3): every change of a pad's level
# or direction, in order.
_EDGE_OFFSET = _GPIO_OFFSET + _GPIO_SIZE
_EDGE_HEADER = 16
_EDGE_MAGIC = 0x56455856

EventCallback = Callable[[str, dict], Awaitable[None]]


class Rp2350Instance:
    def __init__(self, client_id: str, callback: EventCallback, psram: bool):
        self.client_id = client_id
        self.callback = callback
        self.psram = psram
        self.process: asyncio.subprocess.Process | None = None
        self.panel_path = os.path.join(_SHM_DIR, 'velxio-rp2350-%d-%s.fb' % (
            os.getpid(), ''.join(c for c in client_id if c.isalnum())[:32]))
        self.panel: mmap.mmap | None = None
        self.touch_serial = 0
        self.gpio_ok = False        # the machine writes the GPIO block (layout v2)
        self.edge_capacity = 0      # records in its edge log (layout v3), 0: none
        # What the circuit drives, kept from the start: the first levels come
        # before the machine has made its file, and must not be lost.
        self.inputs: dict[int, bool | None] = {}
        self.tasks: list[asyncio.Task] = []
        self.running = False

    async def emit(self, event_type: str, data: dict) -> None:
        try:
            await self.callback(event_type, data)
        except Exception as e:  # a closed socket must not kill the lane
            logger.debug('[%s] emit(%s): %s', self.client_id, event_type, e)


class Rp2350Manager:
    def __init__(self) -> None:
        self._instances: dict[str, Rp2350Instance] = {}

    async def start(self, client_id: str, callback: EventCallback, psram: bool) -> None:
        await self.stop(client_id)
        inst = Rp2350Instance(client_id, callback, psram)
        self._instances[client_id] = inst
        for path, what in ((QEMU_BIN, 'qemu-system-arm (RP2350_QEMU_BIN)'),
                           (DEFAULT_FW, 'firmware (RP2350_FIRMWARE)')):
            if not os.path.exists(path):
                await inst.emit('error', {'message': f'RP2350: {what} not found at {path}'})
                self._instances.pop(client_id, None)
                return
        machine = 'raspi-pico2,panel-file=%s%s' % (inst.panel_path, ',psram=on' if psram else '')
        args = [QEMU_BIN, '-M', machine, '-kernel', DEFAULT_FW,
                '-nographic', '-serial', 'stdio', '-monitor', 'none']
        logger.info('[%s] rp2350 start: %s', client_id, ' '.join(args))
        await inst.emit('system', {'event': 'booting'})
        inst.process = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        inst.running = True
        inst.tasks = [asyncio.create_task(self._read_serial(inst)),
                      asyncio.create_task(self._poll_panel(inst))]

    async def stop(self, client_id: str) -> None:
        inst = self._instances.pop(client_id, None)
        if not inst:
            return
        inst.running = False
        for t in inst.tasks:
            t.cancel()
        if inst.process and inst.process.returncode is None:
            try:
                inst.process.kill()
                await asyncio.wait_for(inst.process.wait(), 5)
            except (ProcessLookupError, asyncio.TimeoutError):
                pass
        if inst.panel is not None:
            inst.panel.close()
        try:
            os.unlink(inst.panel_path)
        except OSError:
            pass

    async def send_serial(self, client_id: str, data: bytes) -> None:
        inst = self._instances.get(client_id)
        if inst and inst.process and inst.process.stdin:
            inst.process.stdin.write(data)
            await inst.process.stdin.drain()

    def touch(self, client_id: str, x: int, y: int, pressed: bool) -> None:
        inst = self._instances.get(client_id)
        if not inst or inst.panel is None:
            return
        inst.touch_serial += 1
        x = max(0, min(479, x))
        y = max(0, min(479, y))
        struct.pack_into('<4I', inst.panel, 32, inst.touch_serial, x, y, 1 if pressed else 0)

    def gpio_input(self, client_id: str, pin: int, value: bool | None) -> None:
        """Drive pad `pin` from the circuit (None: let it go)."""
        inst = self._instances.get(client_id)
        if not inst or not 0 <= pin < _GPIO_COUNT:
            return
        inst.inputs[pin] = value
        self._write_input(inst, pin, value)

    @staticmethod
    def _write_input(inst: Rp2350Instance, pin: int, value: bool | None) -> None:
        if inst.panel is None or not inst.gpio_ok:
            return
        word = 4 * (pin >> 5)
        bit = 1 << (pin & 31)
        (level,) = struct.unpack_from('<I', inst.panel, _GPIO_OFFSET + 24 + word)
        (mask,) = struct.unpack_from('<I', inst.panel, _GPIO_OFFSET + 32 + word)
        level = (level | bit) if value else (level & ~bit)
        mask = (mask & ~bit) if value is None else (mask | bit)
        struct.pack_into('<I', inst.panel, _GPIO_OFFSET + 24 + word, level)
        struct.pack_into('<I', inst.panel, _GPIO_OFFSET + 32 + word, mask)

    async def _read_serial(self, inst: Rp2350Instance) -> None:
        assert inst.process and inst.process.stdout
        booted = False
        while True:
            chunk = await inst.process.stdout.read(4096)
            if not chunk:
                break
            text = chunk.decode('utf-8', errors='replace')
            if not booted and 'MicroPython' in text:
                booted = True
                await inst.emit('system', {'event': 'booted'})
            await inst.emit('serial_output', {'data': text})
        if inst.running:
            rc = await inst.process.wait()
            await inst.emit('system', {'event': 'exited', 'code': rc})

    async def _poll_panel(self, inst: Rp2350Instance) -> None:
        # The machine creates the file at start-up.
        for _ in range(200):
            if os.path.exists(inst.panel_path) and os.path.getsize(inst.panel_path) >= _PANEL_SIZE:
                break
            await asyncio.sleep(0.05)
        else:
            await inst.emit('error', {'message': 'RP2350: no panel file from the machine'})
            return
        with open(inst.panel_path, 'r+b') as f:
            size = os.fstat(f.fileno()).st_size
            has_gpio = size >= _GPIO_OFFSET + _GPIO_SIZE
            inst.panel = mmap.mmap(f.fileno(), size if has_gpio else _PANEL_SIZE)
        if has_gpio:
            # The machine gives the file its size first, then clears the GPIO
            # block and writes its magic: an input written before that would
            # be wiped, and a poll started before it would find no block.
            for _ in range(_GPIO_MAGIC_TRIES):
                if struct.unpack_from('<I', inst.panel, _GPIO_OFFSET)[0] == _GPIO_MAGIC:
                    inst.gpio_ok = True
                    break
                await asyncio.sleep(0.01)
            # The edge log is filled before the GPIO magic is written.
            if inst.gpio_ok and size >= _EDGE_OFFSET + _EDGE_HEADER:
                magic, capacity = struct.unpack_from('<2I', inst.panel, _EDGE_OFFSET)
                if magic == _EDGE_MAGIC and 0 < capacity <= (size - _EDGE_OFFSET - _EDGE_HEADER) // 8:
                    inst.edge_capacity = capacity
        if inst.gpio_ok:
            for pin, value in list(inst.inputs.items()):
                self._write_input(inst, pin, value)
            inst.tasks.append(asyncio.create_task(self._poll_gpio(inst)))
        last = 0
        while inst.running:
            magic, _ver, serial, w, h, scale = struct.unpack_from('<6I', inst.panel, 0)
            if magic == _PANEL_MAGIC and serial != last and w and h and w * h * 2 <= _PANEL_SIZE - _PANEL_HEADER:
                last = serial
                pixels = inst.panel[_PANEL_HEADER:_PANEL_HEADER + w * h * 2]
                scale = scale or 1
                await inst.emit('framebuffer', {
                    'width': w, 'height': h, 'pitch': w * 2,
                    'source_width': w * scale, 'source_height': h * scale,
                    'scale': scale, 'format': 'rgb565',
                    'bytes_b64': base64.b64encode(pixels).decode('ascii'),
                })
            await asyncio.sleep(_FB_POLL_S)


    async def _poll_gpio(self, inst: Rp2350Instance) -> None:
        """What the firmware does with its pads, as events.

        With the machine's edge log (layout v3) every change of a pad's level
        or direction is sent, in the order it happened, as one
        `rp2350_gpio_batch` a look: `events` is a list of [kind, pin, value,
        time in us], kind 0 a level and 1 a direction. A bit-banged line (a
        shift register's clock, a stepper driver's STEP) keeps all its edges.
        Without the log, or when the lane fell behind it, the levels and
        directions come from the block as they are at the time of the look
        (`rp2350_gpio_dir`, `rp2350_gpio_change`). PWM duty and the pads'
        pulls always come from the block (`rp2350_pwm`, `rp2350_gpio_pull`).
        """
        assert inst.panel is not None
        p = inst.panel
        capacity = inst.edge_capacity
        last_serial = None
        levels: list[bool | None] = [None] * _GPIO_COUNT
        driven = 0
        duties: list[float | None] = [None] * _GPIO_COUNT
        pulls: list[str | None] = [None] * _GPIO_COUNT
        read: int | None = None             # the log's next record
        while inst.running:
            from_block = capacity == 0
            batch: list[list] = []
            if capacity:
                count = struct.unpack_from('<I', p, _EDGE_OFFSET + 8)[0]
                if read is None:            # the first look: start from the block
                    read, from_block = count, True
                behind = (count - read) & 0xFFFFFFFF
                records: tuple[int, ...] = ()
                if 0 < behind <= capacity:
                    records = tuple(
                        struct.unpack_from('<Q', p, _EDGE_OFFSET + _EDGE_HEADER + 8 * ((read + i) % capacity))[0]
                        for i in range(behind))
                    # the machine may have gone round the log while it was read
                    count = struct.unpack_from('<I', p, _EDGE_OFFSET + 8)[0]
                if ((count - read) & 0xFFFFFFFF) > capacity:
                    read, from_block, records = count, True, ()
                else:
                    read = (read + len(records)) & 0xFFFFFFFF
                for rec in records:
                    n, value, t_us = rec & 0x3F, bool(rec & 0x40), rec >> 8
                    if n >= _GPIO_COUNT:
                        continue
                    if rec & 0x80:          # the pad starts or stops being driven
                        if bool((driven >> n) & 1) == value:
                            continue
                        driven ^= 1 << n
                        levels[n] = None
                        batch.append([1, n, 1 if value else 0, t_us])
                    elif levels[n] != value:
                        levels[n] = value
                        batch.append([0, n, value, t_us])
            if batch:
                await inst.emit('rp2350_gpio_batch', {'events': batch})

            serial = struct.unpack_from('<I', p, _GPIO_OFFSET + 4)[0]
            if serial != last_serial or from_block:
                last_serial = serial
                out_lo, out_hi, oe_lo, oe_hi = struct.unpack_from('<4I', p, _GPIO_OFFSET + 8)
                up_lo, up_hi, down_lo, down_hi = struct.unpack_from('<4I', p, _GPIO_OFFSET + 40)
                raw = struct.unpack_from('<%dI' % _GPIO_COUNT, p, _GPIO_OFFSET + 64)
                if from_block:
                    out = out_lo | (out_hi << 32)
                    oe = oe_lo | (oe_hi << 32)
                    for n in range(_GPIO_COUNT):
                        if ((oe ^ driven) >> n) & 1:
                            if not (oe >> n) & 1:
                                levels[n] = None    # the next time it drives, say its level again
                            await inst.emit('rp2350_gpio_dir', {'pin': n, 'dir': (oe >> n) & 1})
                    driven = oe
                    for n in range(_GPIO_COUNT):
                        if not (oe >> n) & 1:
                            continue
                        level = bool((out >> n) & 1)
                        if level != levels[n]:
                            levels[n] = level
                            await inst.emit('rp2350_gpio_change', {'pin': n, 'value': level})
                up = up_lo | (up_hi << 32)
                down = down_lo | (down_hi << 32)
                for n in range(_GPIO_COUNT):
                    duty = None if raw[n] == 0xffffffff else min(raw[n], 65536) / 65536
                    if duty != duties[n]:
                        duties[n] = duty
                        await inst.emit('rp2350_pwm', {'pin': n, 'duty': duty})
                    pull = 'down' if (down >> n) & 1 else 'up' if (up >> n) & 1 else None
                    if pull != pulls[n]:
                        pulls[n] = pull
                        await inst.emit('rp2350_gpio_pull', {'pin': n, 'pull': pull})
            await asyncio.sleep(_GPIO_POLL_S)


rp2350_manager = Rp2350Manager()


async def handle_message(websocket, client_id: str, msg_type: str,
                         msg_data: dict, callback) -> bool:  # noqa: ARG001
    if not msg_type.startswith(MESSAGE_PREFIX):
        return False
    if msg_type == 'rp2350_start':
        await rp2350_manager.start(client_id, callback, bool(msg_data.get('psram', False)))
    elif msg_type == 'rp2350_stop':
        await rp2350_manager.stop(client_id)
    elif msg_type == 'rp2350_serial_input':
        raw = msg_data.get('bytes', [])
        if raw:
            await rp2350_manager.send_serial(client_id, bytes(raw))
    elif msg_type == 'rp2350_gpio_input':
        value = msg_data.get('value')
        rp2350_manager.gpio_input(client_id, int(msg_data.get('pin', -1)),
                                  None if value is None else bool(value))
    elif msg_type == 'rp2350_touch_input':
        rp2350_manager.touch(client_id, int(msg_data.get('x', 0)), int(msg_data.get('y', 0)),
                             bool(msg_data.get('pressed', False)))
    else:
        return False
    return True


async def handle_disconnect(client_id: str) -> None:
    await rp2350_manager.stop(client_id)


def register() -> None:
    register_ws_sim_handler(handle_message)
    register_ws_sim_disconnect(handle_disconnect)
