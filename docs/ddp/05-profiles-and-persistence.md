# 05 — Profiles and Persistence

This document describes the data model behind the user-visible state:
profiles, IEQ presets, GEQ curves, and how all of this is persisted to
disk.

## The 6-profile model

There are exactly 6 profiles, indexed 0..5:

| Index | XML id  | Display name | Category   |
| ----- | ------- | ------------ | ---------- |
| 0     | `movie` | Movie        | MOVIE      |
| 1     | `music` | Music        | MUSIC      |
| 2     | `game`  | Game         | GAME       |
| 3     | `voice` | Voice        | VOICE      |
| 4     | `user1` | Custom 1     | CUSTOMIZED |
| 5     | `user2` | Custom 2     | CUSTOMIZED |

Plus a logical 7th, `off`, which exists in `ds1-default.xml` but **is
not in the user-facing profile list**. It is reserved for the future
"use OFF profile when DS is off" behaviour, but the v8.1 build sets
`useOffProfileForDsOff = false` in `Ds.java`, so the off profile is
never actually loaded. The DS-off path uses `AudioEffect.setEnabled(false)`
which bypasses the effect entirely.

## The 4-preset IEQ model

Each profile has 4 IEQ-preset slots, indexed 0..3:

| Index | Engine `ieon`                | UI label                                      |
| ----- | ---------------------------- | --------------------------------------------- |
| 0     | `ieon=0`                     | "Off" — IEQ disabled, GEQ may still be active |
| 1     | `ieon=1`, `iebt=ieq_open`    | "Open" — airy, bright                         |
| 2     | `ieon=1`, `iebt=ieq_rich`    | "Rich" — warm, full (default staged curve)    |
| 3     | `ieon=1`, `iebt=ieq_focused` | "Focused" — vocal-forward                     |

Out of the box IEQ is **Off**: every shipped profile has `ieon = 0`, and
`DsProfileSettings` derives the preset index from `ieon` (`0` → Off,
overriding the parsed preset). A profile's `include preset` (Rich for
most, Open for Game) only pre-stages `iebt` — the curve you land on when
first enabling IEQ.

The UI's "Custom" 4th cell (in mobile layout) is **not** an IEQ preset —
it is a UI-layer convention meaning "use preset 0 (Off) and let the user
manually shape the GEQ". See
[04-ui-data-flow.md](04-ui-data-flow.md#what-custom-mode-means-in-the-ieq-grid).

## The 6 × 4 × 20 GEQ matrix

This is the single most counter-intuitive part of the data model. Each
`(profile, preset)` pair has its **own** 20-band GEQ curve.

```
geqBandGains_[6 profiles][4 presets][20 bands]   // int16 (1/16 dB)
```

Storage: 6 × 4 × 20 × 2 bytes = **960 bytes per Ds instance**.

Why? Because users routinely customize EQ on a per-IEQ-preset basis.
Picking "Rich" and adding a +2 dB shelf in the high end should remember
that customization. Switching to "Open" should give you the un-modified
"Open" baseline (or whatever you customized when "Open" was selected
last). Switching back to "Rich" should restore your +2 dB shelf.

The original UI implements this via:

```
// in DsProfileSettings.setIeqPreset(int preset)
int gebgLen = DsAkSettings.getGeqBandCount();  // = 20
for (int i = 0; i < gebgLen; i++) {
    geqBandGains_[preset][i] = akSettings.set("gebg", i, geqBandGains_[preset][i]);
}
```

So when switching IEQ preset, the engine's live `gebg` is overwritten
with the stored preset's gains. When the user drags a band, `setGeq`
writes back into `geqBandGains_[currentIeqPreset]`.

## The 5-bit DsClientSettings digest

Five out of the 64 AK parameters are special: they are exposed to the
UI not via the generic `setDsApParam` API, but via a tiny Parcelable
called `DsClientSettings` that contains exactly 5 booleans:

```
class DsClientSettings implements Parcelable {
    boolean isGeqOn;                 // → AK param geon (0/1)
    boolean isDialogEnhancerOn;      // → AK param deon (0/1)
    boolean isVolumeLevellerOn;      // → AK param dvle (0/1)
    boolean isHeadphoneVirtualizerOn;// → AK param vdhe (0 or 2)
    boolean isSpeakerVirtualizerOn;  // → AK param vspe (0 or 2)
}
```

The set is hardcoded in `DsClientSettings.basicProfileParams`:

```
{ "geon", "deon", "dvle", "vdhe", "vspe", "ieon" }
```

(Note: `ieon` is in the basicProfileParams set, but DsClientSettings
itself does NOT have an isIeqOn bit — `ieon` is handled by the dedicated
`setIeqPreset` API instead. The presence of `ieon` in the basic set is
what causes `setDsApParam("ieon", ...)` to fire `onProfileSettingsChanged`
instead of `onDsApParamChange`. This is a minor implementation detail.)

The translation rules for the 5 booleans:

| `DsClientSettings` field   | AK param | "Off" value | "On" value   |
| -------------------------- | -------- | ----------- | ------------ |
| `isGeqOn`                  | `geon`   | 0           | **1**        |
| `isDialogEnhancerOn`       | `deon`   | 0           | **1**        |
| `isVolumeLevellerOn`       | `dvle`   | 0           | **1**        |
| `isHeadphoneVirtualizerOn` | `vdhe`   | 0           | **2** (auto) |
| `isSpeakerVirtualizerOn`   | `vspe`   | 0           | **2** (auto) |

The use of `2` instead of `1` for the headphone/speaker virtualizers is
critical and easy to miss. Setting `vdhe=1` means "always on regardless
of output device", which on a phone means the headphone HRTF will be
applied even when the user is on the loudspeaker — producing a smeared,
unfocused sound. Setting `vdhe=2` (auto) means "engage when output is
HEADPHONES", which is what users expect from a switch labelled "Surround
Virtualizer" — it just works in the right context.

The `setProfileSettings` codepath does a diff, so flipping just one
switch results in a single `setSingleSetting` call to the engine, not a
full resend.

## The default profiles (factory)

Below is each profile's full settings as parsed from `ds1-default.xml`.
Defaults are shared between profiles unless explicitly overridden.

### Movie

```
deon  = 1     vdhe  = 2     dssb  = 96     plmd  = 4
dea   = 3     vspe  = 0     dssf  = 200    aoon  = 2
ded   = 0     ngon  = 2     dvla  = 7      vmon  = 0
ieon  = 0     dhsb  = 96    dvle  = 0      vmb   = 144
iea   = 10    dhrg  = 0     dvme  = 0      plb   = 0
                                            geon  = 0
include preset = ieq_rich
```

### Music

```
deon  = 1     vdhe  = 2     dssb  = 0      plmd  = 4
dea   = 2     vspe  = 0     dssf  = 200    aoon  = 2
ded   = 0     ngon  = 2     dvla  = 4      vmon  = 0
ieon  = 0     dhsb  = 48    dvle  = 0      vmb   = 144
iea   = 10    dhrg  = 0     dvme  = 0      plb   = 0
                                            geon  = 0
include preset = ieq_rich
```

### Game

```
deon  = 0     vdhe  = 2     dssb  = 0      plmd  = 4
dea   = 7     vspe  = 2     dssf  = 200    aoon  = 2
ded   = 0     ngon  = 2     dvla  = 0      vmon  = 2
ieon  = 0     dhsb  = 0     dvle  = 1      vmb   = 144
iea   = 10    dhrg  = 0     dvme  = 0      plb   = 0
                                            geon  = 0
include preset = ieq_open
```

### Voice

```
deon  = 1     vdhe  = 0     dssb  = 0      plmd  = 4
dea   = 10    vspe  = 0     dssf  = 200    aoon  = 2
ded   = 0     ngon  = 2     dvla  = 0      vmon  = 0
ieon  = 0     dhsb  = 0     dvle  = 0      vmb   = 144
iea   = 10    dhrg  = 0     dvme  = 0      plb   = 0
                                            geon  = 0
include preset = ieq_rich
```

### Custom 1, Custom 2 (identical defaults)

```
deon  = 0     vdhe  = 0     dssb  = 48     plmd  = 4
dea   = 7     vspe  = 0     dssf  = 200    aoon  = 2
ded   = 0     ngon  = 2     dvla  = 5      vmon  = 2
ieon  = 0     dhsb  = 48    dvle  = 0      vmb   = 144
iea   = 10    dhrg  = 0     dvme  = 0      plb   = 0
                                            geon  = 0
include preset = ieq_rich
```

### Off (reserved, not user-facing)

```
all "amount" and "boost" parameters = 0
all enables = 0
plmd = 1   (limiter completely disabled)
include preset = ieq_open
```

## The IEQ preset target curves

These are the three IEQ band-target curves embedded in `ds1-default.xml`:

```
ieq_open    = [117, 133, 188, 176, 141, 149, 175, 185, 185, 200,
                236, 242, 228, 213, 182, 132, 110,  68,  -27, -240]
ieq_rich    = [ 67,  95, 172, 163, 168, 201, 189, 242, 196, 221,
                192, 186, 168, 139, 102,  57,  35,   9,  -55, -235]
ieq_focused = [-419, -112,  75, 116, 113, 160, 165,  80,  61,  79,
                 98, 121,  64,  70,  44, -71, -33, -100, -238, -411]
```

These are int16 values in 1/16 dB. Divide by 16 to get dB. So
`ieq_rich[7] = 242` means the engine is told "the natural target for
band 7 (~947 Hz) is +15.125 dB". The IEQ algorithm doesn't apply the
target rigidly; the `iea` amount parameter (0..16) is a strength
multiplier.

## The GEQ band centre frequencies

From `ds1-default.xml` `<constant>`:

```
gebf = [43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550,
        2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777]
```

These are also the visualizer band centres (`vcbf`) and the IEQ band
centres (`iebf`) by convention — the parser uses `gebf` for all three
in this build.

## Persistence — three XML files

The Android service persists to three files in its private data
directory (`/data/data/com.dolby.ds1/files/` typically):

### 1. `ds1-default.xml` (read-only, factory defaults)

Shipped in the magisk module under `/system/etc/`. Never written. Loaded
once by `DsConfigParser` at service startup. Defines:

- The 3 IEQ presets (`ieq_open`, `ieq_rich`, `ieq_focused`)
- The 7 profiles (6 user-facing + 1 reserved "off")
- The constant params (`genb`, `ienb`, `aonb`, `gebf`, `iebf`, `dvli`,
  `dvlo`, `dvmc`, `aocc`)
- The default tuning for SPEAKER endpoint (`aobf`, `aobg`, `arbf`,
  `arbi`, `arbl`, `arbh`, `arod`, `artp`, `dssa`)
- The `<authorized_technologies>` SKU gate

### 2. `ds1-current.xml` (read-write, user customizations)

Written by `DsStoreUtil.saveDsProfileSettings` whenever a UI client
**unregisters** its callback (typically when the activity exits). NOT
written on every parameter change — that would be too much I/O. The
write is batched at unregistration time.

Format mirrors `ds1-default.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<currentdata>

  <preset id="geq_movie_off">
    <data>gebg=[0, 0, ..., 0]</data>
  </preset>
  <preset id="geq_movie_open">
    <data>gebg=[+2, +5, ..., -1]</data>
  </preset>
  <preset id="geq_movie_rich">
    <data>gebg=[...]</data>
  </preset>
  <preset id="geq_movie_focused">
    <data>gebg=[...]</data>
  </preset>

  <profile id="movie" name="Movie">
    <data>aoon=[2] dea=[3] ... (all settable params) ...</data>
    <include preset="geq_movie_rich"/>
  </profile>

  <!-- ... same for music, game, voice, user1, user2 -->

</currentdata>
```

Key things to notice:

- The GEQ band gains are stored as 4 separate `<preset>` blocks per
  profile, one per IEQ preset, with id `geq_<profile>_<preset_name>`.
  This is the on-disk representation of the `geqBandGains_[6][4][20]`
  matrix.
- The `<include preset="...">` inside each profile records which IEQ
  preset is currently active for that profile.
- Renamed custom profiles store their new name in the `name=` attribute.
- Only **settable** AK parameters are written. Read-only / constant
  ones are not persisted.

### 3. `ds1-state.xml` (read-write, master state)

Written by `DsStoreUtil.saveDsState` whenever `saveDsStateAndSettings`
fires (which is on `unregisterCallback`, identical timing to
`ds1-current.xml`). Format is trivial:

```xml
<?xml version="1.0" encoding="utf-8"?>
<DsState>
  <DsOn>1</DsOn>
  <CurrentProfile>1</CurrentProfile>
</DsState>
```

Just the two values: master on/off and selected profile index. That's
the entire state-restoration scope.

### When persistence runs

```
Ds.saveDsStateAndSettings()
    │
    ├─ DsStoreUtil.saveDsState(isDsOn_, selectedProfile_)
    │     → writes ds1-state.xml
    │
    └─ DsStoreUtil.saveDsProfileSettings(currentProfiles_)
          → writes ds1-current.xml
```

This is called from `DsService.unregisterCallback` (and only from
there). The entire UI state survives across UI-process restarts, but
NOT across device reboots if the service was running and the UI was
killed: the service holds the dirty in-memory state and only flushes
when its last UI client disconnects.

The `setNonPersistentMode(true)` AIDL call (transaction 3) suppresses
the flush — useful for "demo mode" where you want to mess around without
saving.

## Service initialization and state restore

```
DsService.onCreate
    │
    └─ Ds.populateSettings(defaultStream, dataDir)
            │
            ├─ DsStoreUtil.storeDsPath(dataDir + "/ds1-current.xml",
            │                         dataDir + "/ds1-state.xml")
            │
            ├─ DsPresetsConfiguration.xmlConfigParsing(currentInStream, defaultInStream)
            │     │
            │     ├─ DsConfigParser(defaultInStream)   ← parses ds1-default.xml
            │     │     - During parsing, calls DsAkSettings.setConstantAkParam
            │     │       for genb=20, ienb=20, aonb=20, gebf=[…]
            │     │     - This triggers DsAkSettings.defineSettings() (the
            │     │       internal flat-index map)
            │     │
            │     ├─ DsConfigParser(currentInStream)   ← parses ds1-current.xml
            │     │     (this overrides the defaults with persisted user values)
            │
            ├─ DsPresetsConfiguration.createProfileSettings()
            │     - Builds the 6 DsProfileSettings objects with the merged
            │       (default, then overridden) values
            │
new Ds(audioSessionId)
    │
    ├─ defaultProfiles_ = DsPresetsConfiguration.getDefaultSettings()  ← from default XML only
    ├─ currentProfiles_ = DsPresetsConfiguration.getCurrentSettings()  ← merged
    ├─ dsEffect_ = new DsEffect(audioSessionId)
    │     [does the init handshake — see 03-binary-protocol.md]
    │
    └─ setInitStatus(false)
          ├─ DsStoreUtil.loadDsState() reads ds1-state.xml
          ├─ this.isDsOn_ = restoredState[0].equals("1")
          ├─ this.selectedProfile_ = parseInt(restoredState[1])
          ├─ dsEffect_.setEnabled(true) // engine starts processing
          ├─ setSelectedProfile(selectedProfile_)  // pushes the state via command 2
          └─ setDsOn(isDsOn_)  // re-applies the saved on/off (toggles enabled flag)
```

The clean two-phase split (parse-XML → instantiate-DsProfileSettings →
push-to-engine) makes it easy to mock for testing and means the engine
never sees half-loaded state.

## Per-(profile, preset) GEQ in code

When the user is editing the GEQ for, say, the Music profile with the
"Rich" IEQ preset selected, the data path is:

```
[touch event]
  → mEqualizer.mEventQueue.add(band, gain)
  → mRecalcPositions: fills mGainsSmooth[20]
  → DsClient.setGeq(profile=1 (Music), preset=2 (Rich), mGainsSmooth)
       → AIDL → Ds.setGeq(1, 2, gains)
            → DsProfileSettings.setGeq(2, gains):
                  for each band b:
                      values[b] = (short) (16 * gains[b])
                      values[b] = akSettings.set("gebg", b, values[b])
                      geqBandGains_[2][b] = values[b]   // <-- stored here
            → if (selectedProfile_ == 1):
                  dsEffect_.setSingleSetting(gebg_idx, 0, values, HEADPHONE)
                  // command 3 — pushes to engine
            → returns true → service posts EQ_SETTINGS_CHANGED_MSG
```

When the user later switches to "Open":

```
[onClick]
  → DsClient.setIeqPreset(profile=1 (Music), preset=1 (Open))
       → AIDL → Ds.setIeqPreset(1, 1):
            → DsProfileSettings.setIeqPreset(1):
                  akSettings.set("ieon", 0, 1)   // turn IEQ back on
                  for each band b in 0..19:
                      ieqBandTargets_[1][b] = akSettings.set("iebt", b, ieqBandTargets_[1][b])
                  for each band b in 0..19:
                      geqBandGains_[1][b] = akSettings.set("gebg", b, geqBandGains_[1][b])
                                                                          // ^^ the user's
                                                                          //    "Open" GEQ
                                                                          //    is restored
                  currentIeqPreset_ = 1
            → dsEffect_.setAllProfileSettings(currentProfiles_[1])
                  // command 2 — full bulk push
```

So the user's customization is implicitly preserved in
`geqBandGains_[currentIeqPreset]` until the next `setGeq`, and surfaces
again next time that preset is selected.

## What "OFF" means in the original DDP

To make the engine "do nothing":

```
DsClient.setDsOn(false)
    → AIDL → Ds.setDsOn(false)
        → dsEffect_.setEnabled(false)   // calls AudioEffect.setEnabled(false)
```

`Ds.java:24` hard-codes `useOffProfileForDsOff = false`. The path is
strictly: UI button → AIDL → engine `EFFECT_CMD_DISABLE`. No
parameters are touched. `Ds.setDsOn` is at `Ds.java:149-160`.

### What the engine actually does (probe evidence)

The engine doesn't immediately bypass — it crossfades. From the
`libdseffect.so` binary string table plus the live engine log
captured by [tools/ddp_probe/](../../tools/ddp_probe/README.md):

```
[EffectDs] EFFECT_CMD_DISABLE Starting graceful disable over 5512 samples
... (the engine continues to call process(); audio fades to silence) ...
[EffectDs] Effect_process() Graceful disable finished. Returning -ENODATA
... (subsequent process() calls return -ENODATA; the AudioEffect
     framework treats the block as bypass and copies input→output) ...
```

- **5512 samples ≈ 125 ms at 44100 Hz** for DISABLE — measured exactly
  that value across multiple probe runs. The probe runs only at
  44.1 kHz; whether the engine's crossfade is a fixed sample count
  or scales with `process()`'s sample rate is unmeasured.
- During the crossfade the engine runs `process()` normally but
  attenuates the wet signal. The host should keep feeding audio; the
  engine writes a decaying tail into the output buffer.
- Once the fade completes the engine starts returning `-ENODATA`,
  which the AOSP `AudioEffect` framework interprets as "no audio
  produced this block; treat as bypass".

Re-enabling has an **asymmetric** crossfade — ENABLE is longer:

```
[EffectDs] EFFECT_CMD_ENABLE Starting graceful enable over 7560 samples
... (engine ramps back to full processing over ~171 ms @ 44.1 kHz) ...
```

### Idempotency

Both commands are idempotent. A second call to ENABLE/DISABLE while
already in that state logs `Already enabled/disabled, ignoring` and
returns reply 0 without doing work. The host doesn't have to
track the engine's enabled state separately.

### Parameter state survives the cycle

The settings cache and the AK registry are **not touched** by
ENABLE/DISABLE. The probe verifies this directly: `set dvla=7;
DISABLE; ENABLE; set dvla=3` returns reply 0 on both writes, and a
subsequent `process()` produces output consistent with `dvla=3`.

### DolbyX v1 divergence

The DolbyX v1 daemon takes a different (less faithful) approach: it
introduces a `DDP_PROFILE_OFF` that zeros every parameter on
power-off and re-applies the saved profile on power-on. The user
hears a brief discontinuity at each toggle (compressor envelopes,
leveler integrator, etc. are reset) that the original DDP doesn't
have because the engine state is preserved across the
ENABLE/DISABLE cycle.

See [06-gap-analysis.md](06-gap-analysis.md#issue-power-off-handling)
for the v2 fix.

## Resetting a profile to defaults

`DsClient.resetProfile(profile)`:

```
[UI thread]
DsClient.resetProfile(profile)
    → AIDL → Ds.resetProfile (transaction 12)
        → currentProfiles_[profile] = new DsProfileSettings(defaultProfiles_[profile])
                                                            ^^ deep copy
        → if (selectedProfile_ == profile):
              dsEffect_.setAllProfileSettings(currentProfiles_[profile])
              // command 2
        → service posts PROFILE_SETTINGS_CHANGED_MSG
```

The reset goes back to the factory defaults (from `ds1-default.xml`),
not the last persisted state. It also clears the profile's GEQ for all
4 IEQ presets, since `defaultProfiles_[profile].geqBandGains_` is all
zeros.

## A note on the `<tuning>` blocks

`ds1-default.xml` includes a `<tuning>` block per audio device that
sets per-device EQ parameters (`aobf`, `aobg`, `arbf`, etc.) plus
`dssa`. These are loaded at parse time into a separate device-keyed
map, not the per-profile map.

In the v8.1 build the only tuning is `endpoint="SPEAKER"` (= the
loudspeaker tuning), and as the comment in the XML notes:
_"<tuning> with endpoint other than SPEAKER do not use the band gain,
UNLESS aoon is set 1 (from 2) and plmd is set to 2 (not 4)."_

For DolbyX, where the output is always a desktop endpoint that doesn't
match Android's device taxonomy, you can:

- Hard-code `DEVICE_WIRED_HEADPHONE` (matching the original
  `DsEndpoint.GENERIC` mapping), and
- Either ignore the `<tuning>` block (since `aoon` defaults to `2`
  which is "auto, only on speakers"), or
- Load the speaker tuning into a virtual device for users who want to
  experiment with the per-band Audio Optimizer EQ.

The Advanced section can expose `aobg[40]` as 20 paired sliders if you
want to surface this. For the standard "make it sound like the phone"
behaviour, leave the Audio Optimizer at its `aoon=2` (auto) setting and
the speaker tuning will only kick in when the engine thinks the output
is a speaker — which it never will, because of how the
`endp` parameter is set.

## Summary of state per `Ds` instance

| State                          | Storage                                                  | Persisted to                                               | Size                                         |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Master on/off                  | `Ds.isDsOn_`                                             | `ds1-state.xml`                                            | 1 bit                                        |
| Selected profile               | `Ds.selectedProfile_`                                    | `ds1-state.xml`                                            | 1 byte                                       |
| Per-profile AK settings        | `currentProfiles_[6].allSettings_[HEADPHONE].values_[N]` | `ds1-current.xml`                                          | ~ 6 × N × 2 bytes (N depends on band counts) |
| Per-profile name               | `currentProfiles_[6].displayName_`                       | `ds1-current.xml`                                          | ~ 6 × 24 chars                               |
| Per-profile current IEQ preset | `currentProfiles_[6].currentIeqPreset_`                  | `ds1-current.xml` (in `<include preset="...">`)            | 6 × 1 byte                                   |
| Per-profile per-preset GEQ     | `currentProfiles_[6].geqBandGains_[4][20]`               | `ds1-current.xml` (4 `<preset>` blocks per profile)        | 6 × 4 × 20 × 2 = 960 bytes                   |
| Static IEQ band targets        | `DsProfileSettings.ieqBandTargets_[3][20]` (static)      | NOT persisted; read fresh from `ds1-default.xml` each boot | 3 × 20 × 2 = 120 bytes                       |

The 6 × 4 × 20 GEQ matrix is the single biggest chunk of mutable state,
and the most distinctive thing about the data model. The DolbyX project
currently stores 6 × 20 (one GEQ per profile, no per-preset variation),
which loses the user customizations across IEQ-preset switches. Fixing
this is one of the higher-impact items in the
[gap analysis](06-gap-analysis.md#issue-flat-geq-storage).
