#!/usr/bin/env python3
"""
test_ddp.py — Test the DDP processor with a WAV file or generated tone.

Usage:
    python3 test_ddp.py                    # Process a generated test tone
    python3 test_ddp.py input.wav          # Process a WAV file
    python3 test_ddp.py input.wav out.wav  # Process and save to specific output

The output WAV will be saved next to the input with '_ddp' suffix.
Requires: the ARM processor built in build/ directory.
"""

import struct, math, subprocess, sys, os, wave

BLOCK_SIZE = 256
RATE = 48000
CHANNELS = 2

def generate_test_tone(duration=3.0):
    """Generate a rich test tone: chord + harmonics (mono, to show spatialization)."""
    frames = int(RATE * duration)
    samples = []
    for i in range(frames):
        t = i / RATE
        # C major chord with harmonics
        val = 0
        val += 0.3 * math.sin(2 * math.pi * 261.6 * t)  # C4
        val += 0.25 * math.sin(2 * math.pi * 329.6 * t)  # E4
        val += 0.25 * math.sin(2 * math.pi * 392.0 * t)  # G4
        val += 0.1 * math.sin(2 * math.pi * 523.2 * t)   # C5
        val += 0.05 * math.sin(2 * math.pi * 1046 * t)   # C6
        # Fade in/out
        env = min(t / 0.1, 1.0) * min((duration - t) / 0.3, 1.0)
        val *= env * 28000
        s = max(-32767, min(32767, int(val)))
        samples.append(s)  # L
        samples.append(s)  # R (mono → will be spatialized by DDP)
    return samples, frames

def read_wav(path):
    """Read a WAV file and return int16 samples + frame count."""
    with wave.open(path, 'r') as w:
        assert w.getsampwidth() == 2, "Only 16-bit WAV supported"
        assert w.getnchannels() == 2, "Only stereo WAV supported"
        rate = w.getframerate()
        if rate != RATE:
            print(f"  Warning: WAV is {rate}Hz, DDP runs at {RATE}Hz")
        frames = w.getnframes()
        raw = w.readframes(frames)
        samples = list(struct.unpack(f'<{frames*2}h', raw))
    return samples, frames

def write_wav(path, samples, frames):
    """Write int16 stereo samples to WAV."""
    with wave.open(path, 'w') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(struct.pack(f'<{frames*2}h', *samples))

def process_through_ddp(samples, frames):
    """Pipe audio through the DDP processor."""
    # Build chunked protocol
    msg = b''
    offset = 0
    while offset < frames:
        chunk = min(BLOCK_SIZE, frames - offset)
        msg += struct.pack('<I', chunk)
        msg += struct.pack(f'<{chunk*CHANNELS}h',
                          *samples[offset*CHANNELS:(offset+chunk)*CHANNELS])
        offset += chunk
    msg += struct.pack('<I', 0xFFFFFFFF)  # shutdown

    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = 'build/lib'

    proc = subprocess.run(
        ['qemu-arm-static', '-L', '/usr/arm-linux-gnueabihf',
         'build/ddp_processor', 'build/lib/libdseffect.so',
         str(RATE), '-6', '0'],
        input=msg, capture_output=True, timeout=600, env=env
    )

    if proc.returncode != 0:
        print(f"ERROR: processor exited with code {proc.returncode}")
        stderr = proc.stderr.decode('utf-8', errors='replace')
        for line in stderr.split('\n')[-10:]:
            if line.strip():
                print(f"  {line}")
        sys.exit(1)

    stdout = proc.stdout
    if len(stdout) < 4:
        print("ERROR: no output from processor")
        sys.exit(1)

    magic = struct.unpack('<I', stdout[:4])[0]
    if magic != 0xDD901DAA:
        print(f"ERROR: bad magic 0x{magic:08X}")
        sys.exit(1)

    pcm_out = stdout[4:]
    expected = frames * CHANNELS * 2
    if len(pcm_out) < expected:
        print(f"WARNING: got {len(pcm_out)}/{expected} bytes")
        frames = len(pcm_out) // (CHANNELS * 2)

    return list(struct.unpack(f'<{frames*CHANNELS}h', pcm_out[:frames*CHANNELS*2])), frames

def analyze(in_samples, out_samples, frames):
    """Print analysis comparing input and output."""
    skip = min(2048, frames // 4)  # skip ramp-up
    n = frames - skip

    in_l = [in_samples[i*2] for i in range(skip, frames)]
    out_l = [out_samples[i*2] for i in range(skip, frames)]
    out_r = [out_samples[i*2+1] for i in range(skip, frames)]

    in_rms = math.sqrt(sum(s*s for s in in_l) / n)
    out_l_rms = math.sqrt(sum(s*s for s in out_l) / n)
    out_r_rms = math.sqrt(sum(s*s for s in out_r) / n)
    diff_rms = math.sqrt(sum((l-r)**2 for l,r in zip(out_l, out_r)) / n)

    gain_db = 20 * math.log10(max(1, out_l_rms) / max(1, in_rms))

    print(f"\n  Input  RMS:    {in_rms:.0f}")
    print(f"  Output L RMS: {out_l_rms:.0f}")
    print(f"  Output R RMS: {out_r_rms:.0f}")
    print(f"  L/R diff RMS: {diff_rms:.0f}")
    print(f"  Gain change:  {gain_db:+.1f} dB")
    print()
    if diff_rms > 500:
        print("  ✓ Dolby Headphone spatial processing: ACTIVE")
    if abs(gain_db) > 0.5:
        print("  ✓ Volume Leveler / Audio Regulator: ACTIVE")

def main():
    input_wav = None
    output_wav = None

    if len(sys.argv) > 1:
        input_wav = sys.argv[1]
    if len(sys.argv) > 2:
        output_wav = sys.argv[2]

    if input_wav:
        print(f"Reading {input_wav}...")
        in_samples, frames = read_wav(input_wav)
        if not output_wav:
            base, ext = os.path.splitext(input_wav)
            output_wav = f"{base}_ddp{ext}"
    else:
        print("Generating test tone (C major chord, 3 seconds)...")
        in_samples, frames = generate_test_tone(3.0)
        output_wav = "test_tone_ddp.wav"
        # Also save the input
        write_wav("test_tone_input.wav", in_samples, frames)
        print("  Saved: test_tone_input.wav")

    print(f"Processing {frames} frames ({frames/RATE:.1f}s) through DDP...")
    out_samples, out_frames = process_through_ddp(in_samples, frames)

    write_wav(output_wav, out_samples, out_frames)
    print(f"  Saved: {output_wav}")

    print("\nAnalysis:")
    analyze(in_samples, out_samples, out_frames)

if __name__ == '__main__':
    main()
