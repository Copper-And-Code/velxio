"""
The stm32h7-core-v13 lane through the real simulation WebSocket route:
`stm32h7_*` messages -> app.services.stm32h7_renode (ws_sim hooks) -> RenodeManager,
events back on the socket. Boots the VELXIO firmware, pastes a line into the
REPL, taps the canvas through `stm32h7_touch_input`, and checks that a
framebuffer arrives and that closing the socket stops Renode.

Needs Renode and prebuilt/stm32h7/firmware.elf. Run from backend/:
    python test_stm32h7_ws_route.py
"""
import json
import subprocess
import sys
import time

from fastapi.testclient import TestClient

from app.main import app

CLIENT = 'tab-1::stm32h7-core-v13'


def renode_pids() -> set[str]:
    out = subprocess.run(['pgrep', '-x', 'dotnet'], capture_output=True, text=True).stdout
    return set(out.split())


def main() -> int:
    before = renode_pids()
    failures = []
    serial = ''
    frames = 0
    with TestClient(app) as client:
        with client.websocket_connect(f'/api/simulation/ws/{CLIENT}') as ws:
            ws.send_text(json.dumps({'type': 'stm32h7_start', 'data': {}}))

            def pump(until, timeout):
                nonlocal serial, frames
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    msg = json.loads(ws.receive_text())
                    if msg['type'] == 'serial_output':
                        serial += msg['data'].get('data', '')
                    elif msg['type'] in ('framebuffer', 'framebuffer_patch'):
                        frames += 1
                    elif msg['type'] == 'error':
                        failures.append('error event: %s' % msg['data'])
                        return False
                    if until():
                        return True
                return False

            if not pump(lambda: 'STM32H7_CORE Velxio' in serial and serial.endswith('>>> '), 120):
                failures.append('no REPL banner')
            else:
                line = "import display_driver as d; print('TOUCH', type(d.touch).__name__)\r"
                ws.send_text(json.dumps({'type': 'stm32h7_serial_input',
                                         'data': {'bytes': list(line.encode())}}))
                if not pump(lambda: 'TOUCH VelxioTouch' in serial, 60):
                    failures.append('display_driver/touch not up: %r' % serial[-300:])
                ws.send_text(json.dumps({'type': 'stm32h7_touch_input',
                                         'data': {'x': 512, 'y': 300, 'pressed': True}}))
                ws.send_text(json.dumps({'type': 'stm32h7_touch_input',
                                         'data': {'x': 512, 'y': 300, 'pressed': False}}))
                if not pump(lambda: frames > 0, 30):
                    failures.append('no framebuffer event')
            print('serial tail:', serial[-200:].replace('\r', ''))
            print('frames:', frames)
        time.sleep(8)  # the disconnect hook stops Renode
    leftover = renode_pids() - before
    if leftover:
        failures.append('Renode still running after disconnect: %s' % leftover)
        subprocess.run(['kill', *leftover])
    for f in failures:
        print('FAIL:', f)
    print('PASS' if not failures else 'FAILED')
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
