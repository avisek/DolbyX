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
  only falsify the data. Before the first event: all bricks off.
  Stream stops: hold the last frame. Power off: frames keep applying —
  the off-look is skin CSS reading `data-power`, never a data gate.
- **Columns, not bricks, in the DOM.** 20 column elements carrying
  continuous `--exc`/`--gain` dB vars; quantization is Classic CSS
  `round()`, brick separation is the lattice overlay. Per-brick JS
  rects would bake quantization into markup (ADR-0011).
- **The EQ curve is a polyline with rounded joins — not a spline.** The
  original draws linear segments through `CornerPathEffect(10·scale)`;
  at these stroke widths a rounded-join polyline reproduces it exactly,
  a Catmull-Rom spline does not.

## Classic constants (reference: `GraphicVisualiserPainter.java`)

- Field 20 columns × 48 rows, 1 dB per row, window **[−12, +36]** —
  asymmetric, matches the engine, not ±12.
- Excitation row index: `(int)(convertValue(dB, 47) + 0.5)` where
  `convertValue = (int)((dB + 12) · h / 48)` — double truncation.
  Worked examples: 0 dB → index 11 → bottom **12** bricks lit;
  +36 dB → index 47 → all 48.
- Zone colors by absolute row: top 12 red, next 6 yellow, bottom 30
  blue (`ROWS_RED = 12`, `ROWS_YELLOW = 6`).
- Layer stack, Classic z-order: `bg < fills < lattice < pip <
  eq-overlay`. The original insets bricks 1 px into cells so the black
  gutter pixels are never covered — a lattice *overlay* reproduces
  this over continuous fills. The pip stays continuous
  (`--gain-step: none`) and straddles lattice lines, like the
  original's paint order.
- Element vocabulary, with provenance: **brick** (`mock_gv_brick*`),
  **rows** (`ROWS_*`), **background** (`eq_background`), **pip**
  (`brick_blue_light`), **thumb** (`eq_thumb`), **curve**
  (`mPaintCurve*`), **track** (their `eq_bar`); **lattice** is ours —
  the original leaves the gutter lines unnamed, and "grid" is taken by
  the band layouts. _Avoid_ "bar": the original overloads it (brick
  bitmaps, column width, EQ track).
