# DolbyX v2 — Rearchitecture Plan

This document is the canonical plan for the next-generation DolbyX, designed
in light of the comprehensive DDP reverse engineering captured under
[docs/ddp/](ddp/README.md). It supersedes the v1 plan
(`docs/CROSS_PLATFORM_PLAN.md` — archived with the rest of v1 at tag
`v1` in Slice 0).

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
| 3     | Factory EQ presets apply as overlays          | not started   |                                                    |
| 4     | Master controls (SV / DE / VL)                | not started   | the signature DDP main-screen controls             |
| 5     | Event-driven visualizer                       | not started   |                                                    |
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

- Faithfully reproduces the original DDP's defaults, behavior, look, and feel.
- Cleanly extends DDP's capabilities — custom profiles, custom EQ presets,
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
2. Faithful default behavior: out of the box, DolbyX sounds like the
   original DDP module on Music profile with power on.
3. Same persistence semantics as the original: per-profile parameter
   overrides, per-profile GEQ, master state, all survive restarts.
4. Custom profiles can be added, edited, renamed, and removed.
5. Custom EQ presets can be added, edited, renamed, and removed. EQ
   presets are global — a change to a preset reflects across every profile
   that has it currently selected — and optional: `None` is a valid
   selection, leaving the profile's own EQ params in effect.
6. Every one of the engine's 64 real root-leaf AK parameters is exposed in
   the Advanced UI section, driven by metadata — none dropped. Four settability
   buckets: Settable (42), Experimental (10 — engine-internal slots the
   original DDP UI hid; DolbyX is also a research vehicle for
   `libdseffect.so`), ReadOnly-Dynamic (4 — live per-block monitoring), and
   ReadOnly-Static (8 — the rate-derived native grid plus build-version /
   license readouts; `ak_get` reads any leaf, so nothing is unreadable).
   The `ver` param is the engine-version readout — the UI formats its
   4×i16 as "2.0.4.0".
   (The engine's 64 real root leaves are *not* Java's
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
│  │  - param_metadata (single SoT,    │                                    │
│  │    parameters.toml @ startup)     │                                    │
│  └────────────────┬──────────────────┘                                    │
│  ┌────────────────▼──────────────────┐    ┌──────────────────────────────┐│
│  │ Engine (trait Engine + impl):     │    │ Audio plugin server          ││
│  │  - sessions: HashMap<u32, Handle> │    │ Win:  \\.\pipe\DolbyX        ││
│  │  - vis tail on each Process reply │    │ Unix: /run/dolbyx/dolbyx.sock││
│  └────────────────┬──────────────────┘    └────────────┬─────────────────┘│
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
    fn set_params(&self, id: SessionId, params: &[(&str, &[i16])]) -> Result<()>;
    fn get_params(&self, id: SessionId, names: &[&str]) -> Result<Vec<Vec<i16>>>;
    fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<VisFrame>;
    // VisFrame: the four ReadOnly-Dynamic arrays (vnbg vnbe vcbg vcbe), 4 × 20 i16
}
```

**Engine binding — AK-direct params, cmd lifecycle (hybrid).**

> Persistent record: [ADR-0010 — AK-direct parameter surface; cmd protocol for lifecycle](adr/0010-ak-direct-params-cmd-lifecycle.md).

The shim binds to `libdseffect.so` two ways, split by surface. The
**parameter** methods (`set_params`, `get_params`) are implemented with
the engine's exported AK accessors — `ak_find` (4-CC → ref), `ak_set` /
`ak_set_bulk`, `ak_get` / `ak_get_bulk` — *not* the cmd protocol's
DEFINE_PARAMS + DEFINE_SETTINGS handshake and cmd 2 / 3. cmd 3 SET ≡
`ak_set` bit-for-bit at the DSP (proven by
[`akctl_probe`](../tools/ddp_probe/README.md): the cmd path is a wrapper
that adds a name→ref table, a flat-index map, and a dead settings-cache
write). Going direct drops the handshake, drops the flat-index footgun,
and is name-based natively. The **lifecycle** methods (`create_session`,
`destroy_session`, `set_enabled`, `process`) stay on the cmd protocol —
those carry engine-internal orchestration (the SET_CONFIG reconfigure
below, the ENABLE/DISABLE crossfade) that the bare AK framework calls
don't reproduce.

`get_params` is therefore real, not synthesized: it batch-reads N
params in one round-trip (the shim loops `ak_get` / `ak_get_bulk`) and
returns the live **clamped** registry values the DSP uses — more
truthful than a write mirror. The daemon still owns its state model for
persistence and broadcast (and serves the WebSocket state snapshot from
it), but `get_params` gives an authoritative read-back for
verification, engine-computed slots, and the `readouts`. The visualizer
needs no read call at all: every `process` returns a `VisFrame` — the
four ReadOnly-Dynamic arrays the DSP rewrites each block — riding the
`Process` reply (Decision 9).

The `i16` values throughout this trait are the engine's native 1/16-dB
units. The trait is the canonical boundary where this format stays
consistent end-to-end: persistence, state, wire protocol, and engine
all carry i16s. Only the Web UI converts i16 ↔ float dB at display
and input time.

`set_params` writes a batch (`ak_set` / `ak_set_bulk` per entry) and is
the *only* write path — a single-control edit (slider, toggle, GEQ
drag) is a 1-entry batch. Profile and EQ-preset switches ride one
batch: the shim lands every value before the next `process` block, so
the change applies atomically on one audio block (the DSP recomputes
from the registry per block), avoiding the mid-switch artifact of
dribbling ~40 edits as separate round-trips.

**Structural-param commit.** A few params reshape a feature's filterbank — band
count and centre frequencies (`genb`/`gebf`, `ienb`/`iebf`, `aonb`/`aocc`/`aobf`,
`arnb`/`arbf`). The engine *stages* these and re-derives the filterbank only once
the group's **commit leaf** (its last payload array — `gebg`/`iebt`/`aobg`/`arbh`)
is re-written. The shim hides this: `set_params` carries a static
4-group → commit-leaf map and, after staging a batch, touches each
affected group's commit leaf with its current value
(**touch = commit** — it fires even unchanged).
So the daemon just sets the param and it applies; the commit leaf is
engine-binding knowledge that lives in the shim, *not* in `ParameterDef` and not
above the `Engine` trait ([ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)).
There is no daemon↔engine round-trip — the commit-leaf read is local to the shim —
and storage is fixed-capacity (40), so a count change never needs array
re-alignment, only the commit.

**Sessions.** A session exists per plugin instance and only per plugin
instance: a plugin's `Hello` creates it, its disconnect destroys it,
and the daemon never creates sessions on its own — zero plugins means
zero sessions. AK registries are **per-handle**
([docs/ddp/07](ddp/07-ak-api.md#reaching-ak-in-process)), so the daemon
fans every param write out to all live sessions; with zero sessions a
write is state-only and lands on each future session at init (`set_power`
likewise performs no engine call). The **main session** — the oldest
live one — sources `vis` events and the readouts (Decision 4).

**Sample rate.** Every session init sends one `EFFECT_CMD_SET_CONFIG`
(cmd 1) after `INIT`, explicitly setting the session's rate — DolbyX
never relies on the engine's 44100 Hz power-on default. The engine
validates, rebuilds its `Ds1ap` at the requested rate, and re-applies
the cached AK params (see
[docs/ddp/03](ddp/03-binary-protocol.md#effect_cmd_set_config-effect-command-1)).
This is a lifecycle command, so it stays on the cmd path and supersedes
v1's manual `Ds1ap::New` hot-swap. The rate arrives in the plugin's
`Hello` and is immutable for the session's lifetime — a rate change is
destroy + re-create — so a session sees exactly one `SET_CONFIG`, at
init; the daemon carries no default rate of its own. The same
`SET_CONFIG` pins stereo + PCM16 + **WRITE** output mode (so
`process()` overwrites, no per-block `memset`). The backend validates
host-side first, because the engine's field checks have two footguns:
a rate outside {44100, 48000, 32000} **silently falls back to 44100**
(still replying success), and a **mono** channel mask **poisons the
handle** (it tears the graph down before rejecting, leaving `Ds1ap`
NULL). So the backend rejects non-stereo and out-of-set rates up front
and never sends mono. It stays behind the trait — the `Engine` surface
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
per-stream memory duplication compared to the current code. On Windows
the daemon is a **native Windows binary**; `QemuBackend` spawns the ARM
engine inside WSL2 via `wsl.exe` stdio — the v1-proven path.

When the Unicorn or static-binary backend lands, the daemon configuration
swaps the trait impl and nothing else changes.

### Decision 2 — Profiles are canonical; EQ presets are an optional overlay

> Persistent record: [ADR-0003 — Global EQ presets as optional overlays](adr/0003-global-eq-presets-and-geq-per-preset.md).

A clean simplification over the original DDP model.

**Original DDP**: each profile carried its own copy of every IEQ preset's
backing GEQ curve. The matrix was `profiles × presets × bands` = 6 × 4 × 20.
Adding a preset to one profile didn't add it to others.

**DolbyX v2**: the profile is the canonical home for *every* non-readonly
AK param — all 52 Settable + Experimental, structural constants (`genb`,
`aonb`, band frequencies, …) included, no special cases. IEQ preset
terminology changes to **EQ preset**: a top-level object like a profile,
now an *optional* overlay carrying exactly the 9 EQ params —
`genb`/`gebf`/`geon`/`gebg` (GEQ) + `ienb`/`iebf`/`ieon`/`iebt`/`iea`
(IEQ). Preset eligibility is derived, not declared: a param is
preset-carried ⟺ `category ∈ {Ieq, Geq}` — no `scope` field.

The `State` / `Profile` / `EqPreset` structs and the stable id newtypes are
defined once under [Data model](#data-model): `Profile.params` holds any of
the 52 non-readonly params, `EqPreset.params` only the 9 EQ params, and
`selected_eq_preset` is an `Option` (`None` → the profile's own EQ params
apply). `is_factory` is derived at load, not stored.

**Resolution.** A selected preset's 9 EQ params shadow the profile's own
*entirely* — the preset resolves complete through its own defaults cascade
(Decision 7), so it never half-applies. With `None` selected, the
profile's own EQ params are effective.

**Edit routing.** `set_params` writes the active profile; `edit_eq_preset`
writes the EQ preset — the UI picks which by whether a preset is active. The
daemon just overlays.

User-visible consequences:

- Editing the "Rich" preset (e.g. tweaking the `gebg` or `iebt` curve) takes
  effect immediately for every profile that currently has Rich selected.
- Adding a new EQ preset makes it available across every profile.
- Removing an EQ preset: any profile that had it selected falls back to
  `None` — its own EQ params (there is no Off preset).

Factory EQ presets are `Open`, `Rich`, `Focused`; "off" is `None`, not a
preset. Factory profiles are `Movie`, `Music`, `Game`, `Voice`. Factory
items cannot be deleted; they can be reset to their bundled defaults.

**Session init collapses too.** With structural constants profile-owned,
v1's separate constant-params init step dies: session init is
`create_session` plus one `set_params` of the resolved active profile
(+ selected preset). The shim's commit-leaf touch
([ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)) reshapes the
engine's 10-band power-on state to the 20-band config in that same write —
and reshaping stays a live operation, so the UI is reactive to band
structure. Band arrays are allocated at engine capacity (40); the
effective count is the group's `*nb` value.

Note:
Original DDP only allowed `gebg` curves to be edited through the
Visualizer/Equalizer UI, and `iebt` curves could not be edited beyond their
factory values. DolbyX will keep this behavior for now. In the future,
DolbyX will support editing the `iebt` curve as well (through the same
Visualizer/Equalizer, behind a toggle).

### Decision 3 — Parameter metadata as the single source of truth

> Persistent record: [ADR-0004 — Parameter metadata as single source of truth](adr/0004-parameter-metadata-as-single-source-of-truth.md).

All 64 of the engine's real root-leaf AK parameters are declared once in a
metadata table — none dropped. The 64 real root
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
    pub name: String,           // 4-CC: "dvla", "iebt", …
    pub length: usize,          // engine ak_get_length — fixed allocation;
                                // effective count = the group's *nb value at runtime
    pub min: i16,               // inclusive engine-unit bounds
    pub max: i16,
    pub frac_bits: u8,          // display = raw / 2^frac_bits
    pub default: Vec<i16>,      // length-sized engine power-on value (dump-defaults)
    pub kind: ParamKind,        // drives UI widget choice + unit label
    pub category: ParamCategory,// for UI grouping
    pub access: ParamAccess,
    pub label: String,          // human-readable display name
    pub description: String,    // engine one-liner
    pub help: String,           // engine long help — may be empty
}

pub enum ParamKind {
    Toggle,                     // 0/1
    Tristate { on: i16 },       // 0/1/2, where "on" = 1 or 2
    Integer,
    Decibel { lkfs: bool },
    FrequencyHz,
    Degrees,
    PerBand,
    AobgChannelMajor,           // for aobg (channel-id-prefixed)
    Opaque,                     // license blobs etc — render as int[]
}

pub enum ParamAccess {
    Settable,        // Java-whitelisted; DSP produces well-defined output (42)
    Experimental,    // engine accepts writes; original DDP UI hid the slot (10)
    ReadOnlyDynamic, // DSP rewrites the slot every audio block (4)
    ReadOnlyStatic,  // fixed between reconfigurations; read via ak_get / ak_get_bulk (8)
}

pub enum ParamCategory {
    Ieq, Geq,
    VolumeLeveller, DialogEnhancer,
    HeadphoneVirtualizer, SpeakerVirtualizer, NextGenSurround,
    AudioRegulator, AudioOptimizer, VolumeMaximizer, PeakLimiter,
    Visualizer, EndpointVolume,
}
```

**`frac_bits`.** Uniform fixed-point display scale, engine-sourced:
display value = raw / 2^`frac_bits`. Every dB-coded AK param carries
`frac_bits = 4` (the binary documents "scaled by 16 ie. 16 = 1 dB");
plain integers carry 0. The UI never hardcodes the conversion — each
widget reads it from the injected bootstrap metadata. `Decibel { lkfs }`
switches the unit label from `dB` to `LKFS` for `dvli`/`dvlo`.

**Parameter defaults.** `default` is the engine's intrinsic power-on
value — what a freshly-created engine reports before any profile is
pushed, captured by probe (`make -C tools/ddp_probe dump-defaults`) and
CI-gated against drift (see metadata delivery below). Engine-honest with
no exceptions: the engine boots **10-band**, so `genb` defaults to 10
and `gebf` to the 10 ISO octave centres (32 Hz–16 kHz) zero-padded; the
standard **20-band stereo** config is not a table default — it lives
once in `defaults.toml`'s shared `[profile]` table (Decision 7).
`default` is the base layer of the persistence cascade: `defaults.toml`
and `config.toml` store only divergences from it, so the table is the
single home for the per-param defaults the original DDP repeated in
full in every profile.

**Four-bucket settability classification.** This is a deliberate
deviation from `docs/ddp/02-ak-parameters.md`'s "settable=yes/no"
binary. Empirically, the engine accepts cmd 3 SET against any
declared param and forwards the write to `ak_set` regardless of
Java's `isParamSettable` whitelist (direct evidence in
[tools/ddp_probe/](../tools/ddp_probe/README.md) section 5b). The
four buckets are about **DSP semantics + UI presentation**, not
engine-level acceptance:

- **Settable** (42) — every param in Java's `isParamSettable` whitelist.
  DSP reads the value and produces well-defined
  bounded behavior. Editable widgets in the Advanced panel.
- **ReadOnly-Dynamic** (4) — `vnbg`, `vnbe` (native) + `vcbg`, `vcbe`
  (custom): write-protected (flag `0x2`), rewritten by the DSP every audio
  block. They ride the `vis` event (Decision 4 and Decision 9); their
  Advanced cards live-update from it. `vc*` and `vn*` read identical until
  the custom bands are reconfigured, because the engine seeds the custom
  grid to the native one — `vc*` is the native data resampled onto host-set
  `vcnb`/`vcbf`.
- **ReadOnly-Static** (8) — the native grid `vnnb`/`vnbf` plus the
  build-version / license slots `bver`, `bndl`, `ver`, `lcmf`, `lcvd`,
  `lcpt`. Effectively read-only and fixed between reconfigurations; read
  once via `ak_get` / `ak_get_bulk` after the session's `SET_CONFIG` —
  `vnnb`/`vnbf` are rate-derived, so the readouts re-read when the main
  session changes (Decision 4). Six carry the write-protect flag `0x2`
  (`vnnb`/`vnbf`/`bver`/`ver`/`bndl`/`lcvd`); `lcmf`/`lcpt` accept writes
  with no observable effect ([docs/ddp/02](ddp/02-ak-parameters.md)). Plain
  read-only cards in the Advanced panel.
- **Experimental** (10) — not exposed by original DDP, but the engine
  treats the slot as a real DSP input: `preg`, `pstg`, `endp`,
  `ocf`, `ven`, `vol`, `vcnb`, `vcbf`, `scpe`, `test`. Editable behind an
  "experimental" badge. (`scpe` (Surround Compressor enable) and `test`
  (Peak Limiter test mode) are real root leaves Java omits — added here;
  `mxou`, a Java phantom resolving to ref 0, is dropped. See
  [docs/ddp/02](ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves).)
  Behavioral confirmation that the DSP applies these params (read from
  the clamped registry, not the raw cache) is in
  [tools/ddp_probe/](../tools/ddp_probe/README.md) section 7: a `vmb`
  sweep over `{0, 120, 240, 480}` moves peak/rms — sweep peaks are trends,
  not exact — with `vmb=240` and `vmb=480` collapsing onto the same
  output because both clamp to the engine's `vmb` max of 192 (read back
  via `ak_get` in #2/#9). The decisive proof in the same section is a
  direct cache poke (registry frozen) the DSP ignores. A `dvla` sweep
  confirms the leveler also varies and collapses the same way (`dvla=10`
  and `dvla=200` give identical output, both clamped to 10). The same
  forwarding path applies to every Experimental param — cmd 3 SET fires
  `ak_set(idx/name, offset) = V` regardless of bucket (section 5b), so a
  host that drives `endp`, `vol`, etc. gets the same DSP-input semantics.
  (`vol` is a host volume hint the leveler reads; `ven` is a single
  enable gating the fills of both the `vn*` and `vc*` families —
  `vcnb`/`vcbf` just define the host-writable custom band grid onto which
  `vn*` is resampled to produce `vc*`, not a separate "mode". The
  libdseffect.so `preg` description string says "this parameter should be
  set to reflect how much gain has been applied".)

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

**Metadata delivery.** No generated code. The table ships as a runtime file —
`parameters.toml`, engine-seeded, hand-editable, living next to the
daemon binary alongside `defaults.toml` — parsed and validated at
startup only (never watched); malformed → the daemon refuses to start
rather than run against a wrong table. Crate seams: `ddp-state` owns the
pure parser/validator (`&str → Vec<ParameterDef>`, defs own their
`String`s); `ddp-persistence` reads the file.

A committed twin, `parameters.engine.toml`, is regenerated straight from
the probe (`dump-tree` + `dump-docs` + `dump-defaults`; `just
param-twin`) and never loaded — it exists so CI can diff
`parameters.toml`'s **engine-fact fields** (`name`, `length`, `min`,
`max`, `frac_bits`, `default`) against engine ground truth and fail on
drift. The product fields (`kind`, `category`, `access`, `label`,
`description`, `help`) are free to edit.

Wire and storage are name-based (4-CC string). Saved configs are
stable under reordering the table. Adding a new parameter to the
Advanced section is an edit to `parameters.toml` plus a daemon restart;
the UI auto-discovers it on next page load (the daemon re-serializes
the metadata into `window.__BOOTSTRAP__` on every `GET /`).

**Advanced-panel layout.** A CSS Grid with
`grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))` and
`gap: var(--space-3)`. Each parameter renders as a compact card: the
4-CC code, the human label, the current value(s), and either an input
(Settable / Experimental) or a read-only display (the two ReadOnly
buckets).
Experimental cards get a small "experimental" badge. Long arrays
(`aobg` ≤ 329, `arbi`/`arbl`/`arbh`/`aobf`/`arbf` 40) render in a wide
card with `grid-column: 1 / -1`, collapsed behind a toggle by default.
Tiny scalars pack densely; bulky arrays stay out of the way. Category
headers introduce visual groupings.

### Decision 4 — Wire protocol: name-based, originator-aware

> Persistent record: [ADR-0005 — Wire protocol: name-based, originator-aware, i16 1/16-dB throughout](adr/0005-wire-protocol-i16-name-based-originator-aware.md).

**Wire format.** The state snapshot, all `set_params` commands,
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
`vis` events broadcast unconditionally to all clients.

Commands (client → daemon):

```jsonc
{ "cmd": "get_state", "request_id": "r1" }
{ "cmd": "set_power", "request_id": "r2", "on": true }
{ "cmd": "set_profile", "request_id": "r3", "id": "music" }
{ "cmd": "set_params", "request_id": "r4", "params": { "dvla": [4] } }  // single edit = 1-entry batch
{ "cmd": "set_params", "request_id": "r5", "params": { "gebg": [24, -8, ...], "geon": [1] } }
{ "cmd": "set_eq_preset", "request_id": "r6", "id": "rich" }  // "id": null → profile's own EQ params

{ "cmd": "add_profile", "request_id": "r7", "from": "music", "name": "My Music" }
{ "cmd": "rename_profile", "request_id": "r8", "id": "user_a3f1", "name": "Late Night" }
{ "cmd": "remove_profile", "request_id": "r9", "id": "user_a3f1" }
{ "cmd": "reset_profile", "request_id": "r10", "id": "music" }

{ "cmd": "add_eq_preset", "request_id": "r11", "from": "rich", "name": "Vocal Forward" }
{ "cmd": "rename_eq_preset", "request_id": "r12", "id": "user_91c2", "name": "Vocal" }
{ "cmd": "edit_eq_preset", "request_id": "r13", "id": "user_91c2", "params": { "gebg": [...] } }
{ "cmd": "remove_eq_preset", "request_id": "r14", "id": "user_91c2" }
{ "cmd": "reset_eq_preset", "request_id": "r15", "id": "rich" }
```

Every command carries a client-generated `request_id`, echoed verbatim
in the resulting `ack` / `error` — replies on a multiplexed WebSocket
aren't positionally paired with requests, so the id is what lets a
client (or a test) await its outcome, promise-style. `set_params` is
the only param write; a bulk edit (profile switch, GEQ drag frame)
lands as one atomic engine batch. `set_params`, `edit_eq_preset`, and
the `vis` event all share one payload shape:
`params: { "<4-CC>": [i16, …] }`.

Events (daemon → client):

```jsonc
{ "type": "state", "snapshot": { /* full state */ } }
{ "type": "vis", "params": { "vnbg": [...], "vnbe": [...], "vcbg": [...], "vcbe": [...] } }
{ "type": "ack", "request_id": "...", "ok": true }
{ "type": "error", "request_id": "...", "code": "INVALID_REQUEST", "message": "..." }
{ "type": "error", "request_id": "...", "code": "ENGINE_REJECTED", "status": -22, "message": "..." }
```

The full `state` snapshot is also sent on `get_state`, on connect, and any
time the daemon's internal state mutates from a non-WS source (e.g. config
file edit reload). At DolbyX's state scale (hundreds of bytes) full
snapshots are preferable to partial diffs. The snapshot carries user-state
plus a read-only `readouts` map — the 8 ReadOnly-Static values keyed by
4-CC, read from the main session (`ParameterDef.default` values while no
session exists).

**Validation: two layers, asymmetric responsibilities.**

_Daemon-side_ (the only layer that does value validation): every
`set_params` entry is checked against the `ParameterDef` metadata —
4-CC declared, length matches, values within `min`/`max`. Failures
short-circuit with
`{ "type": "error", "code": "INVALID_REQUEST", "request_id": "...",
"message": "..." }` and the engine is never called. `INVALID_REQUEST`
is the only daemon-side rejection code — malformed JSON, unknown ids,
factory rename/delete, and param validation all use it, the `message`
saying why. On any `error` the client re-issues `get_state` to
reconcile.

_Engine-side_ (validates a very narrow set of things): the engine
checks (a) `setting_index` range against the cache size, (b)
value-buffer-size mismatch, and (c) cmd-code recognition (and even
that is asymmetric — cmd 3 GET is always rejected because it isn't
implemented; see Decision 4 protocol table below) — these return
`-EINVAL(-22)`, surfaced as
`{ "type": "error", "code": "ENGINE_REJECTED", "request_id": "...",
"status": -22, "message": "..." }`. Malformed command data (psize ≠ 4
or a missing payload) returns `-1(-EPERM)` instead, and a write to a
write-protected leaf is a **silent no-op** (`ak_set` stores nothing, no
error). The engine does **NOT** *reject*
out-of-range values, does **NOT** reject unknown 4-CCs in DEFINE_PARAMS,
does **NOT** reject non-zero offsets in DEFINE_SETTINGS — direct evidence
from [tools/ddp_probe/](../tools/ddp_probe/README.md) and the engine
string table (`_akSet: Wrong parameter index %d`,
`DS_PARAM_SINGLE_DEVICE_VALUE setting_index %i is invalid`,
`Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)`; no
range-check strings exist). But it does **silently clamp**: the param
binding's `ak_set` saturates the stored value to the engine's own
`[ak_get_min, ak_get_max]`, and the DSP reads that **clamped registry**
value (ddp_probe #7) — so out-of-range writes are clamped, not rejected,
and the daemon validates up front for predictable behavior.

This is why the daemon must still own range validation up front. An
out-of-range write isn't rejected — it's silently clamped to a range that
differs from the published table for some params (`vmb` clamps at 192,
not 240; `vol` at -2080, not -2048). Validating host-side gives
predictable, inspectable behavior rather than relying on a hidden clamp
(probe section 7: `vmb=240` and `vmb=480` both clamp to 192; #2 reads the
clamped values back via `ak_get`).

**Visualizer source.** `vis` events source from the **main session** —
the oldest live session, index 0 of the supervisor's creation-ordered
session list: its `Process` replies carry the vis frame the daemon
broadcasts (Decision 9). If the main session has no audio flowing
there are simply no events — no suspended flag; idle is client-derived.
The source does not switch when the main session goes silent — only
when it dies, at which point the next-oldest becomes main and the
daemon re-reads the readouts (the rate-derived `vnnb`/`vnbf` may
differ) and broadcasts. This keeps the visualizer predictable and
avoids flicker between sources.

**ReadOnly param updates.** The four ReadOnly-Dynamic params (`vnbg`,
`vnbe`, `vcbg`, `vcbe`) ride the `vis` event, refreshed per audio block
(Decision 9). The eight ReadOnly-Static params surface in the snapshot's
`readouts` map — read from the main session via `ak_get` / `ak_get_bulk`
at its init, re-read when a different session becomes main; with zero
sessions they are implicitly the `ParameterDef.default` values, and real
sampling starts with the first session. Both paths use the AK-direct binding
([ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)); the engine has no
cmd 3 GET, so AK-direct is what makes a real param read possible. (v1 tried
to read params via cmd 3 GET — the engine rejects it with `-EINVAL`, and v1
swallowed that and shipped zero-fill. The engine's actual GET paths are cmd 4
`DS_PARAM_VISUALIZER_DATA` (visualizer state), cmd 6 (version), and cmd 7
(echoes a host-written boolean) — none a general param read.) Experimental
params update through the regular state-snapshot path since the daemon
owns the write side.

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
| 0x10 | `SetParams`      | `[u32 session_id][u16 n]( [4-CC name][u16 count][i16 × count] × n )` | empty                      |
| 0x11 | `GetParams`      | `[u32 session_id][u16 n]( [4-CC name] × n )`          | `[u16 n]( [u16 count][i16 × count] × n )` |
| 0x30 | `Process`        | `[u32 session_id][u32 frames][i16 × frames × 2 pcm]`  | `[i16 × frames × 2 pcm][i16 × 80 vis tail]` |

`SetParams` / `GetParams` are served in the shim by the AK accessors, not
the cmd protocol (the AK-direct binding — Decision 1,
[ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)). `GetParams` returns
the live **clamped** registry the DSP uses — the only true per-param getter,
since the engine has no cmd 3 GET (see
[docs/ddp/03 → The AK registry read path](ddp/03-binary-protocol.md#the-ak-registry-read-path)).

The `Process` opcode wraps `libdseffect.so`'s `process()` (see
[ddp_probe](ddp/03-binary-protocol.md#practical-reminders)). Its reply
carries a fixed 160-byte **vis tail**: the ARM shim appends
`vnbg ‖ vnbe ‖ vcbg ‖ vcbe` (4 × 20 i16) after each block via local
`ak_get_bulk` — the vis tail rides the reply, no extra
round-trip, no dedicated opcode (Decision 9). v2 configures
the output for **WRITE** mode in `SET_CONFIG`, so `process()` overwrites the
output buffer — **no per-block zeroing** (v1 used ACCUMULATE, which required
a `memset` before every call). **Disable is engine-owned:** on `DISABLE` the engine crossfades
wet→dry (≈125 ms, blocks still return `0`), then bypassed blocks return
`-ENODATA` and — in WRITE mode — deposit the dry input straight into the
output (`OUT == IN`, verified by `setconfig_probe` Sc9; same for a
never-enabled session). So the daemon treats enabled, crossfading, and
bypassed blocks identically — call `process()`, ship the output — with no
memset and no input→output copy. The vis tail rides every reply the same
way — the vis feed is **process-driven, not power-gated**: bypassed blocks
still emit `vis` events (the client renders whatever the engine yields),
idling only when `process()` stops.

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

A future optimization (Latency optimization, below) replaces byte-stream socket audio with a
shared-memory ring buffer plus a socket for signalling, removing per-block
kernel transitions. Defer until measured latency motivates the work.

### Decision 5 — Daemon in Rust

> Persistent record: [ADR-0001 — Rust for the daemon](adr/0001-rust-daemon.md).

Rust gives us:

- Strict type safety across many concurrent threads (HTTP, WebSocket,
  audio I/O, engine subprocess management).
- `tokio` handles cross-platform async I/O uniformly, including Windows
  named pipes (`tokio::net::windows::named_pipe`) and Unix domain sockets.
- `axum` + `tokio-tungstenite` give HTTP and WebSocket for essentially free.
- `serde` + `toml` make persistence trivial.
- Cargo workspace structure scales as the project grows.
- `#![forbid(unsafe_code)]` everywhere except the engine FFI boundary;
  that boundary has explicit `// SAFETY:` comments explaining every invariant.

Code-quality gates — lint, format, `proptest` conversions, unit +
integration tests — live in [Code quality standards](#code-quality-standards).

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
  without code changes. The SVG visualizer (Decision 9) plays well
  with CSS-driven theming.
- **`solid-js/store`** for state management — built-in `createStore`,
  no third-party state library needed.
- **Vitest** (unit, with `@solidjs/testing-library` + a mocked WebSocket)
  and **Playwright** (E2E against the real daemon + engine). Test policy,
  the why-not-mock rationale, and CI's `qemu-user-static` provisioning live
  in [Code quality standards](#code-quality-standards).
- **ESLint** with `@typescript-eslint/strict-type-checked` and
  `eslint-plugin-solid`, **Prettier**.

**Bootstrap injection.** The daemon templates `index.html` at request
time and injects parameter metadata and the initial state snapshot as
a single `window.__BOOTSTRAP__` global:

```ts
window.__BOOTSTRAP__: {
  params: ParameterDef[],            // full metadata table — no /api/parameters
  state: StateSnapshot,              // user-state — mirrors the WebSocket "state" event
}
```

The bootstrap shape is intentionally wider than the WS `state` event:
`params` is delivered once on page load and never re-broadcast (the
metadata table cannot change for the lifetime of the daemon). The UI
reads `window.__BOOTSTRAP__` synchronously at module init, hydrates
the Solid store, and paints the full UI on the first frame. The
WebSocket then connects in the background; its `state` event reconciles
any drift between HTML render time and WS connect time (and handles
reconnects).

There is intentionally no `/api/*` endpoint in dev or prod. Bootstrap
injection is the only mechanism.

Development workflow. The repo root carries a single `Justfile`
(`cargo install just` once). `just dev` runs both the daemon under
`cargo watch` (passing `--ui ui/dev.html`) and `pnpm -C ui dev`
concurrently with prefixed/colored output. Rust changes restart the
daemon; TS and CSS changes hot-reload via Vite.

The daemon is the single front door for both dev and prod: the browser
visits `localhost:9876`. `GET /` reads one HTML file from disk and
string-replaces its `<!--BOOTSTRAP-->` placeholder with a `<script>`
defining `window.__BOOTSTRAP__` — a single producer; dev and prod
differ only in which file. Prod (default): `$(daemon-dir)/index.html`,
the Vite singlefile build placed beside the binary by `just
build-release`. Dev: `just dev` passes `--ui ui/dev.html`, the
checked-in dev shell that pulls the Vite dev server's module entry
directly. A missing or unreadable file → the daemon refuses to start
(same policy as `parameters.toml`).

```html
<!-- ui/dev.html -->
<!DOCTYPE html>
<html>
  <head>
    <title>DolbyX</title>
    <!--BOOTSTRAP-->
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
cargo watch -x 'run -p ddp-daemon -- --ui ui/dev.html'
pnpm -C ui dev
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
# → cargo build --release
# → ui/dist/index.html copied into the release dir beside the binary
```

Nothing is embedded in the daemon binary — no cargo feature, no
`rust-embed`, one `GET /` code path.

UI component tree:

```
src/
├── main.tsx
├── App.tsx
├── store/
│   ├── state.ts           # Solid store — mirrors daemon state shape; hydrated from window.__BOOTSTRAP__
│   └── ws.ts              # WebSocket client + auto-reconnect
├── styles/
│   ├── theme.css          # CSS custom properties (colors, spacing, radii)
│   ├── base.css           # element resets and base typography
│   └── components/        # one BEM file per component family
├── components/
│   ├── PowerToggle.tsx
│   ├── ProfileTabs.tsx
│   ├── EqPresetPicker.tsx
│   ├── MasterControls.tsx # Surround Virtualizer + Dialog Enhancer + Volume Leveller
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

**System-level deployment.** DolbyX installs once per machine and
serves every user — there is no per-user mode. The daemon runs as a
system service (Linux: systemd unit with `RuntimeDirectory=dolbyx`;
Windows: a Windows service), so every path below is machine-wide. The
plugin socket lives at `/run/dolbyx/dolbyx.sock` (Windows:
`\\.\pipe\DolbyX`); the installer / service unit owns directory
creation and ACLs so user-session audio hosts can connect.

Two TOML files in distinct locations:

- `config.toml` — user state, editable, in the platform-standard data dir.
  Windows: `%PROGRAMDATA%\DolbyX\config.toml`. Linux:
  `/var/lib/dolbyx/config.toml`.
- `defaults.toml` — factory defaults, user-editable, in the **same directory
  as the daemon binary** (beside `parameters.toml`, Decision 3 — metadata,
  not state, and outside this cascade).

Both store **only deltas** over the `ParameterDef.default` base
(Decision 3), in **two namespaces** each — `[profile]` and
`[eq_preset]` — parsed by one uniform rule: a sub-table
(`[profile.<id>]`, `[eq_preset.<id>]`) holds one item's params; any
other key in the namespace table is a **shared** param applying to
*every* item — the shared operational config (the 20-band setup,
`ven`, …) is stated exactly once in `[profile]`. The root level holds
exactly `power` and `selected_profile`, nothing else. A param may live
in both namespaces (`genb` is part of each profile's band structure
*and* each preset's). A param resolves through five layers, later
shadowing earlier:

```
ParameterDef.default → defaults.toml shared → defaults.toml [item]
                     →  config.toml  shared →  config.toml  [item]
```

("shared" = the namespace's `[profile]` / `[eq_preset]` table keys;
`[item]` = the `[profile.<id>]` / `[eq_preset.<id>]` table.) The two
files mirror the original's `ds1-default.xml` / `ds1-current.xml`
pair; the `ParameterDef.default` base and the shared layers are v2
refinements — the original repeated the factory defaults in full in
every profile, DolbyX factors them out. The cascade is resolved at
load, so each in-memory profile and preset is complete — a profile
switch pushes one `SetParams` batch (Decision 4), with no per-param
fallback. `defaults.toml` also drives `reset_profile` and
`reset_eq_preset` actions (reset = remove the user's overrides).
Write-back is **always per-item**: the daemon writes params under
`[profile.<id>]` / `[eq_preset.<id>]`, never to a shared layer — the
shared layers are a hand-edit affordance.

A `notify`-based file watcher subscribes to **`config.toml` only**;
`defaults.toml` and `parameters.toml` are read once at startup — an
edit there takes a daemon restart. On an external `config.toml` edit
the daemon debounces for 500 ms (matching the write-side debounce),
re-resolves the cascade, and broadcasts a fresh state snapshot to every
connected client. Users can hand-edit the file and watch the UI catch
up. To avoid the watcher firing on the daemon's own writes, the daemon
records each mtime it flushed and suppresses watcher events that match
within a 1 s quiet window.

`is_factory` is not stored on disk — it's derived at load from
`defaults.toml` presence (see [Data model](#data-model)).

Schema notes:

- The root level is exactly `power` + `selected_profile` — no
  `[state]` table header, no root param keys.
- Profiles and EQ presets are keyed by id using table-per-id syntax
  (`[profile.music]`, `[eq_preset.rich]`), not array-of-tables. The id
  becomes the table key.
- AK param overrides (4-CC keys) live directly in the namespace they
  modify — `[profile]`, `[eq_preset]`, `[profile.<id>]`,
  `[eq_preset.<id>]` — no `params` sub-tables. Both namespaces parse by
  the same rule: a sub-table is an item, any other key is a shared
  param. Serde uses
  `#[serde(flatten)] params: HashMap<String, ParamValue>` to collect
  unknown keys.

`defaults.toml` (lives next to the daemon binary) — abbreviated:

```toml
power = true
selected_profile = "music"

[profile]            # → every profile: the standard 20-band stereo config, stated once
genb = 20
ienb = 20
aonb = 20
aocc = 2
gebf = [43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550,
        2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777]
# iebf = the same grid; … arnb, leveler calibration, speaker-tuning tables
ven = 1              # visualizer feed on (v1's cmd-7 VISUALIZER_ENABLE, retired)

[eq_preset]          # → every EQ preset: band structure, so presets resolve standalone
genb = 20
ienb = 20
# gebf / iebf as above

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

**First run.** With no `config.toml`, the daemon initializes from
`defaults.toml` and writes this minimal config — power on, Music selected,
no per-profile overrides — so the user hears the original DDP Music defaults
the first time they play audio. "Preserve the original default behavior,"
made concrete.

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
geon = 1
# iebt / gebg = the user's 20-band curves
```

Persistence write semantics:

- All on-disk state changes (power, selected_profile, profile params,
  EQ preset edits) are debounced together with a single 500 ms timer.
- All pending writes are flushed on graceful daemon shutdown (SIGTERM
  / Windows console close handler).

### Decision 8 — Custom profiles have no category

The original DDP categorized profiles as Movie / Music / Game / Voice /
Customized. The category had no engine semantics; it only drove UI grouping
and an icon. In DolbyX v2, factory profiles keep their category-derived
display names. Custom profiles have no category — they are simply listed
in the profiles with their user-chosen name.

This eliminates a UI affordance the user would have to make a decision about
with no functional consequence.

### Decision 9 — Visualizer/Equalizer rendering and feel

> Persistent record: [ADR-0008 — Visualizer / Equalizer rendering spec](adr/0008-visualizer-equalizer-rendering-spec.md).

The V/E is the single most visible piece of DDP; it must feel identical
to the original. Reference is the mobile DDPlus Android UI
(`docs/ui-reference/original-ui-visualizer-eq-overlay.png`): 5 cyan
circular thumbs riding a soft-glow cyan polyline over 20×48 spectrum
bricks. All constants and rules below are transcribed from
`decompiled/DsUI.apk/sources/com/dolby/ds1appUI/`.

**Event-driven feed — no pump.** v1 copied DDP's `DsService` 50 ms
polling loop; v2 drops the daemon-side cadence entirely — the
visualizer is a pure event stream:

- **Data.** The ARM shim appends the four ReadOnly-Dynamic arrays
  (`vnbg ‖ vnbe ‖ vcbg ‖ vcbe`, 4 × 20 i16) to every `Process` reply
  via local `ak_get_bulk` — no separate `get_params`, no round-trip, no
  pump thread (Decision 4 protocol table).
- **Broadcast.** The daemon emits one `vis` event per main-session
  block (Decision 4), all four arrays keyed by 4-CC as raw int16
  1/16-dB. No coalescing, no timer: no audio → no events.
- **Render.** The client draws every `rAF` (~60 fps) from the latest
  event, applying fast-attack / slow-decay per-band ballistics —
  smooth at any host block rate.
- **Idle.** Client-derived: no event for ~200 ms → freeze the last
  frame, then fade the spectrum to the floor over ~500 ms. (Distinct
  from the EQ overlay's 5 s input-driven auto-hide below, which
  stays.)

The `vc*` pair drives the spectrum and EQ curve here; the `vn*` pair
feeds the Advanced panel's ReadOnly-Dynamic live cards (Decision 3).

**SVG layer stack** (z-order, top of stack = drawn last):

1. Background — radial gradient (dark navy → near-black) via a
   CSS variable theme.
2. Grid — 1-px black `<line>`s between every column and row.
3. Spectrum bricks — 20 cols × 48 rows. Brick `(c, r)` is filled iff
   `excitation_idx(c) ≥ 47 - r`; color: `r < 12` red, `12 ≤ r < 18`
   yellow, `r ≥ 18` blue (`ROWS_RED = 12`, `ROWS_YELLOW = 6` in
   `GraphicVisualiserPainter.java`). Empty rows render as the dark
   "off" tile.
4. Level pip — one brighter cyan brick per column at the row for
   the current `vcbg[c]` (the per-column EQ-curve indicator, same
   source as the curve).
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
`vcbg` array during steady state, and falls back to the locally
smoothed user buffer while idle (no `vis` events).
`vcbg ≠ gebg`: `gebg` is the user's GEQ input parameter, while
`vcbg` is the composed EQ curve the engine is actually applying
(`gebg` blended with `iebt` per `ieon`). The overlay must reflect
what the engine produces, so `vcbg` is the only correct source —
rendering from stored `gebg` would hide the IEQ contribution. Drag
lag is one audio block — the next `Process` reply carries the new
curve — versus the original DDP's structural ~50 ms pump lag
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
**60 ms** (30 ms while idle):

1. **handleNewTouchEvents** — for each event, compute
   `newUserGain = touchGain - (uiGain[b] - smooth[b])` (when not
   idle; raw `touchGain` while idle), then splat into
   the inclusive (2L+1)-cell window `temp[b ..= b+2L]` (every cell
   gets the same value — the "thick-brush" feel).
2. **smoothenCurve** — for each `temp` cell _outside_ `[minEditGain,
maxEditGain]`, decay toward the violated clamp with
   `α = 0.5^(Δt / 0.3s)`; in-range cells are untouched. Then
   convolve: `smooth[b] = Σ kernel[i] · temp[b + i]`. Skip-write
   threshold `|new - old| > 0.02 dB`.
3. Throttled `set_params` — at most one per 60 ms; carries the
   smoothed, clamped 20-band `gebg` int16 1/16-dB array to the
   daemon as a 1-entry batch.

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

### Decision 10 — Bundle `libdseffect.so` with releases

> Persistent record: [ADR-0009 — Bundle `libdseffect.so` with releases](adr/0009-bundle-libdseffect-so.md).

The binary is shipped alongside the daemon executable. The release
artifact contains:

```
dolbyx/
├── dolbyx-daemon          # the Rust binary
├── index.html             # Vite singlefile UI build, disk-served (Decision 6)
├── dolbyx-engine-arm      # the ARM-side engine binary (statically built)
├── libdseffect.so         # bundled
├── parameters.toml        # AK metadata table, runtime-loaded (Decision 3)
├── defaults.toml          # factory profiles + EQ presets, user-inspectable
└── README.txt
```

Plus platform-specific extras (the VST DLL on Windows, the LV2 bundle on
Linux). The daemon resolves `libdseffect.so` from the same directory.

This is a deliberate tradeoff: ease-of-install over legal cleanliness.
Distribution is for personal use; the project README is explicit that
DolbyX is a wrapper around a third-party proprietary binary. Legal review
is deferred until and unless DolbyX is offered as a commercial product.

### Decision 11 — Logging and observability

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
    pub profiles: Vec<Profile>,               // factory + custom
    pub eq_presets: Vec<EqPreset>,            // factory + custom, global across profiles
}

pub struct Profile {
    pub id: ProfileId,                        // stable string id, e.g. "music", "user_a3f1"
    pub name: String,                         // display name, user-editable
    pub selected_eq_preset: Option<PresetId>, // None → profile's own EQ params apply
    pub params: HashMap<String, Vec<i16>>,    // overrides keyed by 4-CC — any of the 52
}

pub struct EqPreset {
    pub id: PresetId,                         // e.g. "rich", "user_91c2"
    pub name: String,                         // display name, user-editable
    pub params: HashMap<String, Vec<i16>>,    // overrides keyed by 4-CC — the 9 EQ params only
}

```

`is_factory` is derived at load time, not stored: any id present in
`defaults.toml` is factory; any id present only in `config.toml` is
custom.

- **Factory profiles**: `movie`, `music`, `game`, `voice`. Cannot be
  deleted or renamed. Can be reset to bundled defaults.
- **Factory EQ presets**: `open`, `rich`, `focused`. Cannot be
  deleted or renamed. Can be reset to bundled defaults.

Custom items can be freely renamed, edited, or deleted. Removing a
custom EQ preset that some profile has selected: those profiles fall
back to `None` (their own EQ params).

## Module structure

```
DolbyX/
├── Cargo.toml                       # Cargo workspace
├── Justfile                         # `just dev`, `just build-release`, `just param-twin`, …
├── rust-toolchain.toml              # pin a stable Rust version
├── flake.nix                        # Nix shell + NixOS module (Linux)
├── crates/
│   ├── ddp-engine/                  # Engine trait + backend impls
│   │   ├── src/lib.rs               #   trait Engine + VisFrame + SessionId
│   │   ├── src/qemu.rs              #   QemuBackend (shared subprocess)
│   │   ├── src/stub.rs              #   StubBackend — no libdseffect.so
│   │   ├── src/protocol.rs          #   binary protocol (shared with engine-arm)
│   │   └── tests/qemu_smoke.rs
│   ├── ddp-state/                   # Pure state model — no I/O
│   │   ├── src/lib.rs
│   │   ├── src/profile.rs
│   │   ├── src/preset.rs
│   │   ├── src/state.rs             #   State aggregate + all mutations
│   │   ├── src/param_def.rs         #   ParameterDef + pure TOML parser/validator
│   │   └── src/conversion.rs        #   int16 ↔ dB helpers (used by UI tests too)
│   ├── ddp-persistence/             # TOML load/save — separate from state logic
│   │   ├── src/lib.rs
│   │   ├── src/schema.rs            #   serde structs matching the TOML
│   │   ├── src/factory.rs           #   loads defaults.toml from $(daemon-dir)
│   │   ├── src/file_watcher.rs      #   notify-rs watcher on config.toml
│   │   └── src/debounce.rs          #   write debouncing (500 ms uniform)
│   ├── ddp-daemon/                  # The dolbyx-daemon binary
│   │   ├── build.rs                 #   copies both TOMLs next to the binary
│   │   ├── defaults.toml            #   factory profiles + EQ presets (source-of-truth)
│   │   ├── parameters.toml          #   AK metadata table, runtime-loaded (source-of-truth)
│   │   ├── parameters.engine.toml   #   probe-generated twin — CI diff gate, never loaded
│   │   ├── src/main.rs
│   │   ├── src/http_server.rs       #   GET / (disk HTML + bootstrap) + GET /ws
│   │   ├── src/ws_server.rs         #   WebSocket session handling
│   │   ├── src/ws_commands.rs       #   command dispatch
│   │   ├── src/audio_server.rs      #   plugin socket accept loop
│   │   ├── src/engine_supervisor.rs #   owns the Engine instance + session map
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
│   ├── dev.html                     # dev shell — :5173 module entry + placeholder
│   └── src/                         # (see Decision 6 for component tree)
├── vendored/
│   ├── libdseffect.so               # v8.1 build, bundled
│   └── ds1-default.xml              # original DDP factory XML — defaults.toml source
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

v1 is archived, not kept alongside: Slice 0 tags the pre-v2 tree as
`v1` and deletes the v1 code in one commit — `daemon/`, the vanilla-JS
`ui/`, `windows/vst/`, `arm/` (after relocating `libdseffect.so` +
`ds1-default.xml` to `vendored/` and the Android stubs into
`tools/ddp_probe/`), the v1 docs and scripts. `tools/ddp_probe/` and
`samples/` stay — active tooling, not v1 code. Reference the old tree
via `git show v1:<path>` if ever needed.

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
| **`Engine`** trait (`ddp-engine`) | `create_session(sample_rate) → SessionId` · `destroy_session(id)` · `set_enabled(id, bool)` · `set_params(id, &[(name, &[i16])])` · `get_params(id, names) → Vec<Vec<i16>>` · `process(id, &input, &mut output) → VisFrame`. All values are `i16` 1/16-dB; the param surface is batch-only (a single edit = 1-entry batch). `get_params` reads the live clamped registry via `ak_get` / `ak_get_bulk` (AK-direct binding, [ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)); every `process` reply carries the four ReadOnly-Dynamic arrays as its `VisFrame` (Decision 9). | QEMU subprocess lifecycle, binary protocol framing, session table, ARM-side multiplexing, the AK-direct param binding (params via `ak_*`, lifecycle via cmd), the structural-param commit (touch the group's commit leaf), the vis-tail append (local `ak_get_bulk` per block). Later: Unicorn ELF loader, Android stubs. **Two adapters** (Stub + QEMU) — real seam, not hypothetical. | Slice 1 (Stub), Slice 9 (QEMU) |
| **`EngineSupervisor`** (`ddp-daemon`) | `start() → Result<()>` · `shutdown()` · session ops mirroring `Engine`. Errors: `EngineCrashed`, `SessionInitFailed`, `SessionNotFound`. | Subprocess respawn on crash, the creation-ordered session list (**main session** = oldest = index 0, Decision 4), session init (`EFFECT_CMD_INIT` → `SET_CONFIG` at the plugin's rate → one `set_params` of the resolved profile → `EFFECT_CMD_ENABLE` — no DEFINE_PARAMS/SETTINGS handshake, [ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)), the `readouts` re-read when the main session changes (`ParameterDef.default` with zero sessions), the vis fan-out (main-session `Process` replies → `vis` events, Decision 9). Param writes and `set_enabled` fan out to every live session (AK registries are per-handle); with zero sessions, no engine call. A session created while power is off starts disabled. | Slice 1 |
| **`State`** (`ddp-state`) | `State::new_from_defaults(&Defaults)` · `apply(Command) → Result<StateDiff, ValidationError>` · accessor methods for power / selected_profile / profiles / eq_presets. Invariants: `selected_profile` always exists; every `Some` `selected_eq_preset` exists; deleting a referenced EQ preset falls profiles back to `None`. | Factory overlay, `is_factory` derivation from `Defaults` presence, validation against `ParameterDef` (4-CC declared, length matches, value in range), profile / preset CRUD invariants. I/O-free. | Slice 1 (just `power`), grown each slice |
| **`ParameterDef` table** (`ddp-state`) | `parse(toml: &str) → Result<Vec<ParameterDef>, ParseError>` · `lookup(name: &str) → Option<&ParameterDef>` · `iter() → impl Iterator<…>`. Returned `ParameterDef` carries `name`, `length`, `min`/`max`, `frac_bits`, `default`, `kind`, `category`, `access`, `label`, `description`, `help`. | 64 entries parsed from the runtime `parameters.toml` at daemon startup (malformed → refuse to start), file validation, the four-bucket settability classification (see ADR-0004). | Slice 0 (parser), used Slice 1+ |
| **`Persistence`** (`ddp-persistence`) | `load(params_path, defaults_path, config_path) → State` · `flush(&State)` (500 ms debounced; debounce shared across all on-disk fields) · `watch(callback)` — `config.toml` only. Errors: `ParseError`. | `parameters.toml` + `defaults.toml` startup loads, the 5-layer cascade (two namespaces), per-item write-back, `notify` watcher on `config.toml`, mtime self-write suppression (1 s quiet window), debounce timer. | Slice 1 |
| **`HttpServer`** (`ddp-daemon`) | Two routes: `GET /` → bootstrap-injected HTML · `GET /ws` → WebSocket upgrade (handled by `WsServer`). Port from the `--port` CLI flag (default 9876) — not config.toml. | Disk read of the UI HTML (`$(daemon-dir)/index.html`; dev flag points at the checked-in `ui/dev.html`), the `<!--BOOTSTRAP-->` string-replace, `window.__BOOTSTRAP__` JSON serialization of `params[] + state`, refuse-to-start on a missing/unreadable file. | Slice 1 |
| **`WsServer` + `WsCommands`** (`ddp-daemon`) | `WsServer::accept(stream)` registers an originator. `WsCommands::dispatch(originator, Command) → Event` typed via `serde`. Errors: `INVALID_REQUEST` (any daemon-side rejection — malformed JSON, unknown ids, param validation) and `ENGINE_REJECTED` (status −22 from engine). | Originator id assignment + echo suppression, `request_id` echo in ack/error, command validation against `ParameterDef`, broadcast routing, full state snapshot on `get_state` and on connect. | Slice 1 |
| **`AudioServer`** (`ddp-daemon`) | `accept_loop(supervisor) → !`. Plugin protocol: `Hello{sample_rate, max_frames}` → `HelloAck{session_id}` · `Process{frames, pcm}` → `Processed{pcm}` · `Goodbye`. | Per-platform socket accept (Windows named pipe `\\.\pipe\DolbyX` vs Unix `/run/dolbyx/dolbyx.sock`), session-id allocation, audio multiplexing onto the shared engine subprocess. **Two adapters** (named-pipe + AF_UNIX) — real seam. | Slice 10 |
| **UI `GainSmoother`** (`ui/src/lib/gain_smoother.ts`) | `enqueue(band, dB)` · `tick(): Int16Array | null` (returns the smoothed, clamped 20-band write, or `null` if nothing pending). | 5-cell thick-brush splat, τ=0.3 s exponential decay toward clamps, kernel convolution (`Mobile` / `Soft` / `Direct`), 60 ms drain throttle, 20×20 pseudoinverse on preset-change broadcasts for drag continuity. | Slice 6 |

`is_factory`, the four-bucket settability classification, and the
debounce-shared write semantics are not free-floating concepts — they
live behind specific module interfaces above and are documented there.

## Implementation phases

Phases are organized as **vertical tracer-bullet slices** per
[to-issues](../.agents/skills/to-issues/SKILL.md) skill: each slice
cuts through every layer it touches and ships something demoable on its
own. Each TDD slice is then implemented with the
[tdd](../.agents/skills/tdd/SKILL.md) skill — one test → one
impl → repeat; never write all tests up front. Slices 0–10 constitute
the v2.0 release. v2.1+ and v3.0 follow.

> **Slices are provisional.** They set scope and order, but will be
> re-derived just before implementation so each slice fits a single
> session's context window (< 100k tokens) — split where needed, never
> merged into bigger bangs.

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

- **v1 archival.** Tag the pre-v2 tree `v1`, then delete v1 in one
  commit: `daemon/`, the vanilla-JS `ui/`, `windows/vst/`, `arm/`,
  the v1 docs (`docs/ARCHITECTURE.md`, `docs/CROSS_PLATFORM_PLAN.md`,
  `docs/DDP_Reverse_Engineering_Analysis.md` — superseded by `docs/ddp/`),
  the v1 scripts (`start-dolbyx.bat`, `setup_wsl.sh`), and the
  `linux/` / `macos/` / `nix/` `.gitkeep` placeholders. Relocate
  first: `arm/lib/libdseffect.so` + `ds1-default.xml` → `vendored/`;
  `arm/stubs/` (+ the stub-build Makefile bits) → `tools/ddp_probe/`,
  fixing the probe's `ARMDIR` and README paths so it builds
  standalone. `tools/ddp_probe/` and `samples/` stay. Rewrite the root
  README for v2.
- New Cargo workspace with the crate skeleton above.
- Top-level `Justfile` with `dev`, `build-release`, `lint`, `test`
  recipes.
- CI scaffolding: GitHub Actions running `cargo check`, `cargo test`,
  `cargo clippy`, `cargo fmt --check` on Linux + Windows.
- Solid + Vite UI scaffolding with TypeScript, ESLint, Prettier;
  `vite-plugin-solid`, `vite-plugin-singlefile`,
  `@solidjs/testing-library`, and `eslint-plugin-solid` pinned. No
  Tailwind — plain CSS with BEM + `theme.css` of CSS variables.
- `defaults.toml` created from `vendored/ds1-default.xml` — each
  factory profile / EQ preset stored as its delta over the
  `ParameterDef.default` base, plus the shared `[profile]` 20-band
  operational block (Decision 7).
- AK parameter metadata file (`parameters.toml`, runtime-loaded — no
  build step) populated with all 64 entries, **seeded from the engine tree**
  (`make -C tools/ddp_probe dump-tree`) — authoritative names, lengths,
  ranges, frac bits, and one-line descriptions straight from the binary —
  *not* transcribed from Java / [02](ddp/02-ak-parameters.md). (The engine
  also carries a long per-param help string, `make -C tools/ddp_probe
  dump-docs`, available for UI tooltips.) Seeding from the
  engine corrects Java's param-set bug for free: it drops the `mxou`/`lcsz`
  phantoms (node params that resolve to ref 0) and picks up the real leaves
  Java omits, `scpe`/`test` (both Experimental). Four-bucket settability
  classification per
  [ADR-0004](adr/0004-parameter-metadata-as-single-source-of-truth.md).
  Every entry's `default` is the engine's power-on value
  (`make -C tools/ddp_probe dump-defaults`), not 02's Music-profile
  column — engine-honest, 10-band boot, no structural-constant
  exception (the 20-band block lives in `defaults.toml`, Decision 7).
- `parameters.engine.toml` twin generated from the same probe dumps
  (`just param-twin`) and committed; CI diffs its engine-fact fields
  against `parameters.toml` and fails on drift (Decision 3).

**Progress checklist:**

- [ ] v1 tagged `v1` + deleted; `tools/ddp_probe/` builds standalone
- [ ] Cargo workspace + crate skeleton compiled
- [ ] Justfile recipes work end-to-end (`just dev`, `just lint`, `just test`)
- [ ] GitHub Actions CI green on Linux + Windows runners
- [ ] UI scaffold builds via `pnpm -C ui build`
- [ ] `defaults.toml` round-trips through TOML parser
- [ ] `parameters.toml` parses to 64 `ParameterDef`s at daemon startup
- [ ] `parameters.toml` seeded from `make -C tools/ddp_probe dump-tree` (drops `mxou`/`lcsz`, adds `scpe`/`test`)
- [ ] `ParameterDef.default` values captured via `make -C tools/ddp_probe dump-defaults`
- [ ] `parameters.engine.toml` twin committed; CI diff gate on engine-fact fields wired
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
auto-reconnecting WebSocket client (`ws.ts`), `PowerToggle.tsx`, and
`ConnectionBadge.tsx`.

**Behaviors to test (red → green order):**

1. [ ] Daemon binds `:9876`; `GET /` returns HTML carrying a valid
       `window.__BOOTSTRAP__` JSON payload (params, state).
2. [ ] WS `/ws` connects; first frame is a `state` event matching the
       current `State`.
3. [ ] WS `set_power { on: false }` flips `State.power`; daemon
       replies with an `ack` echoing the command's `request_id`.
4. [ ] With one session created via `EngineSupervisor`, `set_power`
       records `set_enabled(session, false)` on the `StubBackend`
       exactly once; with zero sessions, no engine call at all.
5. [ ] Two concurrent WS clients connect; one issues `set_power`;
       only the *other* receives the broadcast `state` event
       (originator echo suppression — see
       [ADR-0005](adr/0005-wire-protocol-i16-name-based-originator-aware.md)).
6. [ ] `power` change debounces 500 ms then writes to `config.toml`
       (overlay semantics — see
       [ADR-0007](adr/0007-toml-overlay-persistence-with-file-watcher.md)).
7. [ ] Daemon restart reloads `power` from `config.toml`.
8. [ ] Malformed JSON command returns
       `{ type: "error", code: "INVALID_REQUEST", … }` and does not
       crash the session.
9. [ ] The WebSocket client auto-reconnects after the daemon restarts
       or the socket drops; on reconnect it re-issues `get_state` and
       reconciles, and `ConnectionBadge` reflects connected /
       reconnecting (Decision 6).
10. [ ] With zero sessions, the snapshot's `readouts` carry
       `ParameterDef.default` values; real engine values are verified
       in Slice 9.
11. [ ] Refactor pass — extract duplication revealed by 1–10 without
       breaking any green test ([tdd](../.agents/skills/tdd/SKILL.md):
       never refactor while RED).

**Tracer bullet test.** Integration test: start daemon with
`StubBackend`, create one session via `EngineSupervisor`, connect via
WS, send `{ "cmd": "set_power", "on": false }`, assert `StubBackend`
recorded `set_enabled(session, false)` exactly once. Real `axum` test
client, real `tokio-tungstenite` against a bound port — no mocking
past the `Engine` trait.

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
       Decision 7).
3. [ ] WS `set_profile { id: "movie" }` updates `selected_profile`.
4. [ ] On profile switch, the daemon pushes the selected profile's full
       parameter set to the engine atomically via `set_params`.
5. [ ] `selected_profile` persists across daemon restart.
6. [ ] `reset_profile { id: "music" }` clears `config.toml`'s
       per-profile overrides; UI receives a fresh state snapshot.
7. [ ] `set_profile { id: "nonexistent" }` returns
       `INVALID_REQUEST`, leaves state unchanged.

**Tracer bullet test.** Start daemon, WS `set_profile {id:"movie"}`,
assert `StubBackend` recorded a single `set_params` call carrying
Movie's full parameter set.

**Mock policy.** Stub only.

**HITL/AFK:** AFK.

---

### Slice 3 — Factory EQ presets apply as overlays

**Slice goal.** Selecting an EQ preset (Open / Rich / Focused) writes
the preset's resolved 9 EQ params to the engine; the active profile
records the selection; `id: null` detaches — the profile's own EQ
params apply.

**Modules introduced.** `State.eq_presets`, `Profile.selected_eq_preset`
(`Option`), `WsCommands(set_eq_preset, reset_eq_preset, edit_eq_preset)`,
EQ-preset picker UI.

**Behaviors to test:**

1. [ ] Factory EQ presets load from `defaults.toml` per
       [ADR-0003](adr/0003-global-eq-presets-and-geq-per-preset.md).
2. [ ] On `set_eq_preset { id: "rich" }` the engine receives the
       preset's resolved 9 EQ params in one atomic `set_params`; the
       preset id is stored on the active profile.
3. [ ] `set_eq_preset { id: null }` detaches: the engine receives the
       profile's own EQ params in one `set_params`.
4. [ ] Editing a preset's `iebt` via `edit_eq_preset` immediately
       affects *every* profile currently selecting that preset
       ([ADR-0003](adr/0003-global-eq-presets-and-geq-per-preset.md)).
5. [ ] `selected_eq_preset` persists per-profile across restart as an
       `Option`.

**Tracer bullet test.** WS `set_eq_preset { id: "rich" }`, assert
`StubBackend` recorded one `set_params` carrying all 9 EQ params —
`iebt = [67, 95, …, -235]` and `ieon = 1` among them.

**Mock policy.** Stub only.

**HITL/AFK:** AFK.

---

### Slice 4 — Master controls (Surround Virtualizer / Dialog Enhancer / Volume Leveller)

**Slice goal.** The main screen shows the three signature DDP
controls — Surround Virtualizer, Dialog Enhancer, Volume Leveller —
each a toggle plus an amount slider. Adjusting one writes the backing
AK param(s) to the active profile, flushes to the engine, and persists.

**Modules introduced.** `MasterControls.tsx` holding the `MASTER_CONTROLS`
descriptor — three ordered `(label, enable, amount)` entries (`vdhe`/`dhsb`,
`deon`/`dea`, `dvle`/`dvla`) — with bespoke toggle + amount-slider widgets
that resolve each half's `kind` and range from the bootstrap
`params` by 4-CC; reuses `WsCommands(set_params)` against the active profile.

**Behaviors to test:**

1. [ ] The three master controls render from the `MASTER_CONTROLS`
       descriptor, each half resolving its 4-CC against the bootstrap
       metadata.
2. [ ] Toggling Volume Leveller writes its enable param to the active
       profile and flushes to the engine via a 1-entry `set_params`.
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
`set_params` carrying the Volume Leveller amount on Music, assert
`StubBackend` recorded the write and `config.toml` persisted it.

**Mock policy.** Stub. UI via `@solidjs/testing-library` with a mocked
WebSocket ([ADR-0006](adr/0006-solid-ui-with-bootstrap-injection-no-api.md)).

**HITL/AFK:** AFK.

---

### Slice 5 — Event-driven visualizer

**Slice goal.** With the daemon running, the UI shows a 20×48 SVG
spectrum brick field driven by per-block `vis` events. When audio
stops, the client freezes and fades the spectrum on its own — no
suspend protocol.

**Modules introduced.** Vis fan-out in `EngineSupervisor`
(main-session `Process` replies → `vis` events), `Visualizer.tsx`
SVG component with per-band ballistics + idle detection, `vis` event
handling in `ws.ts`, StubBackend fabricated `VisFrame`s for tests.

**Behaviors to test:**

1. [ ] Every `process()` on the main session broadcasts one `vis`
       event carrying the reply's four arrays verbatim under their
       4-CC keys (`params.vnbg` / `vnbe` / `vcbg` / `vcbe` — raw
       int16 1/16-dB).
2. [ ] `process()` on a non-main session emits nothing.
3. [ ] No audio → no `vis` events; no timer fires, no suspend flag
       exists.
4. [ ] The source is the main session (= oldest); when it dies, the
       next-oldest becomes main and takes over (Decision 4).
5. [ ] Client ballistics: fast attack / slow decay per band, smooth
       at any block rate.
6. [ ] Client idle: no event for ~200 ms → freeze last frame; fade
       spectrum to the floor over ~500 ms.
7. [ ] SVG renders 20 columns × 48 rows; brick color matches the
       `r<12` / `12≤r<18` / `r≥18` rule from
       [ADR-0008](adr/0008-visualizer-equalizer-rendering-spec.md).
8. [ ] dB mapping is asymmetric `[-12, +36]` per
       [ADR-0008](adr/0008-visualizer-equalizer-rendering-spec.md).

**Tracer bullet test.** Start daemon with `StubBackend` fabricating
fixed `VisFrame`s; keep the main session live via periodic
`process()` calls (no audio path until Slice 10); subscribe via WS;
assert one `vis` event per `process()` carrying the fabricated arrays
verbatim, and zero events after the calls stop.

**Mock policy.** Stub fabricated frames only. The real engine's vis
tail (shim `ak_get_bulk` append) is verified in Slice 9.

**HITL/AFK:** AFK.

---

### Slice 6 — GEQ editing with smoother + inverse

**Slice goal.** A user drags an EQ thumb; the daemon receives
smoothed, clamped 20-band `gebg` writes throttled at ≤ 60 ms
intervals. Switching EQ presets keeps the next drag continuous via
the inverse-smoother matrix.

**Modules introduced.** UI `GainSmoother` (thick-brush splat, kernel
convolution, exponential decay, inverse-on-preset-change),
`EqCurve.tsx`, `WsCommands(set_params)` for `gebg`, GEQ-thumb pointer
pipeline.

**Behaviors to test:**

1. [ ] `enqueue(band, dB)` followed by `tick()` returns a smoothed
       20-band int16 array within the engine's `gebg` clamp.
2. [ ] Kernel selection (`Mobile` / `Soft` / `Direct`) changes the
       output shape per the matrices in `GraphicEqualizerPainter.java`.
3. [ ] Out-of-range values decay toward the violated clamp with
       `α = 0.5^(Δt / 0.3s)`.
4. [ ] `tick()` emits at most one write per 60 ms (30 ms while
       idle).
5. [ ] On `state` broadcast updating active `gebg`, the
       inverse-smoother repopulates `temp` so the next touch stays
       continuous.
6. [ ] WS `set_params { params: { "gebg": [...] } }` forwards to
       `StubBackend::set_params` correctly.
7. [ ] EQ curve renders as a polyline with rounded joins (not
       Catmull-Rom) per
       [ADR-0008](adr/0008-visualizer-equalizer-rendering-spec.md).
8. [ ] EQ edits route UI-side: a GEQ drag emits `edit_eq_preset` when a
       preset is active, else `set_params`.

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
remove_profile, add_eq_preset, rename_eq_preset, remove_eq_preset)`,
derived `is_factory`, CRUD UI affordances.

**Behaviors to test:**

1. [ ] `is_factory(id)` is derived from `Defaults` presence; not
       stored on disk.
2. [ ] `add_profile { from: "music", name: "Late Night" }` clones
       Music's overrides under a freshly generated id
       (`user_<hash>`).
3. [ ] Renaming a custom profile updates `name`, not `id` (id stable;
       persistence keys on id).
4. [ ] Factory items cannot be deleted or renamed — daemon returns
       `INVALID_REQUEST`.
5. [ ] Deleting a custom EQ preset that N profiles select falls all
       of them back to `None` (their own EQ params).
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

### Slice 8 — Advanced panel auto-generated for all 64 AK parameters

**Slice goal.** Opening the Advanced section renders every AK parameter
as a widget chosen by its `ParamKind` × `ParamAccess`.
Settable / Experimental widgets write back through WS; ReadOnly-Dynamic
cards live-update from `vis` events; ReadOnly-Static cards render the
snapshot `readouts`.

**Modules introduced.** `WidgetFactory.tsx`, the nine widget
components (`ToggleWidget`, `TristateWidget`, `IntegerWidget`,
`DecibelWidget`, `FrequencyWidget`, `DegreesWidget`,
`ArrayPerBandWidget`, `AobgWidget`, `ReadOnlyWidget`), category-grouped
CSS-grid layout.

**Behaviors to test:**

1. [ ] Bootstrap delivers all 64 `ParameterDef` entries in stable
       table order.
2. [ ] `WidgetFactory` dispatches by `(ParamKind, ParamAccess)`;
       every kind has a matching widget; unknown combos render an
       opaque-int fallback with a console warn.
3. [ ] Settable widgets emit `set_params` on commit (debounced 60 ms
       for continuous controls).
4. [ ] Experimental widgets render with a small "experimental" badge
       ([ADR-0004](adr/0004-parameter-metadata-as-single-source-of-truth.md)).
5. [ ] ReadOnly-Dynamic cards (`vnbg`, `vnbe`, `vcbg`, `vcbe`)
       live-update from `vis` events.
6. [ ] ReadOnly-Static cards render the snapshot `readouts`; the `ver`
       card shows the formatted "2.0.4.0".
7. [ ] `aobg` widget renders the channel-id-prefixed layout
       (Decision 3), not header + interleaved pairs.
8. [ ] Long arrays (`aobg ≤ 329`, `arbi`/`arbl`/`arbh`/`aobf`/`arbf`
       40) render in a wide card collapsed by default.
9. [ ] Category headers introduce groupings.

**Tracer bullet test.** Render `AdvancedPanel` with a fixture of 64
params, assert 64 widgets appear in a `data-testid`-matched grid;
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
(binary protocol, the AK-direct param binding, the resolved-profile
apply, `SET_CONFIG`) — [tests.md](../.agents/skills/tdd/tests.md)
("integration tests survive refactors") makes this approach load-bearing.

**Modules introduced.** `QemuBackend` (`ddp-engine`),
`ddp-engine-arm` ARMv7 binary, shared `protocol.rs`.

**Behaviors to test:**

1. [ ] `ddp-engine-arm` cross-compiles for
       `armv7-unknown-linux-gnueabihf`.
2. [ ] `QemuBackend::start` spawns one `qemu-arm-static` subprocess
       and initializes a session via the AK-direct binding
       ([ADR-0010](adr/0010-ak-direct-params-cmd-lifecycle.md)):
       - `EFFECT_CMD_INIT`, then resolve all 64 4-CC names to refs
         with `ak_find` — no DEFINE_PARAMS / DEFINE_SETTINGS handshake.
       - `EFFECT_CMD_SET_CONFIG` at the session's rate — always sent,
         pinning stereo + PCM16 + WRITE (Decision 1).
       - One `set_params` of the resolved active profile (+ selected
         EQ preset); the shim's commit-leaf touch reshapes the 10-band
         power-on state into the 20-band stereo config — no separate
         constant-params step, and no `VISUALIZER_ENABLE` cmd 7
         (`ven = 1` rides the profile apply).
       - `EFFECT_CMD_ENABLE`.
3. [ ] All Slices 1–8 integration tests pass under
       `cargo test --features qemu`.
4. [ ] `tools/ddp_probe/` regression harness runs in CI under
       `qemu-user-static` and verifies the documented behavior
       (cmd 3 ≡ `ak_set` via `akctl_probe`, `SET_CONFIG` rate-swap via
       `setconfig_probe`, cache-raw vs registry-clamped, 7560 / 5512
       sample crossfade).
5. [ ] `EngineSupervisor` respawns the subprocess on crash; the
       session map is reconstructed transparently.
6. [ ] `get_params(["ver"])` fills the snapshot `readouts`; the
       Advanced `ver` card shows 2.0.4.0.
7. [ ] Playwright E2E lands, driving the real daemon + `QemuBackend`
       end-to-end.

**Tracer bullet test.** `cargo test --features qemu -p ddp-daemon
power_toggle_persists` — the Slice-1 tracer bullet test, now against
the real engine.

**Mock policy.** Real engine. `StubBackend` stays in the codebase for
fast inner-loop tests; the `qemu` cargo feature toggles which backend
the integration tests bind to.

**HITL/AFK:** HITL — the first QEMU green run requires manual
investigation of any session-init delta. The engine doesn't emit
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
       `/run/dolbyx/dolbyx.sock`.
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
       ARM engine applies `EFFECT_CMD_SET_CONFIG` so processed audio
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
feature) and `ddp-engine`'s `qemu_smoke.rs` exercise the full QEMU +
`libdseffect.so` path. UI E2E (Playwright, landing with Slice 9)
drives the real daemon with the real engine so the binary protocol
and the AK-direct engine binding are covered end-to-end.

**TypeScript**: `strict: true`, `noUncheckedIndexedAccess: true`,
`exactOptionalPropertyTypes: true`. ESLint with
`@typescript-eslint/strict-type-checked` and `eslint-plugin-solid`.
Prettier. Components have unit tests in Vitest with
`@solidjs/testing-library` and a mocked WebSocket; user flows have
E2E tests in Playwright against a real daemon driving the real
engine (`QemuBackend` + `libdseffect.so`). Mocking the daemon's
WebSocket would duplicate the daemon's logic in test fixtures and
drift over time; mocking the engine would skip the binary protocol,
the AK-direct param binding, and lifecycle (`SET_CONFIG` / crossfade) —
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
| EQ preset model           | Per-profile static array                             | Global *optional* overlay of the 9 EQ params; `None` valid; edits affect every profile selecting it                                                                                            |
| GEQ model                 | 6 × 4 × 20 matrix                                    | Profile-owned; a selected EQ preset's overlay shadows it                                                                                                                                       |
| Wire format               | Mixed dB / int16                                     | int16 1/16-dB throughout; dB conversion is UI-only                                                                                                                                             |
| Wire protocol             | Parameter indices; cmd 3 GET swallowed silently      | Parameter names (4-CC); single source of truth via metadata table; params via AK accessors (`ak_set`/`ak_set_bulk` write, `ak_get`/`ak_get_bulk` real read); cmd protocol for lifecycle; the vis frame (`vc*` + `vn*`) rides every `Process` reply (ADR-0010)|
| Param coverage            | 24 of 64 AK params                                   | All 64 AK params via `ak_find`/`ak_set` (no DEFINE_PARAMS/SETTINGS handshake); four buckets: Settable / Experimental / ReadOnly-Dynamic / ReadOnly-Static (incl. the build/license readouts — `ver` is the version readout)                                |
| Web UI                    | Vanilla JS embedded in daemon                        | Solid + TypeScript + Vite; plain CSS + BEM; separate dev workflow; daemon injects bootstrap (metadata table + initial state) into the disk-served `index.html` — nothing embedded |
| Persistence               | Multi-file XML                                       | Runtime `parameters.toml` + `defaults.toml` (next to the daemon binary) + `config.toml` (platform data dir); table-per-id; 5-layer cascade; 500 ms debounce                                    |
| External edits            | Not supported                                        | `notify`-based watcher on `config.toml` only (the binary-side TOMLs load at startup); debounced reload + state-snapshot broadcast                                                              |
| Visualizer                | Gains only                                           | Per-block `vis` events riding `Process` replies (`vc*` gains/excitations + `vn*` native); client ballistics + idle fade — no pump, no suspend protocol                                         |
| Power off                 | Zero-out the OFF profile                             | `EFFECT_CMD_DISABLE` on the engine; engine performs graceful crossfade; idempotent; parameter state survives the toggle                                                                        |
| Custom profile categories | Labelled (Movie / Music / Game / Voice / Customized) | Removed; custom profiles are just named profiles                                                                                                                                               |
| First-run defaults        | Undefined                                            | Music profile + power on, matching original DDP out-of-box                                                                                                                                     |
