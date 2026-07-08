# Slice 10 — Factory profiles + `defaults.toml` + cascade persistence

**Goal.** The four factory profiles (Movie, Music, Game, Voice) load from
a real `defaults.toml`, switching profiles in the UI pushes the resolved
parameter set to the engine atomically, and the selection + edits persist
via the full overlay cascade. **First authentic DDP sound**: out of the
box, Music + power on matches the original module.

**Blocked by:** Slices 05, 08.
**Mode:** AFK.

## What to build

### `defaults.toml` — profiles portion

Derive from `vendored/ds1-default.xml` (the original factory XML; param
reference: `docs/ddp/05-profiles-and-persistence.md`). Lives
beside the daemon binary (source of truth in `crates/ddp-daemon/`,
`build.rs` copies it). Each factory profile stores its **delta over
`ParameterDef.default`**; the shared operational config is stated once.
This slice writes the root keys, the shared `[profile]` block, and the 4
`[profile.<id>]` tables (omit `selected_eq_preset` keys — Slice 15 adds
them with the presets). Abbreviated target:

```toml
power = true
selected_profile = "music"

[profile]            # → every profile: standard 20-band stereo config, stated once
genb = 20
ienb = 20
aonb = 20
aocc = 2
gebf = [43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550,
        2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777]
# iebf = same grid; arnb, leveler calibration, speaker-tuning tables — per the XML
ven = 1              # visualizer feed on (v1's cmd-7 VISUALIZER_ENABLE, retired)

[profile.music]
name = "Music"
dvla = 4
deon = 1
dea = 2
dhsb = 48
vdhe = 2
ngon = 2
aoon = 2
plmd = 4
vmb = 144
# … movie, game, voice from the XML
```

### Persistence cascade (ADR-0007 — `docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`)

Extend Slice 04's root-keys persistence to the full model. Two files, two
namespaces each (`[profile]`, `[eq_preset]` — build both now even though
presets fill in Slice 15), one parse rule: a sub-table
(`[profile.<id>]`) is one item's params; **any other key in the namespace
table is a shared param applying to every item**. Root holds only `power`
+ `selected_profile`, written only on divergence. A param may live in both
namespaces (`genb` is band structure for profiles *and* presets). Five
layers, later shadows earlier:

```
ParameterDef.default → defaults.toml shared → defaults.toml [item]
                     →  config.toml  shared →  config.toml  [item]
```

- `defaults.toml` stores deltas over `ParameterDef.default`; `config.toml`
  stores only what diverges from whatever resolves beneath it. The pair
  mirrors the original's `ds1-default.xml` / `ds1-current.xml`; the base
  layer + shared layers are v2's refinement (the original repeated
  factory defaults in full per profile).
- Resolved **at load** — each in-memory profile is complete, so a profile
  switch pushes one `set_params` batch with no per-param fallback.
- **Write-back is always per-item** (`[profile.<id>]`), never to shared
  layers — those are a hand-edit affordance.
- Schema: 4-CC keys live directly in the tables (no `params` sub-tables);
  table-per-id (`[profile.music]`), not array-of-tables; serde
  `#[serde(flatten)] params: HashMap<String, ParamValue>` collects them.
- `is_factory` derived from `defaults.toml` presence at load, never
  stored.
- First run: no `config.toml` → initialize from `defaults.toml`, write an
  **empty** `config.toml` (0 bytes; must exist for the watcher +
  hand-editing). Nothing diverges → user hears original DDP defaults.
- Example `config.toml` after edits:

```toml
power = false   # selected_profile still "music" (= factory) → omitted

[profile.music]
dvla = 5

[profile.user_a3f1]
name = "Late Night"
dvla = 2
dea = 6
```

### Commands + UI + engine flow

- `State.profiles` (factory only), `WsCommands(set_profile,
  reset_profile)`; `edit_profile` lands here too (the Slice 04 dispatch
  grows — value validation against `ParameterDef` per the epic's
  validation section).
- On switch: daemon pushes the selected profile's full resolved set in
  **one atomic `set_params`** to all live sessions (mid-switch dribble
  causes audible artifacts). Session init now pushes this resolved set —
  the shim's commit-leaf touch reshapes the engine's 10-band power-on
  state to the 20-band config in that same write; reshaping is a live
  operation (UI stays reactive to band structure). Band arrays are
  allocated at engine capacity (40); effective count = the group's `*nb`.
- `reset_profile { id }` = remove that id's `config.toml` overrides
  (factory rows in `defaults.toml` untouched); fresh snapshot broadcast.
- UI: `ProfileTabs.tsx` — factory profiles with their category-derived
  display names (custom profiles, later, are just named — no category;
  epic data model).

## Behaviors to test

1. [ ] `Defaults::load` produces 4 factory profiles with their declared
       overrides; shared `[profile]` keys apply to every profile.
2. [ ] `State::new_from_defaults` selects `music` (first-run UX).
3. [ ] Cascade resolution: `ParameterDef.default` < defaults-shared <
       defaults-item < config-shared < config-item (table-driven test).
4. [ ] `set_profile { id: "movie" }` updates selection; daemon pushes
       Movie's full resolved set in one `set_params`.
5. [ ] `edit_profile` on a non-selected profile persists but doesn't
       touch the engine; on the selected profile it flushes.
6. [ ] `selected_profile` + per-profile edits survive restart; factory
       values never written to `config.toml`.
7. [ ] First run writes an empty `config.toml`.
8. [ ] `reset_profile("music")` clears its overrides; snapshot broadcast.
9. [ ] `set_profile { id: "nonexistent" }` → `INVALID_REQUEST`, state
       unchanged.
10. [ ] ProfileTabs renders 4 tabs; switching updates via ack; other
        client updates via broadcast.
11. [ ] **qemu replay**: suite green under `--features qemu`; assert via
        `get_params` that after init the engine really is 20-band
        (`genb`=20) with Music's `dvla`/`dea`/… applied — the
        10→20-band-reshape-at-init proof.

## Tracer bullet

WS `set_profile {id:"movie"}` → assert `StubBackend` recorded a single
`set_params` carrying Movie's full resolved parameter set.

**Mock policy.** Stub for the dispatch suite; behavior 11 runs real.

## References

- Epic: persistence overview, data model, invariants (atomic batch)
- ADR-0003 (`docs/adr/0003-global-eq-presets-and-geq-per-preset.md`),
  ADR-0007 (`docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`)
- `docs/ddp/05-profiles-and-persistence.md`
- `vendored/ds1-default.xml`
