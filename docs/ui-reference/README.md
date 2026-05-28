# Original DDP UI reference

Screenshots from the original Dolby DDPlus Android app. Kept as
visual reference for the look-and-feel target — DolbyX v2's
visualizer/EQ overlay, profile picker, and per-profile detail view
should feel recognisable to someone migrating from the original app.

| File                                           | What it shows                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `original-ui-profile-picker.png`               | Profile picker: master toggle, Dolby header, live visualizer band-graph, six selectable profiles (Movie / Music / Game / Voice / Custom 1 / Custom 2).                                        |
| `original-ui-music-profile-manual-geq.png`     | Music profile detail with visualizer + EQ-curve overlay; toggles for Volume Leveler / Dialogue Enhancer / Surround Virtualizer; `Graphic EQ: Manual` preset selector with four shape buttons. |
| `original-ui-music-profile-intelligent-eq.png` | Same profile detail page but in `Intelligent EQ: Rich` mode.                                                                                                                                  |
| `original-ui-visualizer-eq-overlay.png`        | Zoomed crop of the visualizer + EQ-curve overlay module (the cyan line + circle markers ride on top of the band-graph).                                                                       |

These are captured against the same `DsUI.apk` and `Ds.apk` build the
`decompiled/` sources came from, so the rendered UI matches the Java
state machine documented in [`../ddp/04-ui-data-flow.md`](../ddp/04-ui-data-flow.md).
