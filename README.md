# DolbyX

Run the legendary **Dolby Digital Plus v8.1** audio effect from Android on your PC — system-wide, on all audio. Uses the original ARM DSP binary via QEMU emulation with zero quality compromise.

## What Does It Sound Like?

DolbyX processes audio through a 28-node filterbank DSP pipeline that delivers:
- **Spatial audio** — HRTF-based headphone virtualizer with crossfeed and room simulation
- **Intelligent EQ** — content-adaptive spectral shaping (warm "Rich" curve)
- **Surround upmix** — stereo/mono → virtual 5.1/7.1 with Next Gen Surround
- **Dialog enhancement** — vocal isolation and boost
- **Dynamic range control** — Volume Leveler + Audio Regulator for fatigue-free listening

The result: natural, warm, spacious audio that you can listen to for hours.

## Quick Start (Windows)

### Prerequisites
- Windows 10/11 with [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) + Ubuntu
- [EqualizerAPO](https://sourceforge.net/projects/equalizerapo/) installed

### Setup

```bash
# In WSL2 Ubuntu terminal:
cd ~
git clone https://github.com/avisek/DolbyX.git
cd DolbyX
chmod +x scripts/setup_wsl.sh
./scripts/setup_wsl.sh

# Copy VST to EqualizerAPO:
cp windows/DolbyDDP.dll "/mnt/c/Program Files/EqualizerAPO/VSTPlugins/"
```

### Usage

**Step 1:** Start the bridge (keep this terminal open):
```bash
cd /mnt/c && ~/DolbyX/windows/dolbyx-bridge.exe /home/$USER/DolbyX/arm
```

**Step 2:** In EqualizerAPO Configuration Editor, add a VST plugin and select `DolbyDDP.dll`.

**Step 3:** Put on headphones and play music.

### Process Audio Files

```bash
cd ~/DolbyX/arm
python3 test_ddp.py input.wav              # Creates input_ddp.wav
python3 test_ddp.py input.wav output.wav   # Custom output name
```

## Architecture

```
audiodg.exe → DolbyDDP.dll → \\.\pipe\DolbyX → dolbyx-bridge.exe → WSL2/QEMU → DDP
  (Windows      (VST2)         (named pipe)       (user process)      (ARM emu)
   audio svc)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical deep-dive.

## Performance

| Metric | Value |
|--------|-------|
| Offline processing | 12× realtime |
| Real-time latency | ~10ms perceived |
| CPU usage | ~9% of one core |
| Sample rates | 32000, 44100, **48000** Hz (native) |
| Bit depth | 16-bit internal, float32 at boundaries |

## Project Structure

```
DolbyX/
├── arm/                         # ARM processor (WSL2/Linux)
│   ├── ddp_processor.c          # Main processor with gain staging
│   ├── audio_effect_defs.h      # Android AudioEffect HAL structures
│   ├── test_ddp.py              # WAV file processor
│   ├── stubs/                   # Android library ABI stubs
│   ├── lib/libdseffect.so       # Original Dolby DSP (ARM32)
│   └── Makefile
├── windows/                     # Windows components
│   ├── ddp_vst.c                # VST2 plugin (named pipe client)
│   ├── dolbyx-bridge.c          # Named pipe server + WSL bridge
│   ├── vst2_abi.h               # VST2 ABI definitions
│   ├── DolbyDDP.dll             # Pre-built VST
│   ├── dolbyx-bridge.exe        # Pre-built bridge
│   └── start-bridge.bat         # One-click launcher
├── scripts/
│   ├── setup_wsl.sh             # Build & setup automation
│   ├── dolbyx-daemon.py         # TCP daemon (for standalone testing)
│   └── test_vst_pipe.sh         # VST pipe protocol test
├── docs/
│   ├── ARCHITECTURE.md          # System design & technical details
│   └── DDP_Reverse_Engineering_Analysis.md
├── config/ddp_config.ini        # VST configuration
└── samples/test_song_48k.wav    # Test audio
```

## How It Works

1. **The DSP binary** (`libdseffect.so`, 428KB ARM32) implements Dolby's DS1 audio processor with a 20-band QMF filterbank pipeline
2. **QEMU** translates ARM instructions to x86 at runtime via its TCG JIT compiler
3. **The bridge** runs as a user process, spawning WSL2/QEMU and serving audio via a Windows named pipe
4. **The VST** connects to the pipe from any Windows process, including `audiodg.exe` (the Windows audio service)
5. **Gain staging** (-6dB pre-gain) simulates Android's system volume, preventing Peak Limiter over-activation

## License

DolbyX is a wrapper/bridge for personal and educational use. `libdseffect.so` is proprietary Dolby code — not included in releases, supply your own from a legally obtained Magisk module.
