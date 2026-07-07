# Slice 15 — Factory EQ presets apply as overlays

**Goal.** Selecting an EQ preset (Open / Rich / Focused) writes the
preset's resolved 9 EQ params to the engine; the active profile records the
selection per-profile; `id: null` detaches (profile's own EQ params apply);
editing a preset propagates to every profile selecting it.

**Blocked by:** Slice 10.
**Mode:** AFK.

## What to build

### Model (ADR-0003 — `docs/adr/0003-global-eq-presets-and-geq-per-preset.md`)

Original DDP kept a per-profile copy of every preset's GEQ curve
(6 × 4 × 20 matrix). v2: **EQ presets are top-level, global, optional
overlays** carrying exactly the 9 EQ params — `genb`/`gebf`/`geon`/`gebg`
(GEQ) + `ienb`/`iebf`/`ieon`/`iebt`/`iea` (IEQ). Eligibility is derived,
not declared: preset-carried ⟺ `category ∈ {Ieq, Geq}` — no `scope`
field.

- **Resolution**: a selected preset's 9 params shadow the profile's own
  *entirely* — the preset resolves complete through its own defaults
  cascade (`[eq_preset]` shared layer gives band structure so presets
  resolve standalone), never half-applies. `None` → profile's own EQ
  params. "Off" is `None`, not a preset.
- **Edit routing**: `edit_profile` writes the profile; `edit_eq_preset`
  writes the preset — the UI picks by whether a preset is active (GEQ
  drag routing itself lands in Slice 17); the daemon just overlays.
- Consequences: editing Rich's `iebt` takes effect immediately in every
  profile currently selecting Rich; a new preset is available to all
  profiles; removing one falls selectors back to `None` (Slice 18).
- Original-behavior note: DDP only let `gebg` be edited (via the V/E
  overlay) and `iebt` never beyond factory values. DolbyX keeps that for
  now; direct `iebt` editing behind a toggle is future work (`iebt` is
  Settable — Java whitelists it; only `Ds.setDsApParam` gated it).

### `defaults.toml` — presets portion

Add the `[eq_preset]` shared block + 3 factory presets, and the factory
`selected_eq_preset` keys omitted in Slice 10 (`music` → `"rich"`; others
per `vendored/ds1-default.xml`):

```toml
[eq_preset]          # → every EQ preset: band structure, so presets resolve standalone
genb = 20
ienb = 20
# gebf / iebf = the 20-band grid (as [profile])

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
selected_eq_preset = "rich"
```

### Commands + UI

- `State.eq_presets`, `Profile.selected_eq_preset: Option<PresetId>`,
  `WsCommands(set_eq_preset, edit_eq_preset, reset_eq_preset)`.
- `set_eq_preset { profile_id, id }` — explicit target (EQ selection is
  per-profile); flush-iff-live: engine push only when `profile_id` is the
  selected profile. `edit_eq_preset` same flush rule (any profile
  currently selecting the edited preset and active).
- `EqPresetPicker.tsx`: Open / Rich / Focused + a None affordance.

## Behaviors to test

1. [ ] Factory presets load; `[eq_preset]` shared band structure makes
       each resolve standalone (full 9 params).
2. [ ] `set_eq_preset { profile_id: "music", id: "rich" }` → one atomic
       `set_params` with the resolved 9 EQ params; selection stored on
       that profile.
3. [ ] `set_eq_preset { …, id: null }` detaches → one `set_params` with
       the profile's own EQ params.
4. [ ] `edit_eq_preset` on Rich's `iebt` flushes to the engine for the
       active profile selecting Rich, and is visible to every selecting
       profile.
5. [ ] `set_eq_preset` targeting a non-selected profile persists without
       an engine call.
6. [ ] `selected_eq_preset` persists per-profile as an `Option`.
7. [ ] Music arrives from factory with Rich selected (first-run parity
       with the original).
8. [ ] qemu replay: after `set_eq_preset` rich, `get_params("iebt")`
       returns Rich's curve.

## Tracer bullet

WS `set_eq_preset { profile_id: "music", id: "rich" }` → Stub recorded one
`set_params` carrying all 9 EQ params — `iebt = [67, 95, …, -235]` and
`ieon = 1` among them.

**Mock policy.** Stub; behavior 8 real.

## References

- Epic: data model, invariants (overlay rule)
- ADR-0003 (`docs/adr/0003-global-eq-presets-and-geq-per-preset.md`)
- `docs/ddp/05-profiles-and-persistence.md`
- CONTEXT.md — "EQ preset", "IEQ", "GEQ"
