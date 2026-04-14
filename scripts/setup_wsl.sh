#!/bin/bash
set -e
echo "════════════════════════════════════════════════════"
echo "  DolbyX — Build Setup"
echo "════════════════════════════════════════════════════"
echo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ARM_DIR="$PROJECT_DIR/arm"

echo "[1/4] Installing build dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
    qemu-user-static gcc-mingw-w64-x86-64 make python3
echo

if [ ! -f "$ARM_DIR/lib/libdseffect.so" ]; then
    echo "[!] libdseffect.so not found in $ARM_DIR/lib/"; exit 1
fi
echo "[2/4] Found libdseffect.so ✓"
echo

echo "[3/4] Building ARM processor..."
cd "$ARM_DIR" && make clean && make all
echo

echo "[4/4] Building Windows components..."
cd "$PROJECT_DIR/windows"
x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static 2>&1 && echo "  ✓ DolbyDDP.dll"
x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe dolbyx-bridge.c -static 2>&1 && echo "  ✓ dolbyx-bridge.exe"
echo

# Smoke test
echo "Smoke test..."
cd "$ARM_DIR"
RESULT=$(LD_LIBRARY_PATH=build/lib timeout 5 \
    qemu-arm-static -L /usr/arm-linux-gnueabihf \
    build/ddp_processor build/lib/libdseffect.so < /dev/null 2>&1)
if echo "$RESULT" | grep -q "\[DDP\] Ready"; then
    echo "✓ Processor OK!"
else
    echo "✗ Processor failed"; echo "$RESULT"; exit 1
fi

echo
echo "════════════════════════════════════════════════════"
echo "  DolbyX setup complete!"
echo "════════════════════════════════════════════════════"
echo
echo "To use with EqualizerAPO:"
echo ""
echo "  1. Copy files to EqualizerAPO:"
echo "     cp $PROJECT_DIR/windows/DolbyDDP.dll \\"
echo "        \"/mnt/c/Program Files/EqualizerAPO/VSTPlugins/\""
echo ""
echo "  2. Start the bridge (from Windows CMD or PowerShell):"
echo "     cd $(wslpath -w $PROJECT_DIR/windows)"
echo "     dolbyx-bridge.exe $ARM_DIR"
echo ""
echo "  3. Add VST in EqualizerAPO Configuration Editor"
echo ""
echo "  Or start bridge from WSL2:"
echo "     cmd.exe /c \"\$(wslpath -w $PROJECT_DIR/windows/dolbyx-bridge.exe)\" $ARM_DIR"
