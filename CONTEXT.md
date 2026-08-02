# DolbyX

DolbyX wraps the Android Dolby Digital Plus `libdseffect.so` engine for
desktop audio hosts — a Rust daemon, a Solid Web UI, and thin platform
plugins — matching the original DDP's behavior, look, and feel out of the
box, then extending it.

This is the canonical glossary for DolbyX-specific terms — pin new terms
here, not inline in plans or ADRs. For the *engine's* own vocabulary
(protocol opcodes, AK internals, signal path), see
[`docs/ddp/`](docs/ddp/README.md).

## Language

### Engine

**AK parameter**:
A `libdseffect.so` Audio-Kernel setting identified by a 4-character code
(`dvla`, `iebt`, `gebg`, …) — engine semantics, not a UI control.
_Avoid_: setting, knob, slider.

**4-CC name**:
The four-character code identifying an AK parameter on the wire and in
persistence; stable across reorderings of the metadata table.
_Avoid_: param id, key, code.

**Root leaf**:
A leaf directly under the engine's AK tree root — the real parameter
universe (64), which differs from Java's registered list
([ddp/02](docs/ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves)).

**Power-on default**:
The value a root leaf holds in a fresh AK registry — recorded in the
param twin, not `ParameterDef.default`. Deterministic and
rate-independent; may sit outside the param's own write bounds (bounds
clamp writes, not storage). Only the six DSP-owned visualizer slots ever
move later, at the first process blocks
([ADR-0004](docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).
_Avoid_: boot value, initial value, factory default (collides with
Factory item).

**Settability bucket**:
The classification of every AK parameter into exactly one of `Settable`,
`Experimental`, `ReadOnly-Dynamic`, or `ReadOnly-Static`
([ADR-0004](docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).
_Avoid_: param access, settable flag.

**Structural param**:
An AK param that reshapes a feature's filterbank — band count + centre
frequencies — staged by the engine and applied only on its group's
commit-leaf write. Also *structural constants* where they sit fixed in a
profile's config.

**Commit leaf**:
The last payload array of a structural-param group (`gebg`, `iebt`,
`aobg`, `arbh`); re-writing it — even unchanged — makes the engine
re-derive that group's filterbank (**touch = commit**). Shim-internal,
never in `ParameterDef`
([ADR-0010](docs/adr/0010-ak-direct-params-cmd-lifecycle.md)). The
custom visualizer grid (`vcnb`/`vcbf`) has no commit semantics — plain
per-block registry reads.
_Avoid_: trigger param, commit param.

**Native grid** (`vnnb` / `vnbf`):
The visualizer's intrinsic band layout — count + centre frequencies —
read-only, derived by the engine from the sample rate.
_Avoid_: "native bands" (ambiguous with the per-block `vnbg`/`vnbe` data).

**`vcbg` / `vcbe`**:
The custom-grid visualizer pair — per-block EQ gains + spectrum
excitations resampled onto the host-set grid (`vcnb`/`vcbf`); two of the
four ReadOnly-Dynamic arrays ([ddp/02](docs/ddp/02-ak-parameters.md)).
_Avoid_: "visualizer data" alone (ambiguous between the raw arrays and
the `vis` event payload).

**Session**:
An `effect_handle_t` inside the engine subprocess — one per plugin
instance, created by the plugin's `Hello`, destroyed by its disconnect,
sample rate fixed for its lifetime.
_Avoid_: stream, connection, instance.

**Main session**:
The oldest live session — index 0 of the supervisor's creation-ordered
list; sources the `vis` events and the readouts.
_Avoid_: oldest session, control session, primary session.

**Vis tail** / **`VisFrame`**:
The four ReadOnly-Dynamic arrays (`vnbg ‖ vnbe ‖ vcbg ‖ vcbe`,
4 × 20 i16) the shim appends to every `Process` reply; surfaced at the
`Engine` trait as `VisFrame`.
_Avoid_: vis packet; visualizer data (see `vcbg`/`vcbe`).

**Shim**:
The `ddp-engine-arm` ARMv7 binary that dlopens `libdseffect.so` and
serves the engine protocol — the only code touching the engine's
exported symbols.
_Avoid_: wrapper; engine binary (ambiguous with `libdseffect.so` itself).

**Backend**:
An implementation of the `Engine` trait — `StubBackend`, `QemuBackend`,
later Unicorn / static translation
([ADR-0002](docs/adr/0002-backend-agnostic-engine-qemu-default.md)).
_Avoid_: engine (that's `libdseffect.so`).

**DDP module** (`v8.1-20211005`):
The reverse-engineered Magisk module — source-of-truth artifact every
`docs/ddp/` fact derives from.
_Avoid_: tagging the engine or `.so` "v8.1".

**Engine version** (`2.0.4.0`):
`libdseffect.so`'s own version, reported by cmd 6 (`DS_PARAM_VERSION`)
/ the `ver` readout. Long-EOL and frozen — no newer version expected.
_Avoid_: v8.1 (the module), `bver` (opaque build blob), `1.8.0.0`
(`DS_VERSION_INTERNAL`, Java-side).

### Daemon & wire

**Supervisor**:
The daemon module (`EngineSupervisor`) owning the backend's lifecycle
and the creation-ordered session list.

**Originator**:
The connection that issued the command currently being handled; the
daemon excludes it from the state fan-out (its own `ack` confirms) — an
internal `ConnId`, never on the wire.
_Avoid_: sender, source, client (those don't carry the suppression
semantics).

**Bootstrap**:
`window.__BOOTSTRAP__` — the JSON blob (parameter metadata + initial
state snapshot) the daemon injects into `index.html` at request time,
read synchronously so the first paint is fully populated.
_Avoid_: config, init payload, manifest.

**LAN access**:
The root toggle deciding whether other devices on the local network may
reach the daemon's UI and WebSocket — off (the default) means this
machine only; on trusts every device on the network equally (no auth).
Off also revokes: established non-loopback connections are severed on
the flip (ADR-0012). A root scalar resolved through the Cascade like
`power`.
_Avoid_: remote access (implies internet), bind address (the mechanism,
not the concept).

**`vis` event**:
The per-block visualizer broadcast — the vis tail's four arrays keyed by
4-CC; a pure event stream (no audio → no events, no client-side
smoothing; 250 ms without a frame is Vis idle).
_Avoid_: visualizer data (see `vcbg`/`vcbe`); `vis_suspended` /
suspended (removed concept).

**Readouts**:
The eight ReadOnly-Static values in the state snapshot's `readouts` map,
keyed by 4-CC — the native grid plus the build-version / license slots,
read from the main session.
_Avoid_: static params, version blob.

**Cascade**:
The five-layer parameter resolution order — `ParameterDef.default →
defaults.toml shared → defaults.toml item → config.toml shared →
config.toml item` — later shadows earlier
([ADR-0007](docs/adr/0007-toml-overlay-persistence-with-file-watcher.md)).

**Param twin**:
`parameters.engine.toml` — probe-generated, committed, never loaded; the
engine-truth reference `parameters.toml` is curated from. CI checks
`parameters.toml` against it structurally — names 1:1, lengths equal,
every range within the engine envelope
([ADR-0004](docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).
_Avoid_: twin (unqualified).

**Engine envelope**:
A param's `[min, max]` as the param twin records it — curation may
narrow a range inside the envelope, never exceed it.
_Avoid_: engine bounds (ambiguous with `parameters.toml`'s own
`min`/`max`).

### Profiles & UI

**Profile**:
The canonical persistence unit — home for every non-readonly AK param
(the 52), plus an optional selected EQ preset; exactly one profile is
selected at any time.
_Avoid_: preset (overloaded with EQ preset), mode.

**EQ preset**:
An optional EQ overlay, global across profiles, carrying the nine EQ
params; when selected it shadows the profile's own EQ params entirely,
and `None` means the profile's own apply
([ADR-0003](docs/adr/0003-global-eq-presets-and-geq-per-preset.md)).
_Avoid_: IEQ preset (legacy DDP term); preset without "EQ" (ambiguous
with Profile); "Off" preset (replaced by `None`).

**EQ selection**:
A profile's `selected_eq_preset` content key — which EQ preset shadows
the profile's own nine (`None` — JSON `null`, TOML `"none"` — ⇒ its
own apply). Cascaded like any content key.
_Avoid_: bare "selection" (ambiguous with the active profile and with
picker UI state), preset selection.

**Factory item** (`is_factory`):
A profile or EQ preset whose id appears in `defaults.toml` — derived at
load, never stored; never deleted or renamed (a Reset falls it back to
its bundled defaults). Factory profiles: Movie, Music, Game, Voice;
factory EQ presets: Open, Rich, Focused.
_Avoid_: built-in, default item, preset flag.

**Fallback profile**:
Where the active profile falls when the selected profile is deleted —
`defaults.toml`'s `selected_profile`, a factory id, so the fallback
itself can never be deleted.
_Avoid_: default profile (ambiguous with the factory defaults).

**Baseline**:
What resolves beneath an item's `config.toml` row — every Cascade
layer under it: through the `defaults.toml` item row + `config.toml`
shared for factory items; `ParameterDef.default` ⊕ the shared layers
for customs (no `defaults.toml` row). Covers params and, for profiles,
the EQ selection. Ships in every snapshot beside the resolved content;
divergence (resolved ≠ baseline, per content key) is derived from it —
never stored, never sent — and it is Reset's floor, the write law's
base, and the filler of an `add_*`'s unstated params
([ADR-0007](docs/adr/0007-toml-overlay-persistence-with-file-watcher.md)).
_Avoid_: overridden (the dead precomputed list), birth clone (a custom
never resets to it).

**Content key**:
One resettable key of an item's own config row — any writable param
4-CC, plus `selected_eq_preset` for profiles. `name` is excluded (a
label, never reset). The vocabulary of Reset scopes and divergence
tracking.
_Avoid_: field, property, override key.

**Reset**:
Clearing an item's `config.toml` divergences — whole-item or scoped to
named content keys — so the Cascade's layers beneath resolve: a factory
item falls to its bundled defaults, a custom item to the shared layers.
Valid on every item; never touches `name`, never restores a custom
item's birth clone.
_Avoid_: restore defaults, factory reset (reset isn't factory-only).

**IEQ**:
"Intelligent EQ" — the engine-driven target curve, backed by `iebt`
(band targets) and `ieon` (enable).

**GEQ**:
"Graphic EQ" — the user-driven curve, backed by `gebg` (band gains) and
`geon` (enable).

**GEQ editor**:
The EQ editing surface inside the visualizer — the sliders and curve
riding the `vis` feed; revealed and hidden per skin policy (Classic:
hover / focus / drag, 5 s linger).
_Avoid_: eq overlay ("overlay" is taken — an EQ preset shadowing a
profile's params); GEQ overlay.

**Master control**:
One of the three main-screen controls — Surround Virtualizer
(`vdhe`+`dhsb`), Dialog Enhancer (`deon`+`dea`), Volume Leveller
(`dvle`+`dvla`) — each pairing an enable param with an amount param; a
curated UI overlay, not engine metadata.
_Avoid_: basic param, basic switch, "Basic panel".

**Skin**:
A CSS-only visual variant of the whole UI — all visual policy
(quantization, colors, z-order, state looks) lives in skin CSS;
components expose data as CSS variables and state as BEM modifier
classes, never appearance.
_Avoid_: theme (reads as light/dark color scheme).

**Classic skin**:
The factory skin — the faithful transcription of the original DDP look.

**Lattice**:
The per-column chrome surface whose separator lines carve the column's
fill into bricks; the pieces tile into the field-wide grid (the
original's per-cell brick insets, not a global overlay). Skin-painted
quantization chrome.
_Avoid_: grid (taken — the band layouts: Native grid, custom vis grid).

**Pip**:
The per-column gain marker riding `vcbg[c]` (the original's
`brick_blue_light`); quantization per skin — Classic keeps it
continuous, like the original.
_Avoid_: bar (the original overloads it: brick bitmaps, column width, EQ
track).

**Slider**:
The per-visible-band EQ control unit — track chrome + draggable thumb
(the original's `mSliderBg`/`mSliderThumb`), riding a fractional `gebf`
index; visible count `N ∈ [2, genb]`, default 5.
_Avoid_: band (sliders sit at fractional indices, between bands).

**Vis idle**:
The feed state entered 250 ms after the last `vis` event — feed death
only (zero sessions, host stopped processing, WS down), never `ven` or
power (bypassed blocks keep emitting). The visualizer returns to the
silence floor; the GEQ editor renders resolved state; a fresh frame
exits instantly. Mount starts idle.
_Avoid_: suspended (the original's removed concept); stale frame.

**Brush buffer**:
The GEQ smoother's pre-convolution user-gain state — what a stroke
actually paints; the kernel convolves it into the smoothed curve the
engine receives. Never persisted — rehydrated from the stored curve.
_Avoid_: temp gains (the Java field); user gains (ambiguous with
`gebg`).

**Rehydrate**:
Rebuilding the brush buffer from a stored curve via the kernel's
pseudoinverse, so the convolution reproduces that curve exactly and the
next stroke continues it without a jump — run whenever the active
`gebg` changes by any path other than the smoother's own write.
_Avoid_: inverse smoothing (the mechanism, not the purpose).
