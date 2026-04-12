#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# setup_wsl.sh — DolbyX WSL2 Build & Setup
# ═══════════════════════════════════════════════════════════════════════
set -e

echo "════════════════════════════════════════════════════"
echo "  DolbyX — WSL2 Build Setup"
echo "════════════════════════════════════════════════════"
echo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ARM_DIR="$PROJECT_DIR/arm"

# ── Install dependencies ───────────────────────────────────────────
echo "[1/5] Installing build dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    gcc-arm-linux-gnueabihf \
    g++-arm-linux-gnueabihf \
    qemu-user-static \
    gcc-mingw-w64-x86-64 \
    make \
    python3
echo

# ── Check libdseffect.so ──────────────────────────────────────────
if [ ! -f "$ARM_DIR/lib/libdseffect.so" ]; then
    echo "[!] libdseffect.so not found in $ARM_DIR/lib/"
    echo "    Please copy it from the Magisk module."
    exit 1
fi
echo "[2/5] Found libdseffect.so ✓"
echo

# ── Build ─────────────────────────────────────────────────────────
echo "[3/5] Building ARM processor and stub libraries..."
cd "$ARM_DIR"
make clean
make all
echo

# ── Smoke test ────────────────────────────────────────────────────
echo "[4/5] Running smoke test..."
set +e
RESULT=$(LD_LIBRARY_PATH=build/lib \
    qemu-arm-static -L /usr/arm-linux-gnueabihf \
    build/ddp_processor build/lib/libdseffect.so < /dev/null 2>&1 \
    | head -20)
set -e
echo "$RESULT" | grep -v "^$" | head -10

# Check for the "Ready" log line (works with both 44.1k and 48k)
if echo "$RESULT" | grep -q "\[DDP\] Ready"; then
    echo
    echo "✓ DDP processor loaded and initialized successfully!"
else
    echo
    echo "✗ Something went wrong. Check the output above."
    echo "  Common issues:"
    echo "  - Missing ARM sysroot: sudo apt install libc6-armhf-cross"
    echo "  - QEMU version too old: try qemu-user-static from Ubuntu 22.04+"
    exit 1
fi
echo

# ── Build Windows VST ──────────────────────────────────────────────
echo "[5/5] Building Windows VST plugin..."
cd "$PROJECT_DIR/windows"
if x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static 2>&1; then
    echo "✓ DolbyDDP.dll built!"
else
    echo "  MinGW build failed — you can build with MSVC later."
fi

echo
echo "════════════════════════════════════════════════════"
echo "  DolbyX setup complete!"
echo "════════════════════════════════════════════════════"
echo
echo "Quick test (process a WAV file):"
echo "  cd $ARM_DIR"
echo "  python3 test_ddp.py ../samples/test_song_48k.wav"
echo
echo "For EqualizerAPO:"
echo "  1. Copy windows/DolbyDDP.dll to:"
echo "       /mnt/c/Program\ Files/EqualizerAPO/VSTPlugins/"
echo "  2. Copy config/ddp_config.ini next to it"
echo "  3. Edit ddp_config.ini — set ddp_path to: $ARM_DIR"
echo "  4. Add VST filter in EqualizerAPO Configuration Editor"
