# DolbyX

DolbyX is a cross-platform wrapper around the Android Dolby Digital Plus
`libdseffect.so` engine, exposing it to desktop audio hosts via a Rust
daemon, a Solid-based Web UI, and platform-native plugins.

**Goal.** Match the original DDP's default behavior, look, and feel
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
An `effect_handle_t` inside the engine subprocess; one per plugin
instance — the plugin's `Hello` creates it (`Engine::create_session`),
its disconnect destroys it. The daemon never creates sessions on its
own: zero plugins = zero sessions. The shared engine subprocess
multiplexes many sessions; the sample rate is fixed at creation for
the session's lifetime.
_Avoid_: stream, connection, instance.

**Main session**:
The oldest live session — index 0 of the supervisor's creation-ordered
list. Sources `vis` events and the ReadOnly-Static `readouts`; when it
dies the next-oldest becomes main and the readouts re-read (the
rate-derived native grid may differ). With zero sessions, readouts
fall back to `ParameterDef.default`.
_Avoid_: oldest session, control session, primary session.

**Native grid** (`vnnb` / `vnbf`):
The visualizer's intrinsic band layout — count (`vnnb`) + centre frequencies
(`vnbf`), read-only and **rate-derived**: the engine selects it from the
sample rate, re-derived on (re)configuration, not per block. The custom
grid (`vcnb`/`vcbf`) seeds from it; `vnbg`/`vnbe` are the per-block
measurements taken on it (see [docs/ddp/02](docs/ddp/02-ak-parameters.md)).
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
build-version / license — read once at session config via `ak_get_bulk`,
never per block). All 64 engine root leaves fall in exactly one bucket; none are
dropped.
_Avoid_: param access, settable flag.

**Commit leaf**:
The last payload array of a structural-param group (`gebg` GEQ, `iebt` IEQ,
`aobg` Audio Optimizer, `arbh` Audio Regulator). The engine stages a group's
structural edits and re-derives its filterbank only when the commit leaf is
re-written, so the shim touches it after any structural change (**touch =
commit** — fires even unchanged). Shim-internal, not a `ParameterDef` field
([ADR-0010](docs/adr/0010-ak-direct-params-cmd-lifecycle.md)).
_Avoid_: trigger param, commit param.

**Structural param**:
An AK param that reshapes a feature's filterbank — band count + centre
frequencies (`genb`/`gebf`, `ienb`/`iebf`, `aonb`/`aocc`/`aobf`,
`arnb`/`arbf`). Staged and applied only on the group's **commit leaf** write;
storage is fixed-capacity (40), so a count change commits without re-aligning
arrays. Profile-owned — also called *structural constants* where they sit
fixed in a profile's config.

**Vis tail** / **`VisFrame`**:
The four ReadOnly-Dynamic arrays (`vnbg ‖ vnbe ‖ vcbg ‖ vcbe`, 4 × 20 i16 =
160 bytes) the ARM shim appends to every `Process` reply via local
`ak_get_bulk` (one per array) — riding the audio, no separate call. Surfaced
at the `Engine` trait as `VisFrame`; the daemon turns each into one `vis` event.
_Avoid_: vis packet; visualizer data (see `vcbg`/`vcbe`).

### UI / state vocabulary

**Profile**:
The canonical persistence unit — the home for *every* non-readonly AK param
(the 52 Settable + Experimental), no special cases (structural constants
included). Persists only its divergences (in `config.toml`, over whatever
resolves beneath it), plus an *optional* selected EQ preset. Factory: Movie,
Music, Game, Voice; custom profiles have no category. Exactly one profile is
selected at any time.
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

**Factory item** (`is_factory`):
A profile or EQ preset whose id appears in `defaults.toml`. Derived at load,
never stored (an id only in `config.toml` is custom). Factory items can be
reset to bundled defaults but not deleted or renamed. Factory profiles: Movie,
Music, Game, Voice; factory EQ presets: Open, Rich, Focused.
_Avoid_: built-in, default item, preset flag.

**IEQ**:
"Intelligent EQ" — the engine-driven target curve. Backed by AK params
`iebt[20]` (band targets) and `ieon` (enable).

**GEQ**:
"Graphic EQ" — the user-driven curve. Backed by AK params `gebg[20]` (band
gains) and `geon` (enable). Edited via the Visualizer/Equalizer overlay
([ADR-0008](docs/adr/0008-visualizer-equalizer-rendering-spec.md); Slice 17).

**Master control**:
One of the three main-screen controls — Surround Virtualizer
(`vdhe`+`dhsb`), Dialog Enhancer (`deon`+`dea`), Volume Leveller
(`dvle`+`dvla`) — each pairing an enable AK param (toggle / tri-state) with an
amount AK param (slider). A curated UI overlay, *not* an engine-derived
category or a `ParameterDef` field; the same params also appear in the
Advanced panel under their feature categories.
_Avoid_: basic param, basic switch, "Basic panel".

**Originator**:
The connection that issued the command currently being handled. The daemon
excludes it from the state fan-out — its own `ack` already confirms the
change — while broadcasting to the others; an internal `ConnId`, never on
the wire. Protects the originator's in-flight edits (e.g. a live slider
drag) from a lagging echo.
_Avoid_: sender, source, client (those don't carry the suppression
semantics).

**Bootstrap**:
`window.__BOOTSTRAP__` — a JSON blob the daemon injects into `index.html`
at request time. Carries the full `ParameterDef[]` metadata table and the
initial `State` snapshot. The UI reads it synchronously at module init
so the page paints fully populated on the first frame, with no pre-paint
network round-trip.
_Avoid_: config, init payload, manifest.

**`vis` event**:
The visualizer broadcast — a `params` map keyed by 4-CC: `vcbg`/`vcbe`
(EQ curve + spectrum) plus native `vnbg`/`vnbe` (Advanced live
display), emitted once per main-session `process()` block (the ARM shim
piggybacks the arrays on the `Process` reply). A pure event stream: no
audio → no events. The client renders at 60 fps from the latest event
and detects idle itself (no event for ~200 ms → freeze + fade). No
daemon-side pump, cadence, or suspend latch.
_Avoid_: visualizer data (see `vcbg`/`vcbe`), `vis_suspended` / suspended
(removed — idle is client-side).

**Readouts**:
The eight ReadOnly-Static values in the state snapshot's `readouts` map, keyed
by 4-CC — the rate-derived native grid (`vnnb`/`vnbf`) plus the build-version /
license slots (`bver`/`bndl`/`ver`/`lcmf`/`lcvd`/`lcpt`). Read from the main
session via `ak_get_bulk`, `ParameterDef.default` while no session exists; `ver`
renders as the formatted engine version (e.g. `2.0.4.0`).
_Avoid_: static params, version blob.

**Slice** (architectural):
A vertical tracer bullet through every layer DolbyX uses (UI · WS ·
daemon · engine · persistence). Each implementation phase is one slice.
_Avoid_: phase (the project still uses "phase" for the document-level
heading; "slice" is the unit a TDD session targets).

### Architecture vocabulary

The architecture vocabulary from
[the improve-codebase-architecture skill](.agents/skills/improve-codebase-architecture/SKILL.md)
applies verbatim: **module**, **interface**, **implementation**,
**depth**, **seam**, **adapter**, **leverage**, **locality**. Do not
substitute "component", "service", "API", or "boundary".
