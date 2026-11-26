#!/usr/bin/env bash
# One-time setup of the devcontainer (postCreateCommand): Python and npm
# dependencies, Renode, arduino-cli with the AVR core, and the binaries of
# the panel boards (QEMU builds and VELXIO firmwares, scripts/fetch-prebuilt.sh).
# Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

# Renode portable build (same source as Dockerfile.standalone).
RENODE_URL=${RENODE_URL:-https://builds.renode.io/renode-latest.linux-portable.tar.gz}

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

echo "== QEMU runtime libraries (ESP32 libraries, RP2350 qemu-system-arm)"
sudo apt-get update -q && sudo apt-get install -y -q --no-install-recommends \
  libglib2.0-0 libgcrypt20 libslirp0 libfdt1 zlib1g

echo "== Panel board binaries: QEMU builds and VELXIO firmwares"
if ! scripts/fetch-prebuilt.sh; then
  echo "WARNING: scripts/fetch-prebuilt.sh failed: the STM32H743 Core, the ESP32"
  echo "boards and the RP2350-Touch-LCD-4 will answer 'not found' at Run."
  echo "Run it again later: bash scripts/fetch-prebuilt.sh"
fi
echo "== setup done"
