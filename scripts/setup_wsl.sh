#!/bin/bash
set -e

echo ""
echo "  DolbyX — Build Setup"
echo "  ===================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ARM_DIR="$PROJECT_DIR/arm"
DAEMON_DIR="$PROJECT_DIR/daemon"
VST_DIR="$PROJECT_DIR/windows/vst"
UI_DIR="$PROJECT_DIR/ui"

echo "[1/5] Installing build dependencies..."
sudo apt-get update -qq 2>/dev/null
sudo apt-get install -y -qq gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
    qemu-user-static gcc-mingw-w64-x86-64 make python3 nodejs npm 2>/dev/null
echo ""

if [ ! -f "$ARM_DIR/lib/libdseffect.so" ]; then
    echo "ERROR: libdseffect.so not found in $ARM_DIR/lib/"; exit 1; fi
echo "[2/5] Found libdseffect.so"
echo ""

echo "[3/5] Building ARM processor..."
cd "$ARM_DIR" && make clean && make all
echo ""

echo "[4/5] Building Web UI..."
cd "$UI_DIR"
npm install --save-dev esbuild 2>/dev/null
node build.js
echo ""

echo "[5/5] Building Windows components..."

# Daemon (with embedded Web UI)
cd "$DAEMON_DIR"
x86_64-w64-mingw32-gcc -O2 -DDOLBYX_USE_BUNDLE -o dolbyx.exe main.c http.c \
    -static -ladvapi32 -lws2_32 \
    && echo "  dolbyx.exe OK" || { echo "  dolbyx.exe FAILED"; exit 1; }

# VST
cd "$VST_DIR"
x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c \
    -static -lshell32 \
    && echo "  DolbyDDP.dll OK" || { echo "  DolbyDDP.dll FAILED"; exit 1; }
echo ""

# Smoke test
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
    echo "  FAILED"; exit 1
fi

echo ""
echo "  Build complete!"
echo ""
echo "  1. Copy VST:"
echo "     cp $VST_DIR/DolbyDDP.dll '/mnt/c/Program Files/EqualizerAPO/VSTPlugins/'"
echo ""
echo "  2. Start daemon:"
echo "     cd /mnt/c && $DAEMON_DIR/dolbyx.exe $ARM_DIR"
echo ""
echo "  3. Add DolbyDDP in EqualizerAPO"
echo "  4. Open http://localhost:9876 for Web UI"
echo ""
