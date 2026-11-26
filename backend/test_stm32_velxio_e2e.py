"""
End-to-end test of the STM32H7 path with the VELXIO firmware variant of
copper-and-code-mcu-boards (prebuilt/stm32h7/firmware.elf):

  RenodeManager boot → MicroPython REPL on the UART
  → `import display_driver` (st_ltdc + LVGL + velxio_touch)
  → an LVGL button; two taps through RenodeManager.inject_touch (mailbox in SRAM4)
  → the button's CLICKED count printed on the REPL
  → framebuffer events rebuilt into an image (PNG with --png PATH)

Needs Renode on PATH (or RENODE_BIN). Run from backend/:
    python test_stm32_velxio_e2e.py [--png /path/frame.png]
"""
import asyncio
import base64
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services import renode_manager as rm  # noqa: E402

CLIENT_ID = 'velxio-e2e-1'
BOOT_TIMEOUT_S = 120.0
CMD_TIMEOUT_S = 60.0

APP = [
    "import display_driver as d, lvgl as lv",
    "print('TOUCH', type(d.touch).__name__, d.WIDTH, d.HEIGHT)",
    "n = []",
    "scr = lv.screen_active(); scr.set_style_bg_color(lv.color_hex(0x0e1726), 0)",
    "b = lv.button(scr); b.set_size(240, 120); b.center()",
    "t = lv.label(b); t.set_text('Velxio'); t.center()",
    "b.add_event_cb(lambda e: n.append(1), lv.EVENT.CLICKED, None)",
]


class Frame:
    """The framebuffer as the browser rebuilds it from the events."""

    def __init__(self):
        self.width = self.height = self.pitch = 0
        self.fmt = None
        self.buf = bytearray()
        self.full = self.patches = 0

    def on_full(self, d):
        self.width, self.height, self.pitch = d['width'], d['height'], d['pitch']
        self.fmt = d['format']
        self.buf = bytearray(base64.b64decode(d['bytes_b64']))
        self.full += 1

    def on_patch(self, d):
        if not self.buf:
            return
        data = base64.b64decode(d['bytes_b64'])
        for row in range(d['height']):
            src = row * d['pitch']
            dst = (d['y'] + row) * self.pitch + d['x'] * (self.pitch // self.width)
            self.buf[dst:dst + d['pitch']] = data[src:src + d['pitch']]
        self.patches += 1

    def pixel565(self, x, y):
        o = y * self.pitch + x * 2
        v = self.buf[o] | self.buf[o + 1] << 8
        return ((v >> 11) & 0x1F) << 3, ((v >> 5) & 0x3F) << 2, (v & 0x1F) << 3

    def save_png(self, path):
        from PIL import Image
        img = Image.frombytes('RGB', (self.width, self.height),
                              bytes(self._rgb888()))
        img.save(path)

    def _rgb888(self):
        out = bytearray()
        for y in range(self.height):
            for x in range(self.width):
                out += bytes(self.pixel565(x, y))
        return out


async def main() -> int:
    png = sys.argv[sys.argv.index('--png') + 1] if '--png' in sys.argv else None
    serial = []
    frame = Frame()

    async def cb(event_type, data):
        if event_type == 'serial_output':
            serial.append(data.get('data', ''))
        elif event_type == 'framebuffer':
            frame.on_full(data)
        elif event_type == 'framebuffer_patch':
            frame.on_patch(data)
        elif event_type == 'error':
            print('error event:', data)

    def text():
        return ''.join(serial)

    async def wait_for(pattern, start, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            m = re.search(pattern, text()[start:])
            if m:
                return m
            await asyncio.sleep(0.2)
        return None

    async def run(line, expect=r'>>> ', timeout=CMD_TIMEOUT_S):
        start = len(text())
        await rm.renode_manager.send_serial_bytes(CLIENT_ID, (line + '\r').encode())
        return await wait_for(expect, start, timeout)

    print('firmware:', rm.DEFAULT_FW)
    rm.renode_manager.start_instance(CLIENT_ID, 'stm32h7-core-v13', cb)
    failures = []
    try:
        if not await wait_for(r'STM32H7_CORE Velxio with STM32H743[\s\S]*>>> ', 0,
                              BOOT_TIMEOUT_S):
            failures.append('no REPL banner of the VELXIO variant')
            print(text()[-2000:])
            return 1
        print('REPL up')
        for line in APP:
            if not await run(line):
                failures.append('no prompt after: ' + line)
        m = re.search(r'TOUCH (\w+) (\d+) (\d+)', text())
        if not m or m.group(1) != 'VelxioTouch':
            failures.append('display_driver did not register VelxioTouch')
        print(m.group(0) if m else 'no TOUCH line')

        cx, cy = 512, 300
        for _ in range(2):
            await rm.renode_manager.inject_touch(CLIENT_ID, cx, cy, True)
            await asyncio.sleep(0.6)
            await rm.renode_manager.inject_touch(CLIENT_ID, cx, cy, False)
            await asyncio.sleep(0.6)
        m = await run("print('CLICKS', len(n))", expect=r'CLICKS (\d+)')
        clicks = int(m.group(1)) if m else -1
        print('clicks:', clicks)
        if clicks != 2:
            failures.append('expected 2 clicks, got %d' % clicks)

        await asyncio.sleep(3.0)  # let the poller catch the last frame
        print('framebuffer: %dx%d %s, %d full + %d patches' % (
            frame.width, frame.height, frame.fmt, frame.full, frame.patches))
        if (frame.width, frame.height, frame.fmt) != (1024, 600, 'rgb565'):
            failures.append('framebuffer not 1024x600 rgb565')
        elif frame.pixel565(5, 5) == frame.pixel565(cx, cy - 50):
            failures.append('no button drawn in the framebuffer')
        if png and frame.buf:
            frame.save_png(png)
            print('saved', png)
    finally:
        inst = rm.renode_manager._instances.pop(CLIENT_ID, None)
        if inst:
            await rm.renode_manager._shutdown(inst)

    for f in failures:
        print('FAIL:', f)
    print('PASS' if not failures else 'FAILED')
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
