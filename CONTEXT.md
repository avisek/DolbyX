# DolbyX

DolbyX is a cross-platform wrapper around the Android Dolby Digital Plus
`libdseffect.so` engine, exposing it to desktop audio hosts via a Rust
daemon, a Solid-based Web UI, and platform-native plugins.

**Goal.** Match the original DDP's default behaviour, look, and feel
out of the box, then extend its capabilities beyond the original and
simplify where possible.

This document is the canonical glossary for terms specific to the DolbyX
project — pin new project-specific terms here, not inline in plans or ADRs.

For the *engine's* own vocabulary (binary protocol opcodes, AK setting
internals, signal-path internals), see [`docs/ddp/`](docs/ddp/README.md).

## Language

### Engine vocabulary

**AK parameter**:
A `libdseffect.so` setting identified by a 4-character code (`dvla`,
`iebt`, `gebg`, …). Engine semantics, not a UI control.
_Avoid_: setting, knob, slider.

**4-CC name**:
The four-character code that identifies an AK parameter on the wire and
in persistence. Stable across reorderings of the metadata table.
_Avoid_: param id, key, code.

**Session**:
An `effect_handle_t` inside the engine subprocess; one per audio stream.
Created by `Engine::create_session`, destroyed by `destroy_session`. The
shared engine subprocess multiplexes many sessions.
_Avoid_: stream, connection, instance.

**Native grid** (`vnnb` / `vnbf`):
The visualizer's intrinsic band layout — count (`vnnb`) + centre frequencies
(`vnbf`), read-only and **rate-derived**: the engine selects it from the
sample rate (20 bands @48k/44.1k, 19 @32k), re-derived on (re)configuration,
not per block. The custom grid (`vcnb`/`vcbf`) seeds from it; `vnbg`/`vnbe`
are the per-block measurements taken on it (see
[docs/ddp/02](docs/ddp/02-ak-parameters.md)).
_Avoid_: "native bands" (ambiguous with the per-block `vnbg`/`vnbe` data).

**`vcbg` / `vcbe`**:
Two of the four `ReadOnly-Dynamic` AK parameters the DSP rewrites every
audio block (in the AK registry). Engine cmd 4 (`DS_PARAM_VISUALIZER_DATA`)
returns the pair as 40 int16s — the original service's read path; v2 instead
ferries all four dynamic arrays on each `Process` reply (see `vis` event).
In-process, the engine's own `ak_get` reads the same registry, and most
other params' live value too (see
[docs/ddp/03](docs/ddp/03-binary-protocol.md#the-ak-registry-read-path)).
These are the *custom* (`vc*`) bands — the engine's *native* (`vn*`)
per-band visualizer data resampled onto a host-set frequency grid
(`vcnb`/`vcbf`); they read identical to `vn*` until that grid is
reconfigured (see [docs/ddp/02](docs/ddp/02-ak-parameters.md)).
_Avoid_: "visualizer data" alone (ambiguous between the raw arrays and the
post-processed `vis` event payload).

**Settability bucket**:
The classification of an AK parameter into one of four:
`Settable` (Java-whitelisted, DSP produces well-defined output),
`Experimental` (engine accepts writes, original DDP UI hid the slot),
`ReadOnly-Dynamic` (`vnbg`/`vnbe`/`vcbg`/`vcbe` — write-protected, the DSP
rewrites them every audio block), or `ReadOnly-Static` (`vnnb`/`vnbf` the
rate-derived native grid + `bver`/`bndl`/`ver`/`lcmf`/`lcvd`/`lcpt`
build-version / license — read once at session config via `ak_get`, never
per block). All 64 engine root leaves fall in exactly one bucket; none are
dropped.
_Avoid_: param access, settable flag.

### UI / state vocabulary

**Profile**:
The canonical persistence unit — the home for *every* non-readonly AK param
(the 52 Settable + Experimental), no special cases (structural constants
included). Stores deltas over `ParameterDef.default`, plus an *optional*
selected EQ preset. Factory: Movie, Music, Game, Voice; custom profiles have
no category. Exactly one profile is selected at any time.
_Avoid_: preset (overloaded with EQ preset), mode.

**EQ preset**:
An *optional* EQ overlay on top of a profile, global across profiles. Carries
the full EQ param set — band structure (`genb`/`gebf`/`ienb`/`iebf`), curves
(`gebg`/`iebt`), enables (`geon`/`ieon`), amount (`iea`). When a profile
selects one, the preset's EQ params shadow the profile's own; with `None`
selected, the profile's own EQ params are effective. Editing a preset
propagates to every profile currently using it. Factory: Open, Rich, Focused.
_Avoid_: IEQ preset (legacy DDP term), preset (without "EQ" — ambiguous with
Profile), "Off" preset (replaced by `None`).

**IEQ**:
"Intelligent EQ" — the engine-driven target curve. Backed by AK params
`iebt[20]` (band targets) and `ieon` (enable).

**GEQ**:
"Graphic EQ" — the user-driven curve. Backed by AK params `gebg[20]` (band
gains) and `geon` (enable). Edited via the Visualizer/Equalizer overlay
(see Decision 10).

**Originator**:
The WebSocket client that issued a command. The daemon assigns each WS
connection a serial id at handshake and suppresses broadcasting the
resulting state change back to this client, preventing echo loops in
multi-tab scenarios.
_Avoid_: sender, source, client (those don't carry the suppression
semantics).

**Bootstrap**:
`window.__BOOTSTRAP__` — a JSON blob the daemon injects into `index.html`
at request time. Carries the full `ParameterDef[]` metadata table, the
initial `State` snapshot, and the engine backend name. The UI reads it
synchronously at module init so the page paints fully populated on the
first frame, with no pre-paint network round-trip. (Engine version is not
a bootstrap field — it's the `ver` param, a ReadOnly-Static readout.)
_Avoid_: config, init payload, manifest.

**`vis` event**:
The visualizer broadcast — `vc*` gains/excitations (main spectrum + EQ
curve) plus native `vn*` bands (Advanced live display), emitted once per
oldest-session `process()` block (the ARM shim piggybacks the arrays on the
`Process` reply). A pure event stream: no audio → no events. The client
renders at 60 fps from the latest event and detects idle itself (no event
for ~200 ms → freeze + fade). No daemon-side pump, cadence, or suspend latch.
_Avoid_: visualizer data (see `vcbg`/`vcbe`), `vis_suspended` / suspended
(removed — idle is client-side).

**Slice** (architectural):
A vertical tracer bullet through every layer DolbyX uses (UI · WS ·
daemon · engine · persistence). Each implementation phase is one slice.
_Avoid_: phase (the project still uses "phase" for the document-level
heading; "slice" is the unit a TDD session targets).

### Architecture vocabulary

The architecture vocabulary from
[LANGUAGE.md](.agents/skills/improve-codebase-architecture/LANGUAGE.md)
applies verbatim: **module**, **interface**, **implementation**,
**depth**, **seam**, **adapter**, **leverage**, **locality**. Do not
substitute "component", "service", "API", or "boundary".
