#!/usr/bin/env bash
# Build the bambushim wrapper for the host platform.
# Output: same directory as this script.

set -euo pipefail
cd "$(dirname "$0")"

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  echo "[shim] Building for macOS (universal arm64+x86_64)..."
  clang++ -std=c++17 -shared -fPIC -O2 \
    -arch arm64 -arch x86_64 \
    -o libbambushim.dylib bambushim.cpp \
    -L../../vendor/bambu/mac -lbambu_networking \
    -Wl,-rpath,@loader_path/../../vendor/bambu/mac
  echo "[shim] Built libbambushim.dylib"
  file libbambushim.dylib

elif [ "$OS" = "Linux" ]; then
  echo "[shim] Building for Linux..."
  g++ -std=c++17 -shared -fPIC -O2 \
    -o libbambushim.so bambushim.cpp \
    -L../../vendor/bambu/linux -lbambu_networking \
    -Wl,-rpath,'$ORIGIN/../../vendor/bambu/linux'
  echo "[shim] Built libbambushim.so"
  file libbambushim.so
else
  echo "[shim] Unsupported OS: $OS" >&2
  exit 1
fi
