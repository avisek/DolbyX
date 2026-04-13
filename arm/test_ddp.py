#!/usr/bin/env python3
"""
test_ddp.py — Process a WAV file through DolbyX (fast version).

Usage:
    python3 test_ddp.py                      # Generate test tone
    python3 test_ddp.py input.wav            # Process WAV
    python3 test_ddp.py input.wav output.wav # Custom output path

Uses binary array I/O for speed (~10× faster than struct.pack per sample).
"""

import struct, math, subprocess, sys, os, wave, time, array

BLOCK_SIZE = 256
RATE = 48000
CHANNELS = 2

def generate_test_tone(duration=3.0):
    frames = int(RATE * duration)
    buf = array.array('h', [0] * (frames * 2))
    for i in range(frames):
        t = i / RATE
        val = 0.3*math.sin(2*math.pi*261.6*t) + 0.25*math.sin(2*math.pi*329.6*t) + \
              0.25*math.sin(2*math.pi*392.0*t) + 0.1*math.sin(2*math.pi*523.2*t)
        env = min(t/0.1, 1.0) * min((duration-t)/0.3, 1.0)
        s = max(-32767, min(32767, int(val * env * 28000)))
        buf[i*2] = s; buf[i*2+1] = s
    return buf, frames

def read_wav(path):
    with wave.open(path, 'r') as w:
        nch = w.getnchannels()
        sw = w.getsampwidth()
        rate = w.getframerate()
        frames = w.getnframes()
        raw = w.readframes(frames)

    if sw == 2 and nch == 2:
        buf = array.array('h')
        buf.frombytes(raw)
        if sys.byteorder == 'big': buf.byteswap()
    elif sw == 2 and nch == 1:
        mono = array.array('h')
        mono.frombytes(raw)
        if sys.byteorder == 'big': mono.byteswap()
        buf = array.array('h', [0] * (frames * 2))
        for i in range(frames):
            buf[i*2] = mono[i]; buf[i*2+1] = mono[i]
    else:
        print(f"Unsupported: {sw*8}bit {nch}ch. Convert to 16-bit stereo first.")
        sys.exit(1)

    if rate != RATE:
        print(f"  Note: WAV is {rate}Hz, DDP processes at {RATE}Hz")
    return buf, frames

def process(samples, frames):
    """Pipe audio through DDP. Fast binary protocol."""
    # Build all protocol messages in one buffer
    msg_parts = []
    offset = 0
    while offset < frames:
        chunk = min(BLOCK_SIZE, frames - offset)
        msg_parts.append(struct.pack('<I', chunk))
        # Slice the array and get raw bytes directly
        chunk_data = samples[offset*CHANNELS:(offset+chunk)*CHANNELS]
        msg_parts.append(chunk_data.tobytes())
        offset += chunk
    msg_parts.append(struct.pack('<I', 0xFFFFFFFF))
    msg = b''.join(msg_parts)

    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = 'build/lib'

    proc = subprocess.run(
        ['qemu-arm-static', '-L', '/usr/arm-linux-gnueabihf',
         'build/ddp_processor', 'build/lib/libdseffect.so',
         str(RATE), '-6', '0'],
        input=msg, capture_output=True, timeout=600, env=env
    )

    if proc.returncode != 0:
        print(f"ERROR: exit code {proc.returncode}")
        for line in proc.stderr.decode('utf-8','replace').split('\n')[-5:]:
            if line.strip(): print(f"  {line}")
        sys.exit(1)

    stdout = proc.stdout
    if len(stdout) < 4:
        print("ERROR: no output"); sys.exit(1)

    magic = struct.unpack('<I', stdout[:4])[0]
    if magic != 0xDD901DAA:
        print(f"ERROR: bad magic 0x{magic:08X}"); sys.exit(1)

    pcm = stdout[4:]
    out_frames = len(pcm) // (CHANNELS * 2)
    out = array.array('h')
    out.frombytes(pcm[:out_frames * CHANNELS * 2])
    if sys.byteorder == 'big': out.byteswap()
    return out, out_frames

def write_wav(path, buf, frames):
    data = buf[:frames*2]
    if sys.byteorder == 'big':
        data = array.array('h', data)
        data.byteswap()
    with wave.open(path, 'w') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(data.tobytes() if isinstance(data, array.array) else data)

def analyze(inp, out, frames):
    skip = min(4096, frames//4)
    n = frames - skip
    in_ss = sum(inp[i*2]**2 for i in range(skip, frames))
    ol_ss = sum(out[i*2]**2 for i in range(skip, frames))
    or_ss = sum(out[i*2+1]**2 for i in range(skip, frames))
    lr_ss = sum((out[i*2]-out[i*2+1])**2 for i in range(skip, frames))

    in_rms = math.sqrt(in_ss / n)
    ol_rms = math.sqrt(ol_ss / n)
    or_rms = math.sqrt(or_ss / n)
    lr_rms = math.sqrt(lr_ss / n)
    gain = 20*math.log10(max(1,ol_rms)/max(1,in_rms))

    print(f"\n  Input  RMS:    {in_rms:.0f}")
    print(f"  Output L RMS: {ol_rms:.0f}")
    print(f"  Output R RMS: {or_rms:.0f}")
    print(f"  L/R diff RMS: {lr_rms:.0f}")
    print(f"  Gain change:  {gain:+.1f} dB")
    print()
    if lr_rms > 500: print("  ✓ Dolby Headphone spatial processing: ACTIVE")
    if abs(gain) > 0.5: print("  ✓ Volume Leveler / Audio Regulator: ACTIVE")

def main():
    in_path = sys.argv[1] if len(sys.argv) > 1 else None
    out_path = sys.argv[2] if len(sys.argv) > 2 else None

    if in_path:
        print(f"Reading {in_path}...")
        samples, frames = read_wav(in_path)
        if not out_path:
            base, ext = os.path.splitext(in_path)
            out_path = f"{base}_ddp{ext}"
    else:
        print("Generating test tone...")
        samples, frames = generate_test_tone(3.0)
        write_wav("test_tone_input.wav", samples, frames)
        out_path = "test_tone_ddp.wav"
        print("  Saved: test_tone_input.wav")

    print(f"Processing {frames} frames ({frames/RATE:.1f}s) through DDP...")
    t0 = time.time()
    out, out_frames = process(samples, frames)
    elapsed = time.time() - t0
    print(f"  {elapsed:.1f}s ({frames/RATE/elapsed:.1f}× realtime)")

    write_wav(out_path, out, out_frames)
    print(f"  Saved: {out_path}")

    print("\nAnalysis:")
    analyze(samples, out, out_frames)

if __name__ == '__main__':
    main()
