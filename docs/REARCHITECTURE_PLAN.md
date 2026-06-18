# DolbyX v2 — Rearchitecture Plan

This document is the canonical plan for the next-generation DolbyX, designed
in light of the comprehensive DDP reverse engineering captured under
[docs/ddp/](ddp/README.md). It supersedes [docs/CROSS_PLATFORM_PLAN.md](CROSS_PLATFORM_PLAN.md)
once implementation begins.

Companion docs:

- **[`CONTEXT.md`](../CONTEXT.md)** — domain glossary (terms only). The
  plan uses these terms exactly; do not drift.
- **[`docs/adr/`](adr/)** — hard-to-reverse decisions captured as
  Architecture Decision Records. Each ADR is a short paragraph; the plan
  links into them rather than re-stating rationale.

## Progress

Live progress across the 11 v2.0 slices. Per-behavior checklists live inside
each slice section below; this table is the at-a-glance summary. Status
values: `not started`, `in progress`, `done`, `blocked`.

| Slice | Title                                         | Status        | Notes                                              |
|-------|-----------------------------------------------|---------------|----------------------------------------------------|
| 0     | Workspace bootstrap                           | not started   | scaffold-only, no TDD                              |
| 1     | Power toggle, persisted end-to-end            | not started   | **tracer bullet** — first vertical slice           |
| 2     | Factory profile selection applies AK overrides| not started   |                                                    |
| 3     | Factory EQ presets apply IEQ curves           | not started   |                                                    |
| 4     | Master controls (VL / DE / SV)                | not started   | the signature DDP main-screen controls             |
| 5     | Visualizer pump + suspended-state detection   | not started   |                                                    |
| 6     | GEQ editing with smoother + inverse           | not started   | HITL — golden snapshots                            |
| 7     | Custom profiles & EQ presets (full CRUD)      | not started   |                                                    |
| 8     | Advanced panel auto-generated                 | not started   |                                                    |
| 9     | Real engine (`QemuBackend`) — swap & replay   | not started   | HITL — first QEMU green requires manual debug      |
| 10    | Plugins ferry audio (VST2 + LV2)              | not started   | HITL — manual install for smoke-test               |
| v2.1+ | Unicorn backend                               | not started   | replays Slices 1–8 under `--features unicorn`      |
| v3.0  | macOS port                                    | not started   |                                                    |
| opt   | Shared-memory ring buffers                    | not started   | latency optimization, no version pin               |

Each slice below is implemented one at a time with the `/tdd` skill —
vertical tracer bullets, never horizontal layer slices. Update the
row above when a slice transitions, and tick the per-behavior boxes
inside the slice section as RED → GREEN advances.

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
6. Every AK parameter that the engine surfaces (54 of the engine's 64 real
   root leaves) is exposed in the Advanced UI section, driven by metadata —
   including ReadOnly ones (for live monitoring) and Experimental ones
   (engine-internal slots the original DDP UI hid; DolbyX is also a research
   vehicle for `libdseffect.so`). The remaining 10 — 6 static build-version /
   license slots plus 4 native-visualizer slots (`vnnb`, `vnbf`, `vnbg`,
   `vnbe`; `ak_get` shows `vnbg`/`vnbe` are a live mirror of `vcbg`/`vcbe`) —
   carry nothing the host needs and are dropped entirely; the engine version
   surfaces via cmd 6. (The engine's 64 real root leaves are *not* Java's
   64-name list — Java registers two phantoms and omits two real leaves; see
   [docs/ddp/02](ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves).)
7. Backend-agnostic engine layer: the QEMU subprocess approach is the
   default for v2.0; Unicorn Engine and Static Binary Translation slot in
   as alternative backends without touching the rest of the code.
8. Single-process daemon hosting: HTTP/WebSocket server, audio plugin IPC,
   and engine all in one binary.
9. Rust for the daemon, Solid.js with TypeScript for the Web UI.
10. Top-notch code quality: strict linting, mandatory doc comments,
    unit + integration tests, CI gates.

**Non-goals (this phase):**

- macOS support — its own milestone, after v2.0.
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

> Persistent record: [ADR-0002 — Backend-agnostic engine, QEMU subprocess as v2.0 default](adr/0002-backend-agnostic-engine-qemu-default.md).

The daemon talks to the engine through a `trait Engine` (Rust):

```rust
pub trait Engine: Send + Sync {
    fn create_session(&self, sample_rate: u32) -> Result<SessionId>;
    fn destroy_session(&self, id: SessionId) -> Result<()>;
    fn set_enabled(&self, id: SessionId, enabled: bool) -> Result<()>;
    fn set_param(&self, id: SessionId, name: &str, values: &[i16]) -> Result<()>;
    fn set_params(&self, id: SessionId, params: &[(&str, &[i16])]) -> Result<()>;
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

`set_param` writes one parameter (engine cmd 3); `set_params` writes a
batch atomically in a single round-trip (engine cmd 2,
`DS_PARAM_ALL_VALUES`). The daemon uses the batch path for profile and
EQ-preset switches — the engine applies the whole change on one audio
block, avoiding the mid-switch artifact of dribbling ~40 single writes
through cmd 3. Single-control edits (slider, toggle, GEQ drag) use
`set_param`.

**Sample rate.** `libdseffect.so` runs at 44100 Hz by default. A
`create_session` at any other rate (e.g. a 32000 or 48000 Hz host)
needs the ARM side to apply the engine's `Ds1ap::New` hot-swap (see
[docs/ddp/03](ddp/03-binary-protocol.md#practical-reminders)). This
stays behind the trait — the backend handles it; the `Engine` surface
is unchanged.

Three impls are anticipated, but only one ships in v2.0:

| Backend               | Status           | Where it works                 | Notes                                                                                                                                                                                     |
| --------------------- | ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QemuBackend`         | **v2.0 default** | Linux native; Windows via WSL2 | One shared `qemu-arm-static` subprocess that holds `libdseffect.so` and multiplexes all sessions. Communicates with the daemon over stdin/stdout using a length-prefixed binary protocol. |
| `UnicornBackend`      | Future (v2.1)    | Native on all platforms        | Custom ELF loader + Android stub library + Unicorn JIT, all inside the daemon process. Eliminates WSL on Windows. Identical Engine trait surface.                                         |
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

> Persistent record: [ADR-0003 — Global EQ presets, GEQ owned by preset](adr/0003-global-eq-presets-and-geq-per-preset.md).

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

Factory EQ presets are `Off`, `Open`, `Rich`, `Focused`. Factory
profiles are `Movie`, `Music`, `Game`, `Voice`. Factory items cannot
be deleted; they can be reset to their bundled defaults.

Note:
Original DDP only allowed `gebg` curves to be edited through the
Visualizer/Equalizer UI, and `iebt` curves could not be edited beyond their
factory values. DolbyX will keep this behavior for now. In the future,
DolbyX will support editing the `iebt` curve as well (through the same
Visualizer/Equalizer, behind a toggle).

### Decision 3 — Parameter metadata as the single source of truth

> Persistent record: [ADR-0004 — Parameter metadata as single source of truth](adr/0004-parameter-metadata-as-single-source-of-truth.md).

54 of the engine's 64 real root-leaf AK parameters are declared once in a
static metadata table. (The other 10 — `bver`, `bndl`, `ver`, `lcmf`,
`lcvd`, `lcpt` (static engine-internal build-version / license slots) plus
`vnnb`, `vnbf`, `vnbg`, `vnbe` (native-visualizer slots; `ak_get` shows
`vnbg`/`vnbe` are a live byte-for-byte mirror of `vcbg`/`vcbe`) — carry
nothing the host needs and are omitted; the engine version string is
surfaced via cmd 6 → bootstrap `engine.version` instead.) The 64 real root
leaves are *not* Java's `DsAkSettings.akParams_` 64-name list: Java
registers two phantoms (`mxou`, `lcsz` — node params resolving to ref 0)
and omits two real leaves (`scpe`, `test`); the table seeds from the engine
tree (`ddp_probe dump`), not Java, so the corrected set lands automatically
([docs/ddp/02](ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves)).
Everything else — wire protocol,
engine init, persistence, UI generation, range validation — derives from
this table.

```rust
pub struct ParameterDef {
    pub name: &'static str,             // 4-CC: "dvla", "iebt", …
    pub length: ParamLength,            // fixed or aonb-derived
    pub range: (i16, i16),              // inclusive engine-unit bounds
    pub default: ParamDefault,          // scalar or per-band array
    pub kind: ParamKind,                // drives UI widget choice
    pub category: ParamCategory,        // for UI grouping
    pub access: ParamAccess,            // Settable / ReadOnly / Experimental
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
    ReadOnly,                   // DSP overwrites slot every audio block (vcbg, vcbe)
    Experimental,               // engine reads slot but original DDP UI hid it
}

pub enum ParamCategory {
    Basic, Ieq, Geq,
    VolumeLeveller, DialogEnhancer,
    HeadphoneVirtualizer, SpeakerVirtualizer, NextGenSurround,
    AudioRegulator, AudioOptimizer, VolumeMaximizer, PeakLimiter,
    Visualizer, EndpointVolume,
}
```

**Decibel kind.** `Decibel { lkfs, divisor }` keeps `divisor` as
metadata so the UI never hardcodes the 1/16 conversion factor —
each widget reads `def.divisor` from the injected bootstrap metadata and divides.
Every dB-coded AK param uses `divisor = 16` today (the binary
documents "scaled by 16 ie. 16 = 1 dB"); the metadata table stays
the canonical source. `lkfs: bool` switches the unit label from
`dB` to `LKFS` for `dvli`/`dvlo`.

**Parameter defaults.** For settable params, `default` is the engine's
intrinsic power-on value — what a freshly-created engine reports before
any profile is pushed, captured by probe (`make -C tools/ddp_probe
dump`). It's the base layer of the persistence overlay (Decision 7):
`defaults.toml` and `config.toml` store only divergences from it, so the
table is the single home for the per-param defaults the original DDP
repeated in full in every profile. The structural **constants** (band
counts / freq tables / channel count — `genb`, `ienb`, `aonb`, `aocc`,
`gebf`, …) are the exception: the engine powers on **10-band / `aocc=1`**,
but the host rewrites them to the standard **20-band stereo** config in
the init constant-params dance, so their `default` is that operational
value, not the boot state — and they sit outside the profile overlay.

**Three-bucket settability classification.** This is a deliberate
deviation from `docs/ddp/02-ak-parameters.md`'s "settable=yes/no"
binary. Empirically, the engine accepts cmd 3 SET against any
declared param and forwards the write to `ak_set` regardless of
Java's `isParamSettable` whitelist (direct evidence in
[tools/ddp_probe/](../tools/ddp_probe/README.md) section 5b). The
three buckets are about **DSP semantics + UI presentation**, not
engine-level acceptance:

- **Settable** — every param in Java's `isParamSettable` whitelist
  (42 params). DSP reads the value and produces well-defined
  bounded behaviour. Editable widgets in the Advanced panel.
- **ReadOnly** — `vcbg`, `vcbe` only. Directly observed via cmd 4:
  the DSP refreshes both slots every audio block, so any host write
  is clobbered on the next block. Cmd 4 returns `vcbg ‖ vcbe` as
  40 int16s in one round-trip; live-updated read-only displays in
  the UI ride the visualizer pump (see Decision 4 and Decision 10).
  Two families of slots that would naturally fit "ReadOnly" by DSP
  semantics are excluded from the metadata table entirely: (a)
  engine-internal build-version / license slots (`bver`, `bndl`, `ver`,
  `lcmf`, `lcvd`, `lcpt`) — the engine pre-populates them at
  DEFINE_SETTINGS time and they never change at runtime, so they'd only
  surface static values; (b) the native-visualizer family (`vnnb`,
  `vnbf`, `vnbg`, `vnbe`) — no cmd 4 path, and although `ak_get` confirms
  `vnbg`/`vnbe` are live and audio-tracking, they're a byte-for-byte
  mirror of `vcbg`/`vcbe` regardless of their own band config, so they
  carry nothing the visualizer pump doesn't already deliver. Both groups
  are dropped. The engine version
  string, which the original DDP UI does display, is exposed via
  the bootstrap `engine.version` field (sourced from cmd 6) instead
  of as an AK parameter — see Decision 6.
- **Experimental** — not exposed by original DDP, but the engine
  treats the slot as a real DSP input: `preg`, `pstg`, `endp`,
  `ocf`, `ven`, `vol`, `vcnb`, `vcbf`, `scpe`, `test`. Editable behind an
  "experimental" badge. (`scpe` (Surround Compressor enable) and `test`
  (Peak Limiter test mode) are real root leaves Java omits — added here;
  `mxou`, a Java phantom resolving to ref 0, is dropped. See
  [docs/ddp/02](ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves).)
  Behavioral confirmation that the DSP applies
  these params (read from the clamped registry, not the raw cache) is in
  [tools/ddp_probe/](../tools/ddp_probe/README.md) section 7: a `vmb`
  sweep over `{0, 120, 240, 480}` raises peak/rms up through `vmb=120`,
  then flattens at the top — `vmb=240` and `vmb=480` both clamp to the
  engine's `vmb` max of 192 (read back via `ak_get` in #2/#9). The decisive
  proof in the same section is a direct cache poke (registry frozen) the
  DSP ignores. A `dvla` sweep confirms the leveler also varies and
  collapses the same way (`dvla=10` and `dvla=200` give identical output,
  both clamped to 10). The same
  forwarding path applies to every Experimental param — cmd 3 SET
  fires `ak_set(idx/name, offset) = V` regardless of bucket
  (section 5b), so a host that drives `endp`, `vol`, etc. gets
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
(`aobg` ≤ 329, `arbi`/`arbl`/`arbh`/`aobf`/`arbf` 40) render in a wide
card with `grid-column: 1 / -1`, collapsed behind a toggle by default.
Tiny scalars pack densely; bulky arrays stay out of the way. Category
headers introduce visual groupings.

### Decision 4 — Wire protocol: name-based, originator-aware

> Persistent record: [ADR-0005 — Wire protocol: name-based, originator-aware, i16 1/16-dB throughout](adr/0005-wire-protocol-i16-name-based-originator-aware.md).

**Wire format.** The state snapshot, all `set_param` commands,
and the binary engine protocol carry raw int16 1/16-dB
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
snapshots are preferable to partial diffs. The snapshot carries user-state
only; engine metadata (version, backend) is delivered once via the bootstrap
`engine` field on page load — see Decision 6.

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
"status": -22, "message": "..." }`. The engine does **NOT** *reject*
out-of-range values, does **NOT** reject unknown 4-CCs in DEFINE_PARAMS,
does **NOT** reject non-zero offsets in DEFINE_SETTINGS — direct evidence
from [tools/ddp_probe/](../tools/ddp_probe/README.md) and the engine
string table (`_akSet: Wrong parameter index %d`,
`DS_PARAM_SINGLE_DEVICE_VALUE setting_index %i is invalid`,
`Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)`; no
range-check strings exist). But it does **silently clamp**: a cmd 3 SET
stores the raw value in the settings cache, while the forwarded `ak_set`
clamps the registry copy to the engine's own `[ak_get_min, ak_get_max]`
— and the DSP reads the **clamped registry** (ddp_probe #7).

This is why the daemon must still own range validation up front. An
out-of-range write isn't rejected — it's silently clamped to a range that
differs from the published table for some params (`vmb` clamps at 192,
not 240; `vol` at -2080, not -2048). Validating host-side gives
predictable, inspectable behaviour rather than relying on a hidden clamp
(probe section 7: `vmb=240` and `vmb=480` both clamp to 192; #2 reads the
clamped values back via `ak_get`).

**Visualizer source.** The daemon always reads the `vis` event's data
from the **oldest session** (the first entry in the session list),
regardless of its suspended state. If that session has no audio
flowing, `vis_suspended: true` is broadcast. The source does not
switch when the oldest session goes silent — it only changes when
that session ends, at which point the next-oldest becomes the source.
This keeps the visualiser predictable and avoids flicker between
sources.

**ReadOnly param updates.** The ReadOnly bucket has exactly two members,
`vcbg` and `vcbe`, both read from the engine via **cmd 4
(`DS_PARAM_VISUALIZER_DATA`) only** — the engine has no cmd 3 GET path, so
there's no fallback. Cmd 4 returns `vcbg ‖ vcbe` as 40 int16s in one
round-trip; the visualizer pump polls at 50 ms (Decision 10) and embeds the
result in the `vis` event. Experimental params (`preg`, `pstg`, `endp`,
`ocf`, `ven`, `vol`, `vcnb`, `vcbf`, `scpe`, `test`) update through the
regular state-snapshot path since the daemon owns the write side.

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
| 0x11 | `SetParams`      | `[u32 session_id][u16 n]( [4-CC name][u16 count][i16 × count] × n )` | empty                      |
| 0x20 | `GetVisualizer`  | `[u32 session_id]`                                    | `[i16 × 20 gains][i16 × 20 excitations]` |
| 0x30 | `Process`        | `[u32 session_id][u32 frames][i16 × frames × 2 pcm]`  | `[i16 × frames × 2 pcm]`                 |
| 0x40 | `Version`        | empty                                                 | `[u8 len][u8 × len utf-8]`               |

There is intentionally **no `GetParam` opcode** in v2. cmd 3 GET is
unimplemented in the engine — see
[docs/ddp/03-binary-protocol.md → Cmd 3 GET](ddp/03-binary-protocol.md#cmd-3-get-unimplemented).
An in-process `ak_get` *could* back a real per-param read (see
[docs/ddp/03 → The AK registry read path](ddp/03-binary-protocol.md#the-ak-registry-read-path)),
but v2 deliberately serves params from the daemon's own write-mirror plus
`config.toml` overlay instead of reading them back; an `ak_get` GET opcode
is a possible later addition, not part of this protocol.
`GetVisualizer` (mapped to cmd 4 in the engine wire protocol) reads the
live visualizer slots; version is served by the daemon from a cached cmd 6
result captured at init.

`SetParams` maps to the engine's cmd 2 (`DS_PARAM_ALL_VALUES`) — see the
batch-vs-single note under Decision 1.

The `Process` opcode wraps `libdseffect.so`'s `process()`, which carries
two contracts the daemon must honour (see
[ddp_probe](ddp/03-binary-protocol.md#practical-reminders)): it
**accumulates** into the output buffer (so the daemon zeroes it every
block — including disabled blocks, which pass the input through and
return `-ENODATA`), and it **clobbers its own input buffer** (so the
daemon keeps a scratch copy when it needs the original PCM).

The engine subprocess holds the session table and routes each command to the
right `effect_handle_t`. For v2.1 (Unicorn backend), this protocol is
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

A future optimisation (Latency optimization, below) replaces byte-stream socket audio with a
shared-memory ring buffer plus a socket for signalling, removing per-block
kernel transitions. Defer until measured latency motivates the work.

### Decision 5 — Daemon in Rust

> Persistent record: [ADR-0001 — Rust for the daemon](adr/0001-rust-daemon.md).

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

> Persistent record: [ADR-0006 — Solid.js UI with bootstrap injection, no `/api/*` routes](adr/0006-solid-ui-with-bootstrap-injection-no-api.md).

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
time and injects parameter metadata, the initial state snapshot, and
runtime engine info as a single `window.__BOOTSTRAP__` global:

```ts
window.__BOOTSTRAP__: {
  params: ParameterDef[],            // full metadata table — no /api/parameters
  state: StateSnapshot,              // user-state — mirrors the WebSocket "state" event
  engine: {                          // engine-info — bootstrap-only, immutable for session
    version: string,                 // cmd 6 result, e.g. "APPv1 version 2.0.4.0"
    backend: "qemu" | "unicorn" | "sbt",
  },
}
```

The bootstrap shape is intentionally wider than the WS `state` event:
`engine` is sent once on page load and never re-broadcast (cmd 6 returns
the same string for the lifetime of the engine subprocess). The daemon
reads `state` from the shared state lock and `engine` from
`EngineSupervisor::info()` when serializing the bootstrap. The UI reads
`window.__BOOTSTRAP__` synchronously at module init, hydrates the Solid
store, and paints the full UI — including any "About" / footer display
of `engine.version` — on the first frame. The WebSocket then connects in
the background; its `state` event reconciles any drift between HTML
render time and WS connect time (and handles reconnects) without needing
to re-deliver `engine`.

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

> Persistent record: [ADR-0007 — TOML overlay persistence with file watcher](adr/0007-toml-overlay-persistence-with-file-watcher.md).

Two TOML files in distinct locations:

- `config.toml` — user state, editable, in the platform-standard data dir.
  Windows: `%PROGRAMDATA%\DolbyX\config.toml`. Linux:
  `/var/lib/dolbyx/config.toml`.
- `defaults.toml` — factory defaults, user-editable, in the **same directory
  as the daemon binary**.

`defaults.toml` and `config.toml` both store **only deltas** over the
`ParameterDef.default` base (Decision 3) — `defaults.toml` each factory
profile / EQ preset's divergence from the per-param defaults,
`config.toml` the user's edits on top. A param absent from both
resolves to its `ParameterDef.default`; resolution is
`ParameterDef.default → defaults.toml → config.toml`. The two TOML
files mirror the original's `ds1-default.xml` / `ds1-current.xml` pair;
the `ParameterDef.default` base is a v2 refinement — the original
repeated the factory defaults in full in every profile, DolbyX factors
them out. The overlay is resolved at
load, so each in-memory profile is complete — a profile switch then
pushes it via Decision 4's `SetParams` (cmd 2), with no per-param
fallback. `defaults.toml` also drives
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
# no deltas — resolves to ParameterDef.default (flat: IEQ + GEQ both off)

[eq_preset.open]
name = "Open"
ieon = 1
iebt = [117, 133, 188, 176, 141, 149, 175, 185, 185, 200,
        236, 242, 228, 213, 182, 132, 110,  68, -27, -240]

[eq_preset.rich]
name = "Rich"
ieon = 1
iebt = [67, 95, 172, 163, 168, 201, 189, 242, 196, 221,
        192, 186, 168, 139, 102,  57,  35,   9, -55, -235]

[eq_preset.focused]
name = "Focused"
ieon = 1
iebt = [-419, -112,  75, 116, 113, 160, 165,  80,  61,  79,
          98,  121,  64,  70,  44, -71, -33,-100,-238,-411]

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

### Decision 10 — Visualizer/Equalizer rendering and feel

> Persistent record: [ADR-0008 — Visualizer / Equalizer rendering spec](adr/0008-visualizer-equalizer-rendering-spec.md).

The V/E is the single most visible piece of DDP; it must feel identical
to the original. Reference is the mobile DDPlus Android UI
(`docs/ui-reference/original-ui-visualizer-eq-overlay.png`): 5 cyan
circular thumbs riding a soft-glow cyan polyline over 20×48 spectrum
bricks. All constants and rules below are transcribed from
`decompiled/DsUI.apk/sources/com/dolby/ds1appUI/`.

**Pump.** Fixed 50 ms cadence, matching DDP's `DsService` loop:

```rust
// crates/ddp-daemon/src/visualizer_pump.rs
pub const VISUALIZER_PUMP_INTERVAL: Duration = Duration::from_millis(50);
pub const VISUALIZER_SUSPENDED_THRESHOLD: u32 = 10; // matches
                                                    // DsService.COUNTER_THRESHOLD; ≈500 ms
```

The pump reads from the **oldest session** (Decision 4) via cmd 4
(`DS_PARAM_VISUALIZER_DATA`) which returns `vcbg ‖ vcbe` as 40 int16s
in one round-trip; the Engine trait wraps it as
`VisualizerData { gains[20], excitations[20] }` (or `None` on empty).
Suspend/resume is symmetric (matches `DsService.visualizerUpdate`):
the threshold counter resets whenever the cmd 4 reply length
changes, so 10 consecutive empty reads enter suspended and 10
consecutive non-empty reads leave it. Entering broadcasts
`{ "type": "vis_suspended", "suspended": true }` and suppresses
`vis` events; leaving broadcasts `{ ..., "suspended": false }` and
resumes them. While not suspended the pump broadcasts
`{ "type": "vis", "gains": [...], "excitations": [...] }` with raw
int16 1/16-dB values. There is no cmd 3 GET path and no
separate ReadOnly channel — `vcbg`/`vcbe` are the only ReadOnly
params in the metadata table and they already ride this event.

**SVG layer stack** (z-order, top of stack = drawn last):

1. Background — radial gradient (dark navy → near-black) via a
   CSS variable theme.
2. Grid — 1-px black `<line>`s between every column and row.
3. Spectrum bricks — 20 cols × 48 rows. Brick `(c, r)` is filled iff
   `excitation_idx(c) ≥ 47 - r`; colour: `r < 12` red, `12 ≤ r < 18`
   yellow, `r ≥ 18` blue (`ROWS_RED = 12`, `ROWS_YELLOW = 6` in
   `GraphicVisualiserPainter.java`). Empty rows render as the dark
   "off" tile.
4. Level pip — one brighter cyan brick per column at the row for
   current `gains[c]` (the per-column EQ-curve indicator; sources
   from `vcbg`, same as the curve).
5. EQ overlay group — track + thumbs + curve glow + curve sharp,
   wrapped in an `<g>` with a CSS `opacity` transition for fade.

**dB mapping.** `dB ∈ [-12, +36]` mapped to 48 rows of 1 dB each.
Range is **asymmetric** — matches engine, not ±12. Overlay reserves
`thumbHeight / 4` padding top **and** bottom; usable track is
`H − 2·pad`.

**EQ curve.** Cyan `#75D2FF`, two-pass:

- Glow: stroke 10·scale, α 0x80 (50 %), SVG
  `<filter><feGaussianBlur stdDeviation="4·scale"/></filter>`, ROUND
  caps.
- Sharp: stroke 3·scale, α 0xD0 (≈82 %), `stroke-linejoin="round"`
  (default `BUTT` cap — the glow's rounded ends swallow the sharp
  ends visually).

The curve is a **polyline** with one vertex per engine band (=
`genb`), **not** a Catmull-Rom spline. Linear segments + rounded
joins reproduce the original mobile look (the original uses
`CornerPathEffect(10·scale)` instead of `linejoin=round`; visually
close enough at these stroke widths). Fractional thumb indices
(when visible thumb count < band count) linearly interpolate Y
between the two adjacent integer band gains
(`GraphicEqualizerPainter.translateGaindBToY`).

**Curve source.** The polyline reads from the latest `vis` event's
`gains` array (= `vcbg`, cmd 4) during steady state, and falls back
to the locally smoothed user buffer while `vis_suspended == true`.
`vcbg ≠ gebg`: `gebg` is the user's GEQ input parameter, while
`vcbg` is the composed EQ curve the engine is actually applying
(`gebg` blended with `iebt` per `ieon`). The overlay must reflect
what the engine produces, so `vcbg` is the only correct source —
rendering from stored `gebg` would hide the IEQ contribution. A
~50 ms drag lag is the structural consequence of the 50 ms vis pump
round-trip; the original DDP wears the same lag for the same reason
(`GraphicEqualizerPainter.onDraw` line 349 sources from `mGainsUi`,
the vcbg buffer).

**Thumbs.** Drawn at visible thumb positions only. During drag the
actively-dragged band uses the `eq_thumb_touch_state` variant;
every other thumb renders the default `eq_thumb` drawable. (The
original's `Bright1/2/3` cascade exists in code but
`Bright1 = Bright2 = eq_thumb`, so only distance 0 is visually
distinct — replicate that, not a 3-step gradient.) Overlay fades in
over **250 ms** on mousedown; **5000 ms** after last input it fades
out (`SHOW_HIDE_ANIMATION_DURATION`, `IDLE_HIDE_DELAY`).

**UI preferences** (persisted in browser `localStorage`, **not** in
`config.toml` — they are display prefs, not state):

| Pref                | Allowed values                           | Default  | Notes                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible thumb count | `N ∈ [2, genb]`; step = `(genb-1)/(N-1)` | `5`      | `N=5` → step 4.75 (matches reference screenshot, original mobile); `N=genb` → step 1 (original tablet, one thumb per band); other values (e.g. `N=10`) extend it. Capped at `genb` because the engine has no finer EQ resolution. |
| Smoother kernel     | `Mobile` / `Soft` / `Direct`             | `Mobile` | See kernels below                                                                                                                                                                                                                 |

Smoothing is **UI-only**. The wire and engine always carry the
smoothed, clamped 20-band `gebg` regardless of UI prefs.

**Touch/mouse pipeline.** A drag enqueues `(band, dB)` events into a
per-instance ring buffer (cap 20); consecutive events for the same
band overwrite. A `rAF`-throttled recalc loop drains the queue every
**60 ms** (30 ms while `vis_suspended`):

1. **handleNewTouchEvents** — for each event, compute
   `newUserGain = touchGain - (uiGain[b] - smooth[b])` (when not
   suspended; raw `touchGain` when suspended), then splat into
   the inclusive (2L+1)-cell window `temp[b ..= b+2L]` (every cell
   gets the same value — the "thick-brush" feel).
2. **smoothenCurve** — for each `temp` cell _outside_ `[minEditGain,
maxEditGain]`, decay toward the violated clamp with
   `α = 0.5^(Δt / 0.3s)`; in-range cells are untouched. Then
   convolve: `smooth[b] = Σ kernel[i] · temp[b + i]`. Skip-write
   threshold `|new - old| > 0.02 dB`.
3. Throttled `set_param gebg` — at most one per 60 ms; carries the
   smoothed, clamped 20-band int16 1/16-dB array to the daemon.

**Smoother kernels.**

```ts
const KERNELS = {
  Mobile: { L: 2, k: [0.1, 0.25, 0.3, 0.25, 0.1] }, // original mobile
  Soft: { L: 1, k: [0.25, 0.5, 0.25] }, // original tablet
  Direct: { L: 0, k: [1.0] }, // no smoothing
}
```

`τ = 0.3 s` exponential time-decay across all kernels.

**Inverse smoother.** On EQ-preset change (or any daemon `state`
broadcast that updates the active `gebg`), recompute `temp` from the
new `gebg` via the selected kernel's 20×20 pseudoinverse so the next
touch stays continuous. Precomputed
`GAIN_SMOOTHER_INV_MOBILE` / `_SOFT` ship as TS constants — values
come from `GraphicEqualizerPainter.java` lines 70–71 (`_TABLET` →
`_SOFT`, `_MOBILE` → `_MOBILE`). `Direct`'s inverse is the identity.

**Frequency labels.** Sourced at render time from the bootstrap
metadata's `gebf` entry — no hardcoded labels — so a future engine
with different band edges adapts automatically.

**Reference source — match the original look and feel.** Study these
when implementing:

- `GraphicVisualiser.java` — SurfaceView host + paint thread
- `GraphicVisualiserPainter.java` — spectrum bricks, `convertValue` mapping
- `GraphicEqualizerPainter.java` — kernels, inverse matrices, touch queue, glow paint setup, show/hide
- `FragGraphicVisualizer.java` — fragment wiring, IEQ preset grid + custom + reset
- `EqualizerAdapter.java` — IEQ preset cells

### Decision 11 — Bundle `libdseffect.so` with releases

> Persistent record: [ADR-0009 — Bundle `libdseffect.so` with releases](adr/0009-bundle-libdseffect-so.md).

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

// Runtime engine facts — not part of persistent State.
// Owned by EngineSupervisor; populated once at engine init from
// `Engine::version()` (cmd 6) plus the configured backend name.
// Surfaced to the UI via the bootstrap `engine` field (Decision 6);
// never broadcast over the WebSocket.
pub struct EngineInfo {
    pub version: String,
    pub backend: &'static str, // "qemu" | "unicorn" | "sbt"
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
│   │   ├── src/parameters.rs        #   AK metadata table (codegen'd, 54 entries)
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

During the build-out the v1 `arm/` and `daemon/` trees stay alongside the new
`crates/` as the reference implementation; the Solid `ui/` replaces the v1
vanilla-JS `ui/` in place. All v1 remnants are removed in one commit once v2.0
lands.

## Deep modules

The architecture above factors into the deep modules below. The vocabulary
follows [LANGUAGE.md](../.agents/skills/improve-codebase-architecture/LANGUAGE.md)
(**module** · **interface** · **implementation** · **depth** · **seam** ·
**adapter** · **leverage** · **locality**). Each module's **interface** is
the full surface a caller must know — types, invariants, error modes,
ordering — not just the type signature. The **deletion test** captures the
locality argument: removing the module either concentrates complexity in
one place (then the module was earning its keep — deep) or just moves
complexity to N callers (then it was a pass-through — shallow). Every
entry below passes the deletion test.

| Module | Interface | What's hidden | Introduced in |
|---|---|---|---|
| **`Engine`** trait (`ddp-engine`) | `create_session(sample_rate) → SessionId` · `destroy_session(id)` · `set_enabled(id, bool)` · `set_param(id, name, &[i16])` · `set_params(id, &[(name, &[i16])])` · `get_visualizer_data(id) → VisualizerData{gains[20], excitations[20]}` · `process(id, &input, &mut output)` · `version() → String`. All values are `i16` 1/16-dB. No `get_param` by design (engine has no cmd 3 GET — daemon owns the state mirror). | QEMU subprocess lifecycle, binary protocol framing, session table, ARM-side multiplexing. Later: Unicorn ELF loader, Android stubs. **Two adapters** (Stub + QEMU) — real seam, not hypothetical. | Slice 1 (Stub), Slice 9 (QEMU) |
| **`EngineSupervisor`** (`ddp-daemon`) | `start() → Result<EngineInfo>` · `shutdown()` · `info() → EngineInfo{version, backend}` · session ops mirroring `Engine`. Errors: `EngineCrashed`, `HandshakeFailed`, `SessionNotFound`. | Subprocess respawn on crash, session map, init handshake (DEFINE_PARAMS → DEFINE_SETTINGS → constant-params dance → VISUALIZER_ENABLE → EFFECT_CMD_ENABLE), `EngineInfo` caching from cmd 6. `set_enabled` applies to every live session; a session created while power is off starts disabled. | Slice 1 |
| **`State`** (`ddp-state`) | `State::new_from_defaults(&Defaults)` · `apply(Command) → Result<StateDiff, ValidationError>` · accessor methods for power / selected_profile / profiles / eq_presets. Invariants: `selected_profile` always exists; every `Profile::selected_eq_preset` always exists; deleting a referenced EQ preset falls profiles back to `"off"`. | Factory overlay, `is_factory` derivation from `Defaults` presence, validation against `ParameterDef` (4-CC declared, length matches, value in range), profile / preset CRUD invariants. I/O-free. | Slice 1 (just `power`), grown each slice |
| **`ParameterDef` table** (`ddp-state`) | `lookup(name: &str) → Option<&ParameterDef>` · `iter() → impl Iterator<…>`. Returned `ParameterDef` carries `name`, `length`, `range`, `default`, `kind`, `category`, `access`, `label`, `help`, `basic`. | 54 entries × ~10 fields each, codegen'd at build time from `parameters.toml`. The three-bucket Settable / ReadOnly / Experimental classification (see ADR-0004). | Slice 0 (codegen), used Slice 1+ |
| **`Persistence`** (`ddp-persistence`) | `load(defaults_path, config_path) → State` · `flush(&State)` (500 ms debounced; debounce shared across all on-disk fields) · `watch(callback)`. Errors: `ParseError`, `MigrationFailed`. | `defaults.toml` + `config.toml` overlay, `notify` watcher, mtime self-write suppression (1 s quiet window), schema migration from v1, debounce timer. | Slice 1 |
| **`HttpServer`** (`ddp-daemon`) | One route only: `GET /` → bootstrap-injected HTML. Bind address from config. | rust-embed prod asset for `index.html` + `<!--BOOTSTRAP-->` string-replace, hardcoded dev-mode HTML literal referencing `:5173`, `window.__BOOTSTRAP__` JSON serialisation of `params[] + state + engine`. Cargo feature `embedded-ui` toggles dev vs prod producers. | Slice 1 |
| **`WsServer` + `WsCommands`** (`ddp-daemon`) | `WsServer::accept(stream)` registers an originator. `WsCommands::dispatch(originator, Command) → Event` typed via `serde`. Errors: `INVALID_PARAM` (daemon-side validation) and `ENGINE_REJECTED` (status −22 from engine). | Originator id assignment + echo suppression, command validation against `ParameterDef`, ack envelope, broadcast routing, full state snapshot on `get_state` and on connect. | Slice 1 |
| **`VisualizerPump`** (`ddp-daemon`) | `start(supervisor, broadcaster)` → `JoinHandle` · `stop()`. Constants: `VISUALIZER_PUMP_INTERVAL = 50 ms`, `VISUALIZER_SUSPENDED_THRESHOLD = 10` ticks. | 50 ms cadence loop, 10-tick `vis_suspended` hysteresis on empty cmd-4 reads, oldest-session source-of-truth rule, `vis` / `vis_suspended` event emission. | Slice 5 |
| **`AudioServer`** (`ddp-daemon`) | `accept_loop(supervisor) → !`. Plugin protocol: `Hello{sample_rate, max_frames}` → `HelloAck{session_id}` · `Process{frames, pcm}` → `Processed{pcm}` · `Goodbye`. | Per-platform socket accept (Windows named pipe `\\.\pipe\DolbyX` vs Unix `/tmp/dolbyx.sock`), session-id allocation, audio multiplexing onto the shared engine subprocess. **Two adapters** (named-pipe + AF_UNIX) — real seam. | Slice 10 |
| **UI `GainSmoother`** (`ui/src/lib/gain_smoother.ts`) | `enqueue(band, dB)` · `tick() → Option<[i16; 20]>` (returns smoothed, clamped 20-band write, or `None` if nothing pending). | 5-cell thick-brush splat, τ=0.3 s exponential decay toward clamps, kernel convolution (`Mobile` / `Soft` / `Direct`), 60 ms drain throttle, 20×20 pseudoinverse on preset-change broadcasts for drag continuity. | Slice 6 |

`is_factory`, the three-bucket settability classification, and the
debounce-shared write semantics are not free-floating concepts — they
live behind specific module interfaces above and are documented there.

## Implementation phases

Phases are organised as **vertical tracer-bullet slices** per
[to-issues](../.agents/skills/to-issues/SKILL.md) skill: each slice
cuts through every layer it touches and ships something demoable on its
own. Each TDD slice is then implemented with the
[tdd](../.agents/skills/tdd/SKILL.md) skill — one test → one
impl → repeat; never write all tests up front. Slices 0–10 constitute
the v2.0 release. v2.1+ and v3.0 follow.

Each TDD slice carries six fields:

- **Slice goal** — one sentence, demoable.
- **Modules introduced** — references the *Deep modules* table.
- **Behaviors to test** — the red → green worklist (checkboxes track
  progress).
- **Tracer bullet** — the very first test in the loop, picked so the
  initial RED is a one-line assertion that proves the full path.
- **Mock policy** — what stays Stub vs. real (per
  [mocking.md](../.agents/skills/tdd/mocking.md), mock only at
  system boundaries — the `Engine` trait is one).
- **HITL/AFK** — whether the slice can complete unattended (AFK) or
  needs a human in the loop (HITL).

### Slice 0 — Workspace bootstrap (scaffold only, no TDD)

Pure scaffolding — no user-visible behavior to test, so the `tdd` skill
does not apply. Treat this slice as one-shot setup.

- New Cargo workspace with the crate skeleton above.
- Top-level `Justfile` with `dev`, `build-release`, `lint`, `test`
  recipes.
- CI scaffolding: GitHub Actions running `cargo check`, `cargo test`,
  `cargo clippy`, `cargo fmt --check` on Linux + Windows.
- Solid + Vite UI scaffolding with TypeScript, ESLint, Prettier;
  `vite-plugin-solid`, `vite-plugin-singlefile`,
  `@solidjs/testing-library`, and `eslint-plugin-solid` pinned. No
  Tailwind — plain CSS with BEM + `theme.css` of CSS variables.
- `defaults.toml` created from `ds1-default.xml` — each factory profile
  / EQ preset stored as its delta over the `ParameterDef.default` base.
- AK parameter metadata table (`parameters.toml` + codegen) populated
  with all 54 surfaced entries, **seeded from the engine tree**
  (`make -C tools/ddp_probe dump-tree`) — authoritative names, ranges,
  frac bits, and one-line descriptions straight from the binary — *not*
  transcribed from Java / [02](ddp/02-ak-parameters.md). (The engine also
  carries a long per-param help string, `make -C tools/ddp_probe dump-docs`,
  available for UI tooltips.) Seeding from the
  engine corrects Java's param-set bug for free: it drops the `mxou`/`lcsz`
  phantoms (node params that resolve to ref 0) and picks up the real leaves
  Java omits, `scpe`/`test` (both Experimental). Three-bucket Settable /
  ReadOnly / Experimental classification per
  [ADR-0004](adr/0004-parameter-metadata-as-single-source-of-truth.md).
  Each settable entry's `default` is the engine's power-on value
  (`make -C tools/ddp_probe dump-defaults`), not 02's Music-profile column;
  structural constants (band counts, freq tables, `aocc`) carry their
  host-set 20-band values instead — the engine boots 10-band (see
  Decision 3).
  (The 10 omitted entries — 6 static engine-internal build-version /
  license slots `bver`, `bndl`, `ver`, `lcmf`, `lcvd`, `lcpt` plus the 4
  native-visualizer slots `vnnb`, `vnbf`, `vnbg`, `vnbe` (live via `ak_get`
  but a mirror of `vcbg`/`vcbe`) — carry nothing the host needs.)

**Progress checklist:**

- [ ] Cargo workspace + crate skeleton compiled
- [ ] Justfile recipes work end-to-end (`just dev`, `just lint`, `just test`)
- [ ] GitHub Actions CI green on Linux + Windows runners
- [ ] UI scaffold builds via `pnpm --prefix ui build`
- [ ] `defaults.toml` round-trips through TOML parser
- [ ] `parameters.toml` → codegen `parameters.rs` produces 54 entries
- [ ] `parameters.toml` seeded from `make -C tools/ddp_probe dump-tree` (drops `mxou`/`lcsz`, adds `scpe`/`test`)
- [ ] Settable `ParameterDef.default` values captured via `make -C tools/ddp_probe dump-defaults`
- [ ] All linters / formatters / type-checkers clean

**HITL/AFK:** HITL — module layout warrants a human review pass before
the first commit lands on `main`.

---

### Slice 1 — Power toggle, persisted end-to-end (tracer bullet)

**Slice goal.** A user opening `http://localhost:9876` sees a Power
toggle. Clicking it flips state, the `StubBackend` records the
`set_enabled` call, and the change survives a daemon restart.

This is the **tracer bullet**: the smallest possible end-to-end path
through every architectural layer (UI · WS · daemon · engine ·
persistence). Once green, every later slice extends one axis.

**Modules introduced.** `Engine` (Stub adapter only), `State` (just
`power` and `selected_profile = "music"`), `Persistence`,
`HttpServer`, `WsServer + WsCommands(get_state, set_power)`,
`EngineSupervisor` (just enough to drive Stub). UI shell: the
auto-reconnecting WebSocket client (`ws.ts`), `ConnectionBadge.tsx`,
and an About/footer surface that renders `window.__BOOTSTRAP__.engine`.

**Behaviors to test (red → green order):**

1. [ ] Daemon binds `:9876`; `GET /` returns HTML carrying a valid
       `window.__BOOTSTRAP__` JSON payload (params, state, engine).
2. [ ] WS `/ws` connects; first frame is a `state` event matching the
       current `State`.
3. [ ] WS `set_power { on: false }` flips `State.power`; daemon
       replies with an `ack` carrying the originator-matching
       `request_id`.
4. [ ] After `set_power`, the `StubBackend` recorded
       `set_enabled(session, false)` exactly once.
5. [ ] Two concurrent WS clients connect; one issues `set_power`;
       only the *other* receives the broadcast `state` event
       (originator echo suppression — see
       [ADR-0005](adr/0005-wire-protocol-i16-name-based-originator-aware.md)).
6. [ ] `power` change debounces 500 ms then writes to `config.toml`
       (overlay semantics — see
       [ADR-0007](adr/0007-toml-overlay-persistence-with-file-watcher.md)).
7. [ ] Daemon restart reloads `power` from `config.toml`.
8. [ ] Malformed JSON command returns
       `{ type: "error", code: "INVALID_PARAM", … }` and does not
       crash the session.
9. [ ] The WebSocket client auto-reconnects after the daemon restarts
       or the socket drops; on reconnect it re-issues `get_state` and
       reconciles, and `ConnectionBadge` reflects connected /
       reconnecting (Decision 6).
10. [ ] The About/footer surface renders
       `window.__BOOTSTRAP__.engine` — e.g. `Engine: STUB · stub
       0.0.0` under the Stub backend; the real
       `Engine: QEMU · libdseffect.so 2.0.4.0` string is verified in
       Slice 9.
11. [ ] Refactor pass — extract duplication revealed by 1–10 without
       breaking any green test ([tdd](../.agents/skills/tdd/SKILL.md):
       never refactor while RED).

**Tracer bullet test.** Integration test: start daemon with
`StubBackend`, connect via WS, send `{ "cmd": "set_power", "on":
false }`, assert `StubBackend` recorded
`set_enabled(session, false)` exactly once. Real `axum` test client,
real `tokio-tungstenite` against a bound port — no mocking past the
`Engine` trait.

**Mock policy.** `StubBackend` is the only stand-in. HTTP and WS run
real; persistence runs against a real `tempdir`.

**HITL/AFK:** AFK after Slice 0 lands.

---

### Slice 2 — Factory profile selection applies AK overrides

**Slice goal.** Switching the selected profile via the UI flushes that
profile's AK parameter overrides to the engine; the change persists.

**Modules introduced.** `State.profiles` (factory only — Movie, Music,
Game, Voice), `WsCommands(set_profile, reset_profile)`, profile-picker
UI component, factory-state bootstrap.

**Behaviors to test:**

1. [ ] `Defaults::load(defaults.toml)` produces all 4 factory profiles
       with their declared AK overrides.
2. [ ] `State::new_from_defaults` selects `"music"` (first-run UX,
       Decision 8).
3. [ ] WS `set_profile { id: "movie" }` updates `selected_profile`.
4. [ ] On profile switch, the daemon pushes the selected profile's full
       parameter set to the engine atomically via `set_params`.
5. [ ] `selected_profile` persists across daemon restart.
6. [ ] `reset_profile { id: "music" }` clears `config.toml`'s
       per-profile overrides; UI receives a fresh state snapshot.
7. [ ] `set_profile { id: "nonexistent" }` returns
       `INVALID_PARAM`, leaves state unchanged.

**Tracer bullet test.** Start daemon, WS `set_profile {id:"movie"}`,
assert `StubBackend` recorded a single `set_params` call carrying
Movie's full parameter set.

**Mock policy.** Stub only.

**HITL/AFK:** AFK.

---

### Slice 3 — Factory EQ presets apply IEQ curves

**Slice goal.** Selecting an EQ preset (Off / Open / Rich / Focused)
writes the preset's `iebt[20]` and `ieon` to the engine; the active
profile records the selected preset id.

**Modules introduced.** `State.eq_presets`, `Profile.selected_eq_preset`,
`WsCommands(set_eq_preset, reset_eq_preset)`, EQ-preset picker UI.

**Behaviors to test:**

1. [ ] Factory EQ presets load from `defaults.toml` per
       [ADR-0003](adr/0003-global-eq-presets-and-geq-per-preset.md).
2. [ ] On `set_eq_preset { id: "rich" }` the engine receives the
       preset's `iebt[20]` and `ieon=1` in one atomic `set_params`; the
       preset id is stored on the active profile.
3. [ ] Switching to `"off"` writes `ieon=0` and zero `iebt`.
4. [ ] Editing a preset's `iebt` via `edit_eq_preset` immediately
       affects *every* profile currently selecting that preset
       ([ADR-0003](adr/0003-global-eq-presets-and-geq-per-preset.md)).
5. [ ] `selected_eq_preset` persists per-profile across restart.

**Tracer bullet test.** WS `set_eq_preset { id: "rich" }`, assert
`StubBackend` recorded one `set_params` carrying `iebt = [67, 95, …, -235]`
and `ieon = 1`.

**Mock policy.** Stub only.

**HITL/AFK:** AFK.

---

### Slice 4 — Master controls (Volume Leveller / Dialog Enhancer / Surround Virtualizer)

**Slice goal.** The main screen shows the three signature DDP
controls — Volume Leveller, Dialog Enhancer, Surround Virtualizer —
each a toggle plus an amount slider. Adjusting one writes the backing
AK param(s) to the active profile, flushes to the engine, and persists.

**Modules introduced.** `BasicSwitches.tsx` with bespoke toggle +
amount-slider widgets for the `basic`-flagged digest params (`dvla`,
`deon`/`dea`, `vdhe`, … — exact set per
[docs/ddp/02-ak-parameters.md](ddp/02-ak-parameters.md)); reuses
`WsCommands(set_param)` against the active profile.

**Behaviors to test:**

1. [ ] The three master controls render from the `basic`-flagged
       params in the bootstrap metadata, grouped by their
       `ParameterDef.category` (Volume Leveller / Dialog Enhancer /
       Surround Virtualizer).
2. [ ] Toggling Volume Leveller writes its enable param to the active
       profile and flushes to the engine via `set_param`.
3. [ ] Dragging the Dialog Enhancer amount slider writes `dea` to
       the active profile.
4. [ ] The Surround Virtualizer toggle writes `vdhe` per its
       `ParamKind::Tristate { on }` mapping (0 / 1 / 2).
5. [ ] Master-control values are per-profile overrides — switching
       profiles (Slice 2) shows that profile's values.
6. [ ] Edits persist across daemon restart.
7. [ ] A master-control edit broadcasts to other clients, originator
       suppressed.

**Tracer bullet test.** Start daemon with `StubBackend`, WS
`set_param` for the Volume Leveller amount on Music, assert
`StubBackend` recorded the write and `config.toml` persisted it.

**Mock policy.** Stub. UI via `@solidjs/testing-library` with a mocked
WebSocket ([ADR-0006](adr/0006-solid-ui-with-bootstrap-injection-no-api.md)).

**HITL/AFK:** AFK.

---

### Slice 5 — Visualizer pump + suspended-state detection

**Slice goal.** With the daemon running, the UI shows a 20×48 SVG
spectrum brick field driven by `vis` events at 50 ms. When audio
stops, `vis_suspended: true` is broadcast and the spectrum freezes.

**Modules introduced.** `VisualizerPump` (50 ms cadence, 10-tick
hysteresis), `Visualizer.tsx` SVG component, `vis` event handling in
`ws.ts`, StubBackend canned `vcbg`/`vcbe` data for tests.

**Behaviors to test:**

1. [ ] `VisualizerPump::start` polls `Engine::get_visualizer_data`
       every 50 ms ± 5 ms.
2. [ ] Each non-empty read broadcasts a `vis` event with both
       `gains[20]` and `excitations[20]` as raw int16 1/16-dB.
3. [ ] 10 consecutive empty reads latch `vis_suspended: true`; `vis`
       emission stops.
4. [ ] 10 consecutive non-empty reads latch `vis_suspended: false`;
       `vis` emission resumes.
5. [ ] Pump reads from the oldest session; when that session ends,
       source switches to the next-oldest (Decision 4).
6. [ ] SVG renders 20 columns × 48 rows; brick colour matches the
       `r<12` / `12≤r<18` / `r≥18` rule from
       [ADR-0008](adr/0008-visualizer-equalizer-rendering-spec.md).
7. [ ] dB mapping is asymmetric `[-12, +36]` per
       [ADR-0008](adr/0008-visualizer-equalizer-rendering-spec.md).

**Tracer bullet test.** Start daemon with `StubBackend` programmed to
return fixed canned `vcbg`/`vcbe`; subscribe via WS; assert ≥ 18 of
the next 20 `vis` events arrive within 50 ms ± 10 ms of each other
carrying the canned data verbatim.

**Mock policy.** Stub canned data only. The real engine's cmd-4
contract is verified independently in Slice 9.

**HITL/AFK:** AFK.

---

### Slice 6 — GEQ editing with smoother + inverse

**Slice goal.** A user drags an EQ thumb; the daemon receives
smoothed, clamped 20-band `gebg` writes throttled at ≤ 60 ms
intervals. Switching EQ presets keeps the next drag continuous via
the inverse-smoother matrix.

**Modules introduced.** UI `GainSmoother` (thick-brush splat, kernel
convolution, exponential decay, inverse-on-preset-change),
`EqCurve.tsx`, `WsCommands(set_param)` for `gebg`, GEQ-thumb pointer
pipeline.

**Behaviors to test:**

1. [ ] `enqueue(band, dB)` followed by `tick()` returns a smoothed
       20-band int16 array within the engine's `gebg` clamp.
2. [ ] Kernel selection (`Mobile` / `Soft` / `Direct`) changes the
       output shape per the matrices in `GraphicEqualizerPainter.java`.
3. [ ] Out-of-range values decay toward the violated clamp with
       `α = 0.5^(Δt / 0.3s)`.
4. [ ] `tick()` emits at most one write per 60 ms (30 ms while
       `vis_suspended`).
5. [ ] On `state` broadcast updating active `gebg`, the
       inverse-smoother repopulates `temp` so the next touch stays
       continuous.
6. [ ] WS `set_param { name: "gebg", values: [...] }` forwards to
       `StubBackend::set_param("gebg", _)` correctly.
7. [ ] EQ curve renders as a polyline with rounded joins (not
       Catmull-Rom) per
       [ADR-0008](adr/0008-visualizer-equalizer-rendering-spec.md).

**Tracer bullet test.** Vitest unit test — feed a known drag trace
into `GainSmoother`, assert the emitted 20-band write matches a
golden snapshot generated from the Java reference.

**Mock policy.** Stub. The `GainSmoother` is pure UI math —
unit-testable in isolation per
[interface-design.md](../.agents/skills/tdd/interface-design.md)
("return results, don't produce side effects"). Drag-to-WS path tested via
`@solidjs/testing-library` with a mocked WebSocket
([ADR-0006](adr/0006-solid-ui-with-bootstrap-injection-no-api.md)).

**HITL/AFK:** HITL — golden snapshots from the Java reference need
manual visual verification once before locking in.

---

### Slice 7 — Custom profiles & EQ presets (full CRUD)

**Slice goal.** Users can add, rename, edit, delete, and reset custom
profiles and custom EQ presets. Deletes fall referencing items back
to safe defaults.

**Modules introduced.** `WsCommands(add_profile, rename_profile,
remove_profile, add_eq_preset, rename_eq_preset, edit_eq_preset,
remove_eq_preset)`, derived `is_factory`, CRUD UI affordances.

**Behaviors to test:**

1. [ ] `is_factory(id)` is derived from `Defaults` presence; not
       stored on disk.
2. [ ] `add_profile { from: "music", name: "Late Night" }` clones
       Music's overrides under a freshly generated id
       (`user_<hash>`).
3. [ ] Renaming a custom profile updates `name`, not `id` (id stable;
       persistence keys on id).
4. [ ] Factory items cannot be deleted or renamed — daemon returns
       `INVALID_PARAM`.
5. [ ] Deleting a custom EQ preset that N profiles select falls all
       of them back to `"off"`.
6. [ ] Deleting a custom profile currently selected falls back to
       `"music"`.
7. [ ] `reset_profile` / `reset_eq_preset` clears `config.toml`
       overrides for that id; factory rows in `defaults.toml` stay
       untouched.
8. [ ] All CRUD ops persist across restart.

**Tracer bullet test.** Add a custom profile from Music, rename it,
restart the daemon, assert it survived with the new name and same
overrides.

**Mock policy.** Stub.

**HITL/AFK:** AFK.

---

### Slice 8 — Advanced panel auto-generated for all 54 AK parameters

**Slice goal.** Opening the Advanced section renders every surfaced
AK parameter as a widget chosen by its `ParamKind` × `ParamAccess`.
Settable / Experimental widgets write back through WS; ReadOnly cards
live-update from `vis` events.

**Modules introduced.** `WidgetFactory.tsx`, the nine widget
components (`ToggleWidget`, `TristateWidget`, `IntegerWidget`,
`DecibelWidget`, `FrequencyWidget`, `DegreesWidget`,
`ArrayPerBandWidget`, `AobgWidget`, `ReadOnlyWidget`), category-grouped
CSS-grid layout.

**Behaviors to test:**

1. [ ] Bootstrap delivers all 54 `ParameterDef` entries in stable
       table order.
2. [ ] `WidgetFactory` dispatches by `(ParamKind, ParamAccess)`;
       every kind has a matching widget; unknown combos render an
       opaque-int fallback with a console warn.
3. [ ] Settable widgets emit `set_param` on commit (debounced 60 ms
       for continuous controls).
4. [ ] Experimental widgets render with a small "experimental" badge
       ([ADR-0004](adr/0004-parameter-metadata-as-single-source-of-truth.md)).
5. [ ] ReadOnly widgets (only `vcbg`, `vcbe`) live-update from `vis`
       events.
6. [ ] `aobg` widget renders the channel-id-prefixed layout
       (Decision 3), not header + interleaved pairs.
7. [ ] Long arrays (`aobg ≤ 329`, `arbi`/`arbl`/`arbh`/`aobf`/`arbf`
       40) render in a wide card collapsed by default.
8. [ ] Category headers introduce groupings; Basic params appear
       first.

**Tracer bullet test.** Render `AdvancedPanel` with a fixture of 54
params, assert 54 widgets appear in a `data-testid`-matched grid;
one Settable Toggle commit fires the expected WS message.

**Mock policy.** Stub (engine side) + real `axum` (HTTP/WS). UI tests
use `@solidjs/testing-library` with a mocked WS
([ADR-0006](adr/0006-solid-ui-with-bootstrap-injection-no-api.md)).

**HITL/AFK:** AFK.

---

### Slice 9 — Real engine (`QemuBackend`) — swap & replay

**Slice goal.** Replace `StubBackend` with `QemuBackend` in the
default daemon configuration; the integration test suite from Slices
1–8 re-runs against the real engine and stays green.

This is the **swap-and-replay** slice. Reusing the same integration
tests against the real engine exercises exactly where the risk lives
(binary protocol, init handshake, DEFINE_PARAMS / DEFINE_SETTINGS,
constant-params dance) — [tests.md](../.agents/skills/tdd/tests.md)
("integration tests survive refactors") makes this approach load-bearing.

**Modules introduced.** `QemuBackend` (`ddp-engine`),
`ddp-engine-arm` ARMv7 binary, shared `protocol.rs`.

**Behaviors to test:**

1. [ ] `ddp-engine-arm` cross-compiles for
       `armv7-unknown-linux-gnueabihf`.
2. [ ] `QemuBackend::start` spawns one `qemu-arm-static` subprocess
       and completes the init handshake:
       - `DEFINE_PARAMS` with the 54 surfaced 4-CC names (omits the
         10 unreadable slots — engine version flows via cmd 6 →
         bootstrap `engine.version`).
       - `DEFINE_SETTINGS` with the full `(param_idx, offset)`
         expansion (~422 cache slots, ~0.8 KB init payload).
       - Constant-params writes (`genb=20`, `ienb=20`, `aonb=20`,
         `gebf[…]`, …) via cmd 3 — the engine powers on 10-band, so
         this dance establishes the 20-band stereo config.
       - `VISUALIZER_ENABLE` SET.
       - `EFFECT_CMD_ENABLE`.
3. [ ] All Slices 1–8 integration tests pass under
       `cargo test --features qemu`.
4. [ ] `tools/ddp_probe/` regression harness runs in CI under
       `qemu-user-static` and verifies the documented validation
       surface (cmd 3 GET unimplemented but `ak_get` reads the registry,
       cache-raw vs registry-clamped, 7560 / 5512 sample crossfade).
5. [ ] `EngineSupervisor` respawns the subprocess on crash; the
       session map is reconstructed transparently.
6. [ ] `QemuBackend::version()` returns `"APPv1 version 2.0.4.0"`
       (cmd 6); the value reaches
       `window.__BOOTSTRAP__.engine.version`.

**Tracer bullet test.** `cargo test --features qemu -p ddp-daemon
power_toggle_persists` — the Slice-1 tracer bullet test, now against
the real engine.

**Mock policy.** Real engine. `StubBackend` stays in the codebase for
fast inner-loop tests; the `qemu` cargo feature toggles which backend
the integration tests bind to.

**HITL/AFK:** HITL — the first QEMU green run requires manual
investigation of any init-handshake delta. The engine doesn't emit
explicit errors for many things
([ADR-0005](adr/0005-wire-protocol-i16-name-based-originator-aware.md)),
so silent failures look like clean exits.

---

### Slice 10 — Plugins ferry audio (Win VST2 + Linux LV2)

**Slice goal.** With the daemon running, loading the VST in
EqualizerAPO (Windows) or `dolbyx.lv2` in PipeWire `filter-chain`
(Linux) ferries playback audio through the shared engine subprocess;
the visualizer responds; the EQ takes effect.

**Modules introduced.** `AudioServer` (`ddp-daemon`),
`ddp-vst-windows` cdylib, `ddp-lv2-linux` cdylib, plugin protocol
(`Hello` / `HelloAck` / `Process` / `Processed` / `Goodbye`).

**Behaviors to test:**

1. [ ] Windows daemon binds `\\.\pipe\DolbyX`; Linux daemon binds
       `/tmp/dolbyx.sock`.
2. [ ] Plugin `Hello {sample_rate, max_frames}` is acked with a
       fresh `session_id` from `EngineSupervisor::create_session`.
3. [ ] `Process` frames round-trip through the shared engine
       subprocess; processed PCM differs from input when the engine
       is enabled (verifiable via the crossfade ramp from
       `tools/ddp_probe/`).
4. [ ] Two plugin instances multiplex correctly — each on its own
       session, no audio crosstalk.
5. [ ] `Goodbye` cleanly destroys the session.
6. [ ] VST `effEditOpen` launches `http://localhost:9876` via
       `ShellExecuteW`.
7. [ ] PipeWire `filter-chain` config example loads successfully
       (smoke-only).
8. [ ] A plugin `Hello` at 48000 Hz drives `create_session(48000)`; the
       ARM engine applies the `Ds1ap::New` hot-swap so processed audio
       keeps correct pitch (not resampled to 44.1).
9. [ ] Toggling power fans `set_enabled` out to all live sessions; a
       session created while power is off starts disabled.

**Tracer bullet test.** A minimal "loopback" integration test —
start the daemon, connect a synthetic plugin client over the
platform socket, push silence frames, assert `Processed` returns the
same frames (within engine-applied transient bounds).

**Mock policy.** Real engine + real socket. Two adapters (named-pipe
+ AF_UNIX) ⇒ real seam, not hypothetical — per
[DEEPENING.md](../.agents/skills/improve-codebase-architecture/DEEPENING.md)
both must be tested.

**HITL/AFK:** HITL — end-to-end smoke-test requires manual install
of the plugin in EqualizerAPO / PipeWire.

---

**Slices 0–10 complete v2.0.**

### v2.1 — Unicorn backend

- Custom ELF loader for `libdseffect.so` (parses sections, maps into
  Unicorn memory).
- Android stub library: implements `__android_log_print`,
  `String8::String8`, `VectorImpl`, and other imports in native Rust.
- `UnicornBackend` in `ddp-engine`, sharing the same `Engine` trait
  surface — replays Slices 1–8 tests under `--features unicorn`.
- Switch the default backend on Windows from QEMU/WSL2 to Unicorn.
- Enables macOS port.

### v3.0 — macOS port

- `ddp-driver-macos`: AudioServerPlugin virtual device
  (libASPL-based).
- nix-darwin module.
- macOS-specific UI controls (output device selector).
- Manual install docs.

### Latency optimization (incremental, no version pin)

- Shared-memory ring buffers for the plugin ↔ daemon audio path;
  socket retained for signalling.
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

| Aspect                    | v1                                                   | v2                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon language           | C                                                    | Rust                                                                                                                                                                                           |
| Engine integration        | Per-stream QEMU subprocess                           | One shared QEMU subprocess, all sessions multiplexed; swappable Engine trait                                                                                                                   |
| Profile model             | Fixed 6-slot array                                   | Dynamic `Vec<Profile>` with factory + custom                                                                                                                                                   |
| EQ preset model           | Per-profile static array                             | Global `Vec<EqPreset>`; edits affect all profiles uniformly                                                                                                                                    |
| GEQ model                 | 6 × 4 × 20 matrix                                    | One GEQ per EQ preset (decoupled from profile)                                                                                                                                                 |
| Wire format               | Mixed dB / int16                                     | int16 1/16-dB throughout; dB conversion is UI-only                                                                                                                                             |
| Wire protocol             | Parameter indices; cmd 3 GET swallowed silently      | Parameter names (4-CC); single source of truth via metadata table; cmd 3 SET (single edits) + cmd 2 (bulk profile/preset apply); cmd 4 visualizer, cmd 6 version; daemon caches everything else|
| Param coverage            | 24 of 64 AK params                                   | All 54 surfaced AK params in DEFINE_PARAMS/SETTINGS; Settable / ReadOnly / Experimental per docs/ddp/02; 10 unreadable slots omitted (6 license/build, 4 vnb\*)                                |
| Web UI                    | Vanilla JS embedded in daemon                        | Solid + TypeScript + Vite; plain CSS + BEM; separate dev workflow; daemon injects bootstrap (metadata table + initial state + engine info) into `index.html`; embedded at release build        |
| Persistence               | Multi-file XML                                       | Two TOML files: `defaults.toml` (next to the daemon binary) + `config.toml` (platform data dir); table-per-id; overlay semantics; 500 ms debounce                                              |
| External edits            | Not supported                                        | `notify`-based watcher on both TOML files; debounced reload + state-snapshot broadcast                                                                                                         |
| Visualizer                | Gains only                                           | Gains + excitations; suspended-state detection (len==0 for N ticks)                                                                                                                            |
| Power off                 | Zero-out the OFF profile                             | `EFFECT_CMD_DISABLE` on the engine; engine performs graceful crossfade; idempotent; parameter state survives the toggle                                                                        |
| Custom profile categories | Labelled (Movie / Music / Game / Voice / Customized) | Removed; custom profiles are just named profiles                                                                                                                                               |
| First-run defaults        | Undefined                                            | Music profile + power on, matching original DDP out-of-box                                                                                                                                     |
