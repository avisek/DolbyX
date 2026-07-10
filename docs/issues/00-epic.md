# DolbyX v2 — Rearchitecture Epic

DolbyX v2 is a ground-up rebuild of the desktop DDP host: a Rust daemon
(HTTP/WS server + audio-plugin IPC + engine supervision in one binary), a
Solid.js Web UI, and thin platform audio plugins, all driving the Android
`libdseffect.so` engine under emulation. It supersedes v1 (archived at git
tag `v1` in Slice 01) and is designed from the complete reverse engineering
in `docs/ddp/README.md`.

This epic is the shared context for every slice. Each sub-issue
(`docs/issues/NN-*.md`) carries its slice's full spec. Together with
`CONTEXT.md`, `docs/adr/`, and `docs/ddp/`, they replace
`docs/REARCHITECTURE_PLAN.md` entirely.

## How to implement a slice

1. Read: this epic → your slice issue → `CONTEXT.md` (use its terms
   exactly) → the ADRs and `docs/ddp/` sections your issue references.
2. Drive the session with `/implement`; use `/tdd` per behavior (one test →
   one impl; never write all tests up front; never refactor while RED).
3. Mock only at system boundaries — the `Engine` trait is the one
   sanctioned seam (`StubBackend`). HTTP/WS run real; persistence runs
   against a real tempdir.
4. From Slice 10 on, every feature slice's acceptance includes replaying its
   integration tests under `cargo test --features qemu` (Windows-path
   slices 12–13 exempt — no qemu on that runner).
5. Tick behavior checkboxes in the issue as RED → GREEN; update the slice
   index below when a slice transitions; finish with `/code-review`, full
   test suite, commit.

## Why v2

v1 proved the concept (Android DDP engine driven from a desktop host) but
grew incrementally. With full knowledge of the engine's internals, v2:

- Faithfully reproduces the original DDP's defaults, behavior, look, feel.
- Extends it: custom profiles, custom EQ presets, every `libdseffect.so`
  parameter exposed in an Advanced section.
- Single source of truth for parameters — no positional indices, no
  shared-state foot-guns.
- Windows + Linux first-class; macOS later.
- One shared engine subprocess for all streams, pre-shaped for in-process
  ARM emulation (Unicorn / static translation) later.
- Strict typing, mandatory docs, CI gates, comprehensive tests.

## Goals

1. Windows and Linux from day one. macOS deferred.
2. Faithful defaults: out of the box DolbyX sounds like original DDP on
   Music profile with power on.
3. Original persistence semantics: per-profile overrides, per-profile GEQ,
   master state, all survive restarts.
4. Custom profiles: add / edit / rename / remove.
5. Custom EQ presets: same CRUD; presets are **global** (an edit reflects in
   every profile selecting it) and **optional** (`None` valid — profile's
   own EQ params apply).
6. All **64 real root-leaf AK params** exposed in the Advanced UI, metadata
   driven, none dropped. Four settability buckets: Settable (42),
   Experimental (10), ReadOnly-Dynamic (4), ReadOnly-Static (8). The 64 are
   the *engine's* root leaves, not Java's list (Java registers two phantoms
   `mxou`/`lcsz`, omits two real leaves `scpe`/`test` — see
   `docs/ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves`).
7. Backend-agnostic engine layer: QEMU subprocess default in v2.0; Unicorn
   and static-binary-translation slot in behind the same trait.
8. Single-process daemon: HTTP/WS + plugin IPC + engine in one binary.
9. Rust daemon; Solid.js + TypeScript UI.
10. Top-notch quality: strict linting, doc comments, unit + integration
    tests, CI gates.

**Non-goals (v2.0):** macOS; replacing QEMU; code signing; per-stream
profile overrides (all streams share the active profile); third-party
plugin SDK; GPU/SIMD (DSP is CPU-bound inside `libdseffect.so` — the
daemon is plumbing).

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Web UI (Solid-powered Vite-built SPA, separate dev workflow)             │
│  - Auto-generated Advanced section from injected bootstrap                │
│  - int16 1/16-dB on the wire; UI converts ↔ dB for display only           │
│  - Auto-reconnecting WebSocket                                            │
└────────────────────────┬──────────────────────────────────────────────────┘
                         │ JSON over WebSocket
                         │ HTTP for / (index.html with injected bootstrap)
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
│                   │ now:  QEMU subprocess              │                  │
│                   │ future: Unicorn/SBT (in-process)   │                  │
│  ┌────────────────▼─────────────────┐                  │                  │
│  │ dolbyx-engine-arm subprocess     │                  │                  │
│  │  (one shared process, all        │                  │                  │
│  │   sessions multiplexed)          │                  │                  │
│  │  qemu-arm-static                 │                  │                  │
│  │   + libdseffect.so               │                  │                  │
│  │   + Android stubs                │                  │                  │
│  └──────────────────────────────────┘                  │                  │
└────────────────────────────────────────────────────────┼──────────────────┘
           ┌────────────────────────┬────────────────────┴───────┐
  ┌────────▼────────┐    ┌──────────▼─────────┐    ┌─────────────▼────────────┐
  │ Windows: VST2   │    │ Linux: LV2         │    │ macOS: AudioServerPlugin │
  │ DolbyX.dll      │    │ libdolbyx.lv2      │    │ DolbyX.driver (v3.0)     │
  │ thin shim       │    │ thin shim          │    │ thin shim                │
  │ via named pipe  │    │ via AF_UNIX        │    │ via AF_UNIX              │
  └─────────────────┘    └────────────────────┘    └──────────────────────────┘
```

Engine backends (ADR-0002 — `docs/adr/0002-backend-agnostic-engine-qemu-default.md`):

| Backend | Status | Where | Notes |
|---|---|---|---|
| `QemuBackend` | **v2.0 default** | Linux native; Windows via WSL2 | One shared `qemu-arm-static` subprocess holding `libdseffect.so`, all sessions multiplexed, length-prefixed binary protocol over stdin/stdout. On Windows the daemon is a **native Windows binary** spawning the ARM engine inside WSL2 via `wsl.exe` stdio (v1-proven). |
| `UnicornBackend` | v2.1 | Native everywhere | Custom ELF loader + Android stubs + Unicorn JIT in-process. Kills WSL on Windows. Same trait. |
| `StaticBinaryBackend` | Speculative | Native everywhere | ARM → x86_64 translation at build time. |

## Cross-slice invariants

Never violate these; each is load-bearing across slices.

- **i16 1/16-dB end-to-end.** Persistence, state, WS wire, engine protocol
  all carry the engine's native int16 units. Only the UI converts i16 ↔
  float dB at display/input time. dB-coded params: display = raw / 2^4.
- **Name-based everywhere.** Params identified by 4-CC string on the wire
  and on disk. No positional indices. Stable under metadata reordering.
- **`parameters.toml` is the single source of truth**
  (ADR-0004 — `docs/adr/0004-parameter-metadata-as-single-source-of-truth.md`):
  wire validation, engine init, persistence, UI generation, ranges all
  derive from it. Parsed at startup only; malformed → daemon refuses to
  start (same policy for `defaults.toml` and the UI HTML file).
- **`Engine::set_params` is the only engine write path.** `edit_profile`
  and `edit_eq_preset` both funnel into it. A single control edit is a
  1-entry batch; a profile/preset switch is one atomic batch (lands on one
  audio block — never dribble ~40 edits).
- **AK-direct params, cmd lifecycle**
  (ADR-0010 — `docs/adr/0010-ak-direct-params-cmd-lifecycle.md`): param
  methods use the engine's exported `ak_find` / `ak_set_bulk` /
  `ak_get_bulk`; lifecycle (INIT / SET_CONFIG / ENABLE / DISABLE / process)
  stays on the cmd protocol. The structural-param **commit leaf** is
  shim-internal knowledge — never in `ParameterDef`, never above the trait.
- **Sessions exist only per plugin instance.** A plugin's `Hello` creates
  one, its disconnect destroys it; zero plugins = zero sessions. AK
  registries are per-handle, so every param write fans out to all live
  sessions; with zero sessions a write is state-only and lands at future
  session init (`set_power` likewise makes no engine call). A session
  created while power is off starts disabled.
- **Main session** = oldest live session (index 0 of the creation-ordered
  list). Sources `vis` events and the `readouts`; on its death the
  next-oldest takes over and readouts re-read (rate-derived `vnnb`/`vnbf`
  may differ).
- **Sample rate is immutable per session.** Exactly one
  `EFFECT_CMD_SET_CONFIG` at init, at the plugin's `Hello` rate — never
  the engine's 44100 default; rate change = destroy + recreate; the daemon
  carries no default rate. SET_CONFIG pins stereo + PCM16 + **WRITE**
  output mode. Backend validates host-side first (engine footguns: bad
  rate silently falls back to 44100; mono poisons the handle) — reject
  non-stereo and rates outside {44100, 48000, 32000} up front.
- **Daemon owns value validation; the engine doesn't reject, it clamps.**
  See *Validation* below.
- **Power off = `EFFECT_CMD_DISABLE`**, engine-owned graceful crossfade;
  parameter state survives the toggle. No zeroing, no OFF profile.
- **Profiles are canonical; EQ presets are an optional overlay**
  (ADR-0003 — `docs/adr/0003-global-eq-presets-and-geq-per-preset.md`): the
  profile owns all 52 non-readonly params (structural constants included);
  a selected preset's 9 EQ params shadow the profile's own *entirely*;
  `None` → profile's own apply. Preset eligibility is derived:
  param is preset-carried ⟺ `category ∈ {Ieq, Geq}`.
- **UI display prefs live in browser `localStorage`**, never in
  `config.toml` (that's state).

## Wire protocol reference

Canonical copy — sub-issues reference, never restate.
(ADR-0005 — `docs/adr/0005-wire-protocol-i16-name-based-originator-aware.md`)

### UI ↔ daemon (JSON over WebSocket, `localhost:9876/ws`)

One WS per UI tab. Full `state` snapshot on connect, on `get_state`, and on
any non-WS mutation (e.g. config file reload). Snapshots are always full —
state is hundreds of bytes, diffs aren't worth it. Snapshot = user-state +
read-only `readouts` map (8 ReadOnly-Static values keyed by 4-CC, from the
main session; `ParameterDef.default` while zero sessions).

Commands (client → daemon):

```jsonc
{ "cmd": "get_state", "request_id": "r1" }
{ "cmd": "set_power", "request_id": "r2", "on": true }
{ "cmd": "set_profile", "request_id": "r3", "id": "music" }
{ "cmd": "edit_profile", "request_id": "r4", "id": "music", "params": { "dvla": [4] } }
{ "cmd": "set_eq_preset", "request_id": "r5", "profile_id": "music", "id": "rich" }  // id: null → profile's own EQ

{ "cmd": "add_profile", "request_id": "r6", "from": "music", "name": "My Music" }
{ "cmd": "rename_profile", "request_id": "r7", "id": "user_a3f1", "name": "Late Night" }
{ "cmd": "remove_profile", "request_id": "r8", "id": "user_a3f1" }
{ "cmd": "reset_profile", "request_id": "r9", "id": "music" }

{ "cmd": "add_eq_preset", "request_id": "r10", "from": "rich", "name": "Vocal Forward" }
{ "cmd": "rename_eq_preset", "request_id": "r11", "id": "user_91c2", "name": "Vocal" }
{ "cmd": "edit_eq_preset", "request_id": "r12", "id": "user_91c2", "params": { "gebg": [/*20*/] } }
{ "cmd": "remove_eq_preset", "request_id": "r13", "id": "user_91c2" }
{ "cmd": "reset_eq_preset", "request_id": "r14", "id": "rich" }
```

Families: `set_*` picks a selection/scalar; `edit_*` writes a param-map;
`add`/`rename`/`remove`/`reset_*` are CRUD. `set_profile` is global (one
active profile); `set_eq_preset { profile_id, id }` names its target — EQ
selection is per-profile, flush-iff-live. `edit_profile` / `edit_eq_preset`
/ `vis` share one payload shape: `params: { "<4-CC>": [i16, …] }`.

Events (daemon → client):

```jsonc
{ "type": "state", "snapshot": { /* full state */ } }
{ "type": "vis", "params": { "vnbg": [/*20*/], "vnbe": [], "vcbg": [], "vcbe": [] } }
{ "type": "ack", "request_id": "…", "ok": true, "id": "user_a3f1" }  // "id" only on add_* — the minted id
{ "type": "error", "request_id": "…", "code": "INVALID_REQUEST", "message": "…" }
{ "type": "error", "request_id": "…", "code": "ENGINE_REJECTED", "status": -22, "message": "…" }
```

Every command gets exactly one `ack`/`error` echoing its client-generated
`request_id` (replies on a multiplexed WS aren't positionally paired — the
id lets clients/tests await outcomes promise-style). `state` and `vis` are
pub/sub. `add_*` mints the id server-side, returned on the `ack` so the
originator applies locally without waiting for a snapshot.

**Originator-aware broadcast.** While handling a command from connection
*C*, the daemon broadcasts the resulting `state` to every connection
**except *C*** — an internal `ConnId`, never on the wire. Not echo-loop
avoidance: it protects *C*'s in-flight edits (a GEQ/slider drag would fight
a round-trip-lagged snapshot). *C*'s authoritative feedback is its `ack`.
`vis` goes to everyone. (Pattern from
`docs/ddp/04-ui-data-flow.md#originator-handle-echo-suppression`.)

No `/api/*` routes exist — bootstrap injection (Slice 04) is the only
non-WS delivery. No `/api/factory_defaults` either: reset flows through
`reset_profile` / `reset_eq_preset`.

### Validation — two layers, asymmetric

**Daemon-side (the only value validation):** every `edit_*` entry checked
against `ParameterDef` — 4-CC declared, length matches, values within
min/max. Failure → `INVALID_REQUEST`, engine never called.
`INVALID_REQUEST` is the *only* daemon-side code (malformed JSON, unknown
ids, factory rename/delete, param validation — `message` says why). On any
`error` the client re-issues `get_state` to reconcile.

**Engine-side (narrow):** rejects only (a) `setting_index` out of cache
range, (b) value-buffer-size mismatch, (c) unknown cmd codes (cmd 3 GET is
*always* rejected — not implemented) — all `-EINVAL(-22)` →
`ENGINE_REJECTED`. Malformed cmd data (psize ≠ 4, missing payload) returns
`-1(-EPERM)`. A write to a write-protected leaf is a **silent no-op**. The
engine does **not** reject out-of-range values, unknown 4-CCs in
DEFINE_PARAMS, or non-zero offsets — it **silently clamps** to its own
`[ak_get_min, ak_get_max]`, and the DSP reads the clamped registry. Clamp
range can differ from published tables (`vmb` clamps at 192 not 240; `vol`
at −2080 not −2048) — which is why the daemon validates up front.
Evidence: `tools/ddp_probe/README.md` §5b, §7.

### Daemon ↔ engine subprocess (binary, length-prefixed, little-endian)

Message `[u32 length][u32 opcode][payload]`; reply
`[u32 length][i32 status][payload]`.

| Op | Name | Payload | Reply |
|---|---|---|---|
| 0x01 | `CreateSession` | `[u32 sample_rate]` | `[u32 session_id]` |
| 0x02 | `DestroySession` | `[u32 session_id]` | empty |
| 0x03 | `SetEnabled` | `[u32 session_id][u8 enabled]` | empty |
| 0x10 | `SetParams` | `[u32 session_id][u16 n]( [4-CC][u16 count][i16 × count] × n )` | empty |
| 0x11 | `GetParams` | `[u32 session_id][u16 n]( [4-CC] × n )` | `[u16 n]( [u16 count][i16 × count] × n )` |
| 0x30 | `Process` | `[u32 session_id][u32 frames][i16 × frames × 2 pcm]` | `[i16 × frames × 2 pcm][i16 × 80 vis tail]` |

`SetParams`/`GetParams` are served by the AK accessors, not the cmd
protocol. `GetParams` returns the live **clamped** registry the DSP uses —
the only true per-param getter (no cmd 3 GET exists; v1 swallowed its
`-EINVAL` and shipped zero-fill). Every `Process` reply carries the fixed
160-byte **vis tail**: `vnbg ‖ vnbe ‖ vcbg ‖ vcbe` (4 × 20 i16). The vis
feed is **process-driven, not power-gated** — bypassed blocks still emit.
For v2.1 Unicorn this protocol becomes in-process calls; trait unchanged.

### Plugin ↔ daemon (binary, same framing)

Audio only — all control goes through the Web UI.

| Op | Name | Direction | Payload |
|---|---|---|---|
| 0x01 | `Hello` | plugin → daemon | `[u32 sample_rate][u32 max_frames]` |
| 0x02 | `HelloAck` | daemon → plugin | `[u32 session_id]` |
| 0x10 | `Process` | plugin → daemon | `[u32 frames][i16 × frames × 2 pcm]` |
| 0x11 | `Processed` | daemon → plugin | `[i16 × frames × 2 pcm]` |
| 0x20 | `Goodbye` | either | empty |

Transport: Windows named pipe `\\.\pipe\DolbyX`; Unix
`/run/dolbyx/dolbyx.sock`. Audio stays int16 stereo internally (what
`libdseffect.so` expects); the plugin converts from float32 once at the
host boundary.

## The `Engine` trait — canonical seam

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

Batch-only param surface (single edit = 1-entry batch). Two adapters ship
(Stub + QEMU) — a real seam.

## Data model

```rust
pub struct ProfileId(pub String);   // stable string ids — reorder-safe, TOML-clean
pub struct PresetId(pub String);
pub struct SessionId(pub u32);

pub struct State {
    pub power: bool,
    pub selected_profile: ProfileId,
    pub profiles: Vec<Profile>,      // factory + custom
    pub eq_presets: Vec<EqPreset>,   // factory + custom, global across profiles
}

pub struct Profile {
    pub id: ProfileId,                        // "music", "user_a3f1"
    pub name: String,                         // user-editable display name
    pub selected_eq_preset: Option<PresetId>, // None → profile's own EQ params
    pub params: HashMap<String, Vec<i16>>,    // 4-CC overrides — any of the 52
}

pub struct EqPreset {
    pub id: PresetId,                         // "rich", "user_91c2"
    pub name: String,
    pub params: HashMap<String, Vec<i16>>,    // the 9 EQ params only
}
```

`is_factory` is **derived at load, never stored**: id present in
`defaults.toml` → factory; id only in `config.toml` → custom. Factory
profiles `movie`/`music`/`game`/`voice`, factory EQ presets
`open`/`rich`/`focused` — cannot be deleted or renamed, can be reset.
Custom profiles have no category (the original's Movie/…/Customized label
had no engine semantics; dropped). Deleting a referenced EQ preset falls
those profiles back to `None`. Deleting the selected profile falls back to
`music`.

**Persistence overview** (ADR-0007 — `docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`):
system-level install, no per-user mode (Linux systemd unit with
`RuntimeDirectory=dolbyx`; Windows service). `config.toml` = user state in
the platform data dir (`%PROGRAMDATA%\DolbyX\` / `/var/lib/dolbyx/`);
`defaults.toml` + `parameters.toml` live beside the daemon binary, read
once at startup. Five-layer resolve, later shadows earlier:

```
ParameterDef.default → defaults.toml shared → defaults.toml [item]
                     →  config.toml  shared →  config.toml  [item]
```

Files store only divergences from what resolves beneath them; write-back is
always per-item; 500 ms shared debounce + shutdown flush. Full schema +
examples: Slice 10. Watcher: Slice 19.

## Crate map

```
DolbyX/
├── Cargo.toml                       # workspace
├── Justfile                         # dev, build-release, lint, test, param-twin
├── rust-toolchain.toml
├── flake.nix                        # optional (Slice 22)
├── crates/
│   ├── ddp-engine/                  # trait Engine + VisFrame + SessionId; qemu.rs, stub.rs, protocol.rs
│   ├── ddp-state/                   # pure state model, no I/O: state.rs, profile.rs, preset.rs, param_def.rs, conversion.rs
│   ├── ddp-persistence/             # TOML load/save: schema.rs, factory.rs, file_watcher.rs, debounce.rs
│   ├── ddp-daemon/                  # binary: http_server.rs, ws_server.rs, ws_commands.rs, audio_server.rs,
│   │                                #   engine_supervisor.rs, platform/{windows,unix}.rs;
│   │                                #   ships defaults.toml, parameters.toml, parameters.engine.toml
│   ├── ddp-engine-arm/              # ARMv7 engine binary: dlopen libdseffect, session routing, protocol mirror
│   ├── ddp-vst-windows/             # VST2 cdylib
│   └── ddp-lv2-linux/               # LV2 cdylib + dolbyx.ttl
├── ui/                              # Solid SPA — independent pnpm project (vite, dev.html, src/)
├── vendored/                        # libdseffect.so (v2.0.4.0) + ds1-default.xml
└── scripts/                         # build-release.sh, package-*.{sh,ps1}, setup-windows.bat
```

`ddp-state` is I/O-free by design (unit-testable, portable);
`ddp-persistence` keeps I/O out of the state model.

UI source shape (`ui/src/`): `main.tsx`, `App.tsx`, `store/{state,ws}.ts`,
`styles/{theme,base}.css` + `components/` BEM files,
`components/{PowerToggle,ProfileTabs,EqPresetPicker,MasterControls,Visualizer,EqCurve,ConnectionBadge}.tsx`,
`advanced/{AdvancedPanel,WidgetFactory}.tsx` + `advanced/widgets/*`,
`lib/{ws,parameters,units}.ts`.

## Deep modules

Interface = the full surface a caller must know. Every entry passes the
deletion test (removing it would scatter, not remove, complexity).
Vocabulary per `.agents/skills/improve-codebase-architecture/SKILL.md`.

| Module | Interface | Hides | Introduced |
|---|---|---|---|
| **`Engine`** trait (`ddp-engine`) | See above. `get_params` reads the live clamped registry; every `process` reply carries a `VisFrame`. | Subprocess lifecycle, protocol framing, session table, AK-direct binding, commit-leaf touch, vis-tail append. Later: Unicorn loader + stubs. | 04 (Stub), 08 (QEMU) |
| **`EngineSupervisor`** (`ddp-daemon`) | `start()` · `shutdown()` · session ops mirroring `Engine`. Errors: `EngineCrashed`, `SessionInitFailed`, `SessionNotFound`. | Respawn on crash; creation-ordered session list (main = index 0); session init (INIT → SET_CONFIG at plugin rate → one `set_params` of resolved profile → ENABLE/DISABLE — no DEFINE_PARAMS/SETTINGS); readouts re-read on main change; vis fan-out; write fan-out to all sessions (none → state-only); created-while-off starts disabled. | 04, grown 08/11/16 |
| **`State`** (`ddp-state`) | `new_from_defaults(&Defaults)` · `apply(Command) → Result<StateDiff, ValidationError>` · accessors. Invariants: `selected_profile` exists; every `Some` preset exists; deleting a referenced preset → `None`. | Factory overlay, `is_factory` derivation, validation against `ParameterDef`, CRUD invariants. I/O-free. | 04, grown each slice |
| **`ParameterDef` table** (`ddp-state`) | `parse(&str) → Result<Vec<ParameterDef>>` · `lookup(name)` · `iter()`. | 64 entries from runtime `parameters.toml` (malformed → refuse start), four-bucket classification. | 03 |
| **`Persistence`** (`ddp-persistence`) | `load(params, defaults, config) → State` · `flush(&State)` (500 ms shared debounce) · `watch(cb)` — `config.toml` only. | Startup loads, 5-layer cascade, per-item write-back, notify watcher, mtime self-write suppression, debounce timer. | 04 (root keys), 10 (cascade), 19 (watcher) |
| **`HttpServer`** (`ddp-daemon`) | `GET /` → bootstrap-injected HTML · `GET /ws` → upgrade. Port via `--port` flag (default 9876), not config. | Disk HTML read, `<!--BOOTSTRAP-->` replace, `window.__BOOTSTRAP__` serialization, refuse-to-start. | 04 |
| **`WsServer` + `WsCommands`** (`ddp-daemon`) | `accept(stream)` → internal `ConnId`; `dispatch(conn_id, Command) → Event` via serde. Errors: `INVALID_REQUEST`, `ENGINE_REJECTED`. | Originator exclusion, `request_id` echo, validation, broadcast routing, snapshot on connect/`get_state`. | 04 |
| **`AudioServer`** (`ddp-daemon`) | `accept_loop(supervisor) → !`; plugin protocol above. | Per-platform accept (named pipe / AF_UNIX — two adapters, real seam), session-id allocation, multiplexing. | 11 |
| **UI `GainSmoother`** (`ui/src/lib/gain_smoother.ts`) | `enqueue(band, dB)` · `tick(): Int16Array \| null`. | Thick-brush splat, τ=0.3 s decay, kernel convolution, 60 ms throttle, 20×20 pseudoinverse on preset change. | 17 |

## Code quality standards

**Rust:** lints in `[workspace.lints]` (crates opt in via
`[lints] workspace = true`) — `missing_docs` + `clippy::pedantic` at
`warn`, allow-list grown as friction appears. `#![forbid(unsafe_code)]`
everywhere except the engine FFI boundary (every `unsafe` carries
`// SAFETY:`). Warnings stay out of source, elevated to errors in CI only
(`RUSTFLAGS=-D warnings`; `cargo clippy --workspace --all-targets -- -D
warnings`) so toolchain bumps never redden local builds. Every public item
gets `///` docs, examples where reasonable.

**TypeScript:** `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`; ESLint `@typescript-eslint/strict-type-checked`
+ `eslint-plugin-solid`; Prettier.

**Tests:** unit in `#[cfg(test)]` next to code; integration in `tests/`;
`proptest` for invertible conversions (dB ↔ 1/16 dB, clamps). Daemon
command-dispatch integration tests run `StubBackend` (fast,
deterministic); the `qemu` cargo feature binds them to the real engine
(`ddp-daemon/tests/e2e_qemu.rs`, `ddp-engine` smoke). UI: Vitest +
`@solidjs/testing-library` with a mocked WebSocket; Playwright E2E against
the real daemon + real engine — mocking the daemon's WS would duplicate its
logic in fixtures and drift; mocking the engine would skip the binary
protocol, AK binding, and lifecycle, where the integration risk lives. CI
provisions `qemu-user-static` via apt; `libdseffect.so` is bundled from
`vendored/`.

**CI:** GitHub Actions, Linux + Windows, every push/PR. Required: `cargo
test` (`-D warnings`), clippy, `cargo fmt --check`, `pnpm run lint`,
`pnpm run test`.

**Logging:** `tracing`, `RUST_LOG` filter; stdout human-readable, errors
duplicated to stderr, optional rotating file
(`%PROGRAMDATA%\DolbyX\logs\dolbyx.log` / `/var/log/dolbyx/dolbyx.log`,
7-day retention).

## Dev workflow

`just dev` = daemon under `cargo watch` (with `--ui ui/dev.html`) + `pnpm
-C ui dev`, prefixed/colored. Browser always visits `localhost:9876` (the
daemon is the single front door; Vite serves modules + HMR on :5173).
Rust changes restart the daemon; TS/CSS hot-reload. Full mechanics:
Slice 02. Develop on WSL2 (daemon + UI are Linux processes); Windows
daemon/VST work is Slices 12–13. Recommended VS Code: rust-analyzer, Even
Better TOML, ESLint, Prettier.

## Slice index

Order = execution order. Update Status as slices transition
(`not started` / `in progress` / `done` / `blocked`).

| # | Slice | Blocked by | Mode | Status |
|---|---|---|---|---|
| 01 | v1 archival + Cargo workspace + Justfile + Rust CI | — | HITL | not started |
| 02 | UI scaffold + dev workflow | 01 | AFK | not started |
| 03 | Parameter metadata SoT (`parameters.toml` + parser + twin + CI gate) | 01 | AFK | not started |
| 04 | Power toggle over the wire (tracer bullet pt. 1) | 03 | AFK | not started |
| 05 | Power toggle in the browser (tracer bullet pt. 2) | 02, 04 | AFK | not started |
| 06 | `ddp-engine-arm`: protocol + session lifecycle + process | 01 | HITL | not started |
| 07 | `ddp-engine-arm`: AK-direct params + commit leaf + vis tail | 06 | AFK | not started |
| 08 | `QemuBackend` + supervisor respawn + swap & replay | 04, 07 | HITL | not started |
| 09 | Playwright E2E harness | 05, 08 | AFK | not started |
| 10 | Factory profiles + `defaults.toml` + cascade persistence — *first authentic DDP sound* | 05, 08 | AFK | not started |
| 11 | `AudioServer` + plugin protocol (both adapters) | 08 | AFK | not started |
| 12 | Windows daemon bring-up (native + wsl.exe engine) | 10 | HITL | not started |
| 13 | VST2 plugin + EqualizerAPO — **daily-driver milestone** | 11, 12 | HITL | not started |
| 14 | Master controls (SV / DE / VL) + unit helpers | 10 | AFK | not started |
| 15 | Factory EQ presets apply as overlays | 10 | AFK | not started |
| 16 | Event-driven visualizer | 05, 08, 09, 10, 11 | AFK | not started |
| 17 | GEQ editing: smoother + inverse + EqCurve | 14, 15, 16 | HITL | not started |
| 18 | Custom profiles & EQ presets (CRUD) | 15 | AFK | not started |
| 19 | `config.toml` watcher | 18 | AFK | not started |
| 20 | Advanced panel (all 64 params) | 10, 14, 16 | AFK | not started |
| 21 | LV2 plugin + PipeWire | 11 | HITL | not started |
| 22 | Release packaging | 13, 17, 19, 20, 21 | HITL | not started |

Slices are provisional in scope, firm in contract: split further if one
threatens a session's context budget; never merge into bigger bangs.

## Beyond v2.0

- **v2.1 — Unicorn backend:** custom ELF loader for `libdseffect.so`,
  Android stub library in Rust (`__android_log_print`, `String8`,
  `VectorImpl`, …), `UnicornBackend` behind the same trait, replaying the
  integration suite under `--features unicorn`. Default Windows backend
  flips from QEMU/WSL2 to Unicorn. Unblocks macOS.
- **v3.0 — macOS:** `ddp-driver-macos` AudioServerPlugin (libASPL),
  nix-darwin module, output-device selector UI, install docs.
- **Latency (no version pin):** shared-memory ring buffers for plugin ↔
  daemon audio, socket kept for signalling; profile first, optimize where
  measured.
