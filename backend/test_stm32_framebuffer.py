"""
Phase 3 smoke test: drive RenodeManager directly, prime a tiny LTDC layer
via the MicroPython REPL, and assert that the LTDC poller emits at least
one 'framebuffer' event with the expected geometry.

This bypasses the WebSocket layer (which requires a healthy uvicorn) and
exercises the renode_manager polling path on its own.

Pass criteria:
  - REPL banner observed
  - At least one 'framebuffer' event with width=32 height=8 fmt='rgb565'
  - bytes_b64 length > 0
"""

import asyncio
import base64
import logging
import sys
import time

sys.path.insert(0, '/opt/github/velxio/backend')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(name)s %(levelname)s %(message)s',
    stream=sys.stdout,
)

from app.services import renode_manager as rm  # noqa: E402

CLIENT_ID = 'fb-smoke-1'
W, H = 32, 8
PITCH = W * 2          # RGB565
LINE_LEN_M3 = PITCH + 3  # CFBLL = pitch + 3
PIXEL_FORMAT_RGB565 = 0b010

# MicroPython snippet that programs LTDC layer1 and primes SDRAM with a
# recognisable gradient. Sent over USART1 via the manager.
SETUP_SCRIPT = (
    'import stm\n'
    'mem32 = stm.mem32\n'
    'mem8  = stm.mem8\n'
    f'mem32[0x50001094] = {PIXEL_FORMAT_RGB565}\n'      # L1PFCR
    'mem32[0x500010ac] = 0xC0000000\n'                  # L1CFBAR
    f'mem32[0x500010b0] = ({PITCH} << 16) | {LINE_LEN_M3}\n'  # L1CFBLR
    f'mem32[0x500010b4] = {H}\n'                        # L1CFBLNR
    'mem32[0x50001084] = 1\n'                           # L1CR.LEN = 1
    'mem32[0x50001024] = 1\n'                           # LTDC_SRCR.IMR = 1 (commit shadow)
    'mem32[0x50001018] = 1\n'                           # GCR.LTDCEN = 1
    f'for i in range({W*H}):\n'
    '    v = (i * 73) & 0xffff\n'
    '    mem8[0xC0000000 + i*2] = v & 0xff\n'
    '    mem8[0xC0000000 + i*2 + 1] = (v >> 8) & 0xff\n'
    'print("LTDC primed")\n'
)


async def main() -> int:
    queue: asyncio.Queue = asyncio.Queue()
    serial_buf: list[str] = []

    async def callback(event_type: str, data: dict) -> None:
        if event_type == 'serial_output':
            chunk = data.get('data', '')
            serial_buf.append(chunk)
            sys.stdout.write(chunk)
            sys.stdout.flush()
        else:
            await queue.put((event_type, data))
            if event_type != 'framebuffer':
                print(f'\n[event] {event_type} {data}', flush=True)

    rm.renode_manager.start_instance(CLIENT_ID, 'stm32-h7-core-v13', callback)
    print('renode_manager start_instance issued', flush=True)

    # Wait up to 60s for REPL prompt.
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        joined = ''.join(serial_buf)
        if '>>>' in joined and 'MicroPython' in joined:
            break
    else:
        print('FAIL: no REPL prompt within 60s', flush=True)
        rm.renode_manager.stop_instance(CLIENT_ID)
        await asyncio.sleep(1.0)
        return 2

    print('\n--- REPL ready, sending raw paste-mode LTDC setup ---', flush=True)
    # Use raw paste mode to send the multi-line script atomically:
    #   Ctrl-E (paste mode) → script → Ctrl-D (commit)
    # MicroPython prints "===" prompts for paste mode.
    await rm.renode_manager.send_serial_bytes(CLIENT_ID, b'\x05')      # Ctrl-E
    await asyncio.sleep(0.3)
    await rm.renode_manager.send_serial_bytes(CLIENT_ID, SETUP_SCRIPT.encode())
    await asyncio.sleep(0.3)
    await rm.renode_manager.send_serial_bytes(CLIENT_ID, b'\x04')      # Ctrl-D
    print('--- waiting for "LTDC primed" + framebuffer event ---', flush=True)

    # Diagnostic: read LTDC GCR/L1CR/L1CFBAR directly via the monitor right
    # now so we know whether the firmware-side mem32 writes actually set the
    # bits Renode reflects in the registers.
    inst = rm.renode_manager._instances.get(CLIENT_ID)
    if inst:
        for label, addr in [('GCR', rm.LTDC_GCR),
                            ('L1CR', rm.LTDC_L1CR),
                            ('L1CFBAR', rm.LTDC_L1CFBAR),
                            ('L1CFBLR', rm.LTDC_L1CFBLR),
                            ('L1CFBLNR', rm.LTDC_L1CFBLNR),
                            ('L1PFCR', rm.LTDC_L1PFCR)]:
            v = await rm.renode_manager._read_register(inst, addr)
            print(f'  reg {label} @ {addr:#x} = {v:#010x}' if v is not None
                  else f'  reg {label} @ {addr:#x} = <None>',
                  flush=True)

    fb_event = None
    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        try:
            ev_type, ev_data = await asyncio.wait_for(queue.get(), timeout=2.0)
        except asyncio.TimeoutError:
            continue
        if ev_type == 'framebuffer':
            fb_event = ev_data
            break

    rm.renode_manager.stop_instance(CLIENT_ID)
    await asyncio.sleep(2.0)

    if not fb_event:
        print('\nFAIL: no framebuffer event received', flush=True)
        return 1

    print(f"\n[framebuffer] width={fb_event['width']} height={fb_event['height']} "
          f"fmt={fb_event['format']} pitch={fb_event['pitch']} "
          f"b64_len={len(fb_event['bytes_b64'])}", flush=True)
    raw = base64.b64decode(fb_event['bytes_b64'])
    print(f"  raw bytes={len(raw)} first16={raw[:16].hex()}", flush=True)

    ok = (
        fb_event['width']  == W and
        fb_event['height'] == H and
        fb_event['format'] == 'rgb565' and
        len(raw) >= W * H * 2
    )
    print('PASS' if ok else 'FAIL', flush=True)
    return 0 if ok else 1


if __name__ == '__main__':
    try:
        rc = asyncio.run(main())
    except Exception as e:
        print(f'EXC: {e!r}', flush=True)
        rc = 3
    sys.exit(rc)
