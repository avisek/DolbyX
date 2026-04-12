# DolbyX

Run the legendary **Dolby Digital Plus v8.1** (DS1) audio effect from Android on your PC — using the original ARM DSP binary via QEMU emulation. Zero resampling, native 48kHz, full spatial audio.

## What Is This?

DolbyX wraps the original `libdseffect.so` from the Dolby Digital Plus Magisk module (v8.1 by aka_vkl/repey6) inside a portable framework that runs on Windows, Linux, and macOS.

The DSP engine processes audio through a 28-node filterbank pipeline including:
- **Dolby Headphone** — HRTF-based spatial virtualizer (crossfeed + room simulation)
- **Next Gen Surround** — upmixes stereo/mono to virtual 5.1/7.1
- **Intelligent Equalizer** — content-adaptive spectral shaping
- **Volume Leveler** — dynamic loudness normalization
- **Dialog Enhancer** — vocal isolation and boost
- **Audio Regulator** — 20-band multi-band compressor
- **Volume Maximizer** — configurable gain boost
- **Peak Limiter** — brick-wall clipping prevention

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Windows / Linux / macOS                                     │
│                                                              │
│  Audio Source ──► DolbyX Bridge ──► Audio Output              │
│                      │                                       │
│                 stdin/stdout pipe                             │
│                      │                                       │
│  ┌───────────────────┼───────────────────────────────────┐   │
│  │  WSL2 / Linux                                         │   │
│  │                   ▼                                   │   │
│  │  qemu-arm-static ──► ddp_processor (ARM binary)       │   │
│  │                          │                            │   │
│  │                    libdseffect.so (original Dolby)     │   │
│  │                    + stub libs                        │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Supported Sample Rates

Natively supported (no resampling):
| Rate | Status |
|------|--------|
| 32000 Hz | ✅ Supported |
| 44100 Hz | ✅ Supported |
| **48000 Hz** | ✅ **Default** |
| 96000+ Hz | ❌ Not supported by DSP core |

Bit depth: 16-bit integer internally. DolbyX uses float32 gain staging at the boundaries to preserve quality.

## Quick Start

### 1. Prerequisites

- **WSL2** with Ubuntu (Windows) or native Linux
- ARM cross-compiler and QEMU:
  ```bash
  sudo apt install gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf qemu-user-static make python3
  ```

### 2. Build

```bash
cd DolbyX
chmod +x scripts/setup_wsl.sh
./scripts/setup_wsl.sh
```

### 3. Process a WAV File

```bash
cd arm
python3 test_ddp.py ../samples/test_song_48k.wav
```

This produces `test_song_48k_ddp.wav` — listen on headphones to hear the spatial processing.

#### Advanced usage

```bash
# Process with custom sample rate and gain
python3 test_ddp.py input.wav output.wav

# Manual pipe processing
LD_LIBRARY_PATH=build/lib \
  qemu-arm-static -L /usr/arm-linux-gnueabihf \
  build/ddp_processor build/lib/libdseffect.so 48000 -6 0
```

Command-line arguments for `ddp_processor`:
```
ddp_processor <libdseffect.so> [sample_rate] [pre_gain_dB] [post_gain_dB]

  sample_rate:   48000 (default), 44100, or 32000
  pre_gain_dB:   Input attenuation, default -6.0 (simulates ~50% phone volume)
  post_gain_dB:  Output boost, default 0.0 (raw DDP output)
```

### 4. Windows EqualizerAPO Integration

1. Copy `windows/DolbyDDP.dll` to `C:\Program Files\EqualizerAPO\VSTPlugins\`
2. Copy `config/ddp_config.ini` next to the DLL
3. Edit `ddp_config.ini` — set `ddp_path` to your WSL2 path (e.g. `/home/you/DolbyX/arm`)
4. Open EqualizerAPO Configuration Editor → Add VST Plugin → select `DolbyDDP.dll`

## Gain Staging

On Android, audio enters DDP at system volume level (typically 50-70%), not at 0 dBFS. The `pre_gain` parameter simulates this:

| pre_gain | Simulates | Effect |
|----------|-----------|--------|
| -3 dB | ~70% volume | More Volume Maximizer & limiter activity |
| **-6 dB** | **~50% volume** | **Recommended — natural DDP behavior** |
| -9 dB | ~35% volume | Quieter, less dynamics processing |
| -12 dB | ~25% volume | Very gentle processing |

## Profiles

| ID | Name | IEQ Preset | Key Features |
|----|------|------------|--------------|
| 0 | Movie | Rich | Dialog Enhancement ON, high surround boost |
| **1** | **Music** | **Rich** | **Default. Dialog ON, Surround ON** |
| 2 | Game | Open | Volume Maximizer ON, Virtual Speaker ON |
| 3 | Voice | Rich | Strong Dialog Enhancement (amount=10) |
| 4 | Custom 1 | Rich | Balanced processing |
| 5 | Custom 2 | Rich | Same as Custom 1 |

## Project Structure

```
DolbyX/
├── arm/                        # ARM processor (runs in WSL2/Linux)
│   ├── ddp_processor.c         # Main processor with gain staging
│   ├── audio_effect_defs.h     # Android AudioEffect HAL structures
│   ├── test_ddp.py             # WAV file processor script
│   ├── Makefile
│   ├── stubs/                  # Android library stubs
│   │   ├── liblog_stub.c
│   │   ├── libutils_stub.cpp
│   │   └── libcutils_stub.c
│   └── lib/
│       └── libdseffect.so      # Original Dolby DSP binary (ARM32)
├── windows/                    # Windows VST2 plugin
│   ├── ddp_vst.c
│   ├── vst2_abi.h
│   ├── DolbyDDP.dll            # Pre-built x64 VST DLL
│   └── build_vst.bat
├── config/
│   └── ddp_config.ini          # VST plugin configuration
├── scripts/
│   └── setup_wsl.sh            # Automated build & setup
├── samples/
│   └── test_song_48k.wav       # Test audio (48kHz stereo)
└── README.md
```

## Technical Details

### How Native 48kHz Works

The `EffectCreate` API always initializes at 44100 Hz, and `SET_CONFIG` to change the rate is permanently broken in this binary. DolbyX uses a "hot-swap" technique:

1. Create the effect normally (44100 Hz init)
2. Call `Ds1ap::New(0, 48000, 2, 0)` to create a fresh 48kHz DSP instance
3. Initialize its buffer with `Ds1apBufferInit(ctx, 256, 2, 16)`
4. Patch the effect context: swap the Ds1ap pointer at offset +68 and sample rate fields at +12/+44
5. Set all parameters via `DS_PARAM` protocol (they apply to the new instance)

### Why Pre-Gain Matters

The DDP Music profile has `vmb=144` (+7.2 dB Volume Maximizer boost). On Android this is fine because audio arrives pre-attenuated by the system volume. On desktop, audio files are typically normalized to 0 dBFS. Without pre-gain attenuation:

- Volume Maximizer pushes signal to +7.2 dBFS
- Peak Limiter activates constantly, compressing everything
- Result: squashed dynamics, audible pumping

With `-6 dB` pre-gain, the signal enters DDP at -6 dBFS. After +7.2 dB boost, it's at ~+1.2 dBFS — well within the Peak Limiter's gentle handling range.

## License

DolbyX is a wrapper/bridge for personal use. The `libdseffect.so` binary is Dolby proprietary code. The wrapper code in this repository is provided for educational and personal purposes.
