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
- **No client-side dynamics.** No ballistics, no freeze, no fade, no
  idle concept: the engine's excitation data is already ballistic (the
  original painter raw-copies it to screen), and processed silence
  walks the display to the floor by itself. Client smoothing would
  only falsify the data. From mount every column carries the floor
  (`--exc: -12`, `--gain: 0`) — exactly what streamed silence
  produces, so a plugin connecting changes nothing visually. Stream
  stops: vars hold. Power off: frames keep applying — the off-look is
  skin CSS under the app root's `app--off` modifier, never a data
  gate. `ven = 0` likewise: the component only mirrors the resolved
  param as its `visualizer--off` modifier; frames keep applying (the
  DSP has stopped filling, so they carry frozen values — boot-zeros
  read 0 dB) and the skin's off-look covers the field.
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
│     └─ eq-slider__thumb      displays --gain; drag handle
└─ eq-curve                    the only SVG (Slice 17)
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
  column; per-slider track then thumb; curve last). The lattice chrome
  reproduces the original's 1-px brick insets per column; the pip
  stays continuous (`--gain-step: none`) and straddles lattice lines.
- Off-looks: `.app--off` — bricks off + greyed, like the original;
  `.visualizer--off` (resolved `ven` = 0) — fills + pips dark, chrome
  and background stay. The eq family reads state, not the vis stream,
  so it stays live under `visualizer--off`.
- Element vocabulary, with provenance: **brick** (`mock_gv_brick*`),
  **rows** (`ROWS_*`), **background** (`eq_background`), **pip**
  (`brick_blue_light`), **slider** (`mSliderThumb`/`mSliderBg`),
  **thumb** (`eq_thumb`), **track** (their `eq_bar` — slider chrome),
  **curve** (`mPaintCurve*`); **lattice** is ours — the original
  leaves the gutter lines unnamed, and "grid" is taken by the band
  layouts. _Avoid_ "bar": the original overloads it (brick bitmaps,
  column width, EQ track).
