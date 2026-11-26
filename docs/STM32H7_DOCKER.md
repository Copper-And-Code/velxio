# STM32H7 Docker packaging

The standalone Docker image includes the Velxio frontend, FastAPI backend,
ESP32 QEMU runtime, Renode, the STM32H7 Renode platform files, and the
Velxio framebuffer/touch Renode extension.

## Required local artifact

Build the STM32H7_CORE VELXIO variant of
[copper-and-code-mcu-boards](https://github.com/Copper-And-Code/copper-and-code-mcu-boards)
and copy the ELF into the Docker prebuilt directory (the backend uses the same
path outside Docker, unless `STM32H7_CORE_FIRMWARE` names another):

```bash
# in copper-and-code-mcu-boards
scripts/build.sh stm32 STM32H7_CORE VELXIO
# in velxio
mkdir -p prebuilt/stm32h7
cp <copper-and-code-mcu-boards>/.work/micropython/ports/stm32/build-STM32H7_CORE-VELXIO/firmware.elf \
  prebuilt/stm32h7/firmware.elf
```

The file is optional, like the QEMU files in `prebuilt/qemu/`: without it the
image still builds (the log says `[stm32h7] no prebuilt/stm32h7/firmware.elf`)
and the STM32H743 Core board answers "firmware not found" at Run. The firmware
is not built inside the image: the STM32/LVGL toolchain would make every
Velxio image build slow and fragile.

## Build and run

```bash
docker compose up --build
```

Open:

```text
http://localhost:3080
```

The image sets these STM32H7 runtime paths (Dockerfile.standalone, `ENV`):

| Variable | Value |
| --- | --- |
| `VELXIO_REPO_ROOT` | `/app` |
| `RENODE_BIN` | `/usr/local/bin/renode` |
| `STM32H7_CORE_FIRMWARE` | `/app/lib/stm32h7/firmware.elf` |
| `VELXIO_STM32_PTY` | `0` |

`VELXIO_STM32_PTY=0` is deliberate for Docker: the browser uses the WebSocket
transport, while host PTY symlinks are awkward across container namespaces.
For low-level REPL debugging, run a local non-container backend or attach with
`docker exec` and override the variable.
