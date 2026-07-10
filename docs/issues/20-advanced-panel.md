# Slice 20 — Advanced panel: all 64 AK parameters auto-generated

**Goal.** The Advanced section renders every AK parameter as a widget
chosen by `ParamKind` × `ParamAccess` from the bootstrap metadata —
nothing hand-listed. Settable/Experimental widgets write back;
ReadOnly-Dynamic cards live-update from `vis`; ReadOnly-Static cards show
the snapshot `readouts`.

**Blocked by:** Slices 10, 14, 16 (14: `lib/units.ts`).
**Mode:** AFK.

## What to build

- **`WidgetFactory.tsx`**: dispatch on `(ParamKind, ParamAccess)`. Nine
  widgets: `ToggleWidget`, `TristateWidget`, `IntegerWidget`,
  `DecibelWidget` (unit label dB / LKFS via `Decibel { lkfs }`),
  `FrequencyWidget`, `DegreesWidget`, `ArrayPerBandWidget`, `AobgWidget`,
  `ReadOnlyWidget`. Unknown combos render an opaque-int fallback with a
  console warning — never crash on metadata growth.
- Each widget resolves range/frac/label/description/help from its
  `ParameterDef` (tooltips from `help` where non-empty). Values in i16;
  conversion via `lib/units.ts` (Slice 14).
- Writes: `edit_profile` against the active profile (every non-readonly
  param is profile-owned — epic invariant), debounced 60 ms for
  continuous controls. Experimental widgets carry a small "experimental"
  badge.
- **ReadOnly-Dynamic cards** (`vnbg`/`vnbe`/`vcbg`/`vcbe`): live-update
  from `vis` events (`vn*` = the native-grid pair — this is their home;
  the visualizer proper uses `vc*`).
- **ReadOnly-Static cards**: render the snapshot `readouts`; `ver`
  formats as the engine version (`2.0.4.0`).
- **`AobgWidget`**: channel-id-prefixed layout (Slice 03 spec:
  `[chan_id, gains…] × aocc`, optional terminator) — not header +
  interleaved pairs.
- **Layout**: CSS Grid,
  `grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))`,
  `gap: var(--space-3)`. Card = 4-CC code + label + value(s) + input or
  read-only display. Long arrays (`aobg` ≤ 329;
  `arbi`/`arbl`/`arbh`/`aobf`/`arbf` at 40) render in a wide card
  (`grid-column: 1 / -1`), collapsed behind a toggle by default. Category
  headers (from `ParamCategory`) introduce groupings; tiny scalars pack
  densely.
- Band arrays display the effective count (the group's `*nb` value), not
  the full fixed allocation.

## Behaviors to test

1. [ ] Bootstrap delivers all 64 defs in stable table order; panel
       renders 64 widgets.
2. [ ] Factory dispatch covers every `(kind, access)` combo present;
       unknown combo → opaque fallback + console warn.
3. [ ] A Settable toggle commit emits `edit_profile` (1-entry batch);
       continuous controls debounce 60 ms.
4. [ ] Experimental widgets show the badge.
5. [ ] ReadOnly-Dynamic cards update from fabricated `vis` events.
6. [ ] ReadOnly-Static cards render `readouts`; `ver` shows `2.0.4.0`.
7. [ ] `aobg` renders channel-major; band arrays show effective `*nb`
       count.
8. [ ] Long arrays render wide + collapsed by default.
9. [ ] Category headers group correctly.
10. [ ] qemu replay: edit an Experimental param (e.g. `vmb`) from the
        panel; engine read-back confirms (clamped).

## Tracer bullet

Render `AdvancedPanel` with a 64-param fixture, assert 64 widgets in a
`data-testid`-matched grid; one Settable Toggle commit fires the expected
WS message.

**Mock policy.** Stub engine + real axum for integration; UI via
`@solidjs/testing-library` + mocked WS; behavior 10 real.

## References

- Epic: data model, invariants (profile-owned params)
- Slice 03 — `ParamKind`/`ParamAccess`/`ParamCategory`, `aobg` layout,
  bucket semantics
- ADR-0004 (`docs/adr/0004-parameter-metadata-as-single-source-of-truth.md`)
