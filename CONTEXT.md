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
The value a root leaf holds in a fresh AK registry — `ParameterDef.default`,
the cascade's base layer. Deterministic and rate-independent; may sit
outside the param's own write bounds (bounds clamp writes, not storage).
Only the six DSP-owned visualizer slots ever move later, at the first
process blocks
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
([ADR-0010](docs/adr/0010-ak-direct-params-cmd-lifecycle.md)).
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

**`vis` event**:
The per-block visualizer broadcast — the vis tail's four arrays keyed by
4-CC; a pure event stream (no audio → no events; idle is
client-derived).
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
`parameters.engine.toml` — probe-generated, committed, never loaded; CI
diffs its engine-fact fields against `parameters.toml` to block drift
([ADR-0004](docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).
_Avoid_: twin (unqualified).

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

**Factory item** (`is_factory`):
A profile or EQ preset whose id appears in `defaults.toml` — derived at
load, never stored; resettable to bundled defaults but never deleted or
renamed. Factory profiles: Movie, Music, Game, Voice; factory EQ
presets: Open, Rich, Focused.
_Avoid_: built-in, default item, preset flag.

**IEQ**:
"Intelligent EQ" — the engine-driven target curve, backed by `iebt`
(band targets) and `ieon` (enable).

**GEQ**:
"Graphic EQ" — the user-driven curve, backed by `gebg` (band gains) and
`geon` (enable).

**Master control**:
One of the three main-screen controls — Surround Virtualizer
(`vdhe`+`dhsb`), Dialog Enhancer (`deon`+`dea`), Volume Leveller
(`dvle`+`dvla`) — each pairing an enable param with an amount param; a
curated UI overlay, not engine metadata.
_Avoid_: basic param, basic switch, "Basic panel".
