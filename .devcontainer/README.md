# Velxio in Codespaces

This Codespace runs the Copper and Code fork of Velxio: the backend (FastAPI,
Renode, arduino-cli) and the editor, started for you.

1. Wait until the setup finishes (the first time takes a few minutes).
2. Open the **Ports** tab and the address of port **5173 (Velxio)**, or wait
   for the browser tab that opens by itself.
3. In the editor the STM32H743 Core is already on the canvas: press **Run**.
   Renode needs 30-40 seconds to boot the board the first time.
4. More programs: **Examples**, board filter **STM32H743 Core**.

What runs here: STM32H743 Core (Renode), Arduino Uno / Nano / Mega, ATtiny85,
Raspberry Pi Pico, circuit simulation. The ESP32 boards need QEMU libraries
this setup does not install (see `docs/BUILD-QEMU.md`).

If something does not start: `bash .devcontainer/start.sh` restarts both
servers; their logs are `/tmp/velxio-backend.log` and `/tmp/velxio-frontend.log`.
