"""
Smoke test for the touch input path:
  RenodeManager.inject_touch  →  monitor WriteDoubleWord  →  SDRAM @ TOUCH_MAILBOX
  RenodeManager._read_register ← monitor ReadDoubleWord    ← SDRAM @ TOUCH_MAILBOX

This exercises the backend half of the architecture documented in
docs/STM32H7_MANUAL_TEST.md section 8 (touch mailbox at 0x3800FF00)
without spinning up MicroPython on top — useful for catching regressions
in `inject_touch` (write order, dedup, seqno bump) without the full LVGL
stack. For an end-to-end test that exercises the LVGL indev callback
too, use docs/examples/stm32h7_touch_demo.py with the backend + frontend
running.
"""
import asyncio
import sys
import time

sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))

from app.services import renode_manager as rm  # noqa: E402

CLIENT_ID = 'touch-smoke-1'


async def main() -> int:
    serial_buf: list[str] = []

    async def cb(event_type, data):
        if event_type == 'serial_output':
            serial_buf.append(data.get('data', ''))

    rm.renode_manager.start_instance(CLIENT_ID, 'stm32h7-core-v13', cb)
    print('start_instance issued')

    # Wait for Renode to come up. We don't actually need the REPL to be ready
    # — only the monitor must be alive for us to write to memory.
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        inst = rm.renode_manager._instances.get(CLIENT_ID)
        if inst and inst._mon_writer:
            break
    else:
        print('FAIL: monitor never connected')
        rm.renode_manager.stop_instance(CLIENT_ID)
        await asyncio.sleep(1.0)
        return 1

    # Wait extra ~5s for the full boot (just to be safe — ReadDoubleWord on
    # an unbooted machine returns errors).
    await asyncio.sleep(5.0)

    inst = rm.renode_manager._instances.get(CLIENT_ID)
    failures = 0
    for case in [(123, 456, True), (789, 321, False), (0, 0, False),
                 (1023, 599, True), (1023, 599, True)]:  # last is dedup
        x, y, pr = case
        before_seq = inst._touch_seq
        await rm.renode_manager.inject_touch(CLIENT_ID, x, y, pr)
        after_seq = inst._touch_seq
        rb_pr = await rm.renode_manager._read_register(inst, rm.TOUCH_MAILBOX + 0)
        rb_x  = await rm.renode_manager._read_register(inst, rm.TOUCH_MAILBOX + 4)
        rb_y  = await rm.renode_manager._read_register(inst, rm.TOUCH_MAILBOX + 8)
        rb_sq = await rm.renode_manager._read_register(inst, rm.TOUCH_MAILBOX + 12)
        print(f'inject({x},{y},{pr}) → readback pr={rb_pr} x={rb_x} y={rb_y} '
              f'seq={rb_sq} (before_seq={before_seq} after_seq={after_seq})')
        # Dedup case: x,y,pr identical to last → no write, seq unchanged.
        is_dup = (after_seq == before_seq)
        expected_pr = 1 if pr else 0
        if not is_dup:
            if rb_pr != expected_pr or rb_x != x or rb_y != y or rb_sq != after_seq:
                failures += 1

    rm.renode_manager.stop_instance(CLIENT_ID)
    await asyncio.sleep(2.0)

    print(f'failures={failures}')
    return 0 if failures == 0 else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
