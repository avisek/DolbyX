# Slice 03 — Parameter metadata SoT: `parameters.toml` + parser + engine twin + CI gate

**Goal.** All 64 real root-leaf AK parameters are declared once in a
runtime-loaded `parameters.toml`; `ddp-state` parses and validates it; a
probe-generated twin (`parameters.engine.toml`) lets CI fail on any drift
of engine-fact fields.

**Blocked by:** Slice 01 (workspace; standalone probe).
**Mode:** AFK — bucket membership and product fields are fully enumerated
below; probe dumps supply the engine facts.

## What to build

(ADR-0004 — `docs/adr/0004-parameter-metadata-as-single-source-of-truth.md`)
Everything downstream — wire validation, engine init, persistence, UI
generation, ranges — derives from this table. **Seed from the engine tree,
not Java**: Java's `DsAkSettings.akParams_` 64-name list registers two
phantoms (`mxou`, `lcsz` — node params resolving to ref 0) and omits two
real leaves (`scpe`, `test`). Seeding from `make -C tools/ddp_probe
dump-tree` corrects that automatically
(`docs/ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves`).

### The shape

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
    pub category: ParamCategory,// UI grouping
    pub access: ParamAccess,
    pub label: String,          // human-readable display name
    pub description: String,    // engine one-liner
    pub help: String,           // engine long help — may be empty
}

pub enum ParamKind {
    Toggle,                     // 0/1
    Tristate { on: i16 },       // 0/1/2, where "on" = 1 or 2
    Integer,
    Decibel { lkfs: bool },     // lkfs=true switches label dB → LKFS (dvli/dvlo)
    FrequencyHz,
    Degrees,
    PerBand,
    AobgChannelMajor,           // aobg — channel-id-prefixed layout
    Opaque,                     // license blobs etc — render as int[]
}

pub enum ParamAccess { Settable, Experimental, ReadOnlyDynamic, ReadOnlyStatic }

pub enum ParamCategory {
    Ieq, Geq,
    VolumeLeveller, DialogEnhancer,
    HeadphoneVirtualizer, SpeakerVirtualizer, NextGenSurround,
    AudioRegulator, AudioOptimizer, VolumeMaximizer, PeakLimiter,
    Visualizer, EndpointVolume,
}
```

### Field rules

- **`frac_bits`** — engine-sourced uniform fixed-point scale. Every
  dB-coded param carries `frac_bits = 4` (binary: "scaled by 16 ie. 16 =
  1 dB"); plain integers carry 0. The UI never hardcodes the conversion.
- **`default`** — the engine's intrinsic power-on value, captured via
  `make -C tools/ddp_probe dump-defaults`. **Engine-honest, no
  exceptions**: the engine boots **10-band**, so `genb` defaults to 10 and
  `gebf` to the 10 ISO octave centres (32 Hz–16 kHz) zero-padded to
  length. The standard 20-band stereo config is *not* a table default — it
  lives once in `defaults.toml`'s shared `[profile]` table (Slice 10).
  `default` is the base layer of the persistence cascade.
- **Engine-fact fields** (`name`, `length`, `min`, `max`, `frac_bits`,
  `default`) come from the probe; **product fields** (`kind`, `category`,
  `access`, `label`, `description`, `help`) are free to hand-edit.
  `description`/`help` seed from `dump-docs` (75 of 248 defs carry help).

### Four-bucket settability (deliberate deviation from a settable=yes/no binary)

The engine accepts cmd 3 SET against any declared param and forwards to
`ak_set` regardless of Java's whitelist (probe §5b). Buckets are about
**DSP semantics + UI presentation**, not engine acceptance:

- **Settable (42)** — Java's `isParamSettable` whitelist. Well-defined DSP
  behavior; editable widgets. Includes `iebt` (Java whitelists it; only
  the higher-level `Ds.setDsApParam` rejected user writes to protect the
  IEQ-preset abstraction — DolbyX plans direct editing behind a toggle
  later).
- **Experimental (10)** — `preg`, `pstg`, `endp`, `ocf`, `ven`, `vol`,
  `vcnb`, `vcbf`, `scpe`, `test`. Engine treats the slot as a real DSP
  input; original DDP UI hid it. Editable behind an "experimental" badge.
  DolbyX is deliberately a research vehicle for `libdseffect.so`.
  Behavioral proof (probe §7): `vmb` sweep over {0, 120, 240, 480} moves
  peak/rms with 240 and 480 collapsing (both clamp to `vmb` max 192);
  `dvla` sweep collapses the same way (10 and 200 both clamp to 10); the
  DSP reads the clamped registry, not the raw cache (direct cache poke is
  ignored). Notes: `vol` is a host volume hint the leveler reads; `ven` is
  a single enable gating the fills of both `vn*` and `vc*` families;
  `vcnb`/`vcbf` define the host-writable custom grid onto which `vn*` is
  resampled to produce `vc*` (not a separate "mode"); `preg` help: "this
  parameter should be set to reflect how much gain has been applied".
- **ReadOnly-Dynamic (4)** — `vnbg`, `vnbe`, `vcbg`, `vcbe`:
  write-protected (flag `0x2`), rewritten by the DSP every audio block;
  ride the `vis` event. `vc*` reads identical to `vn*` until the custom
  grid is reconfigured.
- **ReadOnly-Static (8)** — native grid `vnnb`/`vnbf` (rate-derived) +
  build/license slots `bver`, `bndl`, `ver`, `lcmf`, `lcvd`, `lcpt`. Read
  once via `ak_get_bulk` after a session's SET_CONFIG; surfaced as the
  snapshot `readouts`. Six carry write-protect `0x2`
  (`vnnb`/`vnbf`/`bver`/`ver`/`bndl`/`lcvd`); `lcmf`/`lcpt` accept writes
  with no observable effect.

### `aobg` layout

Java's static `329` is the worst-case max = `aocc_max (8) × (aonb_max (40)
+ 1 channel-id) + 1 sentinel`; runtime length = `(aonb + 1) × aocc` (= 42
for the 20-band stereo config). Layout is **channel-id-prefixed** (per the
engine's description string), not header + interleaved pairs:

```
[AK_CHAN_L, L_gain_0..L_gain_(aonb-1),
 AK_CHAN_R, R_gain_0..R_gain_(aonb-1),
 …,                                       // up to aocc channels
 AK_CHAN_EMPTY?]                          // optional terminator
```

### Delivery + drift gate

- **No generated code.** `parameters.toml` ships as a runtime file next to
  the daemon binary (with `defaults.toml`), parsed + validated at startup
  only, never watched; malformed → refuse to start. Crate seams:
  `ddp-state` owns the pure parser/validator (`&str →
  Vec<ParameterDef>`, defs own their `String`s); `ddp-persistence` reads
  the file. Source-of-truth copies live in `crates/ddp-daemon/`; a
  `build.rs` copies both TOMLs next to the binary.
- **`parameters.engine.toml`** — committed twin regenerated straight from
  the probe (`dump-tree` + `dump-docs` + `dump-defaults`; recipe `just
  param-twin`), never loaded. CI diffs the engine-fact fields of
  `parameters.toml` against it and fails on drift.
- Adding a param to the Advanced section later = edit `parameters.toml` +
  restart daemon; the UI auto-discovers on next page load (bootstrap
  re-serializes on every `GET /`).

## Acceptance criteria

- [ ] `just param-twin` regenerates `parameters.engine.toml` from the
      probe dumps, deterministically
- [ ] `parameters.toml` parses to exactly 64 `ParameterDef`s; contains
      `scpe`/`test`, not `mxou`/`lcsz`
- [ ] Bucket counts validate: 42 / 10 / 4 / 8
- [ ] Every dB-coded param has `frac_bits = 4`; `dvli`/`dvlo` are
      `Decibel { lkfs: true }`
- [ ] `genb` default = 10; `gebf` default = 10 ISO octave centres
      zero-padded (engine-honest boot values throughout)
- [ ] Parser rejects malformed input (missing field, unknown enum, dup
      name, `default` length ≠ `length`) with useful errors
- [ ] CI diff gate wired and red on a seeded engine-fact drift (prove once,
      then fix)
- [ ] Parser has unit tests; property test for accepted-value bounds

## Tracer bullet

Unit test: `parse(include_str!(…)).unwrap().len() == 64` with spot-checks
(`lookup("dvla")` range/frac, `lookup("scpe").access == Experimental`).

**Mock policy.** Pure parsing — no mocks anywhere.

## References

- ADR-0004 (`docs/adr/0004-parameter-metadata-as-single-source-of-truth.md`)
- `docs/ddp/02-ak-parameters.md` — per-param
  reference + the Java-vs-engine root-leaf analysis
- `docs/ddp/07-ak-api.md` — the AK tree/metadata API
- `tools/ddp_probe/README.md` — dump
  targets (§ "make dump-tree / dump-defaults / dump-docs"), §5b, §7
