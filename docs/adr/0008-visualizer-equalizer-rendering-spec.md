# Visualizer / Equalizer rendering: transcribe the original

The Visualizer/Equalizer overlay is DDP's most visible piece and must
feel identical to the original, so every rendering constant, kernel, and
matrix **transcribes** from the decompiled Java painters
(`decompiled/DsUI.apk/sources/com/dolby/ds1appUI/GraphicVisualiserPainter.java`,
`GraphicEqualizerPainter.java`) — never re-derived or approximated.

Two deliberate choices a reader might otherwise "fix":

- **The feed is a pure event stream** — one `vis` event per main-session
  process block (the frame rides the `Process` reply,
  [ADR-0010](0010-ak-direct-params-cmd-lifecycle.md)); no daemon pump,
  no suspend protocol. The client renders at rAF from the latest frame
  and derives idle itself (no events → freeze, then fade).
- **The EQ curve is a polyline with rounded joins — not a spline.** The
  original draws linear segments through `CornerPathEffect(10·scale)`;
  at these stroke widths a rounded-join polyline reproduces it exactly,
  a Catmull-Rom spline does not.
