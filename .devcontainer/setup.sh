#!/usr/bin/env bash
# One-time setup of the devcontainer (postCreateCommand): Python and npm
# dependencies, Renode, arduino-cli with the AVR core, and the STM32H743 Core
# firmware. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

# Renode portable build (same source as Dockerfile.standalone).
RENODE_URL=${RENODE_URL:-https://builds.renode.io/renode-latest.linux-portable.tar.gz}
# The STM32H7_CORE VELXIO firmware of copper-and-code-mcu-boards, as a release
# asset of this repository (prebuilt/stm32h7/firmware.elf is not in git).
FIRMWARE_URL=${FIRMWARE_URL:-https://github.com/Copper-And-Code/velxio/releases/download/stm32h7-firmware/firmware.elf}
# sha256 of that file (stripped ELF); an empty value skips the check.
FIRMWARE_SHA256=${FIRMWARE_SHA256-4ab09e6fbe6d7235f5634ee5227d69c807014987117ec68db5a97c2aaa779564}

echo "== Python backend"
pip install --no-cache-dir -r backend/requirements.txt

echo "== Frontend (npm 11: the npm 10 of this image crashes on this tree, see Dockerfile.standalone)"
npm install -g npm@11 --no-audit --no-fund
(cd frontend && rm -f package-lock.json && npm install --include=optional --no-audit --no-fund)

echo "== Renode"
if ! command -v renode >/dev/null; then
  sudo mkdir -p /opt/renode
  curl -fsSL "$RENODE_URL" | sudo tar -xz -C /opt/renode --strip-components=1
  sudo ln -sf /opt/renode/renode /usr/local/bin/renode
fi
renode --version | head -1

echo "== arduino-cli (the backend installs the cores it needs at start)"
if ! command -v arduino-cli >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sudo BINDIR=/usr/local/bin sh
fi
arduino-cli version

echo "== STM32H743 Core firmware"
mkdir -p prebuilt/stm32h7
if [ ! -s prebuilt/stm32h7/firmware.elf ]; then
  if curl -fsSL -o prebuilt/stm32h7/firmware.elf "$FIRMWARE_URL" \
     && { [ -z "$FIRMWARE_SHA256" ] || echo "$FIRMWARE_SHA256  prebuilt/stm32h7/firmware.elf" | sha256sum -c -; }; then
    echo "firmware.elf: $(stat -c %s prebuilt/stm32h7/firmware.elf) bytes"
  else
    rm -f prebuilt/stm32h7/firmware.elf
    echo "WARNING: could not download $FIRMWARE_URL; the STM32H743 Core will answer"
    echo "'firmware not found'. Build it (copper-and-code-mcu-boards: scripts/build.sh"
    echo "stm32 STM32H7_CORE VELXIO) and copy it to $ROOT/prebuilt/stm32h7/firmware.elf."
  fi
fi
echo "== setup done"
