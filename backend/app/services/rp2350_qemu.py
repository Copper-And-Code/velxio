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

Events: serial_output {data}, framebuffer {width, height, pitch, source_width,
source_height, scale, format: 'rgb565', bytes_b64}, system {event}, error
{message}.
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
            inst.panel = mmap.mmap(f.fileno(), _PANEL_SIZE)
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
