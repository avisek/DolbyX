#!/bin/bash
# test_vst_pipe.sh — Simulate what the VST plugin does: pipe audio through DDP
#
# This tests the exact same stdin/stdout pipe protocol the VST uses.
# Run from the arm/ directory.

set -e
cd "$(dirname "$0")/../arm"

echo "=== DolbyX VST Pipe Test ==="

# Generate 1 second of 1kHz tone as raw s16le
python3 -c "
import struct, math, sys
RATE=48000; FRAMES=RATE; CH=2
# Write ready-magic reader + protocol sender
samples = []
for i in range(FRAMES):
    v = int(16000 * math.sin(2*math.pi*1000*i/RATE))
    samples.extend([v, v])

# Build protocol: chunks of 256 frames
msg = b''
offset = 0
while offset < FRAMES:
    chunk = min(256, FRAMES - offset)
    msg += struct.pack('<I', chunk)
    msg += struct.pack(f'<{chunk*CH}h', *samples[offset*CH:(offset+chunk)*CH])
    offset += chunk
msg += struct.pack('<I', 0xFFFFFFFF)  # shutdown

sys.stdout.buffer.write(msg)
" | LD_LIBRARY_PATH=build/lib \
    qemu-arm-static -L /usr/arm-linux-gnueabihf \
    build/ddp_processor build/lib/libdseffect.so 48000 -6 0 \
    2>/tmp/dolbyx_pipe_test.log > /tmp/dolbyx_pipe_out.bin

# Check results
echo "Stderr log:"
cat /tmp/dolbyx_pipe_test.log

OUTSIZE=$(wc -c < /tmp/dolbyx_pipe_out.bin)
echo ""
echo "Output size: $OUTSIZE bytes"

# First 4 bytes should be ready magic 0xDD901DAA
python3 -c "
import struct, math
with open('/tmp/dolbyx_pipe_out.bin','rb') as f:
    data = f.read()
if len(data) < 4:
    print('ERROR: No output!')
    exit(1)
magic = struct.unpack('<I', data[:4])[0]
print(f'Ready magic: 0x{magic:08X} {\"✓\" if magic == 0xDD901DAA else \"✗\"} ')

pcm = data[4:]
expected = 48000 * 2 * 2  # 1s stereo s16
print(f'PCM output: {len(pcm)} bytes (expected {expected})')

if len(pcm) >= expected:
    samples = struct.unpack(f'<{48000*2}h', pcm[:expected])
    # Check L/R diff at steady state
    skip = 4096
    lr = math.sqrt(sum((samples[i*2]-samples[i*2+1])**2 for i in range(skip,48000)) / (48000-skip))
    clips = sum(1 for s in samples[skip*2:] if abs(s) >= 32767)
    mx = max(abs(s) for s in samples[skip*2:])
    print(f'LR diff: {lr:.0f}, clips: {clips}, max: {mx}')
    if lr > 200:
        print('✓ Spatial processing confirmed!')
    else:
        print('✗ No spatial processing detected')
else:
    print(f'⚠ Short output: only {len(pcm)} bytes')
"
echo ""
echo "=== Test complete ==="
