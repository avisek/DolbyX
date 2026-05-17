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
6. Every `libdseffect.so`-settable AK parameter is exposable through an
   Advanced UI section, driven by metadata.
7. Backend-agnostic engine layer: the QEMU subprocess approach is the
   default for v2.0; Unicorn Engine and Static Binary Translation slot in
   as alternative backends without touching the rest of the code.
8. Single-process daemon hosting: HTTP/WebSocket server, audio plugin IPC,
   and engine all in one binary.
9. Rust for the daemon, React with TypeScript for the Web UI.
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
│  React UI (Vite-built SPA, separate dev workflow)                         │
│  - Auto-generated Advanced section from /api/parameters                   │
│  - dB units throughout; daemon does the fixed-point conversion            │
│  - Auto-reconnecting WebSocket                                            │
└────────────────────────┬──────────────────────────────────────────────────┘
                         │ JSON over WebSocket
                         │ HTTP for static + /api/parameters
                         │
┌────────────────────────▼──────────────────────────────────────────────────┐
│  dolbyx-daemon  (Rust, single process)                                    │
│  ┌───────────────────────────────────┐                                    │
│  │ HTTP server (axum/hyper)          │   serves /api, /ws, and the built  │
│  │  + WebSocket handler              │   UI at / in production            │
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
    fn get_param(&self, id: SessionId, name: &str, out: &mut [i16]) -> Result<()>;
    fn get_visualizer_data(&self, id: SessionId) -> Result<VisualizerData>;
    fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<()>;
    fn version(&self) -> Result<String>;
}

pub struct VisualizerData {
    pub gains: [i16; 20],        // vcbg
    pub excitations: [i16; 20],  // vcbe
}
```

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

### Decision 2 — IEQ presets are global, decoupled from profiles

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
    is_factory: bool,                     // factory profiles can be reset but not deleted
    selected_eq_preset: PresetId,         // points into State.eq_presets
    params: HashMap<String, Vec<i16>>,    // AK param overrides keyed by 4-CC
}

struct EqPreset {
    id: PresetId,                         // e.g. "off", "rich", "user_91c2"
    name: String,                         // display name, user-editable
    is_factory: bool,                     // factory presets can be reset but not deleted
    ieq: BandCurve,                       // ieon + iebt
    geq: BandCurve,                       // geon + gebg
}

enum BandCurve {
    Off,
    Curve([i16; 20]),
}
```

User-visible consequences:

- Editing the "Rich" preset (e.g. tweaking the `gebg` or `iebt` curve) takes
  effect immediately for every profile that currently has Rich selected.
- Adding a new IEQ preset makes it available across every profile.
- Removing an IEQ preset: any profile that had it selected falls back to
  the "Off" preset.
- GEQ edits are owned by the current IEQ preset, and can be used across profiles.
  (This is a deliberate simplification from the original, where GEQ was
  per-(profile, preset).)

Factory IEQ presets are `Off`, `Open`, `Rich`, `Focused`. Factory profiles
are `Movie`, `Music`, `Game`, `Voice`. Factory items cannot be deleted;
they can be reset to their bundled defaults.

Note:
Original DDP only allowed `gebg` curves to be edited through the
Visualizer/Equalizer UI, and `iebt` curves could not be edited beyond their
factory values. DolbyX will keep this behavior for now. In the future,
DolbyX will support editing the `iebt` curve as well (through the same
Visualizer/Equalizer, behind a toggle).

#### State mutation semantics

Every mutation is described here exactly, as a spec for the `ddp-state` crate.

**`set_profile(id)`**

1. Update `selected_profile`.
2. Push all of the new profile's `params` overrides to the engine.
3. Push `gebg = profile.geq` to the engine.
4. Resolve `profile.selected_eq_preset`; push `ieon = (preset.iebt.is_some() as i16)`.
   If not Off, push `iebt = preset.iebt`.
5. Broadcast `state` to all WS clients except originator.

**`set_eq_preset(id)`**

1. Update `profiles[selected].selected_eq_preset`.
2. Push `ieon` and (if not Off) `iebt` to the engine.
3. `gebg` is **not** touched — the profile's GEQ curve persists.
4. Broadcast.

**`set_geq(bands)`**

1. Update `profiles[selected].geq`.
2. Push `gebg` to the engine.
3. Broadcast.

**`edit_eq_preset_targets(id, iebt)`**

1. Update `eq_presets[id].iebt`.
2. If the currently active profile has that preset selected, push the new `iebt`
   to the engine. Otherwise, no engine call.
3. Broadcast.

**`add_profile { from, name }`**

1. Clone the source profile, assign a fresh stable id and the user's name.
2. Set `is_factory = false`.
3. Append to `profiles`.
4. Broadcast.

**`add_eq_preset { from, name }`**

1. Clone the source preset, assign a fresh stable id and name.
2. Set `is_factory = false`.
3. Append to `eq_presets`.
4. Broadcast.

**`remove_profile(id)`**

1. Reject if `is_factory`.
2. If currently selected, switch to `"music"` first (which triggers `set_profile` above).
3. Remove from `profiles`.
4. Broadcast.

**`remove_eq_preset(id)`**

1. Reject if `is_factory`.
2. For every profile whose `selected_eq_preset == id`, set it to `"off"`.
3. If the deletion caused the active profile's preset to fall back, push updated
   `ieon`/`iebt` to the engine.
4. Remove from `eq_presets`.
5. Broadcast.

**`reset_profile(id)`** / **`reset_eq_preset(id)`**
Restore the item's fields from `factory-defaults.toml`. If the reset item is
currently active, push the restored parameters to the engine. Broadcast.

**`set_power(on)`**

1. Update `power`.
2. Call `engine.set_enabled(session, on)` — uses `EFFECT_CMD_DISABLE` / `EFFECT_CMD_ENABLE`
   on the engine directly, without mutating any parameter.
3. Broadcast.

---

### Decision 3 — Parameter metadata as the single source of truth

All AK parameters are declared once in a static metadata table. Everything
else — wire protocol, engine init, persistence, UI generation, range
validation — derives from this table.

```rust
pub struct ParameterDef {
    pub name: &'static str,             // 4-CC: "dvla", "iebt", …
    pub length: usize,                  // 1 for scalars, 20 for per-band, etc.
    pub range: (i16, i16),              // inclusive engine-unit bounds
    pub default: ParamDefault,          // scalar or per-band array
    pub kind: ParamKind,                // drives UI widget choice
    pub category: ParamCategory,        // for UI grouping
    pub label: &'static str,            // human-readable display name
    pub help: &'static str,             // tooltip text
    pub settable: bool,                 // can be written by the daemon
    pub basic: bool,                    // member of the 5-bool digest
    pub visible_in_advanced: bool,
}

pub enum ParamDefault {
    Scalar(i16),
    PerBand([i16; 20]),    // iebt, gebg, iebf, gebf, …
    PerBandLR([i16; 40]),  // aobg
}

pub enum ParamKind {
    Toggle,             // 0/1
    Tristate { on: i16 }, // 0/1/2, where "on" = 1 or 2 depending on parameter
    Integer { max: u16 },
    Decibel { lkfs: bool, divisor: u16 }, // divisor = 16 typically
    FrequencyHz,
    Degrees,
    PerBand,
    PerBandLR,                     // for aobg (40 entries = 20 bands × 2 ch)
    ReadOnly,
}

pub enum ParamCategory {
    Basic,
    Ieq,
    Geq,
    VolumeLeveller,
    DialogEnhancer,
    HeadphoneVirtualizer,
    SpeakerVirtualizer,
    NextGenSurround,
    AudioRegulator,
    AudioOptimizer,
    VolumeMaximizer,
    PeakLimiter,
    Visualizer,
    Diagnostic,
}
```

The table covers all 64 AK parameters (see
[docs/ddp/02-ak-parameters.md](ddp/02-ak-parameters.md)). Of these,
~42 are settable; the rest are read-only (build, version, license, endpoint).

Wire and storage use the 4-CC name string throughout. Saved configs are
stable under reordering the table. Adding a new parameter to the Advanced
section is a one-line edit: append to the table; the UI auto-discovers it on
the next fetch of `/api/parameters`.

---

### Decision 4 — Wire protocol: name-based, originator-aware

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
{ "cmd": "set_power",         "on": true }
{ "cmd": "set_profile",       "id": "music" }
{ "cmd": "set_param",         "name": "dvla", "value": 4 }
{ "cmd": "set_param",         "name": "iebt", "values": [67, 95, ...] }
{ "cmd": "set_geq",           "bands_db": [-2.0, 0.0, 1.5, ...] }
{ "cmd": "set_eq_preset",    "id": "rich" }

{ "cmd": "add_profile",       "from": "music", "name": "My Music" }
{ "cmd": "rename_profile",    "id": "user_a3f1", "name": "Late Night" }
{ "cmd": "remove_profile",    "id": "user_a3f1" }
{ "cmd": "reset_profile",     "id": "music" }

{ "cmd": "add_eq_preset",    "from": "rich", "name": "Vocal Forward" }
{ "cmd": "rename_eq_preset", "id": "user_91c2", "name": "Vocal" }
{ "cmd": "edit_eq_preset",   "id": "user_91c2", "iebt_db": [...] }
{ "cmd": "remove_eq_preset", "id": "user_91c2" }
{ "cmd": "reset_eq_preset",  "id": "rich" }
```

Events (daemon → client):

```jsonc
{ "type": "state",         "snapshot": { /* full state */ } }
{ "type": "vis",           "excitations_db": [...], "gains_db": [...] }
{ "type": "vis_suspended", "suspended": true }
{ "type": "ack",           "request_id": "...", "ok": true }
{ "type": "error",         "request_id": "...", "code": "INVALID_PARAM", "message": "..." }
```

The full `state` snapshot is also sent on `get_state`, on connect, and any
time the daemon's internal state mutates from a non-WS source (e.g.
config-file reload). At DolbyX's state scale (hundreds of bytes) full
snapshots are preferable to partial diffs.

The daemon also serves two static HTTP endpoints fetched once at UI startup:

```
GET /api/parameters       → ParameterDef[]   (the metadata table)
GET /api/factory_defaults → factory profiles + IEQ presets
```

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
| 0x11 | `GetParam`       | `[u32 session_id][4-CC name][u16 count]`              | `[i16 × count]`                          |
| 0x20 | `GetVisualizer`  | `[u32 session_id]`                                    | `[i16 × 20 gains][i16 × 20 excitations]` |
| 0x30 | `Process`        | `[u32 session_id][u32 frames][i16 × frames × 2 pcm]`  | `[i16 × frames × 2 pcm]`                 |
| 0x40 | `Version`        | empty                                                 | `[u8 len][u8 × len utf-8]`               |

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

---

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

---

### Decision 6 — Web UI in React with TypeScript, separate dev workflow

The UI lives in its own directory (`ui/`) and is developed independently
with full hot-reload via Vite.

Stack:

- **React 19 + TypeScript** with `strict: true`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`.
- **Vite** for dev server and production build.
- **Tailwind CSS** with a custom theme matching the original DDP's dark navy
  background and Dolby cyan accent.
- **Zustand** for state management — small, low ceremony, no provider hell.
- **Vitest** for unit tests, **Playwright** for E2E against a mock daemon.
- **ESLint** with `@typescript-eslint/strict-type-checked`, **Prettier**.

Development workflow:

```bash
# Terminal 1 — daemon
cargo run -p dolbyx-daemon

# Terminal 2 — UI with hot reload
cd ui && pnpm dev      # Vite at http://localhost:5173, proxies /api and /ws to :9876
```

Production build:

```bash
cd ui && pnpm build                                           # → ui/dist/
cargo build --release --features embedded-ui                  # embeds ui/dist/ via rust-embed
```

With `embedded-ui` enabled, the daemon serves the UI at `/`. Without it
(the dev default), the daemon returns a landing page pointing to the Vite
dev server. This keeps the production deployment a single self-contained
binary while allowing UI iteration without Rust rebuilds.

UI component tree:

```
src/
├── main.tsx
├── App.tsx
├── store/
│   ├── state.ts           # Zustand store — mirrors daemon state shape
│   └── ws.ts              # WebSocket client + auto-reconnect
├── components/
│   ├── PowerToggle.tsx
│   ├── ProfileTabs.tsx
│   ├── EqPresetPicker.tsx
│   ├── BasicSwitches.tsx  # Volume Leveller + Dialog Enhancer + Surround Virtualizer
│   ├── Visualizer.tsx     # SVG visualizer + EQ curve
│   ├── EqCurve.tsx
│   └── ConnectionBadge.tsx
├── advanced/
│   ├── AdvancedPanel.tsx  # auto-generated from /api/parameters
│   ├── widgets/
│   │   ├── ToggleWidget.tsx
│   │   ├── TristateWidget.tsx
│   │   ├── IntegerWidget.tsx
│   │   ├── DecibelWidget.tsx
│   │   ├── FrequencyWidget.tsx
│   │   ├── DegreesWidget.tsx
│   │   └── ArrayPerBandWidget.tsx
│   └── WidgetFactory.tsx  # ParamKind → widget
└── lib/
    ├── ws.ts              # WebSocket types and auto-reconnect logic
    ├── parameters.ts      # types for /api/parameters
    └── units.ts           # int16 ↔ dB helpers
```

---

### Decision 7 — Persistence layout

One TOML file in the platform-standard data location:

- Windows: `%PROGRAMDATA%\DolbyX\config.toml`
- Linux: `/var/lib/dolbyx/config.toml`

A separate read-only `factory-defaults.toml` ships bundled with the daemon.
It defines all four factory profiles and four factory IEQ presets with their
original DDP values. The user's `config.toml` stores only deltas — matching
the overlay model the original DDP used with `ds1-default.xml` /
`ds1-current.xml`. The `factory-defaults.toml` also drives `reset_profile`
and `reset_eq_preset` actions.

Schema:

```toml
[state]
power = true
selected_profile = "music"

[[eq_preset]]
id = "off"
name = "Off"
is_factory = true
# no iebt — IEQ engine disabled when this preset is active

[[eq_preset]]
id = "open"
name = "Open"
is_factory = true
iebt = [117, 133, 188, 176, 141, 149, 175, 185, 185, 200,
        236, 242, 228, 213, 182, 132, 110,  68, -27, -240]

[[eq_preset]]
id = "rich"
name = "Rich"
is_factory = true
iebt = [67, 95, 172, 163, 168, 201, 189, 242, 196, 221,
       192, 186, 168, 139, 102,  57,  35,   9, -55, -235]

[[eq_preset]]
id = "focused"
name = "Focused"
is_factory = true
iebt = [-419, -112, 75, 116, 113, 160, 165, 80, 61, 79,
          98,  121, 64,  70,  44, -71, -33, -100, -238, -411]

[[profile]]
id = "music"
name = "Music"
is_factory = true
selected_eq_preset = "rich"
geq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

[profile.params]
# Only parameters that differ from the bundled factory defaults are stored
dvla = 4
deon = 1
dea = 2
dhsb = 48
vdhe = 2
ngon = 2
aoon = 2
plmd = 4
vmb = 144
```

Persistence write semantics:

- `[state]` (power + selected_profile) writes are debounced 500 ms.
- `[[profile]]` and `[[eq_preset]]` writes are debounced 2 s.
- All pending writes are flushed on graceful daemon shutdown (SIGTERM /
  Windows console close handler).
- The legacy v1 TOML schema (positional `[ProfileName]` sections with
  positional params arrays) is migrated automatically on first load and
  re-saved in the new schema.

### Decision 8 — First-run UX

On a fresh install (no `config.toml` exists), the daemon initializes from
`factory-defaults.toml` and writes a minimal config:

```toml
[state]
power = true
selected_profile = "music"
```

Power is on, Music profile is selected, no per-profile overrides. The user
hears the original DDP Music profile defaults the first time they play audio.
This is "preserve the original default behaviour" made concrete.

---

### Decision 9 — Custom profiles have no category

The original DDP categorised profiles as Movie / Music / Game / Voice /
Customized. The category had no engine semantics; it only drove UI grouping
and an icon. In DolbyX v2, factory profiles keep their category-derived
display names. Custom profiles have no category — they are simply listed
under "Custom" with their user-chosen name.

This eliminates a UI affordance the user would have to make a decision about
with no functional consequence.

### Decision 10 — Visualizer pump rate and rendering

The pump runs at a fixed 50 ms cadence, matching the original DDP. Hardcoded
as a named constant, not a user setting:

```rust
// crates/ddp-daemon/src/visualizer_pump.rs
pub const VISUALIZER_PUMP_INTERVAL: Duration = Duration::from_millis(50);
pub const VISUALIZER_SUSPENDED_THRESHOLD: u32 = 10; // consecutive near-silent reads
```

Each tick:

1. Call `engine.get_visualizer_data(session)` → `(gains[20], excitations[20])`.
2. If all excitations are below 1 dB for `VISUALIZER_SUSPENDED_THRESHOLD`
   consecutive ticks, broadcast `vis_suspended: true` and suppress further
   `vis` events until activity resumes.
3. Otherwise broadcast `{ type: "vis", gains_db: [...], excitations_db: [...] }`
   with values converted from 1/16 dB i16 to float dB.

UI rendering — a single `<svg>` with layered groups matching the original DDP:

- Background: radial gradient (dark navy → near-black).
- Spectrum bars: 20 columns × 48 rows driven by `excitations_db`, quantized to
  grid cells. Colour bands: red rows 0–11, yellow 12–17, blue 18–47.
- EQ curve: Catmull-Rom spline through the profile's stored `geq` values (not
  the `vcbg` read-back from the engine — the stored `geq` is the source of
  truth, giving low-latency drag rendering).
- Draggable knob handles for GEQ editing. Touch editing uses an event queue
  with the `GAIN_SMOOTHER` kernel matching the original DDP's feel (see
  [docs/ddp/04-ui-data-flow.md](ddp/04-ui-data-flow.md#example-2--moving-an-eq-slider)).

---

### Decision 11 — Bundle `libdseffect.so` with releases

The release artifact contains:

```
dolbyx/
├── dolbyx-daemon          # Rust binary (UI embedded)
├── dolbyx-engine-arm      # ARM-side engine binary (cross-compiled ARMv7)
├── libdseffect.so         # bundled
└── README.txt
```

Plus platform-specific extras (the VST DLL on Windows, the LV2 bundle on
Linux). For early development and the v2.0 release, `libdseffect.so` is
embedded in the daemon binary via `include_bytes!`. On first run the daemon
extracts it to a known cache location (`%PROGRAMDATA%\DolbyX\engine\` on
Windows, `/var/lib/dolbyx/engine/` on Linux) and loads it from there.
Subsequent runs reuse the cached copy.

This is a deliberate tradeoff: ease-of-install over legal cleanliness.
Distribution is for personal use. A future release can flip to a
"supply your own .so" model with no other changes.

### Decision 12 — Logging and observability

The daemon emits structured logs via `tracing` with a `RUST_LOG` filter.

- `stdout` (default): human-readable, level-colored, for development.
- `stderr`: errors and warnings duplicated here even when `stdout` is silenced.
- Optional rotating file at `%PROGRAMDATA%\DolbyX\logs\dolbyx.log` (Windows)
  or `/var/log/dolbyx/dolbyx.log` (Linux), 7-day retention.

A diagnostic endpoint at `GET /api/diagnostics` returns:

- Current engine version (`"APPv1 version 1.8.0.0"`).
- Active backend (`qemu` / `unicorn` / `static`).
- Active session ids and their sample rates.
- Last visualizer-suspended timestamp.
- Last error events.

This is shown in the UI's "About" panel and is the entry point for support
diagnostics.

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
    pub is_factory: bool,
    pub selected_eq_preset: PresetId,
    pub geq: [i16; 20],                          // 1/16 dB; UI shows dB
    pub params: HashMap<&'static str, Vec<i16>>, // AK param overrides keyed by 4-CC
}

pub struct EqPreset {
    pub id: PresetId,
    pub name: String,
    pub is_factory: bool,
    pub iebt: Option<[i16; 20]>,                 // None for the "Off" sentinel
}
```

Factory items (`is_factory = true`):

- **Factory profiles**: `movie`, `music`, `game`, `voice`. Cannot be deleted
  or renamed. Can be reset to bundled defaults.
- **Factory IEQ presets**: `off`, `open`, `rich`, `focused`. Cannot be deleted
  or renamed. Can be reset to bundled defaults. `off` has no `iebt`; selecting
  it causes the daemon to push `ieon = 0` to the engine.

Custom items (`is_factory = false`) can be freely renamed, edited, or deleted.

---

## Module structure

```
DolbyX/
├── Cargo.toml                       # Cargo workspace
├── rust-toolchain.toml              # pin a stable Rust version
├── flake.nix                        # Nix shell + NixOS module (Linux)
├── crates/
│   ├── ddp-engine/                  # Engine trait + backend impls
│   │   ├── src/lib.rs               #   trait Engine
│   │   ├── src/qemu.rs              #   QemuBackend (shared subprocess)
│   │   ├── src/protocol.rs          #   binary protocol (shared with engine-arm)
│   │   ├── src/backend_unicorn/     #   future, scaffolded empty
│   │   ├── src/backend_sbt/         #   future, scaffolded empty
│   │   └── tests/qemu_smoke.rs
│   ├── ddp-state/                   # Pure state model — no I/O
│   │   ├── src/lib.rs
│   │   ├── src/profile.rs
│   │   ├── src/preset.rs
│   │   ├── src/state.rs             #   State aggregate + all mutations
│   │   ├── src/parameters.rs        #   AK metadata table (static, 64 entries)
│   │   └── src/conversion.rs        #   int16 ↔ dB helpers
│   ├── ddp-persistence/             # TOML load/save — separate from state logic
│   │   ├── src/lib.rs
│   │   ├── src/schema.rs            #   serde structs matching the TOML
│   │   ├── src/factory.rs           #   bundled factory-defaults.toml
│   │   └── src/debounce.rs          #   write debouncing (500 ms / 2 s)
│   ├── ddp-daemon/                  # The dolbyx-daemon binary
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
│   │   └── tests/integration.rs     #   mock-engine WebSocket protocol tests
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
├── ui/                              # React app — independent pnpm project
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── vite.config.ts               # proxies /api + /ws to localhost:9876
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── index.html
│   └── src/                         # (see Decision 6 for component tree)
├── factory-defaults/
│   ├── factory-defaults.toml        # bundled factory profiles + IEQ presets
│   └── parameters.toml              # source for the AK metadata codegen
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

---

## Implementation phases

Phases 0–5 constitute the v2.0 release. Phase 6 is v2.1. Phase 7 is v3.0.

### Phase 0 — Workspace bootstrap (≈ 1 week)

- New Cargo workspace with the crate skeleton above.
- CI scaffolding: GitHub Actions running `cargo check`, `cargo test`,
  `cargo clippy`, `cargo fmt --check` on Linux + Windows.
- React + Vite UI scaffolding with TypeScript, ESLint, Prettier.
- `factory-defaults.toml` created with factory profiles and IEQ presets
  transcribed from `ds1-default.xml`.
- AK parameter metadata table (`parameters.toml` + codegen) populated with
  all 64 entries from [docs/ddp/02-ak-parameters.md](ddp/02-ak-parameters.md).
- No functional behaviour yet; CI is green on a skeleton.

### Phase 1 — State + persistence (≈ 1 week)

- `ddp-state` crate: full data model, factory loading, all mutation operations
  as specified in Decision 2.
- `ddp-persistence` crate: TOML load/save, factory-defaults overlay, debounced
  writes (500 ms for `[state]`, 2 s for profiles/presets).
- Migration from v1 TOML schema.
- Unit + property tests cover the state model fully, including bidirectional
  `f32 dB ↔ i16` 1/16-dB conversion via `proptest`.
- No engine, no server yet; verify with unit tests only.

### Phase 2 — Engine integration (≈ 2 weeks)

- `ddp-engine-arm` binary: cross-compiled to ARMv7, runs under
  `qemu-arm-static`, loads `libdseffect.so`, implements the binary protocol
  with correct init handshake (`DEFINE_PARAMS` with all 64 params,
  constant-params dance `genb`/`ienb`/`aonb`/`gebf`, proper
  `DEFINE_SETTINGS` with per-element offsets, explicit `VISUALIZER_ENABLE`).
- `QemuBackend` in `ddp-engine`: spawns one shared subprocess, multiplexes
  sessions, propagates errors.
- End-to-end test: state mutation → engine round-trip → audio shape matches
  expectations.

### Phase 3 — Daemon server (≈ 1.5 weeks)

- `ddp-daemon` integrates state, engine supervisor, and the HTTP + WebSocket
  server.
- All UI ↔ daemon commands implemented and tested (verify with `curl` +
  `websocat`; no UI yet).
- Originator-aware broadcast pattern.
- Visualizer pump at the named-constant 50 ms cadence with suspended-state
  detection.
- Plugin server accepts Windows named-pipe and AF_UNIX connections, allocates
  sessions, multiplexes audio.

### Phase 4 — React UI (≈ 2–3 weeks)

- Core controls: power, profile picker, the three master toggles (Volume
  Leveller / Dialog Enhancer / Surround Virtualizer), IEQ preset picker, reset.
- SVG visualizer matching the original DDP look: spectrum bars from
  excitations, EQ curve overlay (Catmull-Rom spline), draggable handles
  with `GAIN_SMOOTHER` kernel.
- Profile and IEQ-preset management: add, delete, rename.
- Advanced panel auto-generated from `/api/parameters` metadata.
- WebSocket auto-reconnect, dev/prod build flows.
- Tests: Vitest for components, Playwright for end-to-end flows against a
  mock daemon.

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

---

## Code quality standards

**Rust**: `#![deny(missing_docs, warnings)]` at crate roots.
`cargo clippy -- -D warnings -W clippy::pedantic -W clippy::nursery`.
`cargo fmt --check`. `#![forbid(unsafe_code)]` everywhere except the engine
FFI boundary; that boundary has `// SAFETY:` comments on every invariant.

**Tests**: unit tests live next to the code in `#[cfg(test)] mod tests`.
Integration tests in `tests/`. Property tests via `proptest` for
invertible conversions (dB ↔ 1/16 dB, dB-clamp ↔ engine-clamp).
Mock-engine integration tests for the daemon's WebSocket protocol.

**TypeScript**: `strict: true`, `noUncheckedIndexedAccess: true`,
`exactOptionalPropertyTypes: true`. ESLint with
`@typescript-eslint/strict-type-checked`. Prettier. Components have unit
tests in Vitest; flows have E2E tests in Playwright.

**CI**: GitHub Actions runs the full test matrix on Linux + Windows for every
push and PR. Required checks before merge: `cargo test`,
`cargo clippy -- -D warnings`, `cargo fmt --check`, `pnpm run lint`,
`pnpm run test`.

**Documentation**: every public Rust item has a `///` doc comment with an
example where reasonable. The `ui/` directory has a README describing the
component architecture and dev workflow. The repo root README has a quickstart
for both end users and contributors.

---

## What this changes vs v1

| Aspect                    | v1                                                   | v2                                                                           |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Daemon language           | C                                                    | Rust                                                                         |
| Engine integration        | Per-stream QEMU subprocess                           | One shared QEMU subprocess, all sessions multiplexed; swappable Engine trait |
| Profile model             | Fixed 6-slot array                                   | Dynamic `Vec<Profile>` with factory + custom                                 |
| IEQ preset model          | Per-profile static array                             | Global `Vec<EqPreset>`; edits affect all profiles uniformly                  |
| GEQ model                 | 6 × 4 × 20 matrix                                    | One GEQ per profile                                                          |
| Wire protocol             | Parameter indices                                    | Parameter names (4-CC); single source of truth via metadata table            |
| Web UI                    | Vanilla JS embedded in daemon                        | React + TypeScript + Vite; separate dev workflow; embedded at release build  |
| Persistence               | Multi-file XML                                       | Single TOML file with factory-defaults overlay; same delta semantics         |
| Visualizer                | Gains only                                           | Gains + excitations; suspended-state detection                               |
| Power off                 | Zero-out the OFF profile                             | `EFFECT_CMD_DISABLE` on the engine; no parameter mutation                    |
| Custom profile categories | Labelled (Movie / Music / Game / Voice / Customized) | Removed; custom profiles are just named profiles                             |
| First-run defaults        | Undefined                                            | Music profile + power on, matching original DDP out-of-box                   |

---

## Open questions — resolve before Phase 0

These decisions affect the scope and naming of the implementation.

1. **Release branding**: should v2.0 keep calling itself "DolbyX" or adopt
   version-specific naming (e.g. "DolbyX 2", "DolbyX Reborn")? This affects
   the README, plugin display names, and the named pipe / socket path.

2. **Per-stream profile override**: when multiple plugins are connected,
   should they all share the active profile (the default — the typical user
   mental model), or can individual streams carry their own override? The
   plan defaults to shared; per-stream routing is a later affordance. Confirm
   this is the right call for v2.0.

3. **Plugin auto-launch of daemon**: should the VST/LV2 plugin start the
   daemon automatically if it isn't running ("it just works"), or should the
   daemon be an explicit separate launch? The original DDP was always-on as a
   system service. Recommendation: auto-launch via the platform's service
   mechanism (Windows Service, systemd) set up by the installer.

4. **UI port number**: 9876 is the current choice. If you'd prefer something
   more memorable, or an ephemeral port written to a discovery file, decide
   before the wire protocol is locked.

5. **EQ band count in the UI**: the engine works in 20 bands. The original DDP
   UI exposed a 5-knob abstraction (interpolated to 20). Should the v2 UI
   expose all 20 directly (more control) or keep the 5-knob model (familiar
   feel)? The Advanced section always shows 20 either way.

---

## Deferred technical questions

These don't block the plan and can be decided during implementation:

- Whether to use `serde` untagged or tagged enums for the WebSocket protocol —
  a small ergonomics question.
- Whether the React UI's Zustand store mirrors the daemon's TOML schema 1:1 or
  uses a flatter shape better suited to component rendering.
- How aggressively to debounce parameter writes during a slider drag — the
  original DDP does 60 ms; we may match or go faster on desktop where network
  isn't a constraint.

---

## What this plan does not change

- The current `arm/` and `daemon/` C code stays in `main` during the
  rearchitecture. It is the v1 reference implementation. Once Phase 5
  completes, it is removed in one commit.
- The existing [docs/ddp/](ddp/README.md) reference is unaffected — it
  documents `libdseffect.so` and the original DDP behaviour, which doesn't
  change.
- The bundled `libdseffect.so` is the same v8.1 build the project has
  always used.
