#!/bin/bash
set -e

echo ""
echo "  DolbyX — Build Setup"
echo "  ===================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ARM_DIR="$PROJECT_DIR/arm"
WIN_DIR="$PROJECT_DIR/windows"

echo "[1/4] Installing dependencies..."
sudo apt-get update -qq 2>/dev/null
sudo apt-get install -y -qq gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
    qemu-user-static gcc-mingw-w64-x86-64 make python3 2>/dev/null
echo ""

if [ ! -f "$ARM_DIR/lib/libdseffect.so" ]; then
    echo "ERROR: libdseffect.so not found"; exit 1; fi
echo "[2/4] Found libdseffect.so"
echo ""

echo "[3/4] Building ARM processor..."
cd "$ARM_DIR" && make clean && make all
echo ""

echo "[4/4] Building Windows components..."
cd "$WIN_DIR"
x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll \
    ddp_vst.c ddp_ui.c -static -lgdi32 -lmsimg32 \
    && echo "  DolbyDDP.dll OK" || echo "  DolbyDDP.dll FAILED"
x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe \
    dolbyx-bridge.c -static -ladvapi32 \
    && echo "  dolbyx-bridge.exe OK" || echo "  dolbyx-bridge.exe FAILED"
echo ""

echo "Smoke test..."
cd "$ARM_DIR"
set +e
SMOKE=$(LD_LIBRARY_PATH=build/lib timeout 5 \
    qemu-arm-static -L /usr/arm-linux-gnueabihf \
    build/ddp_processor build/lib/libdseffect.so < /dev/null 2>&1 || true)
set -e
if echo "$SMOKE" | grep -q "\[DDP\] Ready"; then
    echo "  OK"
else
    echo "  FAILED: $SMOKE"; exit 1
fi

echo ""
echo "  Setup complete!"
echo ""
echo "  1. Copy: cp $WIN_DIR/DolbyDDP.dll '/mnt/c/Program Files/EqualizerAPO/VSTPlugins/'"
echo "  2. Bridge: cd /mnt/c && $WIN_DIR/dolbyx-bridge.exe $ARM_DIR"
echo "  3. Add DolbyDDP in EqualizerAPO"
echo ""
