# DolbyX v2 — Rearchitecture Plan

This document is the canonical plan for the next-generation DolbyX, designed
in light of the comprehensive DDP reverse engineering captured under
[docs/ddp/](ddp/README.md). It supersedes [docs/CROSS_PLATFORM_PLAN.md](CROSS_PLATFORM_PLAN.md)
once implementation begins.

## Why a rearchitecture

The current DolbyX codebase was built incrementally and proved the concept:
the Android DDP engine can be driven from a desktop host. With a complete
understanding of how the original DDP module works internally, we can now
build a cleaner foundation that:

- Faithfully reproduces the original DDP's defaults, behaviour, look, and feel.
- Cleanly extends DDP's capabilities — custom profiles, custom IEQ presets,
  and every `libdseffect.so` parameter exposed via an Advanced section.
- Is easier to develop and maintain — a single source of truth for parameters,
  no positional indices to break under refactoring, no shared-state foot-guns.
- Is genuinely cross-platform — Windows and Linux as first-class targets from
  day one; macOS deferred to a later milestone.
- Is efficient and low-latency — a single engine subprocess shared across all
  audio streams, with the architecture pre-shaped for in-process ARM emulation
  (Unicorn, static binary translation) when that work lands.
- Has top-notch code quality — strict typing, mandatory documentation, CI
  enforcement, comprehensive testing.

## Goals and non-goals

**Goals:**

1. Windows and Linux from day one. macOS deferred.
2. Faithful default behaviour: out of the box, DolbyX sounds like the
   original DDP module on Music profile with power on.
3. Same persistence semantics as the original: per-profile parameter
   overrides, per-profile GEQ, master state, all survive restarts.
4. Custom profiles can be added, edited, renamed, and removed.
5. Custom IEQ presets can be added, edited, renamed, and removed. IEQ
   presets are global — a change to a preset reflects across every profile
   that has it currently selected.
6. Every one of `libdseffect.so`'s 64 AK parameters is exposed in the
   Advanced UI section, driven by metadata — including non-settable
   ones (for live monitoring) and engine-internal ones (DolbyX is also
   a research vehicle for `libdseffect.so`).
7. Backend-agnostic engine layer: the QEMU subprocess approach is the
   default for v2.0; Unicorn Engine and Static Binary Translation slot in
   as alternative backends without touching the rest of the code.
8. Single-process daemon hosting: HTTP/WebSocket server, audio plugin IPC,
   and engine all in one binary.
9. Rust for the daemon, Solid.js with TypeScript for the Web UI.
10. Top-notch code quality: strict linting, mandatory doc comments,
    unit + integration tests, CI gates.

**Non-goals (this phase):**

- macOS support — its own milestone, after Phase 5.
- Replacing QEMU as the ARM emulation backend — kept as a swap-in for a
  later phase.
- Code signing and notarization.
- Per-audio-stream profile overrides — all streams share the active
  profile by default; advanced per-stream routing is a later affordance.
- Plugin SDK for third-party DSP — DolbyX is specifically about DDP.
- GPU/SIMD acceleration. The DSP is CPU-bound inside `libdseffect.so`;
  the daemon's job is plumbing, not signal processing.

## Architecture in one picture

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Web UI (Solid-powered Vite-built SPA, separate dev workflow)             │
│  - Auto-generated Advanced section from injected bootstrap                │
│  - int16 1/16-dB on the wire; UI converts ↔ dB for display only           │
│  - Auto-reconnecting WebSocket                                            │
└────────────────────────┬──────────────────────────────────────────────────┘
                         │ JSON over WebSocket
                         │ HTTP for / (index.html with injected bootstrap)
                         │
┌────────────────────────▼──────────────────────────────────────────────────┐
│  dolbyx-daemon  (Rust, single process)                                    │
│  ┌───────────────────────────────────┐                                    │
│  │ HTTP server (axum/hyper)          │   serves / + /ws — no /api routes  │
│  │  + WebSocket handler              │   / templated with bootstrap HTML  │
│  └────────────────┬──────────────────┘                                    │
│  ┌────────────────▼──────────────────┐                                    │
│  │ State (Arc<RwLock<…>>):           │                                    │
│  │  - profiles: Vec<Profile>         │                                    │
│  │  - eq_presets: Vec<EqPreset>      │   (decoupled from profiles)        │
│  │  - selected_profile, power        │                                    │
│  │  - param_metadata (single SoT)    │                                    │
│  └────────────────┬──────────────────┘                                    │
│  ┌────────────────▼──────────────────┐    ┌────────────────────────────┐  │
│  │ Engine (trait Engine + impl):     │    │ Audio plugin server        │  │
│  │  - sessions: HashMap<u32, Handle> │    │  Win: \\.\pipe\DolbyX      │  │
│  │  - visualizer pump (50 ms)        │    │  Unix: /tmp/dolbyx.sock    │  │
│  └────────────────┬──────────────────┘    └────────────┬───────────────┘  │
│                   │                                    │                  │
│                   │ now:  QEMU subprocess              │                  │
│                   │ future: Unicorn/SBT (in-process)   │                  │
│                   │                                    │                  │
│  ┌────────────────▼─────────────────┐                  │                  │
│  │ dolbyx-engine-arm subprocess     │                  │                  │
│  │  (one shared process, all        │                  │                  │
│  │   sessions multiplexed)          │                  │                  │
│  │  qemu-arm-static                 │                  │                  │
│  │   + libdseffect.so               │                  │                  │
│  │   + Android stubs                │                  │                  │
│  └──────────────────────────────────┘                  │                  │
└────────────────────────────────────────────────────────┼──────────────────┘
                                                         │
           ┌────────────────────────┬────────────────────┴───────┐
           │                        │                            │
  ┌────────▼────────┐    ┌──────────▼─────────┐    ┌─────────────▼────────────┐
  │ Windows: VST2   │    │ Linux: LV2         │    │ macOS: AudioServerPlugin │
  │ DolbyX.dll      │    │ libdolbyx.lv2      │    │ DolbyX.driver            │
  │ thin shim       │    │ thin shim          │    │ thin shim                │
  │ via named pipe  │    │ via AF_UNIX        │    │ via AF_UNIX              │
  └─────────────────┘    └────────────────────┘    └──────────────────────────┘
```

## Key design decisions

### Decision 1 — Backend-agnostic engine, QEMU subprocess as v2.0 default

The daemon talks to the engine through a `trait Engine` (Rust):

```rust
pub trait Engine: Send + Sync {
    fn create_session(&self, sample_rate: u32) -> Result<SessionId>;
    fn destroy_session(&self, id: SessionId) -> Result<()>;
    fn set_enabled(&self, id: SessionId, enabled: bool) -> Result<()>;
    fn set_param(&self, id: SessionId, name: &str, values: &[i16]) -> Result<()>;
    fn get_visualizer_data(&self, id: SessionId) -> Result<VisualizerData>;
    fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<()>;
    fn version(&self) -> Result<String>;
}

pub struct VisualizerData {
    pub gains: [i16; 20],        // vcbg
    pub excitations: [i16; 20],  // vcbe
}
```

There is intentionally no generic `get_param` — the underlying engine
(libdseffect.so) does not implement cmd 3 GET, so a per-param read
path would have to be synthesized from the daemon's own state mirror
anyway. Reads of the daemon-cached state are exposed through the
WebSocket state snapshot, not through the Engine trait. The trait's
two read methods are `get_visualizer_data` (mapped to engine cmd 4)
and `version` (mapped to engine cmd 6) — the only two read paths the
engine actually offers.

The `i16` values throughout this trait are the engine's native 1/16-dB
units. The trait is the canonical boundary where this format stays
consistent end-to-end: persistence, state, wire protocol, and engine
all carry i16s. Only the Web UI converts i16 ↔ float dB at display
and input time.

Three impls are anticipated, but only one ships in v2.0:

| Backend               | Status           | Where it works                 | Notes                                                                                                                                                                                     |
| --------------------- | ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QemuBackend`         | **v2.0 default** | Linux native; Windows via WSL2 | One shared `qemu-arm-static` subprocess that holds `libdseffect.so` and multiplexes all sessions. Communicates with the daemon over stdin/stdout using a length-prefixed binary protocol. |
| `UnicornBackend`      | Future (Phase 6) | Native on all platforms        | Custom ELF loader + Android stub library + Unicorn JIT, all inside the daemon process. Eliminates WSL on Windows. Identical Engine trait surface.                                         |
| `StaticBinaryBackend` | Speculative      | Native on all platforms        | ARM → x86_64 binary translation at build time. Native speed, large engineering effort.                                                                                                    |

The trait surface is intentionally narrow so any backend can implement it.
For v2.0 the QEMU subprocess approach is kept, but the **engine subprocess
is shared across all audio streams** — only one `qemu-arm-static` process
runs, holding one loaded `libdseffect.so`, and managing N effect handles
internally. This eliminates per-stream subprocess startup latency and
per-stream memory duplication compared to the current code.

When the Unicorn or static-binary backend lands, the daemon configuration
swaps the trait impl and nothing else changes.

### Decision 2 — IEQ presets are global, decoupled from profiles, generalized as EQ presets

A clean simplification over the original DDP model.

**Original DDP**: each profile carried its own copy of every IEQ preset's
backing GEQ curve. The matrix was `profiles × presets × bands` = 6 × 4 × 20.
Adding a preset to one profile didn't add it to others.

**DolbyX v2**: IEQ preset terminology changed to EQ preset. EQ presets are
top-level objects like profiles. Each preset holds an `iebt[20]` curve and a
`gebg[20]` curve. A profile stores only the **id of its currently selected
EQ preset**, not its own copy of `iebt[20]` or `gebg[20]` values.

```rust
struct State {
    power: bool,
    selected_profile: ProfileId,
    profiles: Vec<Profile>,               // factory + custom
    eq_presets: Vec<EqPreset>,            // factory + custom, applies to all profiles
}

struct Profile {
    id: ProfileId,                        // stable string id, e.g. "music", "user_a3f1"
    name: String,                         // display name, user-editable
    selected_eq_preset: PresetId,         // points into State.eq_presets
    params: HashMap<String, Vec<i16>>,    // AK param overrides keyed by 4-CC
}

struct EqPreset {
    id: PresetId,                         // e.g. "off", "rich", "user_91c2"
    name: String,                         // display name, user-editable
    is_ieq_on: bool,                      // ieon
    ieq_band_targets: [i16; 20],          // iebt
    is_geq_on: bool,                      // geon
    geq_band_gains: [i16; 20],            // gebg
}
```

`is_factory` is not a stored field; it's derived at load time by
checking whether the id exists in `defaults.toml`. Factory items can
be reset (overrides cleared) but not deleted or renamed.

User-visible consequences:

- Editing the "Rich" preset (e.g. tweaking the `gebg` or `iebt` curve) takes
  effect immediately for every profile that currently has Rich selected.
- Adding a new IEQ preset makes it available across every profile.
- Removing an IEQ preset: any profile that had it selected falls back to
  the "Off" preset.
- GEQ edits are owned by the current IEQ preset, and can be used across profiles.
  (This is a deliberate simplification from the original, where GEQ was
  per-(profile, preset).)

Factory EQ presets are `Off`, `Open`, `Rich`, `Focused`. `Off` has no
`iebt`/`gebg` curve — selecting it disables the IEQ engine. Factory
profiles are `Movie`, `Music`, `Game`, `Voice`. Factory items cannot
be deleted; they can be reset to their bundled defaults.

Note:
Original DDP only allowed `gebg` curves to be edited through the
Visualizer/Equalizer UI, and `iebt` curves could not be edited beyond their
factory values. DolbyX will keep this behavior for now. In the future,
DolbyX will support editing the `iebt` curve as well (through the same
Visualizer/Equalizer, behind a toggle).

### Decision 3 — Parameter metadata as the single source of truth

All 64 AK parameters are declared once in a static metadata table.
Everything else — wire protocol, engine init, persistence, UI
generation, range validation — derives from this table.

```rust
pub struct ParameterDef {
    pub name: &'static str,             // 4-CC: "dvla", "iebt", …
    pub length: ParamLength,            // fixed or aonb-derived
    pub range: (i16, i16),              // inclusive engine-unit bounds
    pub default: ParamDefault,          // scalar or per-band array
    pub kind: ParamKind,                // drives UI widget choice
    pub category: ParamCategory,        // for UI grouping
    pub access: ParamAccess,            // Settable / ReadOnlyDynamic / ReadOnlyStatic / Experimental
    pub label: &'static str,            // human-readable display name
    pub help: &'static str,             // tooltip text
    pub basic: bool,                    // member of the 5-bool digest
}

pub enum ParamLength {
    Fixed(usize),               // 1 for scalars, 20 for per-band, etc.
    AobgChannelMajor { max: usize }, // (aonb + 1) × aocc at runtime, max 329
}

pub enum ParamDefault {
    Scalar(i16),
    PerBand([i16; 20]),
    Aobg(Vec<i16>),             // channel-id-prefixed runtime size
}

pub enum ParamKind {
    Toggle,                     // 0/1
    Tristate { on: i16 },       // 0/1/2, where "on" = 1 or 2
    Integer { max: u16 },
    Decibel { lkfs: bool, divisor: u16 }, // divisor = 16 typically
    FrequencyHz,
    Degrees,
    PerBand,
    AobgChannelMajor,           // for aobg (channel-id-prefixed)
    Opaque,                     // license blobs etc — render as int[]
}

pub enum ParamAccess {
    Settable,                   // engine reads slot → write takes effect (42 Java-whitelisted)
    ReadOnlyDynamic,            // DSP overwrites slot every audio block (vcbg, vcbe, vnb*)
    ReadOnlyStatic,             // engine pre-populates at init, never re-reads (bver, ver, license)
    Experimental,               // engine reads slot but original DDP UI hid it
}

pub enum ParamCategory {
    Basic, Ieq, Geq,
    VolumeLeveller, DialogEnhancer,
    HeadphoneVirtualizer, SpeakerVirtualizer, NextGenSurround,
    AudioRegulator, AudioOptimizer, VolumeMaximizer, PeakLimiter,
    Visualizer, EndpointVolume, BuildVersion, License,
}
```

**Decibel kind.** `Decibel { lkfs, divisor }` keeps `divisor` as
metadata so the UI never hardcodes the 1/16 conversion factor —
each widget reads `def.divisor` from the injected bootstrap metadata and divides.
Every dB-coded AK param uses `divisor = 16` today (the binary
documents "scaled by 16 ie. 16 = 1 dB"); the metadata table stays
the canonical source. `lkfs: bool` switches the unit label from
`dB` to `LKFS` for `dvli`/`dvlo`.

**Four-bucket settability classification.** This is a deliberate
deviation from `docs/ddp/02-ak-parameters.md`'s "settable=yes/no"
binary. Empirically, the engine accepts cmd 3 SET against any
declared param and forwards the write to `ak_set` regardless of
Java's `isParamSettable` whitelist (direct evidence in
[tools/ddp_probe/](../tools/ddp_probe/README.md) section 5b). The
four buckets are about **DSP semantics + UI presentation**, not
engine-level acceptance:

- **Settable** — every param in Java's `isParamSettable` whitelist
  (42 params). DSP reads the value and produces well-defined
  bounded behaviour. Editable widgets in the Advanced panel.
- **ReadOnly-Dynamic** — `vcbg`, `vcbe` (directly observed via
  cmd 4 — the DSP refreshes both slots every audio block);
  `vnnb`, `vnbf`, `vnbg`, `vnbe` (Dynamic classification inferred
  from naming symmetry with the `vcb*` family — there's no host
  read path so we can't verify the refresh rate directly).
  Any host write is clobbered on the next block for the directly
  observed pair; the `vnb*` family follows by inference. Read via
  cmd 4 only (cmd 4 returns `vcbg ‖ vcbe` as 40 int16s; the
  `vnb*` family is engine-internal and unreadable from outside).
  Live-updated read-only displays in the UI ride the visualizer
  pump (see Decision 4 and Decision 10).
- **ReadOnly-Static** — `bver`, `bndl`, `ver`, `lcmf`, `lcvd`,
  `lcsz`, `lcpt`. The engine pre-populates these cache slots from
  its internal AK registry at DEFINE_SETTINGS time (engine log
  `ak_get(0/bver, 0..4)`, etc.) and never reads them again at
  runtime. The bundle/build constants (`bver`/`bndl`/`ver`) and the
  license blob (`lcmf`/`lcsz`/`lcpt`) and auth result (`lcvd`) are
  stable for the lifetime of the engine instance. Only `ver` is
  reachable from outside, via cmd 6. Ship the rest once in the
  state snapshot if at all.
- **Experimental** — not exposed by original DDP, but the engine
  treats the slot as a real DSP input: `preg`, `pstg`, `endp`,
  `mxou`, `ocf`, `ven`, `vol`, `vcnb`, `vcbf`. Editable behind an
  "experimental" badge. Behavioral confirmation that the DSP reads
  raw int16 from the cache regardless of declared range is in
  [tools/ddp_probe/](../tools/ddp_probe/README.md) section 7: a
  `vmb` sweep over `{0, 120, 240, 480, -100}` produces peak/rms
  pairs `(1, 0.6)`, `(1, 0.7)`, `(16, 8)`, `(128, 90)`, `(21, 8.5)`
  — `vmb=480` amplifies ~10× past the declared `vmb=240` clamp
  point and `vmb=-100` attenuates instead of acting like 0. A
  `dvla` sweep over `{0, 5, 10, 200, -100}` confirms the leveler
  also varies, though its envelope-driven dynamics make the
  per-block measurement noisier than `vmb`. The same
  forwarding path applies to every Experimental param — cmd 3 SET
  fires `ak_set(idx/name, offset) = V` regardless of bucket
  (section 5b), so a host that drives `endp`, `mxou`, etc. gets
  the same DSP-input semantics. (`vol` is a host volume hint the leveler reads;
  `vcnb`/`vcbf` configure custom-visualizer mode when `ven` is
  `ON`. The libdseffect.so `preg` description string says "this
  parameter should be set to reflect how much gain has been
  applied".)

**`aobg` layout.** The static `329` declared in
`DsAkSettings.akParams_[22]` is the engine's **worst-case max** =
`aocc_max (8) × (aonb_max (40) + 1 channel-id) + 1 sentinel`. The
runtime length is rewritten by `setConstantAkParam("aonb", …)` to
`(aonb + 1) × aocc` (= 42 for the standard 20-band stereo config).
The layout is **channel-id-prefixed** (per the libdseffect.so
description string), not header + interleaved pairs:

```
[AK_CHAN_L, L_gain_0..L_gain_(aonb-1),
 AK_CHAN_R, R_gain_0..R_gain_(aonb-1),
 …,                                       // up to aocc channels
 AK_CHAN_EMPTY?]                          // optional terminator
```

`iebt` stays in the Settable bucket. Java's whitelist already includes
it; only the higher-level `Ds.setDsApParam` rejects user writes to
preserve the IEQ-preset abstraction. The engine accepts iebt writes
via `setSingleSetting`, and DolbyX plans to support direct editing
behind a toggle (see Decision 2).

Wire and storage are name-based (4-CC string). Saved configs are
stable under reordering the table. Adding a new parameter to the
Advanced section is a one-line edit: append to the table; the UI
auto-discovers it on next page load (the daemon re-serializes the
metadata into `window.__BOOTSTRAP__` on every `GET /`).

**Advanced-panel layout.** A CSS Grid with
`grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))` and
`gap: var(--space-3)`. Each parameter renders as a compact card: the
4-CC code, the human label, the current value(s), and either an input
(Settable / Experimental) or a read-only display (ReadOnly).
Experimental cards get a small "experimental" badge. Long arrays
(`aobg` ≤ 329, `lcpt` 168, `arbi`/`arbl`/`arbh`/`aobf`/`arbf` 40)
render in a wide card with `grid-column: 1 / -1`, collapsed behind a
toggle by default. Tiny scalars pack densely; bulky arrays stay out
of the way. Category headers introduce visual groupings.

### Decision 4 — Wire protocol: name-based, originator-aware

**Wire format.** The state snapshot, all `set_param`/`get_param`
commands, and the binary engine protocol carry raw int16 1/16-dB
values end-to-end — no pre-conversion to dB. Only the UI does
the int16 ↔ float dB conversion at the display/input boundary. JSON
examples below show values exactly as they appear on the wire.

#### UI ↔ daemon (WebSocket, JSON on `localhost:9876/ws`)

All control flows through one WebSocket connection per UI tab. The daemon
sends a full state snapshot on connect; clients send commands and receive
state-change broadcasts.

**Originator-aware broadcast**: the daemon assigns each WebSocket a serial id
at handshake, and broadcasts state changes to all clients _except_ the
originator — preventing echo loops in multi-tab/multi-client scenarios (see
[docs/ddp/04-ui-data-flow.md](ddp/04-ui-data-flow.md#originator-handle-echo-suppression)).
The visualizer pump broadcasts unconditionally to all clients.

Commands (client → daemon):

```jsonc
{ "cmd": "get_state" }
{ "cmd": "set_power", "on": true }
{ "cmd": "set_profile", "id": "music" }
{ "cmd": "set_param", "name": "dvla", "value": 4 }
{ "cmd": "set_param", "name": "iebt", "values": [67, 95, ...] }
{ "cmd": "set_param", "name": "gebg", "values": [24, -8, ...] }
{ "cmd": "set_eq_preset", "id": "rich" }

{ "cmd": "add_profile", "from": "music", "name": "My Music" }
{ "cmd": "rename_profile", "id": "user_a3f1", "name": "Late Night" }
{ "cmd": "remove_profile", "id": "user_a3f1" }
{ "cmd": "reset_profile", "id": "music" }

{ "cmd": "add_eq_preset", "from": "rich", "name": "Vocal Forward" }
{ "cmd": "rename_eq_preset", "id": "user_91c2", "name": "Vocal" }
{ "cmd": "edit_eq_preset", "id": "user_91c2", "gebg": [...] }
{ "cmd": "remove_eq_preset", "id": "user_91c2" }
{ "cmd": "reset_eq_preset", "id": "rich" }
```

Events (daemon → client):

```jsonc
{ "type": "state", "snapshot": { /* full state */ } }
{ "type": "vis", "gains": [...], "excitations": [...] }
{ "type": "vis_suspended", "suspended": true }
{ "type": "ack", "request_id": "...", "ok": true }
{ "type": "error", "request_id": "...", "code": "INVALID_PARAM", "message": "..." }
{ "type": "error", "request_id": "...", "code": "ENGINE_REJECTED", "status": -22, "message": "..." }
```

The full `state` snapshot is also sent on `get_state`, on connect, and any
time the daemon's internal state mutates from a non-WS source (e.g. config
file edit reload). At DolbyX's state scale (hundreds of bytes) full
snapshots are preferable to partial diffs. Static ReadOnly params (`bver`,
`bndl`, `ver`, `lcmf`, `lcvd`, `lcsz`, `lcpt`) are included in this
snapshot once and never re-broadcast — they don't change at runtime.

**Validation: two layers, asymmetric responsibilities.**

_Daemon-side_ (the only layer that does value validation): every
`set_param` is checked against the `ParameterDef` metadata — 4-CC
declared, length matches, value within `range`. Failures
short-circuit with
`{ "type": "error", "code": "INVALID_PARAM", "request_id": "...",
"message": "..." }` and the engine is never called.

_Engine-side_ (validates a very narrow set of things): the engine
checks only (a) `setting_index` range against the cache size, (b)
value-buffer-size mismatch, and (c) cmd-code recognition (and even
that is asymmetric — cmd 3 GET is always rejected because it isn't
implemented; see Decision 4 protocol table below). It returns
`-EINVAL(-22)` for any of these, surfaced as
`{ "type": "error", "code": "ENGINE_REJECTED", "request_id": "...",
"status": -22, "message": "..." }`. The engine does **NOT**
validate value ranges, does **NOT** clamp, does **NOT** reject
unknown 4-CCs in DEFINE_PARAMS, does **NOT** reject non-zero offsets
in DEFINE_SETTINGS — direct evidence from
[tools/ddp_probe/](../tools/ddp_probe/README.md) and engine string
table (relevant strings:
`_akSet: Wrong parameter index %d`,
`DS_PARAM_SINGLE_DEVICE_VALUE setting_index %i is invalid`,
`Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)`;
no range-check strings exist anywhere).

This is why the daemon must own range validation completely. An
out-of-range write doesn't get rejected — it propagates verbatim
into the DSP, which then produces undefined-shape output (probe
section 7: `vmb=-100` attenuates the signal to ~16% of baseline rms
instead of acting like `vmb=0`).

**Visualizer source.** The daemon always reads the `vis` event's data
from the **oldest session** (the first entry in the session list),
regardless of its suspended state. If that session has no audio
flowing, `vis_suspended: true` is broadcast. The source does not
switch when the oldest session goes silent — it only changes when
that session ends, at which point the next-oldest becomes the source.
This keeps the visualiser predictable and avoids flicker between
sources.

**Dynamic ReadOnly param updates.** Dynamic ReadOnly params (`vcbg`,
`vcbe`) are read from the engine via **cmd 4
(`DS_PARAM_VISUALIZER_DATA`) only** — the engine has no cmd 3 GET
path, so there's no fallback. Cmd 4 returns `vcbg ‖ vcbe` as 40
int16s in one round-trip; the visualizer pump polls at 50 ms
(Decision 10) and embeds the result in the `vis` event. `vnnb`,
`vnbf`, `vnbg`, `vnbe` are engine-internal native-visualizer state
with no read path at all — DolbyX exposes them as ReadOnly in the
metadata table for completeness but they will only ever show their
DEFINE_SETTINGS-time pre-population values. Experimental params
(`preg`, `pstg`, `endp`, `mxou`, `ocf`, `ven`, `vol`, `vcnb`,
`vcbf`) update through the regular state-snapshot path since the
daemon owns the write side.

The daemon serves no `/api/*` endpoints. Parameter metadata and the
initial state snapshot are injected into the served `index.html` as
`window.__BOOTSTRAP__` — see Decision 6 ("Bootstrap injection") for
the mechanism. The UI reads that synchronously at module init, so
the page paints fully populated on the first frame without any
pre-paint network round-trip. There is no `/api/factory_defaults`
analogue either: the daemon owns reset logic via `reset_profile` /
`reset_eq_preset` commands.

#### Daemon ↔ engine subprocess (binary, length-prefixed)

The engine subprocess speaks a small binary protocol over stdin/stdout.
Each message is `[u32 length][u32 opcode][payload]`. Replies are
`[u32 length][i32 status][payload]`. All multi-byte values are little-endian.

| Op   | Name             | Payload                                               | Reply                                    |
| ---- | ---------------- | ----------------------------------------------------- | ---------------------------------------- |
| 0x01 | `CreateSession`  | `[u32 sample_rate]`                                   | `[u32 session_id]`                       |
| 0x02 | `DestroySession` | `[u32 session_id]`                                    | empty                                    |
| 0x03 | `SetEnabled`     | `[u32 session_id][u8 enabled]`                        | empty                                    |
| 0x10 | `SetParam`       | `[u32 session_id][4-CC name][u16 count][i16 × count]` | empty                                    |
| 0x20 | `GetVisualizer`  | `[u32 session_id]`                                    | `[i16 × 20 gains][i16 × 20 excitations]` |
| 0x30 | `Process`        | `[u32 session_id][u32 frames][i16 × frames × 2 pcm]`  | `[i16 × frames × 2 pcm]`                 |
| 0x40 | `Version`        | empty                                                 | `[u8 len][u8 × len utf-8]`               |

There is intentionally **no `GetParam` opcode**. The underlying
engine (libdseffect.so) does not implement cmd 3 GET — see
[docs/ddp/03-binary-protocol.md → Cmd 3 GET](ddp/03-binary-protocol.md#cmd-3-get-unimplemented).
The daemon caches every write itself and serves it back from
the in-memory state mirror plus `config.toml` overlay.
`GetVisualizer` (mapped to cmd 4 in the engine wire protocol) is
the only way to read live engine state. Version is served by the
daemon from a cached cmd 6 result captured at init.

The engine subprocess holds the session table and routes each command to the
right `effect_handle_t`. For Phase 6 (Unicorn backend), this protocol is
implemented as direct in-process function calls, eliminating the pipe
entirely with no changes to the `Engine` trait.

#### Plugin ↔ daemon (binary, length-prefixed)

Same framing as the engine protocol. The plugin carries audio only; all
control goes through the Web UI.

| Op   | Name        | Direction       | Payload                              |
| ---- | ----------- | --------------- | ------------------------------------ |
| 0x01 | `Hello`     | plugin → daemon | `[u32 sample_rate][u32 max_frames]`  |
| 0x02 | `HelloAck`  | daemon → plugin | `[u32 session_id]`                   |
| 0x10 | `Process`   | plugin → daemon | `[u32 frames][i16 × frames × 2 pcm]` |
| 0x11 | `Processed` | daemon → plugin | `[i16 × frames × 2 pcm]`             |
| 0x20 | `Goodbye`   | either          | empty                                |

The daemon multiplexes audio from all plugins onto the shared engine
subprocess, keeping each plugin's audio on its own session id.

Audio frames stay in int16 stereo internally — matching what `libdseffect.so`
expects. The plugin converts from float32 once at the host boundary;
everything else is int16.

A future optimisation (Phase 8) replaces byte-stream socket audio with a
shared-memory ring buffer plus a socket for signalling, removing per-block
kernel transitions. Defer until measured latency motivates the work.

### Decision 5 — Daemon in Rust

Rust gives us:

- Strict type safety across many concurrent threads (HTTP, WebSocket,
  audio I/O, visualizer pump, engine subprocess management).
- `tokio` handles cross-platform async I/O uniformly, including Windows
  named pipes (`tokio::net::windows::named_pipe`) and Unix domain sockets.
- `axum` + `tokio-tungstenite` give HTTP and WebSocket for essentially free.
- `serde` + `toml` make persistence trivial.
- Cargo workspace structure scales as the project grows.
- `#![forbid(unsafe_code)]` everywhere except the engine FFI boundary;
  that boundary has explicit `// SAFETY:` comments explaining every invariant.

Code quality bar:

- `#![deny(missing_docs, warnings)]` at crate roots.
- `cargo clippy -- -D warnings -W clippy::pedantic -W clippy::nursery`.
- `cargo fmt --check` in CI.
- `proptest` for bidirectional `f32 dB ↔ i16` 1/16-dB conversion.
- Unit tests for the state model, the metadata table, and the persistence layer.
- Integration tests that spin up the daemon with a mock engine and drive it
  through the WebSocket protocol.

### Decision 6 — Web UI in Solid.js with TypeScript, separate dev workflow

The UI lives in its own directory (`ui/`) and is developed independently
with full hot-reload via Vite.

Stack:

- **Solid.js + TypeScript** (`solid-js`, `solid-js/web`) with
  `strict: true`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. Solid's fine-grained reactivity matches
  the UI shape — high-frequency reactive updates (visualizer levels,
  GEQ knob drag) without VDOM diff overhead. ~7 KB runtime vs
  React+ReactDOM ~45 KB.
- **Vite** for dev server and production build, with
  `vite-plugin-solid` (JSX/TSX transform) and `vite-plugin-singlefile`
  (production: inlines all CSS+JS into one `index.html`).
- **Plain CSS with BEM** naming. No utility framework. Theming via CSS
  custom properties in a `theme.css` (DDP-styled defaults: dark navy
  background, Dolby cyan accent), so future skins can swap styles
  without code changes. The SVG visualizer (Decision 10) plays well
  with CSS-driven theming.
- **`solid-js/store`** for state management — built-in `createStore`,
  no third-party state library needed.
- **Vitest** for unit tests with `@solidjs/testing-library` and a
  mocked WebSocket. **Playwright** for E2E against a real daemon
  driving the real engine (`QemuBackend` + `libdseffect.so`), so the
  binary protocol, init handshake, and `DEFINE_PARAMS` /
  `DEFINE_SETTINGS` dance are covered too. `StubBackend` stays in
  `ddp-engine` for Rust unit/integration tests of daemon command
  dispatch — see Code quality standards. CI runs `apt-get install
qemu-user-static` on the Linux image; `libdseffect.so` is bundled in
  the repo (see Decision 11).
- **ESLint** with `@typescript-eslint/strict-type-checked` and
  `eslint-plugin-solid`, **Prettier**.

**Bootstrap injection.** The daemon templates `index.html` at request
time and injects parameter metadata + the initial state snapshot as a
single `window.__BOOTSTRAP__` global:

```ts
window.__BOOTSTRAP__: {
  params: ParameterDef[],   // full metadata table — no /api/parameters
  state: StateSnapshot,     // identical shape to the WebSocket "state" event
}
```

The `state` payload includes static ReadOnly params (`bver`, `bndl`,
`ver`, `lcmf`, `lcvd`, `lcsz`, `lcpt`) — the WebSocket `state` event no
longer needs to ship them as a one-shot at connect. The UI reads
`window.__BOOTSTRAP__` synchronously at module init, hydrates the Solid
store, and paints the full UI on the first frame. The WebSocket then
connects in the background; its `state` event reconciles any drift
between HTML render time and WS connect time (and handles reconnects).

There is intentionally no `/api/*` endpoint in dev or prod. Bootstrap
injection is the only mechanism.

Development workflow. The repo root carries a single `Justfile`
(`cargo install just` once). `just dev` runs both `cargo watch -x 'run
-p ddp-daemon'` and `pnpm --prefix ui dev` concurrently with
prefixed/coloured output. Rust changes restart the daemon; TS and CSS
changes hot-reload via Vite.

The daemon is the single front door for both dev and prod: the browser
visits `localhost:9876`. In dev mode the daemon's `GET /` returns a
hardcoded HTML literal that injects `window.__BOOTSTRAP__` and
references the Vite dev server's module entry directly:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>DolbyX</title>
    <script>
      window.__BOOTSTRAP__ = {
        /* daemon-serialized JSON */
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="http://localhost:5173/@vite/client"></script>
    <script type="module" src="http://localhost:5173/src/main.tsx"></script>
  </body>
</html>
```

`vite.config.ts` is configured for backend integration so HMR works
through the daemon's origin:

```ts
server: {
  cors: true,
  origin: 'http://localhost:5173',
  hmr: { host: 'localhost', port: 5173, protocol: 'ws' },
}
```

The HMR client connects directly to `ws://localhost:5173/`, independent
of the page's `:9876` origin. No Vite `/api` proxy (no endpoints
exist); no Vite `/ws` proxy (the page is same-origin with the
WebSocket).

`main.tsx` includes a 2-line guard for devs who accidentally visit
`localhost:5173` directly:

```ts
if (!window.__BOOTSTRAP__) {
  location.replace('http://localhost:9876' + location.pathname)
  throw new Error('Bootstrap missing — redirecting to daemon')
}
```

```bash
just dev      # daemon + UI together (recommended)

# or, equivalently, in two terminals:
cargo watch -x 'run -p ddp-daemon'
pnpm --prefix ui dev
```

Recommended VS Code extensions: **rust-analyzer**, **Even Better TOML**,
**ESLint**, **Prettier**. WSL note for this codebase: develop on WSL2;
the daemon and UI both run as Linux processes. The Windows VST plugin
builds separately as a cross-compile target in a later phase.

Production build:

```bash
just build-release
# → ui/dist/index.html built by Vite + vite-plugin-singlefile
#   (CSS/JS inlined; <!--BOOTSTRAP--> placeholder left unreplaced)
# → cargo build --release --features embedded-ui embeds
#   ui/dist/index.html via rust-embed
```

With `embedded-ui` enabled, the daemon's `GET /` reads the embedded
single-file `index.html` bytes and string-replaces `<!--BOOTSTRAP-->`
with the serialized bootstrap JSON before sending. Without the feature
(dev default), the daemon serves the hardcoded dev-mode HTML described
above. The `embedded-ui` Cargo feature is the toggle between the two
HTML producers in `http_server`.

UI component tree:

```
src/
├── main.tsx
├── App.tsx
├── store/
│   ├── state.ts           # Solid store — mirrors daemon state shape; hydrated from window.__BOOTSTRAP__
│   └── ws.ts              # WebSocket client + auto-reconnect
├── styles/
│   ├── theme.css          # CSS custom properties (colours, spacing, radii)
│   ├── base.css           # element resets and base typography
│   └── components/        # one BEM file per component family
├── components/
│   ├── PowerToggle.tsx
│   ├── ProfileTabs.tsx
│   ├── EqPresetPicker.tsx
│   ├── BasicSwitches.tsx  # Volume Leveller + Dialog Enhancer + Surround Virtualizer
│   ├── Visualizer.tsx     # SVG visualizer + EQ curve
│   ├── EqCurve.tsx
│   └── ConnectionBadge.tsx
├── advanced/
│   ├── AdvancedPanel.tsx  # auto-generated from window.__BOOTSTRAP__.params
│   ├── widgets/
│   │   ├── ToggleWidget.tsx
│   │   ├── TristateWidget.tsx
│   │   ├── IntegerWidget.tsx
│   │   ├── DecibelWidget.tsx
│   │   ├── FrequencyWidget.tsx
│   │   ├── DegreesWidget.tsx
│   │   ├── ArrayPerBandWidget.tsx
│   │   ├── AobgWidget.tsx       # channel-id-prefixed layout
│   │   └── ReadOnlyWidget.tsx   # live-updated value display
│   └── WidgetFactory.tsx  # ParamKind + ParamAccess → widget
└── lib/
    ├── ws.ts              # WebSocket types and auto-reconnect logic
    ├── parameters.ts      # types for the injected ParameterDef[]
    └── units.ts           # int16 ↔ dB helpers
```

### Decision 7 — Persistence layout

Two TOML files in distinct locations:

- `config.toml` — user state, editable, in the platform-standard data dir.
  Windows: `%PROGRAMDATA%\DolbyX\config.toml`. Linux:
  `/var/lib/dolbyx/config.toml`.
- `defaults.toml` — factory defaults, user-editable, in the **same directory
  as the daemon binary**.

`defaults.toml` declares all factory profiles and EQ presets with
their full default values. `config.toml` stores **only deltas** —
matching the overlay model the original DDP used with
`ds1-default.xml` / `ds1-current.xml`. `defaults.toml` also drives
`reset_profile` and `reset_eq_preset` actions (reset = remove the
user's overrides).

Both files are first-class state for the daemon. A `notify`-based
file watcher subscribes to changes on both paths; on an external
edit the daemon debounces for 500 ms (matching the write-side
debounce), re-overlays the two files, and broadcasts a fresh state
snapshot to every connected client. Users can hand-edit either
file and watch the UI catch up. To avoid the watcher firing on the
daemon's own writes, the daemon records each `(path, mtime)` it
flushed and suppresses watcher events that match within a 1 s
quiet window.

`is_factory` is not stored on disk. It is derived at load time: any
id present in `defaults.toml` is a factory item; any id present only
in `config.toml` is custom.

Schema notes:

- No `[state]` table header; `power` and `selected_profile` live at
  top level for ergonomics.
- Profiles and EQ presets are keyed by id using table-per-id syntax
  (`[profile.music]`, `[eq_preset.rich]`), not array-of-tables. The id
  becomes the table key.
- AK param overrides (4-CC keys) live directly under
  `[profile.<id>]` or `[eq_preset.<id>]` — no `[profile.params]`
  sub-table. Serde uses `#[serde(flatten)] params: HashMap<String,
ParamValue>` to collect unknown keys.

`defaults.toml` (lives next to the daemon binary) — abbreviated:

```toml
power = true
selected_profile = "music"

[eq_preset.off]
name = "Off"
ieon = 0
iebt = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
geon = 0
gebg = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

[eq_preset.open]
name = "Open"
ieon = 1
iebt = [117, 133, 188, 176, 141, 149, 175, 185, 185, 200,
        236, 242, 228, 213, 182, 132, 110,  68, -27, -240]
geon = 0
gebg = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

[eq_preset.rich]
name = "Rich"
ieon = 1
iebt = [67, 95, 172, 163, 168, 201, 189, 242, 196, 221,
        192, 186, 168, 139, 102,  57,  35,   9, -55, -235]
geon = 0
gebg = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

[eq_preset.focused]
name = "Focused"
ieon = 0
iebt = [-419, -112,  75, 116, 113, 160, 165,  80,  61,  79,
          98,  121,  64,  70,  44, -71, -33,-100,-238,-411]
geon = 0
gebg = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

[profile.music]
name = "Music"
selected_eq_preset = "rich"
dvla = 4
deon = 1
dea = 2
dhsb = 48
vdhe = 2
ngon = 2
aoon = 2
plmd = 4
vmb = 144

# … movie, game, voice
```

`config.toml` (fresh install):

```toml
power = true
selected_profile = "music"
```

`config.toml` (after some user edits):

```toml
power = false
selected_profile = "music"

[profile.music]
dvla = 5

[profile.user_a3f1]
name = "Late Night"
selected_eq_preset = "rich"
dvla = 2
dea = 6

[eq_preset.user_91c2]
name = "Vocal Forward"
ieon = 1
iebt = [...]
geon = 1
gebg = [...]
```

Persistence write semantics:

- All on-disk state changes (power, selected_profile, profile params,
  EQ preset edits) are debounced together with a single 500 ms timer.
- All pending writes are flushed on graceful daemon shutdown (SIGTERM
  / Windows console close handler).

### Decision 8 — First-run UX

On a fresh install (no `config.toml` exists), the daemon initializes
from `defaults.toml` and writes a minimal config:

```toml
power = true
selected_profile = "music"
```

Power is on, Music profile is selected, no per-profile overrides. The
user hears the original DDP Music profile defaults the first time
they play audio. This is "preserve the original default behaviour"
made concrete.

### Decision 9 — Custom profiles have no category

The original DDP categorised profiles as Movie / Music / Game / Voice /
Customized. The category had no engine semantics; it only drove UI grouping
and an icon. In DolbyX v2, factory profiles keep their category-derived
display names. Custom profiles have no category — they are simply listed
in the profiles with their user-chosen name.

This eliminates a UI affordance the user would have to make a decision about
with no functional consequence.

### Decision 10 — Visualizer pump rate and rendering

The pump runs at a fixed 50 ms cadence, matching the original DDP.
Hardcoded as a named constant, easy to modify, not a user-facing
setting:

```rust
// crates/ddp-daemon/src/visualizer_pump.rs
pub const VISUALIZER_PUMP_INTERVAL: Duration = Duration::from_millis(50);
pub const VISUALIZER_SUSPENDED_THRESHOLD: u32 = 10; // 10 ticks ≈ 500 ms hysteresis
```

The pump always reads from the **oldest session** (the first entry in
the session list), regardless of suspended state — see Decision 4.

Each tick:

1. Call `engine.get_visualizer_data(session)`, which under the hood
   issues a single engine cmd 4 (`DS_PARAM_VISUALIZER_DATA`) returning
   `vcbg ‖ vcbe` as 40 int16s. The Engine trait wraps that as a
   `VisualizerData { gains[20], excitations[20] }` (or `None` when
   the engine has no fresh audio data — inferred from Java's
   `DsService.visualizerUpdate` counter that increments on empty
   cmd 4 reads; not directly exercised by the probe). No cmd 3 GET
   is involved; cmd 3 GET doesn't exist in the engine.
2. Suspended-state detection matches original DDP
   (`DsService.visualizerUpdate`): a returned length of 0 (None) for
   `VISUALIZER_SUSPENDED_THRESHOLD` consecutive ticks transitions into
   suspended; a non-zero return for the same threshold transitions
   back out. While suspended, the daemon broadcasts a single
   `vis_suspended: true` and suppresses `vis` events until activity
   resumes.
3. Otherwise broadcast
   `{ type: "vis", gains: [...], excitations: [...] }` with raw int16
   1/16-dB values (UI converts on display). No separate ReadOnly
   params channel ships with the event — `vcbg`/`vcbe` are the only
   ReadOnlyDynamic params with a real read path and they already are
   `gains`/`excitations`; the `vnb*` family is engine-internal and
   unreadable.

UI rendering — a single `<svg>` with layered groups matching the original DDP:

- Background: radial gradient (dark navy → near-black).
- Spectrum bars: 20 columns × 48 rows driven by `gains`, quantized to
  grid cells. Colour bands: red rows 0–11, yellow 12–17, blue 18–47.
- EQ curve: Catmull-Rom spline through the profile's stored `geq` values (not
  the `vcbg` read-back from the engine — the stored `geq` is the source of
  truth, giving low-latency drag rendering).
- Draggable knob handles for GEQ editing. Touch editing uses an event queue
  with the `GAIN_SMOOTHER` kernel matching the original DDP's feel (see
  [docs/ddp/04-ui-data-flow.md](ddp/04-ui-data-flow.md#example-2--moving-an-eq-slider)).

**Reference source — match the original look and feel.** The original DDP
V/E lives under `decompiled/DsUI.apk/sources/com/dolby/ds1appUI/`; study it
when implementing to keep the v2 feel faithful:

- `GraphicVisualiser.java` — SurfaceView host + paint thread
- `GraphicVisualiserPainter.java` — spectrum bricks
- `GraphicEqualizerPainter.java` — touch queue, smoother, inverse-smoother, curve, slider thumbs
- `FragGraphicVisualizer.java` — fragment wiring, IEQ preset grid + custom + reset
- `EqualizerAdapter.java` — IEQ preset cells

### Decision 11 — Bundle `libdseffect.so` with releases

The binary is shipped alongside the daemon executable. The release
artifact contains:

```
dolbyx/
├── dolbyx-daemon          # the Rust binary (UI embedded)
├── dolbyx-engine-arm      # the ARM-side engine binary (statically built)
├── libdseffect.so         # bundled
├── defaults.toml          # factory profiles + EQ presets, user-inspectable
└── README.txt
```

Plus platform-specific extras (the VST DLL on Windows, the LV2 bundle on
Linux). The daemon resolves `libdseffect.so` from the same directory.

This is a deliberate tradeoff: ease-of-install over legal cleanliness.
Distribution is for personal use; the project README is explicit that
DolbyX is a wrapper around a third-party proprietary binary. Legal review
is deferred until and unless DolbyX is offered as a commercial product.

### Decision 12 — Logging and observability

The daemon emits structured logs via `tracing` with an environment-variable
filter (`RUST_LOG`). Three log targets:

- `stdout` (default): human-readable, level-colored, used during
  development.
- `stderr`: errors and warnings duplicated here even when `stdout` is
  silenced.
- Optional rotating file at `%PROGRAMDATA%\DolbyX\logs\dolbyx.log` (Windows)
  or `/var/log/dolbyx/dolbyx.log` (Linux), 7-day retention.

## Data model

```rust
// Stable id types — strings so they're stable across reorderings
// and serialize cleanly to TOML.
pub struct ProfileId(pub String);
pub struct PresetId(pub String);
pub struct SessionId(pub u32);

pub struct State {
    pub power: bool,
    pub selected_profile: ProfileId,
    pub profiles: Vec<Profile>,
    pub eq_presets: Vec<EqPreset>,
}

pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    pub selected_eq_preset: PresetId,
    pub params: HashMap<String, Vec<i16>>, // AK param overrides keyed by 4-CC
}

pub struct EqPreset {
    pub id: PresetId,
    pub name: String,
    pub is_ieq_on: bool,
    pub ieq_band_targets: [i16; 20],
    pub is_geq_on: bool,
    pub geq_band_gains: [i16; 20],
}
```

`is_factory` is derived at load time, not stored: any id present in
`defaults.toml` is factory; any id present only in `config.toml` is
custom.

- **Factory profiles**: `movie`, `music`, `game`, `voice`. Cannot be
  deleted or renamed. Can be reset to bundled defaults.
- **Factory EQ presets**: `off`, `open`, `rich`, `focused`. Cannot be
  deleted or renamed. Can be reset to bundled defaults.

Custom items can be freely renamed, edited, or deleted. Removing a
custom EQ preset that some profile has selected: those profiles fall
back to the `Off` preset.

## Module structure

```
DolbyX/
├── Cargo.toml                       # Cargo workspace
├── Justfile                         # `just dev`, `just build-release`, …
├── rust-toolchain.toml              # pin a stable Rust version
├── flake.nix                        # Nix shell + NixOS module (Linux)
├── crates/
│   ├── ddp-engine/                  # Engine trait + backend impls
│   │   ├── src/lib.rs               #   trait Engine + StubBackend (testing)
│   │   ├── src/qemu.rs              #   QemuBackend (shared subprocess)
│   │   ├── src/stub.rs              #   StubBackend — no libdseffect.so
│   │   ├── src/protocol.rs          #   binary protocol (shared with engine-arm)
│   │   ├── src/backend_unicorn/     #   future, scaffolded empty
│   │   ├── src/backend_sbt/         #   future, scaffolded empty
│   │   └── tests/qemu_smoke.rs
│   ├── ddp-state/                   # Pure state model — no I/O
│   │   ├── build.rs                 #   codegen: parameters.toml → parameters.rs
│   │   ├── parameters.toml          #   source for the AK metadata codegen
│   │   ├── src/lib.rs
│   │   ├── src/profile.rs
│   │   ├── src/preset.rs
│   │   ├── src/state.rs             #   State aggregate + all mutations
│   │   ├── src/parameters.rs        #   AK metadata table (codegen'd, 64 entries)
│   │   └── src/conversion.rs        #   int16 ↔ dB helpers (used by UI tests too)
│   ├── ddp-persistence/             # TOML load/save — separate from state logic
│   │   ├── src/lib.rs
│   │   ├── src/schema.rs            #   serde structs matching the TOML
│   │   ├── src/factory.rs           #   loads defaults.toml from $(daemon-dir)
│   │   ├── src/file_watcher.rs      #   notify-rs watcher on both TOML files
│   │   └── src/debounce.rs          #   write debouncing (500 ms uniform)
│   ├── ddp-daemon/                  # The dolbyx-daemon binary
│   │   ├── build.rs                 #   copies defaults.toml next to the binary
│   │   ├── defaults.toml            #   factory profiles + EQ presets (source-of-truth)
│   │   ├── src/main.rs
│   │   ├── src/http_server.rs       #   axum routes + rust-embed UI serving
│   │   ├── src/ws_server.rs         #   WebSocket session handling
│   │   ├── src/ws_commands.rs       #   command dispatch
│   │   ├── src/audio_server.rs      #   plugin socket accept loop
│   │   ├── src/engine_supervisor.rs #   owns the Engine instance + session map
│   │   ├── src/visualizer_pump.rs   #   50 ms broadcast loop
│   │   ├── src/platform/
│   │   │   ├── windows.rs           #   named pipe accept
│   │   │   └── unix.rs              #   AF_UNIX accept
│   │   ├── tests/integration.rs     #   StubBackend command-dispatch tests
│   │   └── tests/e2e_qemu.rs        #   real-engine E2E (cargo feature `qemu`)
│   ├── ddp-engine-arm/              # ARM-side engine binary (cross-compiled ARMv7)
│   │   ├── src/main.rs              #   loads libdseffect.so via dlopen
│   │   ├── src/protocol.rs          #   mirrors ddp-engine/src/protocol.rs
│   │   ├── src/session.rs           #   session_id → effect_handle_t routing
│   │   ├── stubs/                   #   Android + libc stub sources
│   │   └── Cargo.toml               #   target = armv7-unknown-linux-gnueabihf
│   ├── ddp-vst-windows/             # Windows VST2 plugin
│   │   ├── src/lib.rs               #   cdylib; effEditOpen → ShellExecuteW
│   │   └── Cargo.toml
│   └── ddp-lv2-linux/               # Linux LV2 plugin
│       ├── src/lib.rs               #   cdylib
│       ├── dolbyx.ttl
│       └── Cargo.toml
├── ui/                              # Solid app — independent pnpm project
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── vite.config.ts               # backend-integration mode; HMR via :5173
│   ├── tsconfig.json
│   ├── index.html                   # has <!--BOOTSTRAP--> placeholder for prod
│   └── src/                         # (see Decision 6 for component tree)
├── vendored/
│   └── libdseffect.so               # v8.1 build, bundled
└── scripts/
    ├── build-release.sh
    ├── package-windows.ps1
    ├── package-linux.sh
    └── setup-windows.bat            # one-time WSL2 setup (until Unicorn)
```

The Cargo workspace declares all `crates/*` as members. The `ddp-state` crate
is intentionally I/O-free so it can be unit-tested in isolation, ported, or
wrapped for FFI later. The `ddp-persistence` crate is a separate member to
keep I/O concerns out of the state model.

## Implementation phases

Phases 0–5 constitute the v2.0 release. Phase 6 is v2.1. Phase 7 is v3.0.

### Phase 0 — Workspace bootstrap (≈ 1 week)

- New Cargo workspace with the crate skeleton above.
- Top-level `Justfile` with `dev`, `build-release`, `lint`, `test`
  recipes.
- CI scaffolding: GitHub Actions running `cargo check`, `cargo test`,
  `cargo clippy`, `cargo fmt --check` on Linux + Windows.
- Solid + Vite UI scaffolding with TypeScript, ESLint, Prettier;
  `vite-plugin-solid`, `vite-plugin-singlefile`, `@solidjs/testing-library`,
  and `eslint-plugin-solid` pinned. No Tailwind — plain CSS with BEM +
  `theme.css` of CSS variables.
- `defaults.toml` created with factory profiles and EQ presets
  transcribed from `ds1-default.xml`.
- AK parameter metadata table (`parameters.toml` + codegen) populated
  with all 64 entries from
  [docs/ddp/02-ak-parameters.md](ddp/02-ak-parameters.md), with the
  four-bucket Settable / ReadOnlyDynamic / ReadOnlyStatic / Experimental
  classification from Decision 3.
- No functional behaviour yet; CI is green on a skeleton.

### Phase 1 — State + persistence (≈ 1 week)

- `ddp-state` crate: full data model, factory loading, all mutation
  operations as specified in Decision 2. `is_factory` derived from
  defaults.toml presence.
- `ddp-persistence` crate: TOML load/save, defaults overlay, uniform
  500 ms debounced writes.
- Migration from v1 TOML schema.
- Unit + property tests cover the state model fully, including
  bidirectional `f32 dB ↔ i16` 1/16-dB conversion via `proptest`.
- No engine, no server yet; verify with unit tests only.

### Phase 2 — Engine integration (≈ 2 weeks)

- `ddp-engine-arm` binary: cross-compiled to ARMv7, runs under
  `qemu-arm-static`, loads `libdseffect.so`, implements the binary protocol
  with correct init handshake:
  - `DEFINE_PARAMS` with all 64 canonical 4-CC names.
  - **`DEFINE_SETTINGS` with all 64 params** expanded into their full
    `(param_idx, offset)` ranges per element (667 cache slots =
    1334 bytes per device; init payload ~2 KB). The host must know
    the intended `genb`/`ienb`/`aonb` values when building this
    payload so the dependent multi-element params (`gebg`, `aobg`,
    `vcbg`, etc.) get the right slot count. This includes the
    "ReadOnly" and "Experimental" buckets so every AK param has a
    cache slot — the engine pre-populates them from its own AK
    registry via internal `ak_get` calls, and cmd 3 SET against any
    of them propagates through to `ak_set` (proven by
    [tools/ddp_probe/](../tools/ddp_probe/README.md)).
  - Constant-params dance: after DEFINE_SETTINGS, write `genb=20`,
    `ienb=20`, `aonb=20`, `gebf=[…]` (and `iebf`, `aobf`, `arbf` if
    you intend to set those later) via cmd 3 to propagate the
    constants into the engine's AK registry. cmd 3 addresses cache
    flat indices and so must follow DEFINE_SETTINGS.
  - Explicit `VISUALIZER_ENABLE` SET so the engine populates
    `vcbg`/`vcbe` every audio block.
  - Finish with `EFFECT_CMD_ENABLE` so subsequent `process()` calls
    run the DSP chain.
- `QemuBackend` in `ddp-engine`: spawns one shared subprocess, multiplexes
  sessions, propagates errors.
- End-to-end test: state mutation → engine round-trip → audio shape matches
  expectations.
- Regression harness: `tools/ddp_probe/` is the empirical
  source-of-truth for engine behavior. Run it in CI under
  `qemu-user-static` (e.g. on the Linux runner) to verify the v2.0
  engine binary still matches the documented validation surface
  (cmd 3 GET unimplemented, no value-range clamp, asymmetric
  enable/disable crossfade — 7560 / 5512 samples at 44.1 kHz, etc.).

### Phase 3 — Daemon server (≈ 1.5 weeks)

- `ddp-daemon` integrates state, engine supervisor, and the HTTP + WebSocket
  server.
- `GET /` serves `index.html` with `window.__BOOTSTRAP__` injected
  (params + initial state). Dev mode produces a hardcoded HTML literal
  pointing to Vite's module entry at `:5173`; prod mode (with the
  `embedded-ui` Cargo feature) reads the rust-embed asset and
  string-replaces `<!--BOOTSTRAP-->`. No `/api/*` routes exist —
  see Decision 6.
- All UI ↔ daemon WebSocket commands implemented and tested (verify
  with `curl` and `websocat`; no UI yet).
- Originator-aware broadcast pattern.
- Visualizer pump at the named-constant 50 ms cadence with suspended-state
  detection.
- Plugin server accepts Windows named-pipe and AF_UNIX connections, allocates
  sessions, multiplexes audio.

### Phase 4 — Solid UI (≈ 2–3 weeks)

Look-and-feel target is the original DDPlus Android UI — captured in
[`docs/ui-reference/`](ui-reference/) (profile picker, per-profile
detail with Manual GEQ / Intelligent EQ modes, visualizer + EQ
overlay).

- Core controls: power, profile picker, the three master toggles with amount
  sliders (Volume Leveller / Dialog Enhancer / Surround Virtualizer),
  EQ preset picker, EQ preset reset, profile-level reset.
- SVG visualizer matching the original DDP look: spectrum bars from
  excitations, EQ curve overlay (Catmull-Rom spline), draggable
  handles with `GAIN_SMOOTHER` kernel.
- Profile and EQ-preset management: add, delete, rename.
- Advanced panel auto-generated from `window.__BOOTSTRAP__.params`
  metadata, rendered as a CSS-grid of compact cards. Widget dispatch
  collapses `ReadOnlyDynamic` and `ReadOnlyStatic` onto the same
  read-only display kind (the Static-vs-Dynamic distinction is
  informational metadata for the daemon's update logic, not a UI
  mode); editable widgets light up for `Settable`; `Experimental`
  gets the editable widget plus an "experimental" badge (Decision 3).
- BEM CSS + CSS variables for theming; SVG visualizer; no Tailwind.
- WebSocket auto-reconnect, dev/prod build flows.
- Tests: Vitest for components with a mocked WebSocket; Playwright
  E2E against a real daemon driving the real engine (QemuBackend +
  `libdseffect.so`).

### Phase 5 — Plugins (≈ 1.5 weeks)

- Windows VST2 plugin (`ddp-vst-windows`): opens named pipe, ferries audio,
  launches the UI at `http://localhost:9876` via `ShellExecuteW` when
  "Open Panel" is clicked in EqualizerAPO.
- Linux LV2 plugin (`ddp-lv2-linux`): opens `/tmp/dolbyx.sock`, ferries audio.
- PipeWire `filter-chain` config example for system-wide routing.
- Smoke-test: install the daemon, install the plugin, play music, verify the
  visualizer responds and the EQ takes effect.

**This completes v2.0.**

### Phase 6 (v2.1) — Unicorn backend

- Custom ELF loader for `libdseffect.so` (parses sections, maps into Unicorn
  memory).
- Android stub library: implements `__android_log_print`, `String8::String8`,
  `VectorImpl`, and other imports in native Rust.
- `UnicornBackend` in `ddp-engine`, sharing the same `Engine` trait surface.
- Switch the default backend on Windows from QEMU/WSL2 to Unicorn.
- Enables macOS port.

### Phase 7 (v3.0) — macOS port

- `ddp-driver-macos`: AudioServerPlugin virtual device (libASPL-based).
- nix-darwin module.
- macOS-specific UI controls (output device selector).
- Manual install docs.

### Phase 8 (incremental) — Latency optimization

- Shared-memory ring buffers for the plugin ↔ daemon audio path; socket
  retained for signalling.
- End-to-end latency profiling; tighten where measurements warrant.

## Code quality standards

**Rust**: `#![deny(missing_docs, warnings)]` at crate roots.
`cargo clippy -- -D warnings -W clippy::pedantic -W clippy::nursery`.
`cargo fmt --check`. `#![forbid(unsafe_code)]` everywhere except the engine
FFI boundary; that boundary has `// SAFETY:` comments on every invariant.

**Tests**: unit tests live next to the code in `#[cfg(test)] mod
tests`. Integration tests in `tests/`. Property tests via `proptest`
for invertible conversions (dB ↔ 1/16 dB, dB-clamp ↔ engine-clamp).
The daemon's command-dispatch integration tests use the `StubBackend`
engine impl for speed and determinism; the daemon's real-engine integration
test (`ddp-daemon/tests/e2e_qemu.rs`, gated by the `qemu` cargo
feature) and `ddp-engine`'s `qemu_smoke.rs` exercise the full QEMU

- `libdseffect.so` path. UI E2E (Playwright) drives the real daemon
  with the real engine so the binary protocol and init handshake are
  covered end-to-end.

**TypeScript**: `strict: true`, `noUncheckedIndexedAccess: true`,
`exactOptionalPropertyTypes: true`. ESLint with
`@typescript-eslint/strict-type-checked` and `eslint-plugin-solid`.
Prettier. Components have unit tests in Vitest with
`@solidjs/testing-library` and a mocked WebSocket; user flows have
E2E tests in Playwright against a real daemon driving the real
engine (`QemuBackend` + `libdseffect.so`). Mocking the daemon's
WebSocket would duplicate the daemon's logic in test fixtures and
drift over time; mocking the engine would skip the binary protocol,
init handshake, and `DEFINE_PARAMS` / `DEFINE_SETTINGS` dance —
where the integration risk actually lives. `StubBackend` is still
used by `ddp-daemon`'s Rust integration tests for command dispatch
where engine I/O isn't the point. CI provisions
`qemu-user-static` via apt; `libdseffect.so` is bundled.

**CI**: GitHub Actions runs the full test matrix on Linux + Windows for every
push and PR. Required checks before merge: `cargo test`,
`cargo clippy -- -D warnings`, `cargo fmt --check`, `pnpm run lint`,
`pnpm run test`.

**Documentation**: every public Rust item has a `///` doc comment with an
example where reasonable. The `ui/` directory has a README describing the
component architecture and dev workflow. The repo root README has a quickstart
for both end users and contributors.

## What this changes vs v1

| Aspect                    | v1                                                   | v2                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon language           | C                                                    | Rust                                                                                                                                                                      |
| Engine integration        | Per-stream QEMU subprocess                           | One shared QEMU subprocess, all sessions multiplexed; swappable Engine trait                                                                                              |
| Profile model             | Fixed 6-slot array                                   | Dynamic `Vec<Profile>` with factory + custom                                                                                                                              |
| EQ preset model           | Per-profile static array                             | Global `Vec<EqPreset>`; edits affect all profiles uniformly                                                                                                               |
| GEQ model                 | 6 × 4 × 20 matrix                                    | One GEQ per EQ preset (decoupled from profile)                                                                                                                            |
| Wire format               | Mixed dB / int16                                     | int16 1/16-dB throughout; dB conversion is UI-only                                                                                                                        |
| Wire protocol             | Parameter indices; cmd 3 GET swallowed silently      | Parameter names (4-CC); single source of truth via metadata table; cmd 3 SET-only; cmd 4 for visualizer, cmd 6 for version, daemon caches everything else                 |
| Param coverage            | 24 of 64 AK params                                   | All 64 in DEFINE_PARAMS and DEFINE_SETTINGS; Settable / ReadOnly-Dynamic / ReadOnly-Static / Experimental classification per docs/ddp/02                                  |
| Web UI                    | Vanilla JS embedded in daemon                        | Solid + TypeScript + Vite; plain CSS + BEM; separate dev workflow; daemon injects bootstrap (metadata table + initial state) into `index.html`; embedded at release build |
| Persistence               | Multi-file XML                                       | Two TOML files: `defaults.toml` (next to the daemon binary) + `config.toml` (platform data dir); table-per-id; overlay semantics; 500 ms debounce                         |
| External edits            | Not supported                                        | `notify`-based watcher on both TOML files; debounced reload + state-snapshot broadcast                                                                                    |
| Visualizer                | Gains only                                           | Gains + excitations; suspended-state detection (len==0 for N ticks)                                                                                                       |
| Power off                 | Zero-out the OFF profile                             | `EFFECT_CMD_DISABLE` on the engine; engine performs graceful crossfade; idempotent; parameter state survives the toggle                                                   |
| Custom profile categories | Labelled (Movie / Music / Game / Voice / Customized) | Removed; custom profiles are just named profiles                                                                                                                          |
| First-run defaults        | Undefined                                            | Music profile + power on, matching original DDP out-of-box                                                                                                                |

## Deferred technical questions

These don't block the plan and can be decided during implementation:

- Whether to use `serde` untagged or tagged enums for the WebSocket protocol —
  a small ergonomics question.
- Whether the Solid store mirrors the daemon's TOML schema 1:1 or
  uses a flatter shape better suited to component rendering.
- How aggressively to debounce parameter writes during a slider drag — the
  original DDP does 60 ms; we may match or go faster on desktop where network
  isn't a constraint.

## What this plan does not change

- The current `arm/`, `daemon/`, and `ui/` (v1 vanilla-JS scaffold)
  code stays in `main` during the rearchitecture. It is the v1
  reference implementation. Once Phase 5 completes, all three are
  removed in one commit.
- The existing [docs/ddp/](ddp/README.md) reference is unaffected — it
  documents `libdseffect.so` and the original DDP behaviour, which doesn't
  change.
- The bundled `libdseffect.so` is the same v8.1 build the project has
  always used.
