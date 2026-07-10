# Slice 17 — GEQ editing: smoother + inverse + EqCurve overlay

**Goal.** Dragging an EQ thumb sends smoothed, clamped 20-band `gebg`
writes throttled at ≤ 60 ms; the cyan curve + thumbs render and feel like
the original; switching EQ presets keeps the next drag continuous via the
inverse-smoother matrix.

**Blocked by:** Slices 14, 15, 16 (14: `lib/units.ts` dB↔i16).
**Mode:** HITL — golden snapshots from the Java reference need one manual
visual verification before locking in.

## What to build

All constants transcribe from
`decompiled/DsUI.apk/sources/com/dolby/ds1appUI/GraphicEqualizerPainter.java`
(+ `FragGraphicVisualizer.java` wiring, `EqualizerAdapter.java` preset
cells). (ADR-0008 — `docs/adr/0008-visualizer-equalizer-rendering-spec.md`)

### `GainSmoother` (`ui/src/lib/gain_smoother.ts`) — pure UI math

Interface: `enqueue(band, dB)` · `tick(): Int16Array | null` (smoothed,
clamped 20-band write, or `null` if nothing pending). Unit-testable in
isolation; smoothing is **UI-only** — wire and engine always carry the
smoothed, clamped 20-band `gebg`, whatever the UI prefs.

Pipeline — drags enqueue `(band, dB)` into a per-instance ring buffer
(cap 20; consecutive events for the same band overwrite); a
`rAF`-throttled recalc drains every **60 ms** (30 ms while idle):

1. **handleNewTouchEvents** — per event:
   `newUserGain = touchGain − (uiGain[b] − smooth[b])` (raw `touchGain`
   while idle), splat into the inclusive (2L+1)-cell window
   `temp[b ..= b+2L]` — every cell the same value (the "thick-brush"
   feel).
2. **smoothenCurve** — each `temp` cell outside
   `[minEditGain, maxEditGain]` decays toward the violated clamp with
   `α = 0.5^(Δt / 0.3 s)`; in-range cells untouched. Then convolve:
   `smooth[b] = Σ kernel[i] · temp[b + i]`. Skip-write threshold
   `|new − old| > 0.02 dB`.
3. Throttled write — ≤ one per 60 ms; the 20-band i16 1/16-dB array goes
   to the daemon as a 1-entry batch.

```ts
const KERNELS = {
  Mobile: { L: 2, k: [0.1, 0.25, 0.3, 0.25, 0.1] }, // original mobile
  Soft:   { L: 1, k: [0.25, 0.5, 0.25] },           // original tablet
  Direct: { L: 0, k: [1.0] },                       // no smoothing
}
```

τ = 0.3 s exponential time-decay across all kernels.

**Inverse smoother**: on any `state` broadcast updating the active `gebg`
(EQ-preset change included), recompute `temp` from the new `gebg` via the
selected kernel's **20×20 pseudoinverse** so the next touch stays
continuous. Ship precomputed `GAIN_SMOOTHER_INV_MOBILE` / `_SOFT` as TS
constants — values from `GraphicEqualizerPainter.java` lines 70–71
(`_TABLET` → `_SOFT`, `_MOBILE` → `_MOBILE`); `Direct`'s inverse is the
identity.

### `EqCurve.tsx` — the overlay (fills Slice 16's placeholder group)

- **Curve source**: the latest `vis` event's **`vcbg`** during steady
  state; the locally smoothed user buffer while idle. `vcbg ≠ gebg` —
  `gebg` is the user's input param; `vcbg` is the composed curve the
  engine actually applies (`gebg` blended with `iebt` per `ieon`).
  Rendering stored `gebg` would hide the IEQ contribution. Drag lag is
  one audio block (vs the original's structural ~50 ms pump lag).
- **Curve**: cyan `#75D2FF`, two passes — glow: stroke 10·scale, α 0x80,
  `feGaussianBlur stdDeviation="4·scale"`, ROUND caps; sharp: stroke
  3·scale, α 0xD0 (≈82 %), `stroke-linejoin="round"`, default BUTT caps
  (the glow's rounded ends swallow the sharp ends). A **polyline** with
  one vertex per engine band (= `genb`), **not** Catmull-Rom — the
  original uses `CornerPathEffect(10·scale)`; linear segments + rounded
  joins reproduce it at these widths.
- **Thumbs**: drawn at visible thumb positions only; fractional indices
  (visible count < band count) interpolate Y linearly between adjacent
  band gains (`translateGaindBToY`). During drag the active band uses
  `eq_thumb_touch_state`; all others the default `eq_thumb` (the
  Bright1/2/3 cascade collapses — `Bright1 = Bright2 = eq_thumb`; only
  distance 0 is distinct — replicate that). Overlay fades in over
  **250 ms** on mousedown; fades out **5000 ms** after last input
  (`SHOW_HIDE_ANIMATION_DURATION`, `IDLE_HIDE_DELAY`). Track reserves
  `thumbHeight/4` padding top **and** bottom; usable track =
  `H − 2·pad`; dB mapping from Slice 16.
- **Edit routing** (from Slice 15's model): a GEQ drag emits
  `edit_eq_preset` when a preset is active on the current profile, else
  `edit_profile`.

### UI preferences (browser `localStorage` — display prefs, never `config.toml`)

| Pref | Values | Default | Notes |
|---|---|---|---|
| Visible thumb count | `N ∈ [2, genb]`; step = `(genb−1)/(N−1)` | `5` | 5 → step 4.75 (original mobile); `N = genb` → step 1 (original tablet); capped at `genb` — the engine has no finer resolution. |
| Smoother kernel | `Mobile` / `Soft` / `Direct` | `Mobile` | |

## Behaviors to test

1. [ ] `enqueue` + `tick` → smoothed 20-band i16 within the engine's
       `gebg` clamp.
2. [ ] Kernel selection changes output shape per the Java matrices
       (golden snapshots).
3. [ ] Out-of-range cells decay toward the violated clamp with
       `α = 0.5^(Δt/0.3 s)`.
4. [ ] `tick` emits ≤ one write per 60 ms (30 ms idle).
5. [ ] On `state` broadcast updating active `gebg`, the inverse
       repopulates `temp` — next touch continuous (no jump).
6. [ ] `edit_profile { params: { gebg } }` forwards to
       `StubBackend::set_params` correctly.
7. [ ] Curve renders as polyline + rounded joins (not Catmull-Rom); glow
       + sharp pass parameters as specced.
8. [ ] Routing: drag emits `edit_eq_preset` iff a preset is active, else
       `edit_profile`.
9. [ ] Curve reads `vcbg` from `vis` when flowing, local buffer when
       idle.
10. [ ] qemu replay: after a drag trace, `get_params("gebg")` returns the
        emitted curve (clamped registry).

## Tracer bullet

Vitest: feed a known drag trace into `GainSmoother`, assert the emitted
20-band write matches a golden snapshot generated from the Java reference.

**Mock policy.** Stub; `GainSmoother` is pure math (no mocks); drag-to-WS
via `@solidjs/testing-library` + mocked WS; behavior 10 real. HITL: eyeball
the golden snapshots against the original once.

## References

- ADR-0008 (`docs/adr/0008-visualizer-equalizer-rendering-spec.md`)
- Java: `GraphicEqualizerPainter.java` (kernels, inverse matrices, touch
  queue, glow paints, show/hide), `FragGraphicVisualizer.java`,
  `EqualizerAdapter.java`
- Reference: `docs/ui-reference/original-ui-visualizer-eq-overlay.png`
- Epic: invariants (i16, localStorage prefs)
