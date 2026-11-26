"""
Diagnostic: bypass firmware. Boot Renode, then via the monitor write
L1CR=1 and L1PFCR=2 directly using `sysbus WriteDoubleWord` and read
them back. This tells us whether:

  (a) the LTDC model rejects those writes entirely (model bug), or
  (b) the writes work via the monitor but the firmware mem32 path is
      blocked by shadow logic (firmware-only issue, fixable in script).

Pass: monitor reads back L1CR=1 and L1PFCR=2.
"""

import asyncio
import logging
import sys
import time

sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(name)s %(levelname)s %(message)s',
                    stream=sys.stdout)

from app.services import renode_manager as rm  # noqa: E402

CLIENT_ID = 'fb-mon-1'


async def main() -> int:
    serial_buf: list[str] = []

    async def cb(event_type: str, data: dict) -> None:
        if event_type == 'serial_output':
            chunk = data.get('data', '')
            serial_buf.append(chunk)
            sys.stdout.write(chunk)
            sys.stdout.flush()

    rm.renode_manager.start_instance(CLIENT_ID, 'stm32h7-core-v13', cb)

    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        if '>>>' in ''.join(serial_buf) and 'MicroPython' in ''.join(serial_buf):
            break
    else:
        print('FAIL: no REPL', flush=True)
        rm.renode_manager.stop_instance(CLIENT_ID)
        return 2

    inst = rm.renode_manager._instances.get(CLIENT_ID)
    if not inst:
        print('FAIL: no instance', flush=True)
        return 3

    # Write directly via monitor.
    print('\n--- writing LTDC regs via monitor ---', flush=True)
    for addr, val in [
        (rm.LTDC_L1PFCR,  0x2),
        (rm.LTDC_L1CFBAR, 0xC0000000),
        (rm.LTDC_L1CFBLR, (64 << 16) | 67),
        (rm.LTDC_L1CFBLNR, 8),
        (rm.LTDC_L1CR,    0x1),
        (rm.LTDC_BASE + 0x024, 0x1),  # SRCR.IMR
        (rm.LTDC_GCR,     0x1),
    ]:
        cmd = f'sysbus WriteDoubleWord {addr:#x} {val:#x}'
        resp = await rm.renode_manager._monitor_cmd(inst, cmd)
        print(f'  {cmd}  ->  {resp[:120]!r}', flush=True)

    print('\n--- readback ---', flush=True)
    for label, addr in [('GCR', rm.LTDC_GCR),
                        ('SRCR', rm.LTDC_BASE + 0x024),
                        ('L1CR', rm.LTDC_L1CR),
                        ('L1PFCR', rm.LTDC_L1PFCR),
                        ('L1CFBAR', rm.LTDC_L1CFBAR),
                        ('L1CFBLR', rm.LTDC_L1CFBLR),
                        ('L1CFBLNR', rm.LTDC_L1CFBLNR)]:
        v = await rm.renode_manager._read_register(inst, addr)
        print(f'  {label:9s} @ {addr:#x} = {v:#010x}' if v is not None
              else f'  {label:9s} @ {addr:#x} = <None>', flush=True)

    rm.renode_manager.stop_instance(CLIENT_ID)
    await asyncio.sleep(1.0)
    return 0


if __name__ == '__main__':
    try:
        rc = asyncio.run(main())
    except Exception as e:
        print(f'EXC: {e!r}', flush=True)
        rc = 3
    sys.exit(rc)
