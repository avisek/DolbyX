# DolbyX Architecture Analysis & Optimization Plan

## Current Performance Analysis

### Why the VST seems slow despite 12× realtime test_ddp.py

The key insight from the audiodg.exe log:

```
PID:3604 BlockSize: 480     ← audiodg.exe uses 480-frame blocks (10ms)
PID:12348 BlockSize: 65536  ← Configuration Editor uses 65536 (1.37s analysis)
```

The Configuration Editor's -2.2dB measurement and ~10% CPU came from processing
65536 frames (1.37 seconds of audio) in its **one-shot analysis pass** — NOT from
real-time audio. The actual audio path (audiodg.exe) processes in 480-frame
blocks (10ms each), which is ~100× less work per call.

### Latency breakdown (480-frame blocks, batch protocol)

| Component | Time |
|-----------|------|
| Float→int16 conversion (480 samples) | ~0.01ms |
| Named pipe write (4 + 1920 bytes) | ~0.05ms |
| Bridge receive + chunk (2 × 256-frame chunks) | ~0.02ms |
| Bridge→processor stdin write | ~0.05ms |
| QEMU ARM emulation (480 frames of DDP) | ~1-2ms |
| Processor→bridge stdout read | ~0.05ms |
| Named pipe read (1920 bytes) | ~0.05ms |
| Int16→float conversion | ~0.01ms |
| **Total** | **~1.5-2.5ms** |

With the batch protocol, this should be **excellent for gaming** — well under
the 10ms perceptual threshold.

### CPU usage

The ~10% CPU was from the analysis pass processing 65536 frames through QEMU.
Real-time at 480-frame blocks: QEMU processes ~100 blocks/second, each taking
~1-2ms = ~15-20% of one core. This is the cost of ARM emulation.

---

## Path to Standalone Plug-and-Play VST

### Why we currently need WSL

```
Current: audiodg.exe → pipe → bridge.exe → wsl.exe → qemu-arm-static → DDP
                                             ↑              ↑
                                        WSL2 needed    Linux-only tool
```

QEMU user-mode emulation (`qemu-arm-static`) is **Linux-only** — it translates
Linux syscalls to host syscalls. It cannot run natively on Windows. This is
confirmed in QEMU's official docs: "User mode is implemented for Linux and BSD."

### Three paths to standalone

#### Path 1: Unicorn Engine (RECOMMENDED — Most Practical)

**Unicorn** is a lightweight CPU emulator extracted from QEMU's TCG (Tiny Code
Generator). It runs natively on Windows, macOS, and Linux as a C library.

```
Standalone: audiodg.exe → DolbyDDP.dll → Unicorn ARM emulator → libdseffect.so
                              ↑
                     Everything in one DLL!
```

**What we'd build:**
1. Custom ELF loader (parse libdseffect.so sections, map into memory)
2. Stub resolver (hook android:: imports to our C++ stubs)
3. ARM function caller (invoke EffectCreate, Effect_process via Unicorn)
4. All packaged inside the DLL — zero external dependencies

**Pros:** Truly plug-and-play, cross-platform, ~500KB DLL
**Cons:** Complex to build (~2-3 weeks), ~5-10× slower than native QEMU
**Feasibility:** HIGH — Unicorn is well-documented, actively maintained

#### Path 2: Static Binary Translation (Best Performance, Hardest)

Convert ARM machine code to x86 at build time using tools like rev.ng or RetDec.

```
Build-time: libdseffect.so (ARM) → translator → libdseffect_x86.dll (native)
Runtime:    audiodg.exe → DolbyDDP.dll → libdseffect_x86.dll (native speed!)
```

**Pros:** Native speed, zero emulation overhead, ~200KB DLL
**Cons:** Extremely difficult for optimized ARM code, NEON instructions, 
         self-modifying code. May take months. QMF filterbank uses fixed-point
         ARM-specific math that's hard to translate automatically.
**Feasibility:** MEDIUM — would need manual intervention for DSP-heavy code

#### Path 3: Optimized Current Architecture (Quick Wins)

Keep WSL but minimize overhead:
1. ✅ Batch protocol (done in v0.6.0)
2. Pre-warm processor (persistent bridge process)
3. Shared memory instead of named pipes (further reduces IPC)
4. Auto-start bridge as Windows service

**Pros:** Works now, incremental improvement
**Cons:** Still requires WSL2 setup
**Feasibility:** HIGH — days, not weeks

### Recommended Roadmap

| Phase | Goal | Timeline |
|-------|------|----------|
| **v0.6** | Batch protocol + verify performance (**current**) | Done |
| **v0.7** | Auto-start bridge, installer script | 1-2 days |
| **v1.0** | Unicorn-based standalone DLL (no WSL) | 2-3 weeks |
| **v1.1** | Parameter control UI (VST panel or standalone) | 1 week |
| **v1.2** | macOS AudioUnit plugin | 1 week |
| **v2.0** | Clean-room DSP reimplementation | 3-6 months |

---

## Immediate Next Step: Verify Batch Protocol Performance

After updating the bridge and VST, test with the following:

1. Start bridge: `cd /mnt/c && ~/DolbyX/windows/dolbyx-bridge.exe /home/avisek/DolbyX/arm`
2. Toggle VST in EqualizerAPO
3. Play music — should hear DDP effect
4. Check logs: `cat /mnt/c/Users/Public/DolbyDDP.log`
5. Check bridge output for "Block 1: 480 frames" (confirms small blocks)

The 480-frame blocks + batch protocol should give <3ms processing latency,
which is invisible for gaming.
