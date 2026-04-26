# DolbyX Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Windows                                                          │
│                                                                   │
│  Audio App → EqualizerAPO → DolbyDDP.dll (VST2 plugin)           │
│                                  │                                │
│                          \\.\pipe\DolbyX (named pipe)             │
│                                  │                                │
│  dolbyx-bridge.exe ──────────────┘                                │
│      │                                                            │
│      └── wsl.exe → qemu-arm-static → ddp_processor               │
│                                          │                        │
│                                    libdseffect.so (ARM32 binary)  │
└──────────────────────────────────────────────────────────────────┘
```

## Why This Architecture?

**Why Named Pipes?**
- `audiodg.exe` (Windows Audio Service) runs as LOCAL SERVICE
- It cannot make TCP connections (error 10013 WSAEACCES)
- It cannot spawn WSL processes (per-user service)
- Named pipes with NULL DACL are accessible from all local accounts

**Why a Separate Bridge Process?**
- `audiodg.exe` can't launch WSL2
- The bridge runs as the user (can access WSL2)
- It pre-warms the processor for instant startup

**Why QEMU?**
- `libdseffect.so` is a 32-bit ARM binary compiled for Android
- QEMU user-mode translates ARM instructions to x86 at runtime
- Performance: 6-12× realtime (sufficient for audio processing)

## Processing Pipeline

```
Input Audio (float32, 48kHz, stereo)
  │
  ├── VST: float32 → int16 conversion
  │   └── Single pipe write (frame_count + PCM block)
  │
  ├── Bridge: chunk into 256-frame pieces
  │   └── Pipeline all chunks to processor (no per-chunk waiting)
  │
  ├── Processor (ARM/QEMU):
  │   ├── Pre-gain: -6dB (simulate phone volume)
  │   ├── Zero output buffer (ACCUMULATE mode)
  │   ├── libdseffect.so Effect_process()
  │   │   ├── Forward QMF (20-band filterbank)
  │   │   ├── Next Gen Surround (stereo → 5.1 upmix)
  │   │   ├── Dialog Enhancer
  │   │   ├── Volume Leveler
  │   │   ├── Intelligent EQ (content-adaptive)
  │   │   ├── Dolby Headphone (HRTF virtualizer)
  │   │   ├── Audio Regulator (20-band compressor)
  │   │   ├── Peak Limiter
  │   │   └── Reverse QMF (reconstruct audio)
  │   └── Post-gain: 0dB (raw DDP output)
  │
  ├── Bridge: collect all processed chunks
  │   └── Single pipe write back to VST
  │
  └── VST: int16 → float32 conversion
      └── Output Audio
```

## Supported Sample Rates

| Rate | Native Support | Notes |
|------|---------------|-------|
| 32000 Hz | ✅ | Via Ds1ap::New hot-swap |
| 44100 Hz | ✅ | Default EffectCreate rate |
| **48000 Hz** | ✅ | **Default** (hot-swap technique) |
| 96000+ Hz | ❌ | DSP core lacks filterbank coefficients |

## Key Technical Solutions

### Native 48kHz (Hot-Swap)
`EffectCreate` always initializes at 44100Hz, and `SET_CONFIG` is permanently
broken. DolbyX creates a fresh `Ds1ap::New(0, 48000, 2, 0)` and patches the
effect context at runtime (Ds1ap pointer at offset +68, sample rates at +12/+44).

### Gain Staging
On Android, audio enters DDP at system volume (~50%). On desktop, audio is
typically at 0dBFS. Without pre-gain attenuation, the Volume Maximizer (+7.2dB)
causes constant Peak Limiter activation. Default: -6dB pre-gain, 0dB post-gain.

### Output Buffer Zeroing
The DS1 effect uses ACCUMULATE mode — it adds to the output buffer. Without
zeroing, leftover data creates crackling distortion.

### ABI-Compatible Stubs
`libdseffect.so` depends on Android-specific libraries. DolbyX provides
binary-compatible implementations of `android::String8`, `android::VectorImpl`,
and `android::SortedVectorImpl` matching AOSP 4.4-5.0 memory layout.

## Roadmap to Standalone (No WSL)

### Path 1: Unicorn Engine (Recommended)
Embed the Unicorn CPU emulator (extracted from QEMU's TCG backend) directly
in the DLL. Custom ELF loader + stub resolver = single-file plug-and-play VST.
Performance: ~1.2-2× slower than QEMU (same JIT engine, minimal overhead
without instrumentation hooks). Still 6-10× realtime.

### Path 2: Static Binary Translation
Convert ARM machine code to x86 at build time. Native speed but extremely
complex for optimized DSP code with NEON instructions.

### Path 3: Clean-Room Reimplementation
Rewrite the DSP chain in portable C/Rust using extracted parameters and
open-source equivalents. Legally safest, best performance, most effort (3-6mo).
