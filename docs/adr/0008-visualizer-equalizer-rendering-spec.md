# Visualizer / Equalizer rendering spec

The Visualizer / Equalizer overlay is the most visible piece of DDP and
must feel identical to the original. The pump runs at a fixed 50 ms
cadence (`VISUALIZER_PUMP_INTERVAL`, matches `DsService` in the original
Android app), reads from the oldest session via cmd 4, and emits
`vis` / `vis_suspended` events with 10-tick hysteresis
(`VISUALIZER_SUSPENDED_THRESHOLD`). The SVG layer stack renders a
radial-gradient background, 1-px grid, a 20×48 spectrum brick field
coloured `r<12` red / `12≤r<18` yellow / `r≥18` blue, per-column level
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
