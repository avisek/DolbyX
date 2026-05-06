# 02 — AK Parameters Reference

The Audio Kernel (AK) is `libdseffect.so`'s internal parameter system.
Every tunable knob in the engine is addressed by a 4-character ASCII
code (a "4-CC"), has a fixed value-array length, and a fixed
`[lowerBound, upperBound]` range expressed as `int16`.

This document is the canonical reference for all 64 AK parameters. The
authoritative source is `DsAkSettings.akParams_` in
`Ds.apk/android/dolby/ds/DsAkSettings.java`; this file is a paraphrased
version of that array with explanatory annotations.

## Conventions

* **4-CC**: 4-byte ASCII code, NUL-padded if shorter than 4 chars
  (e.g. `"iea"` is sent as `0x69 0x65 0x61 0x00`). All comparisons in
  the engine are case-sensitive on the lowercase form.
* **len**: number of `int16` values. `1` means a scalar; `20` means a
  20-element array (typically per-band); `40` means 40 elements
  (typically per-band per-channel for stereo); `329` is the special
  Audio Optimizer band-gains length.
* **bounds**: clamped at `DsAkSettings.set` time. Values outside the
  range are silently clamped, not rejected.
* **dB scaling**: most dB-valued parameters are stored as
  `int16 = round(dB × 16)`. So a +6 dB setting is stored as `+96`.
  This 1/16 dB resolution applies uniformly to gains, leveler targets,
  visualizer outputs, and more — see `DsProfileSettings.DB_SCALING_FACTOR`.
* **settable**: whether the parameter accepts writes via `setSingleSetting`
  / `setProfileSettings` / `setDsApParam`. Non-settable params are
  read-only or define-only. Source: `DsAkSettings.isParamSettable`.
* **basic**: whether the parameter is one of the 5 booleans digested
  into `DsClientSettings`. Setting a basic param fires
  `onProfileSettingsChanged`; setting a non-basic settable param fires
  `onDsApParamChange`.

## The full table — 64 parameters

The order below matches the order in `DsAkSettings.akParams_`, which is
the order they are sent to the engine in the `DEFINE_PARAMS` (command 5)
init blob. **Do not reorder this list arbitrarily** — the engine maps
parameters by their position in this list when receiving commands 1, 2,
or 3, not by 4-CC. (See [03-binary-protocol.md](03-binary-protocol.md).)

### Build / version (read-only)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 0 | `bver` | 5 | int16 range | no | Build version (5 int16s, opaque) |
| 1 | `bndl` | 2 | int16 range | no | Bundle id (2 int16s) |
| 37 | `ver`  | 4 | int16 range | no | Engine version returned by command 6. Format: `APPv1 version A.B.C.D`. |

### Output configuration

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 2 | `ocf`  | 1 | 0..5 | no | Output channel format. Determines the post-`rqmf` channel layout. The XML never sets this; the engine uses its default. |
| 3 | `preg` | 1 | -2080..480 | no | Pre-gain in 1/16 dB. Range -130 dB to +30 dB. Applied before the processing chain. |
| 38 | `pstg` | 1 | -2080..480 | no | Post-gain in 1/16 dB. Same range as `preg`. Applied after the processing chain. |

> Note: `preg` and `pstg` are *not* in the settable list, so they
> cannot be changed via the public AK API. They are read off the engine's
> internal defaults. DolbyX's CLI-provided pre/post gain in
> `ddp_processor.c` is applied *outside* the engine on host-side
> floats, which is independent of these AK parameters.

### Headphone virtualizer (Dolby Headphone)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 4 | `vdhe` | 1 | 0..2 | yes (basic) | Headphone virtualizer enable. **0 = off, 1 = on, 2 = auto** (engine engages when output endpoint is `HEADPHONES`). The original UI uses `2` when "on", not `1` — see DsProfileSettings.updateFromClientSettings. |
| 39 | `dhsb` | 1 | 0..96 | yes | Headphone surround boost in 1/16 dB (0 to +6 dB). Boosts the virtual surround channels. |
| 40 | `dhrg` | 1 | -2080..96 | yes | Headphone reverb gain in 1/16 dB. Negative = no reverb tail; positive = simulated room reverb. |

### Speaker virtualizer (Dolby Virtual Speaker)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 5 | `vspe` | 1 | 0..2 | yes (basic) | Speaker virtualizer enable. **0 = off, 1 = on, 2 = auto** (engages when output is `SPEAKER`). Same auto-mode-as-on convention as `vdhe`. |
| 41 | `dssb` | 1 | 0..96 | yes | Speaker surround boost in 1/16 dB. |
| 42 | `dssa` | 1 | 5..30 | yes | Speaker angle in degrees (5° to 30°). Physical angle of the user's stereo speakers used for crossfeed calculation. Settable but not basic. |
| 6 | `dssf` | 1 | 20..20000 | yes | Speaker virtualization start frequency in Hz. Below this, the virtualizer does nothing. |

### Volume leveler (Dolby Volume)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 7 | `dvli` | 1 | -640..0 | yes | Volume leveler input target in 1/16 dB LKFS. Default -320 = -20 LKFS. The reference loudness the leveler is told to expect on input. |
| 8 | `dvlo` | 1 | -640..0 | yes | Volume leveler output target in 1/16 dB LKFS. Default -320. The target loudness the leveler tries to maintain. |
| 9 | `dvle` | 1 | 0..1 | yes (basic) | Volume leveler enable. 0/1 only. |
| 10 | `dvmc` | 1 | -320..320 | yes | Volume modeler calibration in 1/16 dB. Compensates for the playback-system reference level offset. |
| 11 | `dvme` | 1 | 0..1 | yes | Volume modeler enable. When on, the leveler accounts for Fletcher-Munson equal-loudness contours. Settable but not basic. |
| 43 | `dvla` | 1 | 0..10 | yes | Volume leveler amount, integer 0–10. Higher = more aggressive compression. |

### Intelligent EQ (IEQ)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 12 | `ienb` | 1 | 1..40 | yes (constant) | IEQ band count. **Must be sent before DEFINE_SETTINGS** — see [03-binary-protocol.md](03-binary-protocol.md#the-mandatory-init-handshake). The engine fixes this to 20 in the standard config. |
| 13 | `iebf` | 20 | 20..20000 | yes | IEQ band centre frequencies in Hz. The engine uses these to design the per-band detector / shaper filters. |
| 14 | `ieon` | 1 | 0..1 | yes | IEQ enable. 0/1. Settable but not in the 5-bit basic digest. |
| 44 | `iebt` | 20 | -480..480 | **no** | IEQ band targets in 1/16 dB. -30 to +30 dB. The "rich/open/focused" preset curve. **Cannot be set via `setDsApParam`** (see `Ds.setDsApParam`); only via `setIeqPreset` which reloads from the stored preset table. |
| 45 | `iea`  | 1 | 0..16 | yes | IEQ amount, integer 0–16. Higher = stronger pull toward the target curve. The original profiles all use `10`. |

### Graphic EQ (GEQ)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 17 | `geon` | 1 | 0..1 | yes (basic) | GEQ enable. 0/1. |
| 18 | `genb` | 1 | 1..40 | yes (constant) | GEQ band count. Must be sent before DEFINE_SETTINGS. Standard = 20. |
| 19 | `gebf` | 20 | 20..20000 | yes (constant) | GEQ band centre frequencies in Hz. Default `[43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550, 2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777]`. Must be sent before DEFINE_SETTINGS so the engine can size the gain array. |
| 48 | `gebg` | 20 | -576..576 | **special** | GEQ band gains in 1/16 dB. -36 to +36 dB. **Cannot be set via `setDsApParam`** — explicitly rejected in `Ds.setDsApParam`. Must be set via the dedicated `setGeq(profile, preset, float[])` API which keeps the per-(profile, preset) backing store in sync. |

### Audio Regulator (multi-band compressor / limiter)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 24 | `arnb` | 1 | 1..40 | yes | Audio Regulator band count. Constrained to equal `aonb`. |
| 25 | `arbf` | 40 | 20..20000 | yes | Audio Regulator band centre frequencies. |
| 50 | `arbi` | 40 | 0..1 | yes | Audio Regulator band isolate flags. Per-band: 1 = independent compression, 0 = group with neighbours. |
| 51 | `arbl` | 40 | -2080..0 | yes | Audio Regulator low thresholds in 1/16 dB. Below these, the band is left alone. |
| 52 | `arbh` | 40 | -2080..0 | yes | Audio Regulator high thresholds in 1/16 dB. Above these, the band is compressed harder. |
| 53 | `arod` | 1 | 0..192 | yes | Audio Regulator overdrive in 1/16 dB. Drives input harder into the regulator. |
| 54 | `artp` | 1 | 0..16 | yes | Audio Regulator timbre preservation, integer. Higher = more spectral-shape preservation during limiting. |

### Peak limiter

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 26 | `plb`  | 1 | 0..288 | yes | Peak limiter boost in 1/16 dB. Pre-limit gain. |
| 27 | `plmd` | 1 | 0..4 | yes | Peak limiter mode. **1 = disable everything, 2 = regulated-peak, 3 = regulated-distortion, 4 = auto.** Mode 0 unused. The original profiles all set this to `4`. |

### Audio Optimizer (per-device EQ)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 20 | `aonb` | 1 | 1..40 | yes (constant) | Audio Optimizer band count. Must equal `arnb`. |
| 21 | `aobf` | 40 | 20..20000 | yes | Audio Optimizer band centre frequencies. |
| 22 | `aobg` | 329 | -480..480 | yes | Audio Optimizer band gains in 1/16 dB. The 329 entries are `(aonb + 1) × 2` rounded up — pairs of `[gain_L, gain_R]` per band plus a header. |
| 23 | `aoon` | 1 | 0..2 | yes | Audio Optimizer enable. **0 = off, 1 = on (all endpoints), 2 = auto (only when output is SPEAKER).** |
| 49 | `aocc` | 1 | 0..8 | yes (constant) | Audio Optimizer constant clamp. Hard-coded to 2 in the standard config. |

### Volume maximizer

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 58 | `vmon` | 1 | 0..2 | yes | Volume maximizer enable. 0 = off, 1 = on, 2 = auto. |
| 59 | `vmb`  | 1 | 0..240 | yes | Volume maximizer boost in 1/16 dB. Range 0 to +15 dB. The original profiles all use `144` (= +9.0 dB). |

### Dialog Enhancer

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 15 | `deon` | 1 | 0..1 | yes (basic) | Dialog Enhancer enable. |
| 46 | `dea`  | 1 | 0..16 | yes | Dialog Enhancer amount. Higher = stronger vocal boost. |
| 47 | `ded`  | 1 | 0..16 | yes | Dialog Enhancer ducking amount. How much to suck non-dialog content while dialog is active. |

### Next Gen Surround (upmixer)

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 16 | `ngon` | 1 | 0..2 | yes | Next Gen Surround enable. 0 = off, 1 = on, 2 = auto (on when input is stereo, off when input is already 5.1+). |

### Visualizer compensation bands (the visible visualizer data)

These are the parameters that the visualizer reads. The engine *fills*
`vcbg` and `vcbe` with the current state of the EQ curve and the
spectral excitations every block. The values cannot be written; the
read happens via command 4 (`DS_PARAM_VISUALIZER_DATA`) which returns
both arrays concatenated as 40 int16s.

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 33 | `vcnb` | 1 | 1..40 | no | Visualizer band count (= 20 in standard config). |
| 34 | `vcbf` | 20 | 20..20000 | no | Visualizer band centre frequencies in Hz. |
| 35 | `vcbg` | 20 | -192..576 | no | Visualizer band **gains** in 1/16 dB (-12 to +36 dB). The current EQ curve. UI divides by 16 to get float dB. |
| 36 | `vcbe` | 20 | -192..576 | no | Visualizer band **excitations** in 1/16 dB. The current per-band audio energy. UI divides by 16. |

The bound `[-192, +576]` is what the engine actually outputs. The UI
maps `[-192, +576]` ÷ 16 = `[-12, +36]` dB onto a 48-row vertical pixel
grid (1 dB per row). See [04-ui-data-flow.md](04-ui-data-flow.md#visualizer-rendering).

### Visualizer "native" bands (separate set, used internally)

These look identical in shape to the `vc*` family and exist alongside
them. They are not used by the standard UI and exist for the engine's
own internal monitoring. None of them are read by `DsClient`.

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 28 | `ven`  | 1 | 0..1 | no | Visualizer enable as an AK parameter (parallel to command 7). |
| 29 | `vnnb` | 1 | 1..20 | no | Visualizer-native band count. |
| 30 | `vnbf` | 20 | int16 | no | Visualizer-native band frequencies. |
| 31 | `vnbg` | 20 | int16 | no | Visualizer-native band gains. |
| 32 | `vnbe` | 20 | int16 | no | Visualizer-native band excitations. |

### Endpoint / volume

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 55 | `endp` | 1 | 0..6 | no | Output endpoint enum. **0 = SPEAKER, 1 = HEADPHONES, 2 = HDMI, 3 = SPDIF, 4 = DLNA, 5 = LINE_OUT, 6 = BLUETOOTH.** Read-only at the AK level — the service is supposed to set this via the `setOutputDevice` HAL flow, not by `setDsApParam`. |
| 56 | `mxou` | 1 | 1..8 | no | Maximum output channels (mono..7.1). |
| 57 | `vol`  | 1 | -2048..480 | no | System volume hint in 1/16 dB. The leveler uses this to know how loud the user is currently playing back. |

### Licensing

These exist to gate features behind an SKU. In the v8.1 build all features
are enabled (`<authorized_technologies>` in `ds1-default.xml`).

| # | 4-CC | len | bounds | settable | Description |
|--:|------|----:|--------|---------|-------------|
| 60 | `lcmf` | 2 | int16 | no | License modifier (2 int16s, opaque). |
| 61 | `lcvd` | 2 | int16 | no | License vendor (2 int16s, opaque). |
| 62 | `lcsz` | 1 | 1..32767 | no | License size. |
| 63 | `lcpt` | 168 | -128..127 | no | License payload (168 bytes of signed payload). |

## Per-parameter scaling cheat-sheet

When the UI/daemon shows or accepts a value, this is how it is converted
to/from the int16 wire format:

| Quantity | UI side | Wire side | Example |
|----------|---------|-----------|---------|
| dB-valued gain (most params) | `float dB` | `int16 round(dB × 16)` | -6 dB ↔ -96; +6 dB ↔ +96 |
| GEQ band gain | `float dB ∈ [-36, +36]` | `int16 ∈ [-576, +576]` | UI clamps `DsConstants.GEQ_BAND_GAIN_RANGE` then `* 16` |
| Visualizer gain / excitation | `float dB ∈ [-12, +36]` | `int16 ∈ [-192, +576]` | UI divides by 16 |
| Frequency | `int Hz` | `int16 Hz` | direct |
| Enable flag (basic) | `bool` | `0` or `1` | direct |
| Enable flag (auto-capable: vdhe, vspe, ngon, aoon, vmon) | `bool true` | **`2`** | UI sends `2` for "on" so engine treats it as auto-mode |
| Amount (iea, dea, ded, dvla, artp) | `int 0..16` (or 0..10 for `dvla`) | direct | direct |
| Peak limiter mode | `int 1..4` | direct | `4` is the default ("auto") |
| LKFS target | `float LKFS ∈ [-40, 0]` | `int16 ∈ [-640, 0]` | `* 16` |

## Default values from `ds1-default.xml`

The following table shows the defaults for the Music profile (the
"showcase" profile that the user notes sounds the best). Values are
verbatim from `ds1-default.xml`. Compare with [05-profiles-and-persistence.md](05-profiles-and-persistence.md#the-default-profiles-factory)
for all six profiles.

```
aoon  = 2          # Audio Optimizer auto
dea   = 2          # Dialog Enhancer amount = 2
ded   = 0          # No ducking
deon  = 1          # Dialog Enhancer ON
dhrg  = 0          # No reverb tail
dhsb  = 48         # Headphone surround boost = +3.0 dB
dssb  = 0          # No speaker surround boost
dssf  = 200        # Speaker virtualization above 200 Hz
dvla  = 4          # Volume Leveler amount = 4 (moderate)
dvle  = 0          # Volume Leveler OFF (the user toggles it)
dvme  = 0          # Volume Modeler OFF
gebg  = [0]*20     # No GEQ override
geon  = 0          # GEQ OFF (user enables by editing)
iea   = 10         # Intelligent EQ amount = 10 (max)
ieon  = 0          # IEQ OFF in the on-disk default; the UI
                   # turns it ON when the user picks an IEQ preset
ngon  = 2          # Next Gen Surround auto
plb   = 0          # No pre-limit boost
plmd  = 4          # Peak limiter mode = auto
vdhe  = 2          # Headphone virtualizer auto
vmb   = 144        # Volume maximizer boost = +9.0 dB
vmon  = 0          # Volume maximizer OFF
vspe  = 0          # Speaker virtualizer OFF
                   # (then <include preset="ieq_rich"/>)
```

## Constant parameters — the init dance

Five parameters are special: their **values** are part of the engine's
size-determining "schema":

* `genb` — the GEQ band count. Must be sent before `DEFINE_SETTINGS`
  so the engine knows how many slots to allocate for `gebg`, `vcbf`,
  `vcbg`, `vcbe`.
* `ienb` — the IEQ band count. Same role for `iebf`, `iebt`.
* `aonb` — the Audio Optimizer band count. Same role for `aobf`,
  `aobg`, `arbf`, `arbi`, `arbl`, `arbh`.
* `gebf` — the GEQ band centre frequencies. The engine uses these to
  derive its filterbank response. Sent before `DEFINE_SETTINGS`.

(`aocc` is also tagged constant in the source but its only valid value
is 2, so it is set by `<constant>` in the XML and never changes.)

If you skip the constant-params step, **the engine will accept commands
1, 2, and 3 but silently produce no output for the dependent
parameters.** This is one of the most common debugging traps; see the
detailed sequence in
[03-binary-protocol.md](03-binary-protocol.md#the-mandatory-init-handshake).

## Per-parameter visualization dimensions

For UI widgets, here are the natural ranges to expose. These are
pre-clamp; the engine will silently clamp anything outside them:

| Parameter group | UI control | Range to expose |
|-----------------|-----------|-----------------|
| `vdhe`, `vspe`, `ngon`, `aoon`, `vmon` | Tri-state toggle | Off / On / Auto |
| `dvle`, `dvme`, `ieon`, `deon`, `geon`, `ven` | Toggle | Off / On |
| `iea`, `dea`, `ded`, `artp` | Slider (int) | 0–16 |
| `dvla` | Slider (int) | 0–10 |
| `plmd` | Radio | 1 (off) / 2 (regulated-peak) / 3 (regulated-distortion) / 4 (auto) |
| `dhsb`, `dssb` | Slider (dB) | 0 to +6 dB (×16 → 0..96) |
| `dssa` | Slider (deg) | 5° to 30° |
| `dssf` | Slider (Hz) | 20–20000 (logarithmic) |
| `vmb` | Slider (dB) | 0 to +15 dB (×16 → 0..240) |
| `plb` | Slider (dB) | 0 to +18 dB (×16 → 0..288) |
| `dhrg` | Slider (dB) | -130 to +6 dB (×16 → -2080..96) |
| `dvli`, `dvlo` | Slider (LKFS) | -40 to 0 LKFS (×16 → -640..0) |
| `dvmc` | Slider (dB) | -20 to +20 dB (×16 → -320..320) |
| `arod` | Slider (dB) | 0 to +12 dB (×16 → 0..192) |
| `arbl[i]`, `arbh[i]` | 20 sliders each | -130 to 0 dB (×16 → -2080..0) |
| `aobg[i]` | 40 paired sliders L/R | -30 to +30 dB (×16 → -480..480) |
| `aobf[i]`, `arbf[i]`, `gebf[i]`, `iebf[i]` | Read-only labels | The band centre frequencies |

For the planned Advanced section in DolbyX, the rule of thumb is: any
parameter with `settable = yes` in the table above should be exposable;
any parameter with `settable = no` should be read-only diagnostic info
(except `vcbg` and `vcbe`, which are the visualizer's purpose, and
`endp`, which the platform owns).
