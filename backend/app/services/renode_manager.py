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
import socket
import subprocess
import tempfile
import tty
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

# ── Paths ────────────────────────────────────────────────────────────────────
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_REPO_ROOT   = os.path.abspath(os.path.join(_BACKEND_DIR, '..'))
RENODE_BIN   = os.environ.get('RENODE_BIN', 'renode')
REPL_PATH    = os.path.join(_REPO_ROOT, 'renode', 'platforms', 'stm32h7_core_v13.repl')
DEFAULT_FW   = os.environ.get(
    'STM32H7_CORE_FIRMWARE',
    '/opt/github/lv_micropython/ports/stm32/build-STM32H7_CORE-VELXIO/firmware.elf',
)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


EventCallback = Callable[[str, dict], Awaitable[None]]


# ── LTDC register layout (STM32H7 RM0433) ────────────────────────────────────
LTDC_BASE      = 0x50001000
LTDC_GCR       = LTDC_BASE + 0x018  # bit 0 = LTDCEN
LTDC_L1CR      = LTDC_BASE + 0x100  # bit 0 = LEN  (NB: not reflected by Renode)
LTDC_L1PFCR    = LTDC_BASE + 0x110  # bits[2:0] = pixel format (NB: not reflected by Renode)
LTDC_L1CFBAR   = LTDC_BASE + 0x12C  # framebuffer pointer
LTDC_L1CFBLR   = LTDC_BASE + 0x130  # bits[28:16]=pitch, [12:0]=line_len_bytes+3
LTDC_L1CFBLNR  = LTDC_BASE + 0x134  # bits[10:0] = line count

# Bytes-per-pixel for each declared pixel format. The Renode `Video.STM32LTDC`
# model does not expose the L1PFCR / L1CR registers via read-back, so we can't
# infer the format at runtime — pick it from the env (default RGB565, which
# matches lv_micropython's `LV_COLOR_DEPTH=16`).
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
_FB_FORMAT = os.environ.get('VELXIO_STM32_FB_FORMAT', 'rgb565').lower()
if _FB_FORMAT not in _FB_FORMAT_BPP:
    _FB_FORMAT = 'rgb565'

# Polling cadence for the LTDC framebuffer (env-overridable)
_FB_POLL_MS = int(os.environ.get('VELXIO_STM32_FB_POLL_MS', '300'))
# Hard cap on framebuffer size we'll attempt to read (safety against bogus
# register values pointing to a huge memcpy). 1024 × 600 × 4 = 2,457,600.
_FB_MAX_BYTES = 4 * 1024 * 1024
# SDRAM windows we accept as plausible framebuffer base addresses.
_FB_VALID_BASES = (0xC0000000, 0xD0000000)

# ANSI SGR escape stripper — Renode wraps its prompt in colour codes
# (e.g. "\x1b[33;1m(machine) \x1b[0m"), and we need a clean ") " terminator
# match to know when a monitor reply is fully buffered.
_ANSI_RE = re.compile(rb'\x1b\[[0-9;]*[a-zA-Z]')

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
machine LoadPlatformDescription @{repl}

logLevel 3
logLevel -1 sysbus.usart1

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
        self.pty_path:       str | None = None
        self.pty_master_fd:  int | None = None
        self.pty_slave_fd:   int | None = None
        self._serial_writer: asyncio.StreamWriter | None = None
        self._mon_reader:    asyncio.StreamReader | None = None
        self._mon_writer:    asyncio.StreamWriter | None = None
        self._mon_lock:      asyncio.Lock = asyncio.Lock()
        self._fb_last_hash:  int = 0
        # Per-port last-seen ODR value, keyed by port letter ('A'/'B'/...).
        # Used by the GPIO poller to emit only on-edge transitions.
        self._gpio_last:     dict[str, int] = {}
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

    # ── Boot sequence ─────────────────────────────────────────────────────────

    async def _boot(self, inst: RenodeInstance) -> None:
        if not os.path.exists(REPL_PATH):
            await inst.emit('error', {'message': f'.repl not found at {REPL_PATH}'})
            self._instances.pop(inst.client_id, None)
            return
        if not os.path.exists(inst.firmware_path):
            await inst.emit('error',
                            {'message': f'firmware not found: {inst.firmware_path}'})
            self._instances.pop(inst.client_id, None)
            return

        inst.uart_port    = _find_free_port()
        inst.monitor_port = _find_free_port()

        # Render .resc to tempfile
        mach_id = inst.client_id.replace('-', '_')[:16]
        resc_text = _RESC_TEMPLATE.format(
            client_id=inst.client_id,
            mach_id=mach_id,
            firmware=inst.firmware_path,
            repl=REPL_PATH,
            uart_port=inst.uart_port,
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
                ),
            )
        except FileNotFoundError:
            await inst.emit('error',
                            {'message': f'{RENODE_BIN} not found in PATH'})
            self._instances.pop(inst.client_id, None)
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
        body = _strip_echo_and_prompt(out, cmd)
        m = re.search(r'0x([0-9A-Fa-f]+)', body)
        if not m:
            return None
        try:
            return int(m.group(1), 16)
        except ValueError:
            return None

    async def _read_memory(self, inst: RenodeInstance,
                           addr: int, count: int) -> bytes:
        cmd = f'sysbus ReadBytes {addr:#x} {count}'
        out = await self._monitor_cmd(
            inst, cmd, timeout=20.0, max_bytes=count * 8 + 4096)
        return _parse_readbytes_response(out, sent_cmd=cmd)

    async def _poll_framebuffer_loop(self, inst: RenodeInstance) -> None:
        """Poll LTDC every `_FB_POLL_MS` ms and emit framebuffer events.

        Skips the frame whenever the LTDC layer is disabled or the parsed
        geometry looks bogus. Suppresses duplicates via a fast hash check.
        """
        delay = max(0.05, _FB_POLL_MS / 1000.0)
        bpp = _FB_FORMAT_BPP[_FB_FORMAT]
        while inst.running:
            try:
                await asyncio.sleep(delay)
                # Renode's STM32LTDC model exposes GCR/CFBAR/CFBLR/CFBLNR but
                # NOT L1CR.LEN / L1PFCR. We gate on LTDCEN + a plausible
                # framebuffer base address and treat the pixel format as a
                # build-time constant (env override).
                gcr = await self._read_register(inst, LTDC_GCR)
                if gcr is None or not (gcr & 0x1):
                    continue                              # LTDC disabled

                fb_addr = await self._read_register(inst, LTDC_L1CFBAR)
                cfblr   = await self._read_register(inst, LTDC_L1CFBLR)
                cfblnr  = await self._read_register(inst, LTDC_L1CFBLNR)
                if None in (fb_addr, cfblr, cfblnr) or fb_addr == 0:
                    continue
                if not any(base <= fb_addr < base + 0x10000000
                           for base in _FB_VALID_BASES):
                    continue

                line_bytes_minus_3 = cfblr & 0x1FFF
                pitch              = (cfblr >> 16) & 0x1FFF
                height             = cfblnr & 0x7FF
                if pitch == 0 or height == 0:
                    continue
                line_bytes = max(0, line_bytes_minus_3 - 3)
                width      = line_bytes // bpp
                if width == 0 or width > 4096 or height > 2160:
                    continue
                total = pitch * height
                if total == 0 or total > _FB_MAX_BYTES:
                    continue

                buf = await self._read_memory(inst, fb_addr, total)
                if len(buf) < total:
                    continue
                # Cheap dup-frame suppression.
                h = hash(buf)
                if h == inst._fb_last_hash:
                    continue
                inst._fb_last_hash = h

                await inst.emit('framebuffer', {
                    'width':   width,
                    'height':  height,
                    'pitch':   pitch,
                    'format':  _FB_FORMAT,
                    'bytes_b64': base64.b64encode(buf).decode('ascii'),
                })
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
                            await inst.emit('stm32_gpio_change', {
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
                if os.path.islink(inst.pty_path):
                    os.unlink(inst.pty_path)
            except OSError:
                pass
            inst.pty_path = None

        if inst.process:
            loop = asyncio.get_running_loop()
            try:
                inst.process.terminate()
                await asyncio.wait_for(
                    loop.run_in_executor(None, inst.process.wait),
                    timeout=5.0,
                )
            except Exception:
                try:
                    inst.process.kill()
                except Exception:
                    pass
            inst.process = None

        if inst.resc_path and os.path.exists(inst.resc_path):
            try:
                os.unlink(inst.resc_path)
            except Exception:
                pass
            inst.resc_path = None

        logger.info('RenodeInstance %s shut down', inst.client_id)


renode_manager = RenodeManager()
