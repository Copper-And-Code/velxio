"""
RenodeManager — backend service for STM32H7_CORE V13 emulation via Renode.

Architecture
------------
Each STM32H7_CORE instance gets:
  - renode subprocess (--disable-xwt --hide-monitor) running a generated .resc
  - USART1 (PA9/PA10) → TCP socket → user serial I/O
  - Renode monitor → TCP socket → register/memory introspection
  - LTDC poller (Phase 3): polls LTDC registers; when layer is enabled, reads
    SDRAM at the configured framebuffer address and emits 'framebuffer' events.
"""

import asyncio
import base64
import logging
import os
import pty
import re
import signal
import socket
import struct
import subprocess
import tempfile
import time
import tty
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

# ── Paths ────────────────────────────────────────────────────────────────────
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_REPO_ROOT   = os.environ.get(
    'VELXIO_REPO_ROOT',
    os.path.abspath(os.path.join(_BACKEND_DIR, '..')),
)
RENODE_BIN   = os.environ.get('RENODE_BIN', 'renode')
REPL_PATH    = os.path.join(_REPO_ROOT, 'renode', 'platforms', 'stm32h7_core_v13.repl')
FB_SERVER_PY = os.path.join(_REPO_ROOT, 'renode', 'extensions', 'velxio_framebuffer_server.py')
# SPI.Winbond_W25Q, the QSPI flash of the .repl: Renode compiles it at run time.
W25Q_CS      = os.path.join(_REPO_ROOT, 'renode', 'extensions', 'Winbond_W25Q.cs')
# Firmware: the STM32H7_CORE VELXIO variant of Copper-And-Code/copper-and-code-mcu-boards
# (`scripts/build.sh stm32 STM32H7_CORE VELXIO`), copied to prebuilt/stm32h7/ as
# the Docker image expects it; STM32H7_CORE_FIRMWARE overrides the path.
DEFAULT_FW   = os.environ.get(
    'STM32H7_CORE_FIRMWARE',
    os.path.join(_REPO_ROOT, 'prebuilt', 'stm32h7', 'firmware.elf'),
)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


EventCallback = Callable[[str, dict], Awaitable[None]]


# ── Touch input mailbox (Velxio extension) ───────────────────────────────────
# Renode models no GT911, so the backend writes the pointer into a 16-byte
# mailbox at the top of the D3 SRAM (SRAM4, 0x38000000-0x3800FFFF), which the
# firmware uses for nothing else. The VELXIO firmware variant reads it in
# python/velxio_touch.py and display_driver registers it as the LVGL pointer, so
# applications need no code of their own. Not in the SDRAM: its top 4 MB
# (0xC1C00000-0xC1FFFFFF) are st_ltdc's framebuffer zone, below it is the GC heap.
TOUCH_MAILBOX = 0x3800FF00
#   +0x00 (uint32) pressed (0/1)
#   +0x04 (uint32) x (display pixel)
#   +0x08 (uint32) y (display pixel)
#   +0x0C (uint32) seqno (incremented per non-redundant write)


# ── LTDC register layout (STM32H7 RM0433) ────────────────────────────────────
LTDC_BASE      = 0x50001000
LTDC_GCR       = LTDC_BASE + 0x018  # bit 0 = LTDCEN
# Layer 1 registers — base at LTDC_BASE + 0x84 per H743 CMSIS / RM0433 §33.7
LTDC_L1CR      = LTDC_BASE + 0x084  # bit 0 = LEN
LTDC_L1PFCR    = LTDC_BASE + 0x094  # bits[2:0] = pixel format
LTDC_L1CFBAR   = LTDC_BASE + 0x0AC  # framebuffer pointer
LTDC_L1CFBLR   = LTDC_BASE + 0x0B0  # bits[28:16]=pitch, [12:0]=line_len_bytes+3
LTDC_L1CFBLNR  = LTDC_BASE + 0x0B4  # bits[10:0] = line count

# Bytes-per-pixel per LTDC pixel format. By default the poller decodes L1PFCR
# at runtime; VELXIO_STM32_FB_FORMAT is only a diagnostic override.
_FB_FORMAT_BPP = {
    'argb8888': 4,
    'rgb888':   3,
    'rgb565':   2,
    'argb1555': 2,
    'argb4444': 2,
    'l8':       1,
    'al44':     1,
    'al88':     2,
}
_FB_FORMAT_OVERRIDE = os.environ.get('VELXIO_STM32_FB_FORMAT', '').lower()
if _FB_FORMAT_OVERRIDE and _FB_FORMAT_OVERRIDE not in _FB_FORMAT_BPP:
    _FB_FORMAT_OVERRIDE = ''

_LTDC_PFCR_FORMAT = {
    0b000: 'argb8888',
    0b001: 'rgb888',
    0b010: 'rgb565',
    0b011: 'argb1555',
    0b100: 'argb4444',
    0b101: 'l8',
    0b110: 'al44',
    0b111: 'al88',
}

# Polling cadence for the LTDC framebuffer (env-overridable)
_FB_POLL_MS = int(os.environ.get('VELXIO_STM32_FB_POLL_MS', '300'))
_FB_FAST_POLL_MS = int(os.environ.get('VELXIO_STM32_FB_FAST_POLL_MS', '80'))
_FB_FAST_WINDOW_MS = int(os.environ.get('VELXIO_STM32_FB_FAST_WINDOW_MS', '1200'))
_FB_BINARY_TRANSPORT = os.environ.get('VELXIO_STM32_FB_BINARY', '1') not in ('0', 'false', 'False')
# Optional preview scaler for Renode's slow text monitor transport. A full
# 1024x600 RGB565 read is 1.2 MB raw and much larger as monitor text; by
# default we sample down to at most 512 logical pixels wide only when using the
# monitor fallback. The binary socket can carry full-res frames fast enough, and
# full-res avoids aliasing LVGL's text glyphs.
_FB_MAX_WIDTH = int(os.environ.get(
    'VELXIO_STM32_FB_MAX_WIDTH',
    '0' if _FB_BINARY_TRANSPORT else '512',
))
_FB_BAND_ROWS = max(1, int(os.environ.get('VELXIO_STM32_FB_BAND_ROWS', '16')))
# Hard cap on framebuffer size we'll attempt to read (safety against bogus
# register values pointing to a huge memcpy). 1024 × 600 × 4 = 2,457,600.
_FB_MAX_BYTES = 4 * 1024 * 1024
# SDRAM windows we accept as plausible framebuffer base addresses.
_FB_VALID_BASES = (0xC0000000, 0xD0000000)

# ANSI SGR escape stripper — Renode wraps its prompt in colour codes
# (e.g. "\x1b[33;1m(machine) \x1b[0m"), and we need a clean ") " terminator
# match to know when a monitor reply is fully buffered.
_ANSI_RE = re.compile(rb'\x1b\[[0-9;]*[a-zA-Z]')
_ANSI_RE_STR = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')

# ── GPIO (STM32H7 RM0433) ────────────────────────────────────────────────────
# Each GPIOx peripheral occupies a 1 KB region starting at 0x58020000.
# ODR (output data register) sits at offset 0x14 and exposes bits[15:0] —
# one bit per pin. We poll ODR for the ports that the V13 board breaks out
# (A, B, C) plus the one carrying the on-board LEDs (B). Rate is fast enough
# for human-visible blinking but coarse for PWM — high-frequency toggling is
# explicitly out of scope for this transport (would need event hooks, not
# polling).
_GPIO_BASE = {
    'A': 0x58020000,
    'B': 0x58020400,
    'C': 0x58020800,
    'D': 0x58020C00,
    'E': 0x58021000,
    'F': 0x58021400,
    'G': 0x58021800,
    'H': 0x58021C00,
}
_GPIO_ODR_OFFSET = 0x14
_GPIO_POLL_PORTS = ('A', 'B', 'C')
_GPIO_POLL_MS = int(os.environ.get('VELXIO_STM32_GPIO_POLL_MS', '50'))


def _strip_echo_and_prompt(text: str, sent_cmd: str) -> str:
    """Drop the command-echo line and the trailing prompt from a monitor reply.

    Renode's monitor echoes every command verbatim before printing the result
    and then a `(machine) ` prompt. The echo line confuses any regex that
    extracts hex tokens (the echoed address is the first match), so we strip
    it before parsing.
    """
    lines = text.replace('\r', '').split('\n')
    cleaned: list[str] = []
    seen_echo = False
    for ln in lines:
        s = ln.strip()
        if not seen_echo and sent_cmd and sent_cmd in s:
            seen_echo = True
            continue
        # Drop the trailing prompt line (matches "(<name>)" patterns).
        if re.fullmatch(r'\(\S+?\)\s*', s):
            continue
        cleaned.append(ln)
    return '\n'.join(cleaned)


def _parse_readbytes_response(text: str, sent_cmd: str = '') -> bytes:
    """Parse the textual output of `sysbus ReadBytes <addr> <count>`.

    The monitor returns lines like:
        [
        0x00, 0x12, 0xff, ...,
        0xab,
        ]
    """
    body = _strip_echo_and_prompt(text, sent_cmd) if sent_cmd else text
    out = bytearray()
    for tok in re.findall(r'0x[0-9A-Fa-f]{1,2}\b', body):
        out.append(int(tok, 16) & 0xFF)
    return bytes(out)


_RESC_TEMPLATE = """\
:name: STM32H7_CORE V13 — Velxio instance {client_id}
:description: Auto-generated per-instance boot script.

$bin?=@{firmware}

using sysbus
mach create "h743_{mach_id}"
include @{w25q_cs}
machine LoadPlatformDescription @{repl}

logLevel 3
logLevel -1 sysbus.usart1

{fb_server_boot}

emulation CreateServerSocketTerminal {uart_port} "uart1term" false
connector Connect sysbus.usart1 uart1term

macro reset
\"\"\"
    cpu VectorTableOffset 0x08000000
    sysbus LoadELF $bin
\"\"\"
runMacro $reset

start
"""

# Whether to expose USART1 as a host PTY (for Thonny / mpremote / minicom).
# Default ON; symlink lives at $VELXIO_STM32_PTY_DIR/velxio-stm32-<client>.pty
_PTY_ENABLED = os.environ.get('VELXIO_STM32_PTY', '1') not in ('0', 'false', 'False')
_PTY_DIR     = os.environ.get('VELXIO_STM32_PTY_DIR', '/tmp')


class RenodeInstance:
    """State for one running STM32H7_CORE board."""

    def __init__(self, client_id: str, callback: EventCallback):
        self.client_id = client_id
        self.callback  = callback

        self.process:        subprocess.Popen | None = None
        self.resc_path:      str | None = None
        self.firmware_path:  str = DEFAULT_FW
        self.uart_port:      int = 0
        self.monitor_port:   int = 0
        self.fb_port:        int = 0
        self.pty_path:       str | None = None
        self.pty_master_fd:  int | None = None
        self.pty_slave_fd:   int | None = None
        self._serial_writer: asyncio.StreamWriter | None = None
        self._mon_reader:    asyncio.StreamReader | None = None
        self._mon_writer:    asyncio.StreamWriter | None = None
        self._fb_reader:     asyncio.StreamReader | None = None
        self._fb_writer:     asyncio.StreamWriter | None = None
        self._fb_io_lock:    asyncio.Lock = asyncio.Lock()
        self._touch_reader:  asyncio.StreamReader | None = None
        self._touch_writer:  asyncio.StreamWriter | None = None
        self._touch_io_lock: asyncio.Lock = asyncio.Lock()
        self._fb_binary_ok:  bool = False
        self._binary_warned: dict[str, bool] = {}
        self._binary_retry_after: dict[str, float] = {}
        self._mon_lock:      asyncio.Lock = asyncio.Lock()
        self._fb_geometry_key: tuple[int, int, int, int, str, int, int] | None = None
        self._fb_rows: list[bytes] = []
        self._fb_stats_window_start: float = time.monotonic()
        self._fb_stats_last_emit: float = 0.0
        self._fb_wake_event: asyncio.Event = asyncio.Event()
        self._fb_fast_until: float = 0.0
        self._fb_current_poll_ms: int = _FB_POLL_MS
        self._fb_stats: dict[str, float | int | str] = {
            'polls': 0,
            'unchanged': 0,
            'full_frames': 0,
            'patches': 0,
            'bytes_sent': 0,
            'changed_rows': 0,
            'scan_ms': 0.0,
            'poll_ms': _FB_POLL_MS,
            'width': 0,
            'height': 0,
            'format': 'rgb565',
        }
        # Per-port last-seen ODR value, keyed by port letter ('A'/'B'/...).
        # Used by the GPIO poller to emit only on-edge transitions.
        self._gpio_last:     dict[str, int] = {}
        # Touch mailbox state — last (x, y, pressed) injected so we skip
        # redundant monitor writes during static drag/hover. seqno
        # advances on every non-redundant write so MicroPython can detect
        # new events even when (x, y, pressed) repeat.
        self._touch_last: tuple[int, int, bool] | None = None
        self._touch_seq: int = 0
        self._tasks: list[asyncio.Task] = []
        self.running = False

    async def emit(self, event_type: str, data: dict) -> None:
        try:
            await self.callback(event_type, data)
        except Exception as e:
            logger.error('emit(%s): %s', event_type, e)


class RenodeManager:
    def __init__(self):
        self._instances: dict[str, RenodeInstance] = {}

    # ── Public API ────────────────────────────────────────────────────────────

    def start_instance(self, client_id: str, board_type: str,  # noqa: ARG002
                       callback: EventCallback,
                       firmware_path: str | None = None) -> None:
        if client_id in self._instances:
            logger.warning('start_instance: %s already running', client_id)
            return
        inst = RenodeInstance(client_id, callback)
        if firmware_path:
            inst.firmware_path = firmware_path
        self._instances[client_id] = inst
        asyncio.create_task(self._boot(inst))

    def stop_instance(self, client_id: str) -> None:
        inst = self._instances.pop(client_id, None)
        if inst:
            asyncio.create_task(self._shutdown(inst))

    def _drop_instance_if_current(self, inst: RenodeInstance) -> None:
        if self._instances.get(inst.client_id) is inst:
            self._instances.pop(inst.client_id, None)

    async def send_serial_bytes(self, client_id: str, data: bytes) -> None:
        inst = self._instances.get(client_id)
        if inst and inst._serial_writer:
            inst._serial_writer.write(data)
            try:
                await inst._serial_writer.drain()
            except Exception as e:
                logger.warning('send_serial_bytes drain: %s', e)

    async def set_gpio_input(self, client_id: str, port: str,
                             pin: int, value: bool) -> None:
        """Drive a GPIO pin as if an external component pulled it high/low.

        Maps onto Renode's `BaseGPIOPort.OnGPIO(int, bool)` method, which is
        what `Miscellaneous.Button` uses internally — so this works for any
        pin the firmware has configured as an input (or as a wake source).
        """
        inst = self._instances.get(client_id)
        if not inst:
            return
        port_u = port.upper()
        if port_u not in _GPIO_BASE or not (0 <= pin < 16):
            logger.warning('set_gpio_input: invalid port=%s pin=%s', port, pin)
            return
        cmd = (f'sysbus.gpioPort{port_u} OnGPIO {pin} '
               f'{"true" if value else "false"}')
        await self._monitor_cmd(inst, cmd, timeout=2.0)
        self._wake_framebuffer_poll(inst)

    async def inject_touch(self, client_id: str,
                           x: int, y: int, pressed: bool) -> None:
        """Write (x, y, pressed) into the touch mailbox at TOUCH_MAILBOX.

        The firmware's touch driver (velxio_touch.py, registered by
        display_driver) polls these four uint32 words from LVGL's indev read
        callback; no interrupts, no handshaking.

        Skips redundant writes (same x, y, pressed as previous call) to
        avoid spamming the monitor under fast mouse-move bursts. Each
        non-redundant write also advances seqno so the MP side can detect
        repeated identical events if it cares to.
        """
        inst = self._instances.get(client_id)
        if not inst:
            return
        x &= 0xFFFFFFFF
        y &= 0xFFFFFFFF
        cur = (x, y, bool(pressed))
        if inst._touch_last == cur:
            return
        inst._touch_last = cur
        inst._touch_seq = (inst._touch_seq + 1) & 0xFFFFFFFF
        # Four sequential writes. The framebuffer binary socket supports a
        # raw WriteDoubleWord path, avoiding monitor-lock contention from
        # GPIO/register polling; if it is unavailable we fall back to the
        # Renode monitor command.
        #
        # Order matters: the LVGL indev callback in the firmware
        # reads the mailbox non-atomically, so it can observe writes mid-
        # flight. We deliberately put `pressed` LAST — that way the
        # firmware sees `pressed=1` only after `x` and `y` are already at
        # their final values, avoiding bogus press-at-(0,0) events that
        # would make LVGL treat a tap as a drag-from-outside-the-widget.
        # `seq` advances second-to-last so MP can detect a clean event
        # boundary before the press transition.
        for off, val in (
            (0x04, x),
            (0x08, y),
            (0x0C, inst._touch_seq),
            (0x00, 1 if pressed else 0),
        ):
            if await self._write_doubleword_binary(inst, TOUCH_MAILBOX + off, val):
                continue
            await self._monitor_cmd(
                inst,
                f'sysbus WriteDoubleWord {TOUCH_MAILBOX + off:#x} {val:#x}',
                timeout=2.0,
            )
        self._wake_framebuffer_poll(inst)

    # ── Boot sequence ─────────────────────────────────────────────────────────

    async def _boot(self, inst: RenodeInstance) -> None:
        if not os.path.exists(REPL_PATH):
            await inst.emit('error', {'message': f'.repl not found at {REPL_PATH}'})
            self._drop_instance_if_current(inst)
            return
        if not os.path.exists(inst.firmware_path):
            await inst.emit('error',
                            {'message': f'firmware not found: {inst.firmware_path}'})
            self._drop_instance_if_current(inst)
            return

        inst.uart_port    = _find_free_port()
        inst.monitor_port = _find_free_port()
        inst.fb_port      = _find_free_port()

        # Render .resc to tempfile
        mach_id = inst.client_id.replace('-', '_')[:16]
        resc_text = _RESC_TEMPLATE.format(
            client_id=inst.client_id,
            mach_id=mach_id,
            firmware=inst.firmware_path,
            repl=REPL_PATH,
            w25q_cs=W25Q_CS,
            uart_port=inst.uart_port,
            fb_port=inst.fb_port,
            fb_server_boot=(
                f'python "VELXIO_FB_PORT={inst.fb_port}"\n'
                f'python "execfile(\'{FB_SERVER_PY}\')"'
                if _FB_BINARY_TRANSPORT else
                '# Velxio framebuffer binary server disabled'
            ),
        )
        tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.resc', prefix='velxio_renode_', delete=False)
        tmp.write(resc_text)
        tmp.close()
        inst.resc_path = tmp.name

        cmd = [
            RENODE_BIN,
            '--disable-xwt',
            '--hide-monitor',
            '--port', str(inst.monitor_port),
            inst.resc_path,
        ]
        logger.info('Launching Renode for %s: %s', inst.client_id, ' '.join(cmd))

        loop = asyncio.get_running_loop()
        try:
            inst.process = await loop.run_in_executor(
                None,
                lambda: subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    # `renode` is a shell script that starts `dotnet Renode.dll`:
                    # a group of its own, so that _shutdown stops both.
                    start_new_session=True,
                ),
            )
        except FileNotFoundError:
            await inst.emit('error',
                            {'message': f'{RENODE_BIN} not found in PATH'})
            self._drop_instance_if_current(inst)
            return

        inst.running = True
        await inst.emit('system', {'event': 'booting'})

        # Renode takes a few seconds to initialise the platform and open sockets
        await asyncio.sleep(3.0)

        inst._tasks.append(asyncio.create_task(self._connect_serial(inst)))
        inst._tasks.append(asyncio.create_task(self._watch_stdout(inst)))
        inst._tasks.append(asyncio.create_task(self._connect_monitor(inst)))

    # ── Serial (USART1) ───────────────────────────────────────────────────────

    async def _connect_serial(self, inst: RenodeInstance) -> None:
        for attempt in range(10):
            try:
                reader, writer = await asyncio.open_connection(
                    '127.0.0.1', inst.uart_port)
                inst._serial_writer = writer
                logger.info('%s: USART1 connected on port %d',
                            inst.client_id, inst.uart_port)
                self._open_pty(inst)
                if inst.pty_path:
                    logger.info('%s: USART1 PTY available at %s',
                                inst.client_id, inst.pty_path)
                    await inst.emit('system',
                                    {'event': 'pty_ready',
                                     'pty_path': inst.pty_path})
                await inst.emit('system', {'event': 'booted'})
                await self._read_serial(inst, reader)
                return
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(1.0 * (attempt + 1))
        await inst.emit('error',
                        {'message': 'Could not connect to Renode USART1 socket'})

    async def _read_serial(self, inst: RenodeInstance,
                           reader: asyncio.StreamReader) -> None:
        while inst.running:
            try:
                chunk = await asyncio.wait_for(reader.read(256), timeout=0.1)
                if not chunk:
                    break
                # Forward Renode output to both the WebSocket and the host PTY.
                if inst.pty_master_fd is not None:
                    try:
                        os.write(inst.pty_master_fd, chunk)
                    except OSError:
                        pass
                text = chunk.decode('utf-8', errors='replace')
                await inst.emit('serial_output', {'data': text})
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.warning('%s serial read: %s', inst.client_id, e)
                break

    # ── Host PTY proxy (so external tools like Thonny can attach) ────────────

    def _open_pty(self, inst: RenodeInstance) -> None:
        if not _PTY_ENABLED or inst.pty_master_fd is not None:
            return
        try:
            os.makedirs(_PTY_DIR, exist_ok=True)
            master_fd, slave_fd = pty.openpty()
            # Put the slave in raw mode BEFORE wiring up reads. The default
            # termios state on a fresh PTY is canonical + ECHO, which means
            # bytes written into the master (i.e. UART output forwarded by
            # _read_serial) get echoed back out of the master and then fed
            # back into the UART by _read_pty_loop — an infinite loop that
            # makes the MicroPython REPL try to execute its own banner as
            # Python code. Raw mode disables ECHO, ICANON, ISIG, IXON, OPOST
            # and the input/output mappings (CR↔LF), giving us a clean
            # transparent byte pipe.
            tty.setraw(slave_fd)
            os.set_blocking(master_fd, False)
            slave_name = os.ttyname(slave_fd)
            safe_id = re.sub(r'[^A-Za-z0-9_-]', '_', inst.client_id)
            link_path = os.path.join(_PTY_DIR, f'velxio-stm32-{safe_id}.pty')
            try:
                if os.path.islink(link_path) or os.path.exists(link_path):
                    os.unlink(link_path)
            except OSError:
                pass
            os.symlink(slave_name, link_path)
            inst.pty_master_fd = master_fd
            inst.pty_slave_fd  = slave_fd
            inst.pty_path      = link_path
            inst._tasks.append(asyncio.create_task(self._read_pty_loop(inst)))
        except OSError as e:
            logger.warning('%s: PTY setup failed: %s', inst.client_id, e)
            inst.pty_master_fd = None
            inst.pty_slave_fd  = None
            inst.pty_path      = None

    async def _read_pty_loop(self, inst: RenodeInstance) -> None:
        """Forward bytes the host wrote to the PTY slave back into USART1."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()

        def on_readable() -> None:
            assert inst.pty_master_fd is not None
            try:
                data = os.read(inst.pty_master_fd, 4096)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                if not fut.done():
                    fut.set_result(None)
                return
            if not data:
                if not fut.done():
                    fut.set_result(None)
                return
            if inst._serial_writer:
                try:
                    inst._serial_writer.write(data)
                except Exception as e:
                    logger.warning('%s: PTY→serial write: %s', inst.client_id, e)

        assert inst.pty_master_fd is not None
        loop.add_reader(inst.pty_master_fd, on_readable)
        try:
            while inst.running:
                try:
                    await asyncio.wait_for(asyncio.shield(fut), timeout=0.5)
                    break
                except asyncio.TimeoutError:
                    continue
        finally:
            try:
                loop.remove_reader(inst.pty_master_fd)
            except Exception:
                pass

    # ── Renode monitor (register/memory introspection) ───────────────────────

    async def _connect_monitor(self, inst: RenodeInstance) -> None:
        for attempt in range(10):
            try:
                inst._mon_reader, inst._mon_writer = await asyncio.open_connection(
                    '127.0.0.1', inst.monitor_port)
                break
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(1.0 * (attempt + 1))
        else:
            logger.warning('%s: could not connect to Renode monitor on port %d',
                           inst.client_id, inst.monitor_port)
            return

        # Drain the welcome banner.
        try:
            await asyncio.wait_for(inst._mon_reader.read(8192), timeout=1.5)
        except asyncio.TimeoutError:
            pass
        logger.info('%s: monitor connected on port %d',
                    inst.client_id, inst.monitor_port)
        # Spawn the GPIO poller as a sibling task so it gets cancelled by
        # `_shutdown` like everything else; the framebuffer loop stays
        # inline so this coroutine pins the monitor connection's lifetime.
        # Both pollers serialise their monitor reads via `_mon_lock`.
        inst._tasks.append(asyncio.create_task(self._poll_gpio_loop(inst)))
        await self._poll_framebuffer_loop(inst)

    async def _monitor_cmd(self, inst: RenodeInstance, line: str,
                           timeout: float = 5.0,
                           max_bytes: int = 16 * 1024 * 1024) -> str:
        """Send a single monitor command and return the reply (text)."""
        if not inst._mon_writer or not inst._mon_reader:
            return ''
        async with inst._mon_lock:
            try:
                inst._mon_writer.write((line + '\n').encode())
                await inst._mon_writer.drain()
            except Exception as e:
                logger.warning('%s: monitor write: %s', inst.client_id, e)
                return ''
            buf = bytearray()
            deadline = asyncio.get_event_loop().time() + timeout
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    chunk = await asyncio.wait_for(
                        inst._mon_reader.read(65536), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                if not chunk:
                    break
                buf.extend(chunk)
                if len(buf) > max_bytes:
                    break
                # Renode prompt: "(<machine-name>) " optionally wrapped in
                # SGR colour escapes like "\x1b[33;1m(...) \x1b[0m". Strip
                # ANSI from the tail before matching — without this every
                # read waits the full timeout (~2 s), turning the GPIO poll
                # into a tortoise that misses fast firmware-side toggles.
                tail = _ANSI_RE.sub(b'', bytes(buf[-64:]))
                if tail.endswith(b') ') and b'\n' in tail:
                    break
        return buf.decode('utf-8', 'replace')

    async def _read_register(self, inst: RenodeInstance, addr: int) -> int | None:
        cmd = f'sysbus ReadDoubleWord {addr:#x}'
        out = await self._monitor_cmd(inst, cmd, timeout=2.0)
        body = _ANSI_RE_STR.sub('', _strip_echo_and_prompt(out, cmd))
        # The reply to ReadDoubleWord is a single hex value on its own line,
        # but the buffer can also contain leftover bytes from the echoed
        # command address or stray prompt fragments. Filter to candidates
        # that look like a 32-bit-word value (ignore the echoed register
        # address itself), then take the last one — the response always
        # follows the echo.
        addr_lit = f'{addr:#x}'.lower()
        candidates = [m for m in re.findall(r'0x[0-9A-Fa-f]+', body)
                      if m.lower() != addr_lit]
        if not candidates:
            return None
        try:
            return int(candidates[-1], 16)
        except ValueError:
            return None

    async def _read_memory(self, inst: RenodeInstance,
                           addr: int, count: int) -> bytes:
        binary = await self._read_memory_binary(inst, addr, count)
        if binary is not None:
            return binary

        cmd = f'sysbus ReadBytes {addr:#x} {count}'
        # Renode's monitor returns ~6 chars per byte plus framing. A 1024×600
        # RGB565 framebuffer (~1.2 MB raw) requires ~10 MB over TCP, which can
        # take many seconds while LVGL is also driving GPIO traffic. Scale the
        # timeout with the size and floor it to a generous 60s.
        timeout = max(60.0, count / 50_000)
        out = await self._monitor_cmd(
            inst, cmd, timeout=timeout, max_bytes=count * 8 + 4096)
        return _parse_readbytes_response(out, sent_cmd=cmd)

    async def _connect_binary_stream(self, inst: RenodeInstance,
                                     kind: str) -> bool:
        if kind == 'touch':
            reader_attr = '_touch_reader'
            writer_attr = '_touch_writer'
        else:
            reader_attr = '_fb_reader'
            writer_attr = '_fb_writer'

        writer = getattr(inst, writer_attr)
        if writer and not writer.is_closing():
            return True

        now = asyncio.get_running_loop().time()
        retry_after = inst._binary_retry_after.get(kind, 0.0)
        if now < retry_after:
            return False

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection('127.0.0.1', inst.fb_port),
                timeout=0.5,
            )
            setattr(inst, reader_attr, reader)
            setattr(inst, writer_attr, writer)
            inst._fb_binary_ok = True
            logger.info('%s: %s binary socket connected on port %d',
                        inst.client_id, kind, inst.fb_port)
            return True
        except Exception as e:
            inst._binary_retry_after[kind] = now + 2.0
            if not inst._binary_warned.get(kind):
                inst._binary_warned[kind] = True
                logger.warning('%s: %s binary socket unavailable on port %d; '
                               'falling back to Renode monitor (%s)',
                               inst.client_id, kind, inst.fb_port, e)
            return False

    async def _connect_fb_binary(self, inst: RenodeInstance) -> bool:
        return await self._connect_binary_stream(inst, 'framebuffer')

    async def _read_memory_binary(self, inst: RenodeInstance,
                                  addr: int, count: int) -> bytes | None:
        if count <= 0:
            return b''
        if count > _FB_MAX_BYTES:
            return None
        if not await self._connect_fb_binary(inst):
            return None
        assert inst._fb_reader is not None
        assert inst._fb_writer is not None
        try:
            async with inst._fb_io_lock:
                inst._fb_writer.write(
                    b'VXFB' + struct.pack('<II', addr & 0xFFFFFFFF, count)
                )
                await inst._fb_writer.drain()
                header = await asyncio.wait_for(
                    inst._fb_reader.readexactly(8), timeout=5.0)
                if header[:4] != b'VXFR':
                    raise ValueError(f'bad framebuffer binary response {header[:4]!r}')
                status = struct.unpack('<I', header[4:])[0]
                if status != 0:
                    raise ValueError(f'framebuffer binary read failed status={status}')
                return await asyncio.wait_for(
                    inst._fb_reader.readexactly(count),
                    timeout=max(5.0, count / 5_000_000),
                )
        except Exception as e:
            logger.warning('%s: framebuffer binary read failed; falling back '
                           'to Renode monitor (%s)', inst.client_id, e)
            try:
                inst._fb_writer.close()
                await inst._fb_writer.wait_closed()
            except Exception:
                pass
            inst._fb_reader = None
            inst._fb_writer = None
            inst._binary_retry_after['framebuffer'] = (
                asyncio.get_running_loop().time() + 2.0
            )
            return None

    async def _write_doubleword_binary(self, inst: RenodeInstance,
                                       addr: int, value: int) -> bool:
        if not await self._connect_binary_stream(inst, 'touch'):
            return False
        assert inst._touch_reader is not None
        assert inst._touch_writer is not None
        try:
            async with inst._touch_io_lock:
                inst._touch_writer.write(
                    b'VXDW' + struct.pack(
                        '<II', addr & 0xFFFFFFFF, value & 0xFFFFFFFF)
                )
                await inst._touch_writer.drain()
                header = await asyncio.wait_for(
                    inst._touch_reader.readexactly(8), timeout=1.0)
                if header[:4] != b'VXFR':
                    raise ValueError(f'bad framebuffer binary response {header[:4]!r}')
                status = struct.unpack('<I', header[4:])[0]
                if status != 0:
                    raise ValueError(f'framebuffer binary write failed status={status}')
                return True
        except Exception as e:
            logger.warning('%s: framebuffer binary write failed; falling back '
                           'to Renode monitor (%s)', inst.client_id, e)
            try:
                inst._touch_writer.close()
                await inst._touch_writer.wait_closed()
            except Exception:
                pass
            inst._touch_reader = None
            inst._touch_writer = None
            inst._binary_retry_after['touch'] = asyncio.get_running_loop().time() + 2.0
            return False

    def _record_framebuffer_poll(self, inst: RenodeInstance, *,
                                 width: int, height: int, fmt: str,
                                 scan_ms: float, unchanged: bool = False,
                                 full_frame: bool = False,
                                 patches: int = 0,
                                 bytes_sent: int = 0,
                                 changed_rows: int = 0) -> None:
        stats = inst._fb_stats
        stats['polls'] = int(stats['polls']) + 1
        stats['scan_ms'] = float(stats['scan_ms']) + scan_ms
        stats['poll_ms'] = inst._fb_current_poll_ms
        stats['width'] = width
        stats['height'] = height
        stats['format'] = fmt
        if unchanged:
            stats['unchanged'] = int(stats['unchanged']) + 1
        if full_frame:
            stats['full_frames'] = int(stats['full_frames']) + 1
        if patches:
            stats['patches'] = int(stats['patches']) + patches
        if bytes_sent:
            stats['bytes_sent'] = int(stats['bytes_sent']) + bytes_sent
        if changed_rows:
            stats['changed_rows'] = int(stats['changed_rows']) + changed_rows

    async def _emit_framebuffer_stats_if_due(self, inst: RenodeInstance) -> None:
        now = time.monotonic()
        if now - inst._fb_stats_last_emit < 1.0:
            return
        inst._fb_stats_last_emit = now
        elapsed_ms = max(1.0, (now - inst._fb_stats_window_start) * 1000.0)
        stats = dict(inst._fb_stats)
        stats['window_ms'] = round(elapsed_ms, 1)
        stats['scan_ms'] = round(float(stats['scan_ms']), 1)
        await inst.emit('display_stats', stats)
        inst._fb_stats_window_start = now
        inst._fb_stats = {
            'polls': 0,
            'unchanged': 0,
            'full_frames': 0,
            'patches': 0,
            'bytes_sent': 0,
            'changed_rows': 0,
            'scan_ms': 0.0,
            'poll_ms': _FB_POLL_MS,
            'width': stats.get('width', 0),
            'height': stats.get('height', 0),
            'format': stats.get('format', 'rgb565'),
        }

    @staticmethod
    def _wake_framebuffer_poll(inst: RenodeInstance) -> None:
        inst._fb_fast_until = max(
            inst._fb_fast_until,
            time.monotonic() + (_FB_FAST_WINDOW_MS / 1000.0),
        )
        inst._fb_wake_event.set()

    async def _poll_scaled_framebuffer(self, inst: RenodeInstance,
                                       addr: int, width: int, height: int,
                                       pitch: int, bpp: int, fmt: str) -> bool:
        """Poll a scaled framebuffer and emit row patches as soon as they change."""
        if _FB_MAX_WIDTH <= 0 or width <= _FB_MAX_WIDTH:
            return False
        scan_start = time.perf_counter()

        step = max(1, (width + _FB_MAX_WIDTH - 1) // _FB_MAX_WIDTH)
        scaled_width = (width + step - 1) // step
        scaled_height = (height + step - 1) // step
        scaled_pitch = scaled_width * bpp
        visible_row_bytes = width * bpp
        geometry_key = (width, height, pitch, bpp, fmt, step, 1)
        need_full = (
            inst._fb_geometry_key != geometry_key or
            len(inst._fb_rows) != scaled_height
        )
        if need_full:
            inst._fb_geometry_key = geometry_key
            inst._fb_rows = [b''] * scaled_height

        changed_rows: list[tuple[int, bytes]] = []
        for dst_row, src_y in enumerate(range(0, height, step)):
            row = await self._read_memory(
                inst, addr + src_y * pitch, visible_row_bytes)
            if len(row) < visible_row_bytes:
                return True

            sampled = bytearray(scaled_pitch)
            for dst_x, src_x in enumerate(range(0, width, step)):
                src = src_x * bpp
                sampled[dst_x * bpp:(dst_x + 1) * bpp] = row[src:src + bpp]
            sampled_b = bytes(sampled)

            if need_full:
                inst._fb_rows[dst_row] = sampled_b
                continue
            if sampled_b == inst._fb_rows[dst_row]:
                continue

            inst._fb_rows[dst_row] = sampled_b
            changed_rows.append((dst_row, sampled_b))

        if need_full:
            buf = b''.join(inst._fb_rows)
            scan_ms = (time.perf_counter() - scan_start) * 1000.0
            self._record_framebuffer_poll(
                inst, width=scaled_width, height=scaled_height, fmt=fmt,
                scan_ms=scan_ms, full_frame=True, bytes_sent=len(buf),
                changed_rows=scaled_height)
            await inst.emit('framebuffer', {
                'width':         scaled_width,
                'height':        scaled_height,
                'pitch':         scaled_pitch,
                'source_width':  width,
                'source_height': height,
                'source_pitch':  pitch,
                'scale':         step,
                'format':        fmt,
                'bytes_b64': base64.b64encode(buf).decode('ascii'),
            })
            return True

        if not changed_rows:
            scan_ms = (time.perf_counter() - scan_start) * 1000.0
            self._record_framebuffer_poll(
                inst, width=scaled_width, height=scaled_height, fmt=fmt,
                scan_ms=scan_ms, unchanged=True)
            return True

        # Emit patches only after the full scaled scan completes. Grouping
        # contiguous rows avoids mixed old/new scanline artifacts in the
        # canvas while keeping payloads small.
        if len(changed_rows) > scaled_height // 2:
            buf = b''.join(inst._fb_rows)
            scan_ms = (time.perf_counter() - scan_start) * 1000.0
            self._record_framebuffer_poll(
                inst, width=scaled_width, height=scaled_height, fmt=fmt,
                scan_ms=scan_ms, full_frame=True, bytes_sent=len(buf),
                changed_rows=len(changed_rows))
            await inst.emit('framebuffer', {
                'width':         scaled_width,
                'height':        scaled_height,
                'pitch':         scaled_pitch,
                'source_width':  width,
                'source_height': height,
                'source_pitch':  pitch,
                'scale':         step,
                'format':        fmt,
                'bytes_b64': base64.b64encode(buf).decode('ascii'),
            })
            return True

        patch_count = 0
        bytes_sent = 0
        run_y = changed_rows[0][0]
        run_rows = [changed_rows[0][1]]
        prev_y = run_y
        for row_y, row_bytes in changed_rows[1:]:
            if row_y == prev_y + 1:
                run_rows.append(row_bytes)
                prev_y = row_y
                continue
            patch_count += 1
            bytes_sent += sum(len(row) for row in run_rows)
            await self._emit_framebuffer_patch_rows(
                inst, run_y, run_rows, scaled_width, scaled_pitch,
                width, height, pitch, step, fmt)
            run_y = row_y
            prev_y = row_y
            run_rows = [row_bytes]
        patch_count += 1
        bytes_sent += sum(len(row) for row in run_rows)
        await self._emit_framebuffer_patch_rows(
            inst, run_y, run_rows, scaled_width, scaled_pitch,
            width, height, pitch, step, fmt)
        scan_ms = (time.perf_counter() - scan_start) * 1000.0
        self._record_framebuffer_poll(
            inst, width=scaled_width, height=scaled_height, fmt=fmt,
            scan_ms=scan_ms, patches=patch_count, bytes_sent=bytes_sent,
            changed_rows=len(changed_rows))

        return True

    async def _poll_fullres_framebuffer_bands(self, inst: RenodeInstance,
                                              addr: int, width: int, height: int,
                                              pitch: int, bpp: int, fmt: str) -> bool:
        """Poll full-resolution framebuffer in bands and emit changed patches.

        We still need to scan the framebuffer to discover changes, but this
        avoids sending and repainting a 1024x600 frame when LVGL only updates a
        label, button, slider, or other small region. The first sample is a
        full `framebuffer` event so the canvas has a complete baseline.
        """
        scan_start = time.perf_counter()
        band_rows = min(_FB_BAND_ROWS, height)
        band_count = (height + band_rows - 1) // band_rows
        geometry_key = (width, height, pitch, bpp, fmt, 1, band_rows)
        need_full = (
            inst._fb_geometry_key != geometry_key or
            len(inst._fb_rows) != band_count
        )
        if need_full:
            inst._fb_geometry_key = geometry_key
            inst._fb_rows = [b''] * band_count

        changed_rects: list[tuple[int, int, int, int, int, bytes]] = []
        for band_idx in range(band_count):
            y = band_idx * band_rows
            rows = min(band_rows, height - y)
            data = await self._read_memory(inst, addr + y * pitch, pitch * rows)
            if len(data) < pitch * rows:
                return True

            if need_full:
                inst._fb_rows[band_idx] = data
                continue
            old_data = inst._fb_rows[band_idx]
            if data == old_data:
                continue

            inst._fb_rows[band_idx] = data
            rect = self._diff_band_rect(old_data, data, y, rows, width, pitch, bpp)
            if rect is not None:
                changed_rects.append(rect)

        if need_full:
            payload = b''.join(inst._fb_rows)
            scan_ms = (time.perf_counter() - scan_start) * 1000.0
            self._record_framebuffer_poll(
                inst, width=width, height=height, fmt=fmt, scan_ms=scan_ms,
                full_frame=True, bytes_sent=len(payload), changed_rows=height)
            await inst.emit('framebuffer', {
                'width':         width,
                'height':        height,
                'pitch':         pitch,
                'source_width':  width,
                'source_height': height,
                'source_pitch':  pitch,
                'scale':         1,
                'format':        fmt,
                'bytes_b64': base64.b64encode(payload).decode('ascii'),
            })
            return True

        if not changed_rects:
            scan_ms = (time.perf_counter() - scan_start) * 1000.0
            self._record_framebuffer_poll(
                inst, width=width, height=height, fmt=fmt, scan_ms=scan_ms,
                unchanged=True)
            return True

        changed_rows = sum(rect_h for _x, _y, _w, rect_h, _rect_pitch, _data in changed_rects)
        patch_payload_bytes = sum(len(data) for *_rect, data in changed_rects)
        full_payload_bytes = width * height * bpp
        if patch_payload_bytes > full_payload_bytes // 2:
            payload = b''.join(inst._fb_rows)
            scan_ms = (time.perf_counter() - scan_start) * 1000.0
            self._record_framebuffer_poll(
                inst, width=width, height=height, fmt=fmt, scan_ms=scan_ms,
                full_frame=True, bytes_sent=len(payload),
                changed_rows=changed_rows)
            await inst.emit('framebuffer', {
                'width':         width,
                'height':        height,
                'pitch':         pitch,
                'source_width':  width,
                'source_height': height,
                'source_pitch':  pitch,
                'scale':         1,
                'format':        fmt,
                'bytes_b64': base64.b64encode(payload).decode('ascii'),
            })
            return True

        patch_count = 0
        bytes_sent = 0
        run_x, run_y, run_w, run_h, run_pitch, run_data = changed_rects[0]
        for x, y, rect_w, rect_h, rect_pitch, data in changed_rects[1:]:
            if x == run_x and rect_w == run_w and rect_pitch == run_pitch and y == run_y + run_h:
                run_h += rect_h
                run_data += data
                continue
            patch_count += 1
            bytes_sent += len(run_data)
            await self._emit_framebuffer_patch_bytes(
                inst, run_x, run_y, run_w, run_h, run_pitch,
                width, height, pitch, 1, fmt, run_data)
            run_x, run_y, run_w, run_h, run_pitch, run_data = x, y, rect_w, rect_h, rect_pitch, data
        patch_count += 1
        bytes_sent += len(run_data)
        await self._emit_framebuffer_patch_bytes(
            inst, run_x, run_y, run_w, run_h, run_pitch,
            width, height, pitch, 1, fmt, run_data)
        scan_ms = (time.perf_counter() - scan_start) * 1000.0
        self._record_framebuffer_poll(
            inst, width=width, height=height, fmt=fmt, scan_ms=scan_ms,
            patches=patch_count, bytes_sent=bytes_sent,
            changed_rows=changed_rows)

        return True

    async def _emit_framebuffer_patch_rows(self, inst: RenodeInstance,
                                           y: int, rows: list[bytes],
                                           scaled_width: int, scaled_pitch: int,
                                           source_width: int, source_height: int,
                                           source_pitch: int, scale: int,
                                           fmt: str | None = None) -> None:
        await self._emit_framebuffer_patch_bytes(
            inst, 0, y, scaled_width, len(rows), scaled_pitch,
            source_width, source_height, source_pitch, scale, fmt,
            b''.join(rows))

    @staticmethod
    def _diff_band_rect(old_data: bytes, new_data: bytes, band_y: int,
                        rows: int, width: int, pitch: int, bpp: int
                        ) -> tuple[int, int, int, int, int, bytes] | None:
        """Return the smallest bpp-aligned rect that changed inside a band."""
        visible_bytes = width * bpp
        if len(old_data) < pitch * rows or len(new_data) < pitch * rows:
            payload = bytearray(visible_bytes * rows)
            for row in range(rows):
                src = row * pitch
                dst = row * visible_bytes
                payload[dst:dst + visible_bytes] = new_data[src:src + visible_bytes]
            return 0, band_y, width, rows, visible_bytes, bytes(payload)

        min_col = width
        max_col = -1
        min_row = rows
        max_row = -1
        for row in range(rows):
            start = row * pitch
            old_row = old_data[start:start + visible_bytes]
            new_row = new_data[start:start + visible_bytes]
            if old_row == new_row:
                continue

            first = 0
            last = visible_bytes - 1
            while first < visible_bytes and old_row[first] == new_row[first]:
                first += 1
            while last > first and old_row[last] == new_row[last]:
                last -= 1

            col0 = first // bpp
            col1 = (last // bpp) + 1
            min_col = min(min_col, col0)
            max_col = max(max_col, col1)
            min_row = min(min_row, row)
            max_row = max(max_row, row + 1)

        if max_col < 0:
            return None

        rect_w = max_col - min_col
        rect_h = max_row - min_row
        rect_pitch = rect_w * bpp
        payload = bytearray(rect_pitch * rect_h)
        src_x = min_col * bpp
        for dst_row, src_row in enumerate(range(min_row, max_row)):
            src = src_row * pitch + src_x
            dst = dst_row * rect_pitch
            payload[dst:dst + rect_pitch] = new_data[src:src + rect_pitch]

        return min_col, band_y + min_row, rect_w, rect_h, rect_pitch, bytes(payload)

    async def _emit_framebuffer_patch_bytes(self, inst: RenodeInstance,
                                            x: int, y: int, width: int, height: int,
                                            pitch: int, source_width: int,
                                            source_height: int, source_pitch: int,
                                            scale: int, fmt: str | None,
                                            payload: bytes) -> None:
        fmt = fmt or 'rgb565'
        await inst.emit('framebuffer_patch', {
            'x':             x,
            'y':             y,
            'width':         width,
            'height':        height,
            'pitch':         pitch,
            'source_width':  source_width,
            'source_height': source_height,
            'source_pitch':  source_pitch,
            'scale':         scale,
            'format':        fmt,
            'bytes_b64': base64.b64encode(payload).decode('ascii'),
        })

    async def _poll_framebuffer_loop(self, inst: RenodeInstance) -> None:
        """Poll LTDC every `_FB_POLL_MS` ms and emit framebuffer events.

        Skips the frame whenever the LTDC layer is disabled or the parsed
        geometry looks bogus. Suppresses duplicates via a fast hash check.
        """
        while inst.running:
            try:
                now = time.monotonic()
                poll_ms = (
                    min(_FB_POLL_MS, _FB_FAST_POLL_MS)
                    if now < inst._fb_fast_until
                    else _FB_POLL_MS
                )
                inst._fb_current_poll_ms = poll_ms
                delay = max(0.02, poll_ms / 1000.0)
                try:
                    await asyncio.wait_for(inst._fb_wake_event.wait(), timeout=delay)
                    inst._fb_wake_event.clear()
                except asyncio.TimeoutError:
                    pass
                # Gate on LTDCEN + a plausible framebuffer base address; treat
                # the pixel format as a build-time constant (env override) since
                # we don't currently need to decode L1PFCR.
                gcr = await self._read_register(inst, LTDC_GCR)
                if gcr is None or not (gcr & 0x1):
                    continue                              # LTDC disabled

                fb_addr = await self._read_register(inst, LTDC_L1CFBAR)
                cfblr   = await self._read_register(inst, LTDC_L1CFBLR)
                cfblnr  = await self._read_register(inst, LTDC_L1CFBLNR)
                pfcr    = await self._read_register(inst, LTDC_L1PFCR)
                if None in (fb_addr, cfblr, cfblnr, pfcr) or fb_addr == 0:
                    continue
                if not any(base <= fb_addr < base + 0x10000000
                           for base in _FB_VALID_BASES):
                    continue

                fmt = _FB_FORMAT_OVERRIDE or _LTDC_PFCR_FORMAT.get(pfcr & 0x7, 'rgb565')
                bpp = _FB_FORMAT_BPP[fmt]

                pitch  = (cfblr >> 16) & 0x1FFF
                height = cfblnr & 0x7FF
                if pitch == 0 or height == 0:
                    continue
                # CFBLL[12:0] is "line length in bytes + 3" per RM0433, but
                # HAL CMSIS writes it with `+ 7U` — using either yields a
                # width that disagrees with the row pitch by a couple of
                # pixels. The pitch field is unambiguous, so derive width
                # from pitch (assumes no inter-row padding, which is the
                # common case for packed framebuffers).
                width = pitch // bpp
                if width == 0 or width > 4096 or height > 2160:
                    continue
                total = pitch * height
                if total == 0 or total > _FB_MAX_BYTES:
                    continue
                if await self._poll_scaled_framebuffer(
                    inst, fb_addr, width, height, pitch, bpp, fmt
                ):
                    await self._emit_framebuffer_stats_if_due(inst)
                    continue
                await self._poll_fullres_framebuffer_bands(
                    inst, fb_addr, width, height, pitch, bpp, fmt)
                await self._emit_framebuffer_stats_if_due(inst)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning('%s: framebuffer poll: %s', inst.client_id, e)
                await asyncio.sleep(1.0)

    async def _poll_gpio_loop(self, inst: RenodeInstance) -> None:
        """Poll GPIOx_ODR every `_GPIO_POLL_MS` ms, emit per-pin transitions.

        Bit i of ODR reflects what the firmware has driven on pin i when the
        pin is configured as a push-pull/open-drain output. For input or
        alternate-function pins ODR keeps its last-written value (usually 0)
        which is harmless — we just emit a constant 0 for those bits, and
        consumers that aren't wired to those pins ignore them anyway.
        """
        delay = max(0.02, _GPIO_POLL_MS / 1000.0)
        while inst.running:
            try:
                await asyncio.sleep(delay)
                for port in _GPIO_POLL_PORTS:
                    addr = _GPIO_BASE[port] + _GPIO_ODR_OFFSET
                    val = await self._read_register(inst, addr)
                    if val is None:
                        continue
                    val &= 0xFFFF
                    last = inst._gpio_last.get(port)
                    if last is not None and val == last:
                        continue
                    # On the first successful read for this port we emit the
                    # full state so subscribers can hydrate their UI; after
                    # that we only emit pins that toggled.
                    changed = 0xFFFF if last is None else (val ^ last)
                    inst._gpio_last[port] = val
                    for bit in range(16):
                        if changed & (1 << bit):
                            await inst.emit('stm32h7_gpio_change', {
                                'port':  port,
                                'pin':   bit,
                                'value': bool(val & (1 << bit)),
                            })
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning('%s: gpio poll: %s', inst.client_id, e)
                await asyncio.sleep(0.5)

    # ── Renode stdout watcher ─────────────────────────────────────────────────

    async def _watch_stdout(self, inst: RenodeInstance) -> None:
        if not inst.process or not inst.process.stdout:
            return
        loop = asyncio.get_running_loop()
        try:
            while inst.running:
                line = await loop.run_in_executor(None, inst.process.stdout.readline)
                if not line:
                    break
                text = line.decode('utf-8', errors='replace').rstrip()
                if text:
                    logger.info('renode[%s] %s', inst.client_id, text)
        except Exception:
            pass
        logger.info('renode[%s] process exited', inst.client_id)
        inst.running = False
        await inst.emit('system', {'event': 'exited'})

    # ── Shutdown ──────────────────────────────────────────────────────────────

    @staticmethod
    def _signal_group(process: subprocess.Popen, sig: int) -> None:
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        except OSError:
            try:
                process.send_signal(sig)
            except Exception:
                pass

    async def _shutdown(self, inst: RenodeInstance) -> None:
        inst.running = False

        for task in inst._tasks:
            task.cancel()
        if inst._tasks:
            await asyncio.gather(*inst._tasks, return_exceptions=True)
        inst._tasks.clear()

        if inst._serial_writer:
            try:
                inst._serial_writer.close()
            except Exception:
                pass
            inst._serial_writer = None

        if inst._mon_writer:
            try:
                inst._mon_writer.close()
            except Exception:
                pass
            inst._mon_writer = None
            inst._mon_reader = None

        if inst._fb_writer:
            try:
                inst._fb_writer.close()
                await inst._fb_writer.wait_closed()
            except Exception:
                pass
            inst._fb_writer = None
            inst._fb_reader = None

        if inst._touch_writer:
            try:
                inst._touch_writer.close()
                await inst._touch_writer.wait_closed()
            except Exception:
                pass
            inst._touch_writer = None
            inst._touch_reader = None

        pty_slave_name: str | None = None
        if inst.pty_slave_fd is not None:
            try:
                pty_slave_name = os.ttyname(inst.pty_slave_fd)
            except OSError:
                pty_slave_name = None

        if inst.pty_master_fd is not None:
            try:
                os.close(inst.pty_master_fd)
            except OSError:
                pass
            inst.pty_master_fd = None
        if inst.pty_slave_fd is not None:
            try:
                os.close(inst.pty_slave_fd)
            except OSError:
                pass
            inst.pty_slave_fd = None
        if inst.pty_path:
            try:
                if (
                    os.path.islink(inst.pty_path)
                    and (pty_slave_name is None or os.readlink(inst.pty_path) == pty_slave_name)
                ):
                    os.unlink(inst.pty_path)
            except OSError:
                pass
            inst.pty_path = None

        if inst.process:
            loop = asyncio.get_running_loop()
            # The whole process group: terminating only the `renode` script
            # left `dotnet Renode.dll` running, with our stdout pipe open.
            try:
                self._signal_group(inst.process, signal.SIGTERM)
                await asyncio.wait_for(
                    loop.run_in_executor(None, inst.process.wait),
                    timeout=5.0,
                )
            except Exception:
                self._signal_group(inst.process, signal.SIGKILL)
            # The Renode script can exit before dotnet: make sure no one is left.
            self._signal_group(inst.process, signal.SIGKILL)
            inst.process = None

        if inst.resc_path and os.path.exists(inst.resc_path):
            try:
                os.unlink(inst.resc_path)
            except Exception:
                pass
            inst.resc_path = None

        logger.info('RenodeInstance %s shut down', inst.client_id)


renode_manager = RenodeManager()
