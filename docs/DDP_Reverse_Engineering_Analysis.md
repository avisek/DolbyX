# Dolby Digital Plus v8.1 Magisk Module — Reverse Engineering Analysis

## Executive Summary

This module is built on **Dolby Audio Processing v1 (DAP v1)**, also known as **DS1** (Dolby Sound 1). The core DSP engine is a **single 32-bit ARM native library** (`libdseffect.so`, 428 KB) that implements the Android AudioEffect HAL interface. It contains a sophisticated multi-stage audio processing pipeline with ~28 internal DSP nodes, all controlled through a parameter system called **AK (Audio Kernel)**. The "magic" you're hearing is likely the combined interplay of the **Intelligent Equalizer**, **Dolby Headphone virtualizer**, **Volume Leveler**, **Surround Compressor**, **Next Gen Surround (upmixer)**, **Dialog Enhancer**, and **Audio Regulator** — all working together in a QMF (Quadrature Mirror Filter) filterbank domain rather than simple time-domain processing.

---

## Module Architecture

```
┌─────────────────────────────────────────────────────────┐
│  DsUI.apk (com.dolby.ds1appUI)  — User interface        │
│  Ds.apk   (com.dolby.ds1)       — Background service     │
│  dolby_ds.jar                    — Java framework API     │
├─────────────────────────────────────────────────────────┤
│  Android AudioEffect HAL Interface                       │
│  UUID: 9d4921da-8225-4f29-aefa-39537a04bcaa              │
├─────────────────────────────────────────────────────────┤
│  libdseffect.so (ARM 32-bit)     — Core DSP engine       │
│  ├── AK Framework (parameter routing & graph execution)  │
│  └── DS1ap (Ds1 Audio Processor wrapper)                 │
├─────────────────────────────────────────────────────────┤
│  ds1-default.xml                 — Profiles & tuning     │
└─────────────────────────────────────────────────────────┘
```

**Dependencies**: libcutils.so, liblog.so, libutils.so, libdl.so, libc.so, libstdc++.so, libm.so (all standard Android libs).

---

## The DSP Processing Chain (28 Nodes)

The audio flows through a QMF filterbank-based pipeline. Here is every processing node identified inside `libdseffect.so`, decoded from symbol names:

| Node ID | Full Name | Purpose |
|---------|-----------|---------|
| `fqmf` | Forward QMF | Splits time-domain audio into frequency subbands (20-band filterbank) |
| `dmxq` | Downmix QMF | Downmixes multichannel to stereo in QMF domain |
| `ngsq` | Next Gen Surround QMF | **Upmixes stereo → 5.1/7.1** using Pro Logic-style decoding. This is what transforms your mono/stereo into spacious surround |
| `umxq` | Upmix QMF | Additional upmixing stage |
| `dvle` | Dolby Volume Leveler | **Dynamic loudness normalization** — quietly boosts quiet parts, tames loud parts. This is key to the "listen for hours" comfort |
| `eqe` | Equalizer Engine | Master EQ engine with 3 modes: manual 20-band, preset (bass/treble), 5-band graphic |
| `egq` | External Graphic EQ | 20-band graphic EQ with per-band gains |
| `legq` | Loudness-compensated EQ | EQ that accounts for Fletcher-Munson equal-loudness contours |
| `gq` | Graphic EQ (core) | Core graphic equalizer processing |
| `gndb` | Gain dB | Gain stage in dB |
| `dele` | Dialog Enhancer | Isolates and boosts dialog/vocals using spectral analysis and ducking |
| `de` | Dialog Enhancement (core) | Core dialog detection and stereo processing |
| `dhq` | Dolby Headphone QMF | **Headphone virtualizer** — HRTF-based spatial simulation. Adds crossfeed, room reverb, spatial cues. This is the "spacious" quality you hear |
| `dvsq` | Dolby Virtual Speaker QMF | Speaker virtualizer for loudspeakers |
| `dvs` | Dolby Virtual Speaker (core) | Core virtual speaker processing with configurable angle |
| `scle` | Surround Compressor Leveler | **Surround channel boost** — up to 6dB boost to surround channels, with signal-adaptive gating |
| `are` | Audio Regulator | **Multi-band compressor/limiter** — prevents distortion while maximizing loudness. 20-band with per-band thresholds |
| `plim` | Peak Limiter | Final brick-wall limiter preventing clipping |
| `agc` | Automatic Gain Control | Gain normalization |
| `gain` | Gain | Simple gain stage |
| `eval` | Evaluation/License | SKU/license checking node |
| `visq` | Visualizer QMF | Extracts visualization data from the processed signal |
| `fshq` | Forward SHQ | Forward filter stage |
| `rshq` | Reverse SHQ | Reverse filter stage |
| `rqmf` | Reverse QMF | Reconstructs time-domain audio from processed subbands |
| `dh` | Dolby Headphone (core) | Core HRTF convolution engine |
| `dly` | Delay | Latency compensation buffer |

### Processing Order (Reconstructed)

```
Input Audio
  │
  ▼
Forward QMF (fqmf) ─── splits into 20 frequency subbands
  │
  ▼
Downmix (dmxq) ─── normalize channel count
  │
  ▼
Next Gen Surround (ngsq) ─── upmix stereo/mono → 5.1/7.1
  │
  ▼
Dialog Enhancer (dele/de) ─── isolate & boost vocals
  │
  ▼
Dolby Volume Leveler (dvle) ─── dynamic loudness normalization
  │                               (includes Fletcher-Munson modeling)
  ▼
Intelligent EQ (eqe/legq) ─── content-adaptive spectral shaping
  │
  ▼
Graphic EQ (egq/gq) ─── user-adjustable EQ
  │
  ▼
Surround Compressor (scle) ─── boost surround channels
  │
  ▼
Virtualizer: Dolby Headphone (dhq/dh) OR Virtual Speaker (dvsq/dvs)
  │             ─── HRTF crossfeed + room reverb (headphones)
  │             ─── virtual surround from speakers
  ▼
Audio Regulator (are) ─── 20-band dynamic compression/limiting
  │
  ▼
Peak Limiter (plim) ─── brick-wall clipping prevention
  │
  ▼
Reverse QMF (rqmf) ─── reconstruct time-domain output
  │
  ▼
Output Audio
```

---

## Complete Parameter Dictionary

Every parameter from `ds1-default.xml`, decoded from embedded documentation strings:

### Profile Parameters (User-Controllable)

| Param | Full Name | Range | Description |
|-------|-----------|-------|-------------|
| `aoon` | Audio Optimizer On | 0/1/2 | 0=off, 1=on (all endpoints), 2=auto (speakers only) |
| `dea` | Dialog Enhancement Amount | 0–16 | Strength of vocal/dialog boost |
| `ded` | Dialog Enhancement Ducking | 0–16 | How much to duck non-dialog content |
| `deon` | Dialog Enhancement Enable | 0/1 | On/off |
| `dhrg` | Dolby Headphone Reverb Gain | 0–?? | Amount of virtual room reverb |
| `dhsb` | Dolby Headphone Surround Boost | 0–192 | dB×2 boost to surround in headphone mode |
| `dssb` | Dolby Virtual Speaker Surround Boost | 0–192 | dB×2 boost in speaker mode |
| `dssf` | Dolby Virtual Speaker Start Freq | Hz | Frequency above which virtualization applies |
| `dvla` | Dolby Volume Leveler Amount | 0–10 | Aggressiveness of loudness leveling |
| `dvle` | Dolby Volume Leveler Enable | 0/1 | On/off |
| `dvme` | Dolby Volume Modeler Enable | 0/1 | Fletcher-Munson psychoacoustic modeling |
| `gebg` | Graphic EQ Band Gains | 20 values | Per-band gains |
| `geon` | Graphic EQ Enable | 0/1 | On/off |
| `iea` | Intelligent EQ Amount | 0–16 | Strength of content-adaptive EQ |
| `ieon` | Intelligent EQ Enable | 0/1 | On/off |
| `ngon` | Next Gen Surround Enable | 0/1/2 | 0=off, 1=on, 2=auto |
| `plb` | Peak Limiter Boost | dB | Additional boost before limiter |
| `plmd` | Peak Limiter Mode | 1–4 | 1=disable all, 2=regulated peak, 3=regulated distortion, 4=auto |
| `vdhe` | Dolby Headphone Enable | 0/1/2 | 0=off, 1=on, 2=auto |
| `vmb` | Volume Maximizer Boost | 0–192 | dB×2 volume boost |
| `vmon` | Volume Maximizer Enable | 0/1/2 | On/off/auto |
| `vspe` | Virtual Speaker Enable | 0/1/2 | On/off/auto |

### Intelligent EQ Presets (Hidden Gems)

These 20-band target curves define the spectral "personality":

| Preset | Character | Values (20 bands, 46Hz–19.7kHz) |
|--------|-----------|------|
| `ieq_open` | Airy, bright, wide | 117, 133, 188, 176, 141, 149, 175, 185, 185, 200, 236, 242, 228, 213, 182, 132, 110, 68, -27, -240 |
| `ieq_rich` | Warm, full, lush ★ | 67, 95, 172, 163, 168, 201, 189, 242, 196, 221, 192, 186, 168, 139, 102, 57, 35, 9, -55, -235 |
| `ieq_focused` | Vocal-forward, narrow | -419, -112, 75, 116, 113, 160, 165, 80, 61, 79, 98, 121, 64, 70, 44, -71, -33, -100, -238, -411 |

**The "Music" profile uses `ieq_rich`** — this is likely the primary preset giving you that warm, full sound.

### Tuning Parameters (Speaker Calibration — Currently SPEAKER Endpoint)

| Param | Full Name | Description |
|-------|-----------|-------------|
| `aobf` | Audio Optimizer Band Frequencies | 20 center frequencies |
| `aobg` | Audio Optimizer Band Gains | Per-channel correction gains (40 values = 20 bands × 2 channels) |
| `arbf` | Audio Regulator Band Frequencies | 20 center frequencies |
| `arbh` | Audio Regulator Band High Thresholds | Upper compression thresholds per band |
| `arbl` | Audio Regulator Band Low Thresholds | Lower compression thresholds per band |
| `arbi` | Audio Regulator Band Isolates | Per-band isolation flags (1=independent, 0=smoothed with neighbors) |
| `arod` | Audio Regulator Overdrive | Additional drive into the regulator |
| `artp` | Audio Regulator Timbre Preservation | How much to preserve spectral shape during limiting |
| `dssa` | Surround Compressor Speaker Angle | Physical speaker angle in degrees |

### Hidden Parameters (Found in AK System, Not Exposed in XML)

| Param | Full Name | What It Controls |
|-------|-----------|-----------------|
| `dvli` | Volume Leveler Input Target | Reference input loudness (currently -320 = -32.0 LKFS) |
| `dvlo` | Volume Leveler Output Target | Target output loudness (-320 = -32.0 LKFS) |
| `dvmc` | Volume Modeler Calibration | Playback level calibration offset |
| `preg` | Pre-gain | Gain before processing chain |
| `pstg` | Post-gain | Gain after processing chain |
| `ocf` | Output Channel Format | STEREO / 5.1 / 7.1 |
| `endp` | Endpoint | SPEAKER / HEADPHONES / HDMI / SPDIF / DLNA / ANALOG |
| `vol` | Volume | System volume level (informs leveler) |
| `vcbe/vcbf/vcbg/vcnb` | Volume Compensation Band params | Additional per-band volume compensation |
| `vnbe/vnbf/vnbg/vnnb` | Visualization Band params | Visualization output configuration |
| `lcmf/lcpt/lcsz/lcvd` | License params | SKU verification |
| `scpe` | Surround Compressor Enable | Separate from the profile-level control |
| `test` | Test mode | Engineering test flag |

---

## Why This Version Sounds So Good (Technical Hypothesis)

Based on the parameter analysis, here's what makes the "Music" profile special:

1. **Intelligent EQ with `ieq_rich` at amount=10** — This isn't a static EQ. It *analyzes the content in real-time* and shapes the spectrum to match the "rich" target curve. It boosts the midrange warmth (bands 5–11, ~650Hz–3kHz) while rolling off harsh treble. Amount=10 means it's at **maximum strength**.

2. **Dialog Enhancement ON (dea=2)** — Even in music mode, this gently lifts vocals/lead instruments out of the mix using spectral isolation, giving that "clarity without harshness" quality.

3. **Volume Leveler (dvla=4, enabled)** — Moderate dynamic range compression that makes quiet passages audible and loud passages comfortable. This is the "listen for hours" factor.

4. **Dolby Headphone Auto (vdhe=2)** — When headphones are detected, HRTF-based crossfeed and room simulation engage automatically. This creates the "spacious" out-of-head experience and reduces listener fatigue by mimicking natural speaker listening.

5. **Headphone Surround Boost (dhsb=48)** — Gentle 2.4dB boost to the virtual surround channels.

6. **Next Gen Surround ON (ngon=2 auto)** — Upmixes stereo and mono to virtual 5.1/7.1 before the headphone virtualizer processes it. This is why even mono tracks sound "spacious and lively."

7. **Audio Regulator in AUTO mode (plmd=4)** — Full multi-band compression and limiting with timbre preservation. Prevents harshness at any volume.

8. **Volume Maximizer (vmb=144)** — 7.2dB boost that the Audio Regulator keeps clean.

9. **Everything processed in QMF filterbank domain** — The 20-band filterbank means all processing happens with frequency-band precision. This avoids the artifacts of crude time-domain processing that makes cheaper mods sound "unnatural."

---

## Portability Analysis & Roadmap

### The Core Challenge

`libdseffect.so` is a **compiled ARM binary** (32-bit, stripped). The actual DSP algorithms (HRTF convolutions, QMF filterbank, loudness model, etc.) are baked into machine code. You have three paths forward:

### Path 1: Binary Translation / Emulation (Fastest to Demo)

**Run the ARM binary on x86/x64 via emulation.**

| Approach | Feasibility | Notes |
|----------|------------|-------|
| QEMU user-mode ARM emulation on Linux | ✅ High | Wrap libdseffect.so in a Linux audio plugin (LADSPA/LV2) that calls the ARM code through QEMU. Real-time performance possible for stereo audio |
| Box86/Box64 | ⚠️ Medium | These translate ARM→x86 dynamically. Would need to stub out Android-specific libs (libcutils, liblog) |
| Android emulator + loopback | ⚠️ Hacky | Run Android x86 with the module, route audio through it |

**For Windows VST on EqualizerAPO**, the most practical path:
1. Use QEMU ARM user-mode emulation
2. Create a thin C wrapper that implements the Android AudioEffect interface (EffectCreate, Effect_process, Effect_command)
3. Wrap that in a VST3 plugin shell
4. Load it in EqualizerAPO's VST plugin host

### Path 2: Clean-Room Reimplementation (Best Long-Term)

Reimplement the DSP chain in portable C/C++ or Rust. This is the path to a true cross-platform solution.

**What you'd need to reimplement:**
1. **QMF Filterbank** (20-band) — well-documented in MPEG/Dolby literature
2. **Intelligent EQ** — content-adaptive EQ targeting a spectral profile. Requires real-time spectral analysis + gain computation
3. **Dolby Headphone** — HRTF convolution. The key question is: what HRTF dataset and room model are baked in? You'd need to extract or substitute these
4. **Volume Leveler** — ITU-R BS.1770 loudness measurement + dynamic gain. Well-understood algorithm
5. **Next Gen Surround** — Pro Logic II-style upmixer. Dolby's implementation is proprietary but the principles are documented
6. **Audio Regulator** — Multi-band compressor with per-band thresholds. Standard DSP
7. **Dialog Enhancer** — Center-channel extraction from stereo via mid/side analysis + spectral weighting
8. **Surround Compressor** — Frequency-dependent surround boost with noise gating
9. **Peak Limiter** — Standard brick-wall limiter

**Estimated effort**: 3–6 months for a skilled DSP engineer. The hardest parts are the HRTF data extraction and getting the Intelligent EQ's content classification right.

### Path 3: Hybrid — Extract Parameters, Use Open-Source DSP

Use the extracted parameter values with existing open-source equivalents:

| DDP Feature | Open-Source Equivalent |
|-------------|----------------------|
| QMF Filterbank | FFT-based processing (not identical but comparable) |
| Dolby Headphone | HeSuVi / OpenAL Soft HRTF / SteamAudio |
| Volume Leveler | libebur128 + custom gain |
| Intelligent EQ | Custom: spectral target + real-time analysis |
| Next Gen Surround | Ambisonic upmixer / OpenAL |
| Audio Regulator | Multi-band compressor (LSP / Calf plugins) |
| Dialog Enhancer | Mid/Side processing + spectral gating |
| Graphic EQ | Any parametric EQ (EqualizerAPO built-in) |

---

## Immediate Next Steps

### 1. Extract the HRTF Data
The Dolby Headphone node (`dhq`/`dh`) contains embedded HRTF impulse responses. These can potentially be extracted by:
- Running the library in an ARM emulator with known test signals (impulse responses per frequency band)
- Dumping memory after initialization to find the HRTF coefficient tables

### 2. Map All Hidden Parameters
The AK system has many more parameters than `ds1-default.xml` exposes. A full parameter dump can be obtained by:
- Calling `ak_enum` / `ak_count_defs` through the emulated library
- Iterating all parameter IDs with `ak_get` to read defaults

### 3. Build a Windows Proof-of-Concept
The fastest path to Windows:
1. Compile a minimal Android AudioEffect HAL stub for x86 (replacing libcutils/liblog with no-ops)
2. Wrap libdseffect.so with QEMU user-mode
3. Package as a VST3 plugin for EqualizerAPO
4. Use the "Music" profile parameters from ds1-default.xml

### 4. Document the AK Parameter Protocol
The `ak_set` / `ak_get` / `ak_set_bulk` API is the control interface. Understanding its binary protocol allows real-time parameter tweaking — exposing all those "hidden" controls.

---

## Key Files Reference

| File | Size | Purpose |
|------|------|---------|
| `system/vendor/lib/soundfx/libdseffect.so` | 428 KB | Core DSP engine (ARM32, stripped) |
| `system/etc/ds1-default.xml` | 5.2 KB | Profiles, tuning, feature enables |
| `system/priv-app/Ds/Ds.apk` | 394 KB | Background service (manages effect lifecycle) |
| `system/priv-app/DsUI/DsUI.apk` | 1.9 MB | UI app |
| `system/framework/dolby_ds.jar` | 47 KB | Java API framework |
| `common/install.sh` | 3.5 KB | Patches audio_effects.conf/xml to register the effect |

## Effect UUID

`9d4921da-8225-4f29-aefa-39537a04bcaa` — This is the Android AudioEffect type UUID that identifies this as the DS1 effect.

---

## Legal Considerations

The `libdseffect.so` binary is Dolby proprietary code. Distributing it or running it outside its intended context may violate Dolby's intellectual property rights. The clean-room reimplementation path (Path 2) is the legally safest approach for a distributable cross-platform solution. For personal use, binary emulation (Path 1) is the pragmatic starting point.
