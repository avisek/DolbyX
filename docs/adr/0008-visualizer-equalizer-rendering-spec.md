# Visualizer / Equalizer rendering: faithful to the original, skinnable

The V/E overlay is DDP's most visible piece. The decompiled Java
painters
(`decompiled/DsUI.apk/sources/com/dolby/ds1appUI/GraphicVisualiserPainter.java`,
`GraphicEqualizerPainter.java`) are the **reference** — DolbyX
faithfully matches the original's look and feel, element naming
inspired by its source, and extends/improves/simplifies only
deliberately. Rendering follows the skin contract (ADR-0011): the
component publishes data; the Classic skin's CSS holds every constant
below.

Deliberate choices a reader might otherwise "fix":

- **The feed is a pure event stream** — one `vis` event per
  main-session process block (the frame rides the `Process` reply,
  [ADR-0010](0010-ak-direct-params-cmd-lifecycle.md)); no daemon pump,
  no suspend protocol. The client is a pure function of the latest
  frame, painted at rAF (coalescing only — latest wins).
- **No dynamics on live data — and one discrete idle state.** No
  ballistics, no fade, no client smoothing: the engine's excitation
  data is already ballistic (the original painter raw-copies it to
  screen), and processed silence walks the display to the floor by
  itself. Client smoothing would only falsify live data — but a dead
  feed has no data to falsify. **Vis idle** — 250 ms without a frame,
  feed death only (zero sessions, host stopped processing, WS down) —
  snaps every column to the silence floor (`--exc: -12`, `--gain: 0`)
  and raises `visualizer--idle`; *how* the display descends is skin
  CSS. (Supersedes the earlier vars-hold-forever rule, which left
  dead non-floor bricks after a disconnect.) Mount starts idle — the
  from-mount floor and feed death are one state; a plugin streaming
  silence changes nothing visually. Idle exit and the first frame's
  vars land in one style recalc. Power off: frames keep applying —
  the off-look is skin CSS under the app root's `app--off` modifier,
  never a data gate. `ven = 0` likewise: the component only mirrors
  the resolved param as its `visualizer--off` modifier; frames keep
  applying (the DSP has stopped filling, so they carry frozen values
  — and keep *arriving*, so neither gate is idle) and the skin's
  off-look covers the field.
- **Columns, not bricks, in the DOM.** One element per live band
  (count = the `vcnb` param, reactive; the component reads the first
  `vcnb` slots of the vis event's fixed 20-slot arrays — the wire
  never changes shape) carrying continuous `--exc`/`--gain` dB
  vars; quantization is Classic CSS `round()`, brick separation is the
  per-column lattice chrome. Per-brick JS rects would bake
  quantization into markup (ADR-0011).
- **The EQ curve is a polyline with rounded joins — not a spline.** The
  original draws linear segments through `CornerPathEffect(10·scale)`;
  at these stroke widths a rounded-join polyline reproduces it exactly,
  a Catmull-Rom spline does not.
- **The GEQ editor renders the engine, not the pointer.** Thumbs and
  curve ride the latest frame's `vcbg` — the composed curve the DSP
  applies (`gebg` blended with `iebt` per `ieon`); the finger leads,
  the display trails by one audio block. Under Vis idle — or
  `ven = 0`, whose frozen frames can't follow edits — they render
  resolved state instead (GEQ-only; the original's suspended render
  deviated identically). One rule, three consumers: curve vertices,
  thumb Ys, the touch math's reference gain.
- **The drag surface is the field, not the thumbs.** Pointer-down
  anywhere edits immediately; x snaps to the nearest visible EQ slider;
  moves sweep across bands — the original's finger-painting feel.
  Thumbs are visual; keyboard edits are per EQ slider (`role="slider"`).
- **Editor visibility is skin policy.** The component publishes
  `visualizer--eq-drag` while a pointer is captured — no timers, no
  visibility state. Classic reveals on `:hover` / `:focus-within` /
  the modifier, fades 250 ms, and lingers 5 s via asymmetric
  `transition-delay`; a skin may choose click-only reveal or an
  always-visible editor. Hidden chrome stays focusable (ADR-0011).

## Markup — regions, data displays, chrome surfaces (ADR-0011)

```
visualizer
├─ vis-columns                 layout wrapper: flex row, inset 0
│  └─ vis-column               × vcnb (live) — carries --exc, --gain
│     ├─ vis-column__fill      displays --exc
│     ├─ vis-column__lattice   chrome surface
│     └─ vis-column__pip       displays --gain
├─ eq-sliders                  layout wrapper (Slice 17)
│  └─ eq-slider                × N visible — role="slider", --gain, …
│     ├─ eq-slider__track      chrome surface
│     └─ eq-slider__thumb      displays --gain
└─ eq-curve                    the only SVG (Slice 17)
   ├─ eq-curve__glow           polyline — same points, paint is skin CSS
   └─ eq-curve__stroke         polyline — same points, paint is skin CSS
```

Wrappers are layout-only; the component never sets z-index, transform,
opacity, or filter, so every leaf shares one stacking context and
z-order is entirely skin CSS. DOM order carries no z meaning.

## Classic constants (reference: the two painters)

- Field 48 rows × the live band count (20 on the shipped grid), 1 dB
  per row, window **[−12, +36]** — asymmetric, matches the engine, not
  ±12.
- Fill rule: linear height `(--exc + 12) / 48`, quantized down to
  whole rows (`--exc-step`: 1 row, expressed in dB — 1 dB ≡ 1 row on
  this window, and dB-space `round()` is float-exact where a
  percentage-space step can land 11.999… and drop a row). Matches the
  original's brick
  count across the window — its index math
  `(int)(convertValue(dB, 47) + 0.5)` with
  `convertValue = (int)((dB + 12) · h / 48)` gives 0 dB → 12 bricks,
  +36 dB → all 48 — except at the exact floor: an inclusive brick
  index can't express zero, so the original keeps the bottom brick lit
  at −12 dB; DolbyX deliberately renders an empty field (silence looks
  silent).
- Zone colors by absolute row: top 12 red, next 6 yellow, bottom 30
  blue (`ROWS_RED = 12`, `ROWS_YELLOW = 6`).
- Classic z — the painters' own paint order: `background < fills <
  lattice < pips < tracks < thumbs < curve` (bricks then pip per
  column; per-EQ-slider track then thumb; curve last). The lattice chrome
  reproduces the original's 1-px brick insets per column; the pip
  stays continuous (`--gain-step`: the wire's 1/16-dB quantum —
  rounding to the data's own resolution is an exact identity) and
  straddles lattice lines.
- Off-looks: `.app--off` — bricks off + greyed, like the original;
  `.visualizer--off` (resolved `ven` = 0) — fills + pips dark, chrome
  and background stay. The GEQ editor sources resolved state wherever
  `vcbg` can't speak for it — Vis idle or `visualizer--off` (a
  bypassed DSP freezes the vis slots, so frozen frames can't follow
  edits) — and stays live under both.
- Idle descent: Classic registers `--exc`/`--gain` (`@property`,
  `<number>`) and transitions them under `.visualizer--idle` only —
  live tracking stays exact (0 s duration); the descent re-quantizes
  through `round()` per frame, so fills walk down brick-by-brick and
  the pip glides. Duration a Classic constant, HITL-eyeballed; a
  fresh frame cancels the descent through the live rule's 0 s
  duration.
- Editor visibility: hidden base state (`opacity` — must stay
  focusable, ADR-0011), revealed by `.visualizer:hover` /
  `:focus-within` / `.visualizer--eq-drag`; show 250 ms with 0 s
  delay, hide 250 ms after a 5 s `transition-delay` — the original's
  `SHOW_HIDE_ANIMATION_DURATION` / `IDLE_HIDE_DELAY` as pure CSS.
- Curve (two passes over shared points): cyan `#75D2FF`; glow stroke
  10 px, α 0x80, `filter: blur(2.8px)` (the original's
  `BlurMaskFilter` radius 4 — Skia σ = 0.577·r + 0.5, *not*
  `stdDeviation: 4`), round caps; sharp stroke 3 px, α 0xD0 (≈ 82 %),
  round joins (`CornerPathEffect(10)` at these widths), butt caps —
  the glow's round ends swallow them. Flat edge extensions to both
  field edges; vertices at column centers. Thumbs `eq_thumb`; the
  active EQ slider (`eq-slider--active`) `eq_thumb_touch_state` — the
  original's Bright1/2/3 cascade collapses (only distance 0 is
  distinct).
- Element vocabulary, with provenance: **brick** (`mock_gv_brick*`),
  **rows** (`ROWS_*`), **background** (`eq_background`), **pip**
  (`brick_blue_light`), **EQ slider** (`mSliderThumb`/`mSliderBg`),
  **thumb** (`eq_thumb`), **track** (their `eq_bar` — EQ slider chrome),
  **curve** (`mPaintCurve*`); **lattice** is ours — the original
  leaves the gutter lines unnamed, and "grid" is taken by the band
  layouts. _Avoid_ "bar": the original overloads it (brick bitmaps,
  column width, EQ track).
