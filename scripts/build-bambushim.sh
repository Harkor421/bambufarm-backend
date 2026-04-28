#!/usr/bin/env bash
# Build the Bambu plugin shim. Runs as a postinstall step so Railway/Nixpacks
# always picks it up (custom nixpacks build phases can be flaky).
#
# Skips silently on macOS — local dev uses ./native/bambushim/build.sh.
# Skips silently if the required tools (g++, curl, unzip) aren't available
# (e.g. local `npm install` outside the deploy environment).

set -e
cd "$(dirname "$0")/.."

OS=$(uname -s)
[ "$OS" != "Linux" ] && { echo "[bambushim] not Linux ($OS), skipping"; exit 0; }

for cmd in g++ curl unzip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "[bambushim] $cmd not available, skipping build"; exit 0; }
done

if [ -f native/bambushim/libbambushim.so ] && [ -f vendor/bambu/linux/libbambu_networking.so ]; then
  echo "[bambushim] already built, skipping"
  exit 0
fi

echo "[bambushim] downloading Bambu network plugin v02.06.00.50 (Linux x86_64)"
mkdir -p vendor/bambu/linux
curl -L -sS -o /tmp/bambu_linux.zip "https://public-cdn.bblmw.com/upgrade/studio/plugins/02.06.00.50/7459f94f40/linux_02.06.00.50.zip"
unzip -q -o /tmp/bambu_linux.zip -d vendor/bambu/linux/
ls -la vendor/bambu/linux/

echo "[bambushim] downloading Bambu's slicer_base64.cer (TLS root for Bambu cloud)"
mkdir -p vendor/bambu/cert
curl -L -sS -o vendor/bambu/cert/slicer_base64.cer "https://raw.githubusercontent.com/bambulab/BambuStudio/master/resources/cert/slicer_base64.cer"
ls -la vendor/bambu/cert/

echo "[bambushim] compiling shim against plugin"
g++ -std=c++17 -shared -fPIC -O2 \
  -o native/bambushim/libbambushim.so \
  native/bambushim/bambushim.cpp \
  -L vendor/bambu/linux -lbambu_networking \
  -Wl,-rpath,'$ORIGIN/../../vendor/bambu/linux'

ls -la native/bambushim/libbambushim.so
echo "[bambushim] done"
