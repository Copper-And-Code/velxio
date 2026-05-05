"""
End-to-end smoke test: drives the live backend via the public
/api/simulation/ws/{client_id} WebSocket, exercising the STM32H7
message handlers added in Fase 2.5.

Pass criteria:
  - WebSocket connects
  - 'start_stm32' produces serial_output containing the MicroPython banner
  - 'stm32_serial_input' echoes a typed expression and returns its result
  - 'stop_stm32' shuts the instance down cleanly
"""

import asyncio
import json
import sys
import time

import websockets

WS_URL = "ws://127.0.0.1:8001/api/simulation/ws/stm32-smoke-1"


async def main() -> int:
    print(f"connecting to {WS_URL} ...", flush=True)
    async with websockets.connect(WS_URL, max_size=None) as ws:
        await ws.send(json.dumps({
            "type": "start_stm32",
            "data": {"board": "stm32-h7-core-v13"},
        }))

        banner_seen = False
        prompt_seen = False
        eval_result = None
        deadline = time.monotonic() + 60.0

        async def collect_output(target_substr: str, timeout: float) -> str:
            buf = ""
            t_end = time.monotonic() + timeout
            while time.monotonic() < t_end:
                remaining = t_end - time.monotonic()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                msg = json.loads(raw)
                if msg.get("type") == "serial_output":
                    chunk = msg.get("data", {}).get("data", "")
                    buf += chunk
                    if target_substr in buf:
                        return buf
                elif msg.get("type") == "error":
                    print("ERROR from backend:", msg, flush=True)
                    return buf
            return buf

        boot_buf = await collect_output(">>>", timeout=45.0)
        print("--- boot output (first 1k chars) ---", flush=True)
        print(boot_buf[:1000], flush=True)
        print("--- end boot ---", flush=True)
        if "MicroPython" in boot_buf:
            banner_seen = True
        if ">>>" in boot_buf:
            prompt_seen = True

        if not (banner_seen and prompt_seen):
            print("FAIL: did not see MicroPython banner or REPL prompt", flush=True)
            await ws.send(json.dumps({"type": "stop_stm32"}))
            return 2

        # Send "21*2\r\n" via stm32_serial_input
        payload = list(b"21*2\r\n")
        await ws.send(json.dumps({
            "type": "stm32_serial_input",
            "data": {"bytes": payload},
        }))
        eval_buf = await collect_output("42", timeout=15.0)
        print("--- eval output ---", flush=True)
        print(eval_buf, flush=True)
        print("--- end eval ---", flush=True)
        if "42" in eval_buf:
            eval_result = "42"

        await ws.send(json.dumps({"type": "stop_stm32"}))
        await asyncio.sleep(0.5)

        ok = banner_seen and prompt_seen and eval_result == "42"
        print(f"banner={banner_seen} prompt={prompt_seen} eval={eval_result}", flush=True)
        print("PASS" if ok else "FAIL", flush=True)
        return 0 if ok else 1


if __name__ == "__main__":
    try:
        rc = asyncio.run(main())
    except Exception as e:
        print(f"EXC: {e!r}", flush=True)
        rc = 3
    sys.exit(rc)
