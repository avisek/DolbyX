# 01 — Architecture

The original DDP module is a four-layer stack. Each layer has a clearly
defined responsibility and talks to its neighbours through a single,
narrow interface.

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 4 — UI       DsUI.apk (com.dolby.ds1appUI)                  │
│                    Fragments, custom SurfaceView painters,        │
│                    EqualizerAdapter, DsClientCache                │
│                                                                    │
│ uses  ▼  android.dolby.DsClient (in dolby_ds.jar)                 │
├──────────────────────────────────────────────────────────────────┤
│ Layer 3 — Client   android.dolby.DsClient                          │
│                    Bound-service wrapper, message handler that     │
│                    moves callbacks onto the UI thread, pre-allocated│
│                    visualizer buffers                              │
│                                                                    │
│ AIDL  ▼  android.dolby.IDs (30 methods, descriptor "android.dolby.IDs")│
├──────────────────────────────────────────────────────────────────┤
│ Layer 2 — Service  Ds.apk (com.dolby.DsService)                    │
│                    Binder server, callback registry, visualizer    │
│                    polling thread, per-client originator-handle    │
│                    tracking, persistence (DsStoreUtil)             │
│                                                                    │
│ Java   ▼  android.dolby.ds.Ds  ─►  DsProfileSettings[6]            │
│                                ─►  DsAkSettings (parameter dictionary)│
│                                ─►  DsEffect (binary encoder)       │
│                                                                    │
│ JNI    ▼  android.media.audiofx.AudioEffect.{set,get}Parameter     │
├──────────────────────────────────────────────────────────────────┤
│ Layer 1 — Engine   libdseffect.so   (ARM 32-bit)                   │
│                    UUID 9d4921da-8225-4f29-aefa-39537a04bcaa       │
│                    Implements 28-node QMF DSP graph + AK parameter │
│                    routing + visualizer tap                        │
└──────────────────────────────────────────────────────────────────┘
```

Each section below describes one layer.

## Layer 1 — `libdseffect.so` (the engine)

The ARM32 native library that does the actual DSP. It implements the
standard Android `AudioEffect` HAL surface (`EffectQueryNumberEffects`,
`EffectQueryEffect`, `EffectCreate`, `EffectRelease`,
`EffectGetDescriptor`, plus the per-instance `process` /  `command` /
`get_descriptor` function pointers). One effect type is exposed:

* **Type UUID** `46d279d9-9be7-453d-9d7c-ef937f675587` (the DDP type)
* **Implementation UUID** `9d4921da-8225-4f29-aefa-39537a04bcaa` (this
  particular DDP build)

The engine processes 16-bit signed PCM stereo samples in `process()`
(ACCUMULATE mode — output is added to whatever is already in the output
buffer, so the caller is responsible for zeroing the output buffer first
or for using the buffer for overlap-add).

All control flows through `command()` with `cmdCode == EFFECT_CMD_SET_PARAM`
or `EFFECT_CMD_GET_PARAM`, where the `pCmdData` is a standard
`effect_param_t` followed by a 4-byte command code and the command's
payload. The 8 supported command codes and their byte layouts are in
[03-binary-protocol.md](03-binary-protocol.md).

The engine does **not** know about profiles, IEQ presets, or per-device
tuning at the high level — it is a stateful DSP graph with one current
parameter set. Profile-switching at the UI level just means "re-push all
the parameters that should be different in this profile". The original
service does this in one batch via command 2 (`DS_PARAM_ALL_VALUES`); see
03 for details.

## Layer 2 — `Ds.apk` (the service)

The service is a foreground Android service running in `com.dolby.ds1`.
It is bound to via `bindService(new Intent("android.dolby.IDs"), ...)`.

The service owns:

* A single **`Ds`** instance (`android.dolby.ds.Ds`), which owns:
  * **`DsEffect`** — wraps the live `AudioEffect` instance and implements
    the binary encoder/decoder for the 8 command codes.
  * **`DsProfileSettings[6]`** in `currentProfiles_` — the live state.
    One slot per profile (Movie, Music, Game, Voice, Custom 1, Custom 2).
    Each slot holds a `Map<AudioDevice, DsAkSettings>` — but in practice
    only `DEVICE_WIRED_HEADPHONE` is ever populated, because
    `DsEndpoint.GENERIC` maps to that one device.
  * **`DsProfileSettings[6]`** in `defaultProfiles_` — a frozen copy of
    the factory defaults loaded from `ds1-default.xml`. Used for the
    "is this profile modified?" check.
  * The current `selectedProfile_` (0..5) and `isDsOn_` flags.
* The **`AudioEffect`** instance bound to audio session 0 (the global
  output mix).
* A **callback registry** (`RemoteCallbackList<IDsServiceCallbacks>`)
  with each registered callback tagged by an integer `handle` (the client
  uses `connection_.hashCode()`).
* A **visualizer subscriber list** (`ArrayList<Integer> visualizerList_`)
  that tracks which client handles want visualizer events.
* A **DS-AP-param subscriber list** (`ArrayList<Integer>
  dsApParamEventList_`) for the secondary callback channel that fires
  for non-basic AK parameter changes.
* A **`HandlerThread`** named `"visualiser thread"` that runs the 50 ms
  visualizer poll loop.
* The **persistence layer** (`DsStoreUtil`) that writes
  `ds1-state.xml` and `ds1-current.xml` to the app's private data
  directory.

The service exposes two thread contexts to the rest of the system:

* **Binder thread pool** — handles incoming AIDL calls. Each call is
  guarded by `lockDolbyContext_` and (where relevant) `lockCallbacks_`.
* **Visualizer thread** — polls the engine every 50 ms, posts updates
  to `mHandler` (the binder-thread handler) which then broadcasts to
  subscribed clients.

The service's most important architectural pattern is **originator-handle
echo suppression**: when a client calls a `set` method, it passes its own
`handle`. The service then broadcasts the resulting change event to all
registered callbacks **except** the one whose cookie equals that handle.
Without this, every UI control would echo back its own change and cause
infinite re-renders. This is described in detail in
[04-ui-data-flow.md](04-ui-data-flow.md#originator-handle-echo-suppression).

## Layer 3 — `dolby_ds.jar` / `DsClient` (the client)

The framework jar contains:

* The **AIDL interfaces**: `IDs` (30 transactions, descriptor
  `android.dolby.IDs`), `IDsServiceCallbacks` (8 transactions,
  descriptor `android.dolby.IDsServiceCallbacks`).
* **`DsClient`** — a high-level wrapper that any UI can use. It owns
  the `ServiceConnection`, registers a single callback, marshals
  arguments, translates error codes to exceptions, and (importantly)
  pre-allocates the visualizer `gains_[]` and `excitations_[]` arrays
  so that visualizer events don't allocate per-frame.
* **`DsClientSettings`** — a tiny Parcelable carrying just 5 booleans:
  the on/off state of GEQ, Dialog Enhancer, Volume Leveler, Headphone
  Virtualizer, and Speaker Virtualizer. This is the digest pattern
  described in [05-profiles-and-persistence.md](05-profiles-and-persistence.md#the-5-bit-dsclientsettings-digest).
* **Three event listener interfaces** that the UI implements:
  * `IDsClientEvents` — connect/disconnect/profile/settings/EQ events
  * `IDsVisualizerEvents` — visualizer update + suspend
  * `IDsApParamEvents` — generic AK parameter changes (for non-basic
    parameters that aren't in the 5-bit digest)
* **`DsConstants`** — public constants like `GEQ_BAND_GAIN_RANGE = {-36, +36}`
  (in floating-point dB), `IEQ_PRESETS_NUMBER = 4`, `PROFILES_NUMBER = 6`.
* **`DsCommon`** — message codes, action strings for widget intents,
  the `IEQ_PRESET_NAMES` and `GEQ_NAMES_XML` lookup tables.

The threading rule for `DsClient` is strict: callbacks arrive on the
binder thread, get pushed into a `Handler`, and emerge on the UI thread.
The UI never has to think about threading. The pre-allocated
`gains_[bandCount]` and `excitations_[bandCount]` arrays are filled by
`System.arraycopy` inside the callback so that the binder thread doesn't
hold onto memory the UI thread is about to read.

## Layer 4 — `DsUI.apk` (the UI)

The UI is built around fragments. Each fragment owns one slice of the
control surface and talks to the service via `DsClient` only.

| Fragment | Owns | Talks to |
|----------|------|----------|
| `FragPower` | The big DD logo / power button | `DsClient.setDsOn` |
| `FragProfilePresets` | The 6-button profile picker | `DsClient.setSelectedProfile` |
| `FragProfilePresetEditor` | Custom-profile rename UI | `DsClient.setProfileName` |
| `FragSwitches` | The three master toggles (Volume Leveler, Dialog Enhancer, Surround Virtualizer) | `DsClient.setProfileSettings(profile, DsClientSettings)` |
| `FragGraphicVisualizer` | The visualizer + EQ panel + IEQ preset grid | `DsClient.registerVisualizer`, `setIeqPreset`, `setGeq` |
| `FragEqualizerPresets` | (Mobile layout only) The IEQ preset list | `DsClient.setIeqPreset` |

The `MainActivity` is the top-level glue. It binds the service, holds
the `DsClient`, implements the various `IDsFrag…Observer` interfaces,
and routes events between fragments.

A small but architecturally important class is **`DsClientCache`** — a
singleton in-process cache of profile settings. Without it, every
fragment would round-trip to the service for every "what's the current
state of profile N?" query. The cache invalidates entries when the
service emits `onProfileSettingsChanged(profile)` or
`onProfileSelected(profile)`, and the UI uses `cacheProfileSettings`
(set without round-trip) versus `setProfileSettings` (set + round-trip)
explicitly.

The actual visualizer is split between two custom classes:

* **`GraphicVisualiser`** — a `SurfaceView` running its own
  `HandlerThread "VisPaint"` (priority −4). Holds two pre-allocated
  `float[20]` arrays (`mGainsUi[]`, `mGainsUserSmoothed[]`) which the
  two painters share.
* **`GraphicVisualiserPainter`** — draws the spectrum bars (red /
  yellow / blue) reading from `mExcitations[20]`.
* **`GraphicEqualizerPainter`** — draws the EQ curve overlay and the
  per-band slider thumbs, and handles touch input for editing the
  curve. Maintains its own `mEventQueue` of touch events drained by
  the 60 ms `mRecalcPositions` runnable, applies a smoother kernel
  (`GAIN_SMOOTHER`), then pushes the result via
  `DsClient.setGeq(profile, preset, float[20])`.

Both painters draw on the same `Canvas` in the same `mCanvasPaint`
runnable so that the spectrum bars and the EQ curve composit correctly.

## Threading model summary

| Thread | Owner | What runs on it |
|--------|-------|-----------------|
| UI / main | UI process | Fragment lifecycle, all `View` methods, `DsClientCache` lookups |
| Binder pool | Service process | All AIDL handlers, the callback `RemoteCallbackList` broadcasts |
| `"visualiser thread"` (HandlerThread) | Service process | The 50 ms polling loop calling `Ds.getVisualizerData` |
| `mHandler` of `DsService` | Service process | Posts `Message` objects from the visualizer thread back to the binder pool for callback broadcast |
| `DsClient.handler_` | UI process | Marshals incoming `IDsServiceCallbacks` calls onto the UI thread before invoking the listener |
| `"VisPaint"` (HandlerThread) | UI process | Locks the `SurfaceHolder` canvas, runs `GraphicVisualiserPainter.onDraw` then `GraphicEqualizerPainter.onDraw` |
| `DS1Application.HANDLER` (main looper) | UI process | Hosts the 60 ms `mRecalcPositions` (touch event drain + smoother + push to engine) and the 5 second hide-EQ-overlay action |

The two-process boundary (UI process ↔ service process) is crossed only
via the AIDL binder. Everything else stays within its process.

## Why this matters for DolbyX

DolbyX collapses layers 1, 2, and 3 into a single ARM-side
`ddp_processor.c` plus a daemon and replaces the binder boundary with a
named-pipe / WebSocket boundary. That's a sensible architectural
simplification — but it also drops several pieces of functionality that
the original layers provide. See
[06-gap-analysis.md](06-gap-analysis.md) for the full inventory and
recommended remediation.

The minimum viable structural target for DolbyX is:

```
Web UI (browser)
   ▼  WebSocket JSON  (analog of IDs AIDL)
dolbyx daemon
   ▼  in-process Java-equivalent state objects  (analog of Ds + DsProfileSettings + DsAkSettings)
   ▼  named pipe binary protocol  (analog of EFFECT_CMD_SET_PARAM)
ddp_processor (QEMU)
   ▼  effect_handle_t.command()  (the actual AudioEffect HAL call)
libdseffect.so
```

The layers don't have to be in different processes the way Android puts
them — but the **state ownership and command translation** that each
layer performs needs to be present somewhere, otherwise you lose
features like per-(profile, IEQ-preset) GEQ storage, originator-handle
echo suppression, and the visualizer's full bidirectional shape.
