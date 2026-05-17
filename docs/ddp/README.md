# DDP Internals — Reference & Migration Guide

This folder is the canonical reference for how the original Dolby Digital Plus
v8.1 Magisk module actually works internally — derived from a full read of the
decompiled `DsUI.apk`, `Ds.apk`, and `dolby_ds.jar` sources, plus the
`libdseffect.so` binary's exposed AudioEffect HAL surface.

The goal of these documents is twofold:

1. **Reference**: explain every layer of the original DDP stack so any future
   contributor (or future-Avisek) can answer concrete questions like "what
   exactly does the engine expect when I toggle Dialog Enhancer?" without
   re-deriving it from the decompiled sources.

2. **Migration plan**: identify every place where the current DolbyX
   implementation diverges from the original, and prescribe the smallest set
   of changes that makes DolbyX a faithful in-binary replica of the DDP UI,
   service, and engine contract — while leaving room for the planned
   Advanced section that exposes every `libdseffect.so` parameter.

For a short, high-level introduction to what the module is and the DSP
pipeline at a conceptual level, see `docs/DDP_Reverse_Engineering_Analysis.md`
in the parent folder. That document predates this folder and is correct as
far as it goes; the documents here go deeper and more prescriptive.

## How to read these in order

If you want the full picture, read them in numeric order. Each one builds on
the previous.

| # | File | What's in it |
|---|------|--------------|
| 1 | [01-architecture.md](01-architecture.md) | The four-layer architecture (UI → DsClient → DsService → DsEffect → libdseffect.so), what each component owns, and the threading model. |
| 2 | [02-ak-parameters.md](02-ak-parameters.md) | Complete reference for all 64 AK parameters: 4-CC names, lengths, bounds, what each one controls, fixed-point dB scaling, settable vs. read-only. |
| 3 | [03-binary-protocol.md](03-binary-protocol.md) | The exact wire format used over `AudioEffect.setParameter / getParameter`. The 8 command codes, the mandatory init handshake, byte-level layouts, the `genb / ienb / aonb / gebf` constant-params dance. |
| 4 | [04-ui-data-flow.md](04-ui-data-flow.md) | The 30-method AIDL contract, the 8 callback events, the visualizer 50 ms pump, the equalizer paint loop and touch model, IEQ preset switching, and the originator-handle echo-suppression pattern. |
| 5 | [05-profiles-and-persistence.md](05-profiles-and-persistence.md) | The 6 × 4 × 20 GEQ matrix, the IEQ preset model, the `ds1-default.xml` / `ds1-current.xml` / `ds1-state.xml` files and exactly when each one is written, and the 5-bit `DsClientSettings` digest. |
| 6 | [06-gap-analysis.md](06-gap-analysis.md) | The actionable migration plan — every divergence between DolbyX today and the original, ranked by impact, with prescribed code changes. |

## Quick navigation by question

* **"How do I make the visualizer bars actually appear?"** → 03 (`vcbg ‖ vcbe` returns 40 shorts, not 20) and 04 (the 50 ms pump).
* **"Why is my IEQ preset switch not loading the right GEQ curve?"** → 05 (each `(profile, ieq_preset)` pair has its own stored 20-band GEQ).
* **"What does the engine actually expect when I toggle the headphone virtualizer?"** → 02 (`vdhe` "on" is value `2`, not `1`).
* **"What's the right initialization sequence for `libdseffect.so`?"** → 03 (the `DEFINE_PARAMS → DEFINE_SETTINGS` handshake, with constant-params first).
* **"What changes does DolbyX need to faithfully match the original?"** → 06.

## Conventions

Throughout this folder:

* **4-CC** means a 4-character ASCII code like `iea ` or `gebg`. Names
  shorter than 4 characters are NUL-padded on the wire.
* **AK** is the Audio Kernel parameter system used internally by
  `libdseffect.so` and exposed by `DsAkSettings.java`.
* Code references to original-DDP files are written as
  `path/Class.java:method`, e.g. `dolby_jar/DsClient.java:registerVisualizer`.
* Code references to DolbyX files use the relative path inside the repo,
  e.g. `arm/ddp_processor.c:register_parameters`.
* "The engine" always means `libdseffect.so`. "The service" always means
  `DsService` (running inside `Ds.apk` on Android, or the `dolbyx` daemon on
  desktop). "The UI" means whichever client is talking to the service —
  `DsUI.apk` on Android, the Web UI on desktop.

## Decompiled sources

The decompiled sources live in `decompiled/` at the repo root:

| Path | Contents |
|------|----------|
| `decompiled/Ds.apk/sources/` | Service-side Java (DsService, DsEffect, DsAkSettings, etc.) |
| `decompiled/Ds.apk/resources/` | AndroidManifest, layouts, drawables |
| `decompiled/DsUI.apk/sources/` | UI-side Java (DsClient, activities, fragments, widgets) |
| `decompiled/DsUI.apk/resources/` | UI layouts, drawables, XML configs |
| `decompiled/dolby_ds.jar/sources/` | Shared library classes (DsAkSettings, DsConstants, etc.) |

## Status

These documents reflect the state of the original DDP module as shipped in
the v8.1-20211005 Magisk module. They are version-pinned to that build and
should be revisited if a different DDP build is ever adopted.
