#!/usr/bin/env bash
# Downloads Bambu's network plugin binaries (closed-source) into vendor/bambu/.
# These are NOT redistributable — for our own backend use only.
# The plugin contains the X.509 cert + private key used to sign cloud MQTT
# commands. See README in this directory for the full feasibility writeup.

set -euo pipefail
cd "$(dirname "$0")/../../vendor/bambu" || { echo "run from repo root"; exit 1; }

VERSION="${BAMBU_PLUGIN_VERSION:-02.06.00.50}"
HASH="${BAMBU_PLUGIN_HASH:-7459f94f40}"
BASE="https://public-cdn.bblmw.com/upgrade/studio/plugins/${VERSION}/${HASH}"

OS="$(uname -s)"

mkdir -p mac linux

case "$OS" in
  Darwin)
    if [ ! -f mac/libbambu_networking.dylib ]; then
      echo "[plugin] Downloading mac variant..."
      curl -sSL -o /tmp/bambu_mac.zip "$BASE/mac_${VERSION}.zip"
      unzip -q -o /tmp/bambu_mac.zip -d mac/
      echo "[plugin] mac/ contents:"
      ls mac/ | head
    fi
    ;;
  Linux)
    if [ ! -f linux/libbambu_networking.so ]; then
      echo "[plugin] Downloading linux variant..."
      curl -sSL -o /tmp/bambu_linux.zip "$BASE/linux_${VERSION}.zip"
      unzip -q -o /tmp/bambu_linux.zip -d linux/
      echo "[plugin] linux/ contents:"
      ls linux/ | head
    fi
    ;;
esac

echo "[plugin] Done."
