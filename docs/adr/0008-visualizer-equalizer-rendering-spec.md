# Visualizer / Equalizer rendering spec

The Visualizer / Equalizer overlay is the most visible piece of DDP and
must feel identical to the original. The feed is event-driven — no pump:
each main-session `Process` reply carries the four ReadOnly-Dynamic
arrays ([ADR-0010](0010-ak-direct-params-cmd-lifecycle.md)), which the
daemon broadcasts as one `vis` event per block. The client draws every
rAF from the latest frame with fast-attack / slow-decay per-band
ballistics and derives idle itself: no event for ~200 ms → freeze, then
fade to the floor over ~500 ms. The SVG layer stack renders a
radial-gradient background, 1-px grid, a 20×48 spectrum brick field
colored `r<12` red / `12≤r<18` yellow / `r≥18` blue, per-column level
pips, and an EQ overlay group (glow polyline + sharp polyline + thumbs).
dB mapping is asymmetric `[-12, +36]` to match the engine. The EQ curve
is a **polyline with rounded joins** — explicitly not a Catmull-Rom
spline — because the original uses `CornerPathEffect(10·scale)` and
linear segments + rounded joins reproduce it at these stroke widths.
The touch pipeline uses the `GAIN_SMOOTHER` kernel (5-cell thick-brush
splat, τ=0.3 s exponential decay toward clamps, convolution, 60 ms
drain throttle), with a 20×20 pseudoinverse matrix applied on
preset-change broadcasts so drags remain continuous. All constants and
matrices transcribe from
`decompiled/DsUI.apk/sources/com/dolby/ds1appUI/GraphicVisualiserPainter.java`
and `GraphicEqualizerPainter.java`.
