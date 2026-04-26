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

# ── Dependencies ──────────────────────────────────────────────────

echo "[1/4] Installing build dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
    qemu-user-static gcc-mingw-w64-x86-64 make python3 2>/dev/null
echo ""

# ── Check libdseffect.so ──────────────────────────────────────────

if [ ! -f "$ARM_DIR/lib/libdseffect.so" ]; then
    echo "ERROR: libdseffect.so not found in $ARM_DIR/lib/"
    echo "       Copy it from the Magisk module first."
    exit 1
fi
echo "[2/4] Found libdseffect.so"
echo ""

# ── Build ARM processor ──────────────────────────────────────────

echo "[3/4] Building ARM processor..."
cd "$ARM_DIR" && make clean && make all
echo ""

# ── Build Windows components ─────────────────────────────────────

echo "[4/4] Building Windows components..."
cd "$WIN_DIR"
x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static \
    && echo "  DolbyDDP.dll OK" || echo "  DolbyDDP.dll FAILED"
x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe dolbyx-bridge.c -static -ladvapi32 \
    && echo "  dolbyx-bridge.exe OK" || echo "  dolbyx-bridge.exe FAILED"
echo ""

# ── Smoke test ────────────────────────────────────────────────────

echo "Smoke test..."
cd "$ARM_DIR"
RESULT=$(LD_LIBRARY_PATH=build/lib timeout 5 \
    qemu-arm-static -L /usr/arm-linux-gnueabihf \
    build/ddp_processor build/lib/libdseffect.so < /dev/null 2>&1)

if echo "$RESULT" | grep -q "\[DDP\] Ready"; then
    echo "  Processor: OK"
else
    echo "  Processor: FAILED"
    echo "$RESULT"
    exit 1
fi

echo ""
echo "  Setup complete!"
echo ""
echo "  Quick start:"
echo "  ─────────────"
echo ""
echo "  1. Copy VST to EqualizerAPO:"
echo "     cp $WIN_DIR/DolbyDDP.dll \\"
echo "        \"/mnt/c/Program Files/EqualizerAPO/VSTPlugins/\""
echo ""
echo "  2. Start the bridge:"
echo "     cd /mnt/c && $WIN_DIR/dolbyx-bridge.exe $ARM_DIR"
echo ""
echo "  3. Add DolbyDDP as VST plugin in EqualizerAPO"
echo ""
echo "  Process audio files directly:"
echo "     cd $ARM_DIR && python3 test_ddp.py input.wav"
echo ""
