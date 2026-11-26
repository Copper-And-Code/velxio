"""STM32H7_CORE in Renode: the simulation-WS lane of the `stm32h7-core-v13` board.

The board runs the STM32H7_CORE VELXIO firmware of copper-and-code-mcu-boards
(MicroPython + LVGL) in Renode, driven by renode_manager. It is not one of the
QEMU STM32 boards of the `app.pro_boards` lane: its messages are prefixed
`stm32h7_` so that lane's `start_stm32` / `stm32_*` never reach it, and it hooks
into the route through the same extension points (register_ws_sim_handler,
register_ws_sim_disconnect) that lane uses.

    stm32h7_start         {board?, firmware_path?}
    stm32h7_stop
    stm32h7_serial_input  {bytes: [int]}
    stm32h7_gpio_input    {port: 'A'..'K', pin: 0..15, value: bool}
    stm32h7_touch_input   {x, y, pressed}
"""
import logging

from app.core.hooks import register_ws_sim_disconnect, register_ws_sim_handler
from app.services.renode_manager import renode_manager

logger = logging.getLogger(__name__)

MESSAGE_PREFIX = 'stm32h7_'
BOARD_KIND = 'stm32h7-core-v13'


async def handle_message(websocket, client_id: str, msg_type: str,
                         msg_data: dict, callback) -> bool:  # noqa: ARG001
    if not msg_type.startswith(MESSAGE_PREFIX):
        return False
    if msg_type == 'stm32h7_start':
        board = msg_data.get('board', BOARD_KIND)
        firmware = msg_data.get('firmware_path')  # optional override
        logger.info('[%s] stm32h7_start board=%s firmware=%s',
                    client_id, board, firmware or '(default)')
        renode_manager.start_instance(client_id, board, callback,
                                      firmware_path=firmware)
    elif msg_type == 'stm32h7_stop':
        renode_manager.stop_instance(client_id)
    elif msg_type == 'stm32h7_serial_input':
        raw_bytes = msg_data.get('bytes', [])
        if raw_bytes:
            await renode_manager.send_serial_bytes(client_id, bytes(raw_bytes))
    elif msg_type == 'stm32h7_gpio_input':
        await renode_manager.set_gpio_input(
            client_id, str(msg_data.get('port', '')), int(msg_data.get('pin', 0)),
            bool(msg_data.get('value', False)))
    elif msg_type == 'stm32h7_touch_input':
        await renode_manager.inject_touch(
            client_id, int(msg_data.get('x', 0)), int(msg_data.get('y', 0)),
            bool(msg_data.get('pressed', False)))
    else:
        return False
    return True


async def handle_disconnect(client_id: str) -> None:
    renode_manager.stop_instance(client_id)


def register() -> None:
    register_ws_sim_handler(handle_message)
    register_ws_sim_disconnect(handle_disconnect)
