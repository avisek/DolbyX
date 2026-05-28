# 04 — UI Data Flow

This document traces the path of every UI interaction from the user's
finger down to `libdseffect.so` and back. It also describes the
visualizer pump and the equalizer paint loop — the two hot loops that
have to keep running smoothly without blocking the UI.

Rendered reference for the look-and-feel target is in
[`../ui-reference/`](../ui-reference/) — profile picker, per-profile
detail page (Manual GEQ + Intelligent EQ modes), and a zoomed
visualizer+EQ overlay crop.

## The AIDL contract

The interface descriptor is `android.dolby.IDs`. Defined in
`dolby_jar/IDs.java`. There are 30 transactions; here is the complete
list grouped by purpose:

### Master state

| # | Method | Purpose |
|---|--------|---------|
| 1 | `setDsOn(handle, on)` | Master on/off — calls `AudioEffect.setEnabled` |
| 2 | `getDsOn()` | Read master state |
| 3 | `setNonPersistentMode(on)` | When true, suppresses `saveDsStateAndSettings` calls |

### Profile management

| # | Method | Purpose |
|---|--------|---------|
| 4 | `getProfileCount()` | Always returns 6 |
| 5 | `getProfileNames()` | Returns the 6 display names from `currentProfiles_` |
| 8 | `setSelectedProfile(handle, profile)` | Switches the active profile (issues command 2 internally) |
| 9 | `getSelectedProfile()` | Read current profile index |
| 13 | `setProfileName(handle, profile, name)` | Renames a custom profile |
| 11 | `getProfileSettings(profile, out_DsClientSettings)` | Read the 5-bit digest for one profile |
| 10 | `setProfileSettings(handle, profile, DsClientSettings)` | Diff against the current digest, push changed bits via command 3 |
| 12 | `resetProfile(handle, profile)` | Restores `currentProfiles_[profile]` from `defaultProfiles_[profile]` |
| 19 | `getProfileModified(profile, out_bitmap)` | Returns bit 0 = settings modified, bit 1 = name modified |

### Equalizer (IEQ + GEQ)

| # | Method | Purpose |
|---|--------|---------|
| 17 | `setIeqPreset(handle, profile, preset)` | Switches IEQ preset, reloads stored GEQ for `(profile, preset)`, pushes via command 2 |
| 18 | `getIeqPreset(profile, out_int)` | Read the current preset (0=Off, 1=Open, 2=Rich, 3=Focused) |
| 20 | `setGeq(handle, profile, preset, float[20])` | Stores the gains in `geqBandGains_[preset]`, pushes via command 3 if `selectedProfile_ == profile` |
| 21 | `getGeq(profile, preset, float[20])` | Read stored gains, divided by 16 to dB |
| 6 | `getBandCount(out_int)` | Returns `genb` (= 20) |
| 7 | `getBandFrequencies(out_int[20])` | Returns `gebf` |

### Generic AK access

| # | Method | Purpose |
|---|--------|---------|
| 22 | `setDsApParam(handle, "iea", int[1])` | Set any non-`gebg` settable param. Pushes via command 3. |
| 23 | `getDsApParam("dvla", out_int[1])` | Read any settable param's stored value |
| 24 | `getDsApParamLength("aobg", out_int[1])` | Returns the param's array length |

### Misc

| # | Method | Purpose |
|---|--------|---------|
| 14 | `getDsApVersion(out_String[1])` | Returns the engine version |
| 16 | `getDsVersion(out_String[1])` | Returns the service-side version string |
| 15 | `getMonoSpeaker(out_bool[1])` | Hardware probe for mono-speaker devices |

### Subscription

| # | Method | Purpose |
|---|--------|---------|
| 27 | `registerCallback(IDsServiceCallbacks, handle)` | Subscribe to general events |
| 28 | `unregisterCallback(IDsServiceCallbacks)` | Unsubscribe — also triggers `saveDsStateAndSettings` |
| 25 | `registerDsApParamEvents(handle)` | Subscribe to `onDsApParamChange` for non-basic AK params |
| 26 | `unregisterDsApParamEvents(handle)` | |
| 29 | `registerVisualizerData(handle)` | Start the visualizer pump (if first subscriber) |
| 30 | `unregisterVisualizerData(handle)` | Stop the visualizer pump (if last subscriber) |

## The 8 callback events

`IDsServiceCallbacks` (descriptor `android.dolby.IDsServiceCallbacks`):

| # | Method | When it fires |
|---|--------|---------------|
| 1 | `onDsOn(boolean)` | Master state changed by another client |
| 2 | `onProfileSelected(int)` | Active profile changed by another client |
| 3 | `onProfileSettingsChanged(int profile)` | One of the 5 basic toggles changed for some profile |
| 4 | `onProfileNameChanged(int, String)` | A custom profile got renamed |
| 5 | `onVisualizerUpdated(float[20] gains, float[20] excitations)` | Every 50 ms while subscribed |
| 6 | `onVisualizerSuspended(boolean)` | Audio stream silent for `COUNTER_THRESHOLD` ticks |
| 7 | `onEqSettingsChanged(int profile, int preset)` | IEQ preset switched OR GEQ written by another client |
| 8 | `onDsApParamChange(int profile, String paramName)` | Non-basic AK param changed by another client |

The two callback lists (general + DS-AP-param) exist for a small
optimization: a UI that only cares about visualizer + master on/off
doesn't have to be woken up every time some other UI changes a deep
parameter like `aobg`.

## Originator-handle echo suppression

This is the architectural pattern that keeps multi-client setups
sane. Every `set*` AIDL method takes a `handle` parameter — by
convention the calling client passes `connection_.hashCode()` of its
own `ServiceConnection`. The service stores this in the `Message.arg1`
field when it posts the change-event message to its own `mHandler`, and
when broadcasting the callback, it iterates the registered callback
list and **skips** any cookie that equals the originator handle:

```
case 3:  // PROFILE_SETTINGS_CHANGED_MSG
    int setter_handle = msg.arg1;
    int profile = msg.arg2;
    int N = callbacks_.beginBroadcast();
    for (int i = 0; i < N; i++) {
        Integer cookie = (Integer) callbacks_.getBroadcastCookie(i);
        if (cookie.intValue() != setter_handle) {
            ((IDsServiceCallbacks) callbacks_.getBroadcastItem(i))
                .onProfileSettingsChanged(profile);
        }
    }
    callbacks_.finishBroadcast();
```

(The `registerCallback` AIDL takes both the callback object and the
handle; `RemoteCallbackList.register(callback, cookie)` stores them
together so the broadcast loop can read the cookie back.)

The visualizer broadcast (event 5) is the one exception — it is fired
to all subscribers without exclusion, since visualizer data has no
"originator".

> **Implication for DolbyX**: today the daemon only has one Web UI
> connection, so echo suppression doesn't matter much. But if you ever
> add a second control surface (e.g. a system tray icon, a CLI, a
> macOS menu bar), you should keep the originator-handle pattern in
> mind. The simplest desktop-equivalent is for each WebSocket
> connection to be assigned a serial integer at handshake time, and
> for `ws_broadcast` to take an "exclude" handle. See
> [06-gap-analysis.md](06-gap-analysis.md#issue-no-originator-aware-broadcast).

## End-to-end flow examples

### Example 1 — toggling Volume Leveler

User taps the Volume Leveler ToggleButton in `FragSwitches`. The
sequence:

```
[UI thread]
1. FragSwitches.onClick reads:
       int profile = DsClientCache.INSTANCE.getSelectedProfile(client);
       DsClientSettings settings = DsClientCache.INSTANCE.getProfileSettings(client, profile);
2. settings.setVolumeLevellerOn(!settings.getVolumeLevellerOn());  // mutate digest
3. DsClientCache.INSTANCE.setProfileSettings(client, profile, settings);
       │
       ├─ ds.setProfileSettings(profile, settings)  [AIDL transaction 10]
       │       │
       │       │  [Binder thread, in service]
       │       ▼
       │   DsService.setProfileSettings:
       │     ds_.setProfileSettings(profile, settings) → returns true
       │         │
       │         ▼
       │     DsProfileSettings.updateFromClientSettings(settings) → ArrayList<String> changed
       │         │  (e.g. ["dvle"])
       │         ▼
       │     for each name in changed:
       │       short[] vals = akSettings.get(name);
       │       if (selectedProfile_ == profile)
       │         dsEffect_.setSingleSetting(getAkParamIndex(name), 0, vals, HEADPHONE);
       │             │
       │             ▼
       │         [Command 3 — DS_PARAM_SINGLE_DEVICE_VALUE]
       │             │
       │             ▼
       │         libdseffect.so internal state updated
       │
       ├─ Service posts Message{what=3, arg1=originatorHandle, arg2=profile} to mHandler
       │       │  [Service mHandler thread]
       │       ▼
       │   Broadcast to all callbacks except originator:
       │     onProfileSettingsChanged(profile)
       │
       └─ [Other clients, if any, receive onProfileSettingsChanged]
4. fragSwitches.mSpecificObserver.onProfileSettingsChanged(profile, settings);
       └─ MainActivity refreshes the GraphicVisualizer's reset button visibility, etc.
```

The originator UI does NOT receive `onProfileSettingsChanged` for its
own change, because of the handle exclusion. The originator's
`DsClientCache` was already updated synchronously inside
`setProfileSettings`, so the UI is consistent.

### Example 2 — moving an EQ slider

User drags a band on the visualizer. The sequence:

```
[VisPaint thread - GraphicVisualiser]
1. SurfaceView.onTouchEvent → GraphicEqualizerPainter.onTouchEvent
2. Maps (x, y) → (band, gain in dB), enqueues into mEventQueue
3. Schedules mRecalcPositions (60ms debounce) on DS1Application.HANDLER

[Main thread - DS1Application.HANDLER, every ≥60ms]
4. mRecalcPositions runs:
   - Drains mEventQueue into mUserGainsTemp[24]
   - smoothenCurve():
       * exponential time-decay: alpha = 0.5^(dt/0.3s)
       * spatial convolution with GAIN_SMOOTHER kernel
       * writes mGainsSmooth[20]
   - updateEqUserGainsInEngine():
       int profile = DsClientCache.INSTANCE.getSelectedProfile(client);
       client.setGeq(profile, mEqPreset, mGainsSmooth);
            │
            │  [AIDL transaction 20: setGeq]
            ▼
        DsService.setGeq → ds_.setGeq → DsProfileSettings.setGeq
            (stores in geqBandGains_[preset])
            (issues command 3 with gebg, count=20, the int16 values)
            │
            ▼
        libdseffect.so updated
            │
            ▼
        Service posts Message{what=7, arg1=originatorHandle, arg2=profile<<8 | preset}
            │
            ▼
        Other clients' onEqSettingsChanged fires
```

Two important details:

* The engine is updated at most every 60 ms during a drag. This is
  intentional: faster than that and the engine's command processing
  would saturate.
* The engine is updated with **the smoothed curve**, not the raw
  pointer-position curve. The smoothing is what makes the curve look
  nice between adjacent slider thumbs (otherwise you'd get sharp
  zig-zags). The inverse-smoother matrix `GAIN_SMOOTHER_INV` is used
  in the opposite direction when the IEQ preset changes — given the
  stored `gebg` curve, compute what `mUserGainsTemp` would have to be
  to *produce* that curve, so that subsequent touches behave
  consistently.

### Example 3 — switching IEQ preset

User taps "Rich" in the IEQ preset grid:

```
[UI thread, FragGraphicVisualizer.chooseEqualizerSettinginUI]
1. int profile = DsClientCache.INSTANCE.getSelectedProfile(client);
2. client.setIeqPreset(profile, preset + 1);  // +1 because UI's preset 0 is "Open" but service's preset 0 is "Off"
        │
        │  [AIDL transaction 17]
        ▼
    DsService.setIeqPreset → Ds.setIeqPreset:
        currentProfiles_[profile].setIeqPreset(preset):
            ieon = (preset != 0) ? 1 : 0
            for i in 0..19: akSettings.set("iebt", i, ieqBandTargets_[preset][i])
            for i in 0..19: akSettings.set("gebg", i, geqBandGains_[preset][i])
            currentIeqPreset_ = preset
        dsEffect_.setAllProfileSettings(currentProfiles_[profile])
            │
            ▼
        [Command 2 — DS_PARAM_ALL_VALUES — pushes ALL settings, not just iebt+gebg]
            │
            ▼
        libdseffect.so receives the full new state
3. Service updates its cached settings and posts EQ_SETTINGS_CHANGED_MSG
4. UI's onEqSettingsChanged fires only on OTHER clients
5. GraphicEqualizerPainter.switchPreset is called locally:
       readUserGainsFromEngine():
           - reads back gebg via getGeq(profile, preset)
           - calls calculateTempGainsFromSmoothed (using GAIN_SMOOTHER_INV)
           - sets mGainsSmooth[20] for the EQ curve display
       updateGeqOnInDs():
           - re-pushes setGeq to ensure consistency
       mRecalcPositions.run()
```

The fact that `setIeqPreset` issues **command 2** (full bulk push) and
not command 3 (single param) is deliberate: switching IEQ preset
changes both `iebt` and the 20-element `gebg`, plus possibly `ieon`,
so doing it as a single bulk push is atomic from the engine's
perspective.

## Visualizer rendering

See [`../ui-reference/original-ui-visualizer-eq-overlay.png`](../ui-reference/original-ui-visualizer-eq-overlay.png)
for the rendered output, and
[`../ui-reference/original-ui-music-profile-manual-geq.png`](../ui-reference/original-ui-music-profile-manual-geq.png)
for how it sits in the profile detail page.

The visualizer panel shows two things composited:

1. **Spectrum bars** — 20 bars × 48 vertical "rows", each row 1 dB
   tall. Colour: rows 0..11 = red, 12..17 = yellow, 18..47 = blue. The
   bar fills from the bottom up; height is determined by
   `excitations[c]` mapped through `(dB + 12) * 48 / 48` (a no-op
   really, since `(dB - (-12))` ranges 0..48 dB for the engine's
   `[-12, +36]` output range).

2. **EQ curve overlay** — for each band, a small "blue light brick"
   bitmap is drawn at the Y position corresponding to the current
   `gainsUi[c]` value (also with the `dB + 12` mapping). When the
   user is touching the EQ, an additional set of slider thumb drawables
   is drawn at the same positions.

Both are drawn on the same `Canvas` in the same Runnable
(`GraphicVisualiser.mCanvasPaint`) so they composite naturally.

### The 50ms pump (service side)

```
[visualiser thread, in DsService]
loop:
    int len = ds_.getVisualizerData(gains_, excitations_);
        // command 4, divides incoming int16 by 16, writes to gains_, excitations_
    if (len == 0):
        noVisualizerCounter_++
        if (noVisualizerCounter_ >= COUNTER_THRESHOLD):
            isVisualizerSuspended_ = true
            mHandler.send(VISUALIZER_SUSPENDED_MSG, true)
    else if (isVisualizerSuspended_):
        // similar logic, transition back out of suspended
    else:
        if (!isDsOn_): zero out gains_ and excitations_
        mHandler.send(VISUALIZER_UPDATED_MSG)
    handler.postDelayed(this, 50ms)
```

The suspended state is the engine telling the service "no audio
flowing — your visualizer is going to be empty bars for a while".
The UI greys out the panel and stops repainting in that state.

> **Implication for DolbyX**: the daemon's `vis_pump_thread` does the
> equivalent at 33 ms and broadcasts via WebSocket. There is no
> equivalent suspended-state heuristic. For a fully-correct visualizer,
> add a counter that checks if every band is zero (or sub-threshold)
> for N consecutive polls, and emit a `{"type":"vis_suspended", ...}`
> message. See
> [06-gap-analysis.md](06-gap-analysis.md#issue-no-suspended-state-detection).

### The 30ms paint loop (UI side)

```
[VisPaint thread, in GraphicVisualiser]
runnable mCanvasPaint:
    if (mSurfaceCreated && mFragmentIsActive):
        Canvas c = mHolder.lockCanvas()
        if (c != null):
            mPainter.onDraw(c)        // spectrum bars
            mEqualizer.onDraw(c)      // EQ curve + slider thumbs
        if (mEqualizer.isAnimating()):
            postDelayed(this, 30ms)    // reschedule for animations
        mHolder.unlockCanvasAndPost(c)
```

The runnable is invoked by `repaint()` whenever new visualizer data
arrives, and re-schedules itself for the next 30 ms while any UI
animation is in progress. This produces ~33 fps during animations,
~20 fps during steady-state visualizer updates (50 ms cycle). Both
are below the human flicker threshold.

The paint thread runs at priority −4 (a "background" thread priority)
so it doesn't steal cycles from the audio threads.

## The touch event queue

`GraphicEqualizerPainter.EQTouchQueue` is a small synchronized ring
buffer of touch events:

```
class EQTouchQueue {
    int[] mBands = new int[20];
    float[] mGains = new float[20];
    int mSize;
    void add(int band, float gain);   // synchronized
    int size();                        // synchronized
    int getBandAt(int);                // synchronized
    float getGainAt(int);              // synchronized
    void reset();                      // synchronized
}
```

The `add` method has the special property that consecutive events for
the same band overwrite the previous one — this lets the painter
collapse a fast-moving drag into a single event per band per frame,
even if `MotionEvent` deliveries are coming faster than the 60 ms
recalc tick can drain them.

When the recalc tick runs:

1. Drain the queue into `mUserGainsTemp[band + GAIN_SMOOTH_LENGTH]`
   (so that bands at the edge of the array can convolve into the
   smoother kernel without wrapping).
2. Apply `smoothenCurve()` (time-decay × spatial convolution).
3. Write into `mGainsSmooth[20]` (the "what gets sent to the engine"
   buffer).
4. Push to the engine via `setGeq`.

## What "Custom" mode means in the IEQ grid

The IEQ preset grid has 4 cells: Open, Rich, Focused, Custom. The
first three are real engine presets (preset id 1, 2, 3 in DDP's
indexing where 0 = Off). "Custom" is just the UI-side state of "the
user has been editing the EQ manually" — it's not a separate preset
in the engine. When Custom is selected:

* `ieon` is set to 0 (turning off the IEQ amount-applied-to-target
  behaviour).
* `geon` is set to 1 (turning on the GEQ).
* The currently-displayed GEQ curve is whatever the user last drew.

When the user picks Open / Rich / Focused, the previous Custom curve
for that profile is discarded — the engine reloads the stored
`geqBandGains_[preset]` for the new preset, which may itself have been
customized (e.g. user drew on the curve while Rich was active).

This is why each `(profile, IEQ preset)` pair has its own stored
20-band GEQ curve. The total storage is **6 profiles × 4 presets ×
20 bands** × `int16` = 960 int16s = 1920 bytes per `Ds` instance.
That's the matrix DolbyX needs to mirror.

## Summary cheat-sheet

| User action | UI method | AIDL call | Engine command |
|-------------|-----------|-----------|----------------|
| Toggle master | `FragPower.onClick` | `setDsOn` | `EFFECT_CMD_ENABLE / DISABLE` (graceful crossfade — see below) |
| Pick profile | `FragProfilePresets.onClick` | `setSelectedProfile` | command 2 |
| Toggle a switch (VL/DE/SV) | `FragSwitches.onClick` | `setProfileSettings` (with diff) | command 3 (one or more times) |
| Pick IEQ preset | `EqualizerAdapter.onTouch` | `setIeqPreset` | command 2 |
| Drag EQ band | `GraphicEqualizerPainter.onTouchEvent` | `setGeq` (debounced 60 ms) | command 3 (gebg, 20 values) |
| Pick "Custom" cell | `FragGraphicVisualizer.onClick equalizerCustom` | `setIeqPreset(0)` then `setGeq` after edits | as above |
| Reset profile | `FragProfilePresetEditor.reset` | `resetProfile` | command 2 (with default values) |
| Rename custom profile | `FragProfilePresetEditor.save` | `setProfileName` | (no engine update — just metadata) |

### Master toggle semantics

The "Toggle master" row is more subtle than the others: the engine
performs an internal **graceful crossfade** on both commands —
**ENABLE over 7560 samples (~171 ms at 44.1 kHz)** and **DISABLE over
5512 samples (~125 ms)** — and both commands are **idempotent**
(second invocation in a row logs `Already enabled/disabled, ignoring`
and returns reply 0). Parameter state survives the cycle: the cache
and the AK registry are not touched, so re-enabling resumes
processing with whatever settings the host had pushed before.

See [05-profiles-and-persistence.md → "What 'OFF' means"](05-profiles-and-persistence.md#what-off-means-in-the-original-ddp)
for the full empirical picture, and
[tools/ddp_probe/](../../tools/ddp_probe/README.md) section 6 for
the engine logs that demonstrate this.
