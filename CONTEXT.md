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

**`vcbg` / `vcbe`**:
The two `ReadOnly` AK parameters the DSP rewrites every audio block (in
the AK registry). Returned together by engine cmd 4
(`DS_PARAM_VISUALIZER_DATA`) as 40 int16s — the *protocol* read path the
visualizer rides. In-process, the engine's own `ak_get` reads the same
registry, and most other params' live value too (see
[docs/ddp/03](docs/ddp/03-binary-protocol.md#the-ak-registry-read-path)).
These are the *custom* (`vc*`) bands — the engine's *native* (`vn*`)
per-band visualizer data resampled onto a host-set frequency grid
(`vcnb`/`vcbf`); they read identical to `vn*` until that grid is
reconfigured (see [docs/ddp/02](docs/ddp/02-ak-parameters.md)).
_Avoid_: "visualizer data" alone (ambiguous between the raw cmd-4 bytes
and the post-processed `vis` event payload).

**Settability bucket**:
The classification of an AK parameter as `Settable` (Java-whitelisted, DSP
produces well-defined output), `ReadOnly` (`vcbg`/`vcbe` and the native
`vn*` family — engine-owned, write-protected; the DSP fills the
gain/excitation arrays each block), or `Experimental` (engine accepts writes
but original DDP UI hid the slot).
_Avoid_: param access, settable flag.

### UI / state vocabulary

**Profile**:
A user-selectable group of AK parameter overrides plus a selected EQ
preset id. Factory: Movie, Music, Game, Voice. Custom profiles have no
category. Exactly one profile is selected at any time.
_Avoid_: preset (overloaded with EQ preset), mode.

**EQ preset**:
A user-selectable IEQ + GEQ curve, global across profiles. Factory: Off,
Open, Rich, Focused. Each profile stores only the *id* of its currently
selected EQ preset, not its own copy of the curves.
_Avoid_: IEQ preset (legacy DDP term — DolbyX generalised IEQ presets to
own both `iebt` and `gebg`), preset (without "EQ" qualifier — ambiguous
with Profile).

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
initial `State` snapshot, and immutable engine info (version, backend).
The UI reads it synchronously at module init so the page paints fully
populated on the first frame, with no pre-paint network round-trip.
_Avoid_: config, init payload, manifest.

**`vis_suspended`**:
The pump-emitted flag indicating audio is idle. Latches on after 10
consecutive empty cmd-4 reads (`VISUALIZER_SUSPENDED_THRESHOLD`) and
latches off symmetrically. While suspended, `vis` events are suppressed.
_Avoid_: idle, paused, off (those overload other concepts).

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
