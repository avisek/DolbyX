# DolbyX

Run the legendary **Dolby Digital Plus v8.1** audio effect from Android on your
PC — system-wide, on all audio. Uses the original ARM DSP binary via QEMU
emulation with zero quality compromise.

## What Does It Sound Like?

DolbyX processes audio through a 28-node filterbank DSP pipeline:
- **Spatial audio** — HRTF-based headphone virtualizer with crossfeed
- **Intelligent EQ** — content-adaptive spectral shaping
- **Surround upmix** — stereo/mono → virtual 5.1/7.1
- **Dialog enhancement** — vocal isolation and boost
- **Dynamic range control** — fatigue-free listening for hours

## Quick Start (Windows)

### Prerequisites
- Windows 10/11 with [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) + Ubuntu
- [EqualizerAPO](https://sourceforge.net/projects/equalizerapo/) installed

### Setup

```bash
cd ~/DolbyX
chmod +x scripts/setup_wsl.sh
./scripts/setup_wsl.sh

# Copy VST to EqualizerAPO
cp windows/vst/DolbyDDP.dll "/mnt/c/Program Files/EqualizerAPO/VSTPlugins/"
```

### Usage

**Step 1:** Start the daemon (keep terminal open):
```bash
cd /mnt/c && ~/DolbyX/daemon/dolbyx.exe /home/$USER/DolbyX/arm
```
Or double-click `scripts/start-dolbyx.bat` from Windows Explorer.

**Step 2:** In EqualizerAPO Configuration Editor, add DolbyDDP as a VST plugin.

**Step 3:** Put on headphones and play music.

### Process Audio Files Offline

```bash
cd ~/DolbyX/arm
python3 test_ddp.py input.wav              # Creates input_ddp.wav
python3 test_ddp.py input.wav output.wav   # Custom output name
```

## Architecture

```
Audio App → EqualizerAPO → DolbyDDP.dll (VST) → \\.\pipe\DolbyX → dolbyx daemon
                                                                       │
                                                        qemu-arm-static + libdseffect.so
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical deep-dive.

## Project Structure

```
DolbyX/
├── arm/                     # ARM processor + Android ABI stubs
│   ├── ddp_processor.c      # Main processor with gain staging
│   ├── ddp_protocol.h       # Shared protocol definitions
│   ├── test_ddp.py          # Offline WAV file processor
│   ├── stubs/               # Android library stubs
│   └── lib/                 # libdseffect.so + ds1-default.xml
├── daemon/                  # DolbyX daemon (background process)
│   └── main.c               # Named pipe server + processor management
├── windows/
│   └── vst/                 # VST2 plugin for EqualizerAPO
├── ui/                      # Web UI (Phase 2 — coming soon)
│   └── src/                 # HTML, CSS, JS sources
├── linux/                   # LV2 plugin + PipeWire config (Phase 5)
├── macos/                   # AudioServerPlugin driver (Phase 7)
├── nix/                     # Nix flake modules (Phases 5, 7)
├── scripts/
│   ├── setup_wsl.sh         # Build automation
│   └── start-dolbyx.bat     # One-click Windows launcher
└── docs/                    # Architecture, reverse engineering, plans
```

## Performance

| Metric | Value |
|--------|-------|
| Offline processing | 12× realtime |
| Real-time latency | ~10ms perceived |
| Sample rates | 32000, 44100, **48000** Hz (native) |

## Roadmap

| Version | Platform | Status |
|---------|----------|--------|
| v1.x | Windows (EqualizerAPO + WSL2) | ✅ Working |
| v2.0 | Windows + Web UI | In progress |
| v2.1 | Linux / NixOS (PipeWire) | Planned |
| v3.0 | macOS (AudioServerPlugin) | Planned |

See [docs/CROSS_PLATFORM_PLAN.md](docs/CROSS_PLATFORM_PLAN.md) for the full plan.

## License

DolbyX is a wrapper/bridge for personal and educational use. `libdseffect.so`
is proprietary Dolby code — supply your own from a legally obtained Magisk module.
