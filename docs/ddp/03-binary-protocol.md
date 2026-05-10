# 03 — Binary Protocol with `libdseffect.so`

The engine's only public surface is the standard Android `AudioEffect`
HAL: a `process()` for audio and a `command()` for control. Every
control operation is a single `command()` call with `cmdCode ==
EFFECT_CMD_SET_PARAM` (5) or `EFFECT_CMD_GET_PARAM` (6).

This document describes the exact byte layouts. All multi-byte integers
are **little-endian** (the ARM32 native order) and unsigned unless
explicitly typed. The encoding is implemented in
`Ds.apk/android/dolby/ds/DsEffect.java`; this file paraphrases that
class.

## The `effect_param_t` envelope

Every control payload is wrapped in the standard AOSP `effect_param_t`
header:

```
struct effect_param_t {
    int32_t  status;   // ignored on input; set by engine on GET
    uint32_t psize;    // size of the "param" portion that follows
    uint32_t vsize;    // size of the "value" portion that follows
    // immediately followed by [param: psize bytes] then [value: vsize bytes]
};
```

For DDP, **`psize` is always 4** (the param portion is just the
4-byte command code), and **`vsize` is the size of the command's payload**.

So the on-the-wire layout for any DDP command is always:

```
+-----------+-----------+-----------+-----------+-----------+
| status:i32| psize:u32 | vsize:u32 |  cmd:i32  |  payload  |
| (=0 in)   | (=4)      | (=N)      |           |  N bytes  |
+-----------+-----------+-----------+-----------+-----------+
```

Total bytes sent into `command()` = `12 (header) + 4 (cmd) + N (payload)`.

The engine returns its result by writing into the supplied buffer when
the call is a GET (cmdCode 6), and into a small reply integer for SETs
(cmdCode 5).

## The eight DDP command codes

These are the only command codes the engine recognises in its
`setParameter` / `getParameter` dispatch. The names are from
`DsEffect.java`:

| Code | Constant | Direction | Payload meaning |
|------|----------|-----------|-----------------|
| 0 | `DS_PARAM_TUNING` | set | Reserved/unused in this v8.1 build. |
| 1 | `DS_PARAM_DEFINE_SETTINGS` | set | Tells the engine the `(parameter, offset) → flat-array-index` mapping for the per-device settings blob. **Sent once at init.** |
| 2 | `DS_PARAM_ALL_VALUES` | set | Bulk-pushes all settable values for all devices in one blob. Used when switching profiles. |
| 3 | `DS_PARAM_SINGLE_DEVICE_VALUE` | set / get | Writes (or reads) one parameter, on one device, starting at one offset, with a length-counted array of int16 values. The workhorse of all live UI updates. |
| 4 | `DS_PARAM_VISUALIZER_DATA` | get | Reads `vcbg ‖ vcbe` (= `genb + genb` int16s) — the live visualizer state. |
| 5 | `DS_PARAM_DEFINE_PARAMS` | set | Tells the engine the list of all 4-CC parameter names. **Sent once at init, before command 1.** |
| 6 | `DS_PARAM_VERSION` | get | Returns the engine version (4 int16s). |
| 7 | `DS_PARAM_VISUALIZER_ENABLE` | set / get | Turns the visualizer tap on (`1`) or off (`0`). |

### Command 0 — `DS_PARAM_TUNING`

Not used by the standard service. The `DsEffect` class has a
`setTuningSettings(Map)` stub but it logs only and never actually issues
the command. Skip it.

### Command 5 — `DS_PARAM_DEFINE_PARAMS`

Sends the list of all 4-CC parameter names so the engine knows which
ones to recognize. Layout:

```
[u16 num_params][4-CC #0][4-CC #1]...[4-CC #(num_params-1)]
```

For the standard 64-parameter table (see
[02-ak-parameters.md](02-ak-parameters.md)) this is `2 + 64 × 4 = 258`
bytes. The order of 4-CCs in this blob defines the parameter index used
in commands 1, 2, and 3 — the engine identifies parameters by their
**position** in this list, not by their 4-CC at the per-call level.

> **Implication for DolbyX**: the 24-parameter list in
> `arm/ddp_processor.c:g_param_names[]` works because `register_parameters`
> only sends those 24, and so the engine assigns them indices 0..23. But
> this means parameters NOT in that list cannot be referenced by index.
> If you want to add `dvli`, `dvlo`, `dvmc`, `dssa`, `arbi`, etc., you
> have to grow the list — and crucially, you must keep the existing
> indices stable so saved state still works. See
> [06-gap-analysis.md](06-gap-analysis.md) for the migration strategy.

### Command 1 — `DS_PARAM_DEFINE_SETTINGS`

Sends the `(parameter, offset)` → flat-index mapping for the per-device
settings blob used by commands 2 and 3. Layout:

```
[u16 num_settings][u8 param_idx_0][u16 offset_0]
                  [u8 param_idx_1][u16 offset_1]
                  ...
```

Each entry is 3 bytes. The engine builds a flat `short[num_settings]`
array per device internally; entry `k` of that array corresponds to
"the value of parameter `param_idx_k` at offset `offset_k`".

For multi-element parameters (e.g. `gebg` with `len = 20`), the
DEFINE_SETTINGS payload contains 20 separate entries:
`(gebg_idx, 0), (gebg_idx, 1), ..., (gebg_idx, 19)`. They get assigned
20 consecutive flat indices.

The total `num_settings` is the sum of `len` over all *settable*
parameters (the result of `DsAkSettings.getNumElementsPerDevice()`).

For the standard 64-param table with the standard band counts
(`genb = ienb = aonb = 20`), this is approximately:

```
sum(len for all settable params) = 1+1+1+1+1+1+1+1+1+20+1+1+1+1+1+1+20+329+1+1+40+1+1+1+1+20+1+20+1+1+1+1+1+40+40+40+1+1+1+1+1+1
                                  = several hundred
```

The exact total depends on `aonb` (which sets `aobf` to length 40 and
`aobg` to length `(aonb+1)*2 = 42`).

> **Implication for DolbyX**: `arm/ddp_processor.c:register_parameters`
> always sends `(param_idx, 0)` — one entry per parameter, all at offset
> zero. This means each of those 24 parameters gets ONE flat index slot
> regardless of its real length. For scalars (most of them) this is
> fine. For `iebt`, `gebg`, `vcbg` — which are 20 elements each — this
> is wrong: the engine only allocates 1 slot, so writes past offset 0
> are silently ignored. The reason `apply_ieq_preset` "works" anyway is
> that `ds1_set_array` includes the count in the payload and the engine
> appears to honour it — but for read-back via command 3 GET this
> silently fails. See
> [06-gap-analysis.md](06-gap-analysis.md#issue-define_settings-uses-offset-0-only).

### Command 2 — `DS_PARAM_ALL_VALUES`

Bulk-pushes the entire flat settings blob for every device. Used by
`Ds.setSelectedProfile` and `Ds.setIeqPreset` to hand the engine a new
profile state in one shot. Layout:

```
[u16 num_devices]
[device #0]:
  [i32 device_id (AudioDevice.toInt())]
  [i16 value_0][i16 value_1]...[i16 value_(num_settings-1)]
[device #1]:
  ...
```

In practice `num_devices = 1` for DDP and `device_id = 8` (= `DEVICE_WIRED_HEADPHONE`).
The original module's `DsEndpoint.GENERIC` is hard-mapped to
`AudioDevice.DEVICE_WIRED_HEADPHONE`.

> **Implication for DolbyX**: this command is the cleanest way to do
> profile switches without flickering parameters. DolbyX currently
> simulates this by issuing N `setSingleSetting` calls in a loop in
> `apply_profile`, which is functionally equivalent but slower. If
> you want to mirror the original behaviour exactly, implementing
> command 2 saves N − 1 round-trips per profile change. Mostly a
> performance / latency-hygiene matter; not strictly required.

### Command 3 — `DS_PARAM_SINGLE_DEVICE_VALUE`

The workhorse. Sets (or reads) a slice of one parameter on one device.
SET layout:

```
[i32 device_id]
[i16 begin_setting_index]   ← the flat index from DEFINE_SETTINGS
[i16 count]                  ← number of int16 values that follow
[i16 v_0][i16 v_1]...[i16 v_(count-1)]
```

Total payload size: `4 + 2 + 2 + count*2 = 8 + count*2` bytes.

GET layout (the engine fills in the values in the same buffer):

```
[i32 device_id]              ← input: which device
[i16 begin_setting_index]    ← input: where to start
[i16 count]                  ← input: how many to read
[i16 v_0]...                 ← output: filled by engine
```

The `begin_setting_index` is **not** a parameter index — it is the flat
index from the DEFINE_SETTINGS map for `(parameter, offset)`. So to set
"the 3rd band of `gebg`", you call
`getAkSettingIndex(gebg_idx, 2)` to get the flat index, then send
`begin_setting_index = that, count = 1, v_0 = the value`.

When setting all 20 bands at once you set `begin_setting_index` to the
flat index of `(gebg_idx, 0)` and `count = 20`.

The original UI builds these requests via
`Ds.setSingleSetting(parameter, offset, values, device)` in
`DsEffect.java`, which does the index lookup for you.

#### Example: setting `dvle` (Volume Leveler enable) to 1

1. Look up the flat index: `getAkSettingIndex(dvle_idx, 0) = K`. The
   exact `K` depends on the order — for a freshly-built engine with
   the standard 64-param table, `dvle` is the 5th settable scalar
   (after `vdhe`, `vspe`, `dssf`, `dvli`, `dvlo`), so `K = 5` or so —
   the only way to know is to actually count.
2. Build the payload: `[8 (LE), K (LE u16), 1 (LE u16), 1 (LE u16)]`
   = 10 bytes.
3. Wrap it: `[status=0, psize=4, vsize=10, cmd=3, payload]`.
4. Call `command(EFFECT_CMD_SET_PARAM, total_size, buf, &reply_size, &reply)`.
5. Read the reply (typically 0 = success).

### Command 4 — `DS_PARAM_VISUALIZER_DATA`

Reads the visualizer state. The engine returns the concatenation of
`vcbg ‖ vcbe`, both as int16 arrays of length `genb` (= 20). Total
output: 40 int16s = 80 bytes.

GET layout:

```
[input: empty payload of size genb × 2 × 2 = 80 bytes]
[output: i16[genb] gains, i16[genb] excitations]
```

The values are in the engine's standard 1/16 dB units. The UI converts
to float dB by dividing by 16. The visible range is `[-12, +36]` dB →
`[-192, +576]` int16.

#### Why this command exists alongside `getDsApParam("vcbg")`

`vcbg` and `vcbe` are non-settable AK parameters, so they CAN be read
via command 3 GET (which DolbyX does in `ds1_get_array(VCBG_INDEX, …)`).
Command 4 is faster: it reads both arrays in one call and avoids the
flat-index lookup. The original service uses command 4 exclusively for
the live polling loop; command 3 GET is only used for diagnostic reads.

Both work. Command 4 is the recommended path.

### Command 6 — `DS_PARAM_VERSION`

Reads the engine version. GET layout:

```
[output: i16[4] version_components]
```

The 4 int16s are formatted as `"APPv1 version a.b.c.d"`. For the
v8.1 build this returns approximately `1.8.0.0` (matches the
`DS_VERSION_INTERNAL` string in `Ds.java`).

### Command 7 — `DS_PARAM_VISUALIZER_ENABLE`

Turns the visualizer tap on or off. SET layout:

```
[i32 enable]   // 0 = off, 1 = on
```

GET layout:

```
[i32 enable]   // returned by engine
```

The original service calls `setVisualizerOn(true)` when the first client
registers for visualizer events, and `setVisualizerOn(false)` when the
last unsubscribes. While off, command 4 returns 0-length / the engine
doesn't fill the values (and the suspended-state heuristic fires after
`COUNTER_THRESHOLD` empty reads).

> **Implication for DolbyX**: the daemon's `vis_pump_thread` polls
> command `0xFFFFFFF2` (which the processor maps to a command 3 GET on
> `vcbg`) every 33 ms. Without command 7 ENABLE, the engine may
> internally keep the visualizer tap dormant and return zeros forever.
> The processor in DolbyX does send `vcnb = 20` and assumes the
> visualizer auto-engages — this might or might not work depending on
> engine internals. **Adding an explicit command 7 SET-on at startup
> is the safest fix.** See
> [06-gap-analysis.md](06-gap-analysis.md#issue-visualizer-not-explicitly-enabled).

## The mandatory init handshake

To bring the engine into a usable state, the host must perform this
sequence:

```
1.  EffectCreate(EFFECT_TYPE_NULL, EFFECT_DS_UUID, sessionId=0, ioId=0, &handle)
2.  command(EFFECT_CMD_INIT, 0, NULL, &replySize, &reply)
3.  [SET command 5: DS_PARAM_DEFINE_PARAMS]
       Payload: [u16 N][4-CC × N]  where N is the total number of
       parameters in your dictionary. Order defines the parameter
       indices used in subsequent commands.
4.  [SET command 3 for `genb`, value = 20]
5.  [SET command 3 for `ienb`, value = 20]
6.  [SET command 3 for `aonb`, value = 20]
7.  [SET command 3 for `gebf`, values = the 20-element band freq array]
       (and `iebf`, `aobf`, `arbf` if you intend to set them later)
       — these MUST be sent before DEFINE_SETTINGS so the engine
       knows the per-band array sizes.
8.  [SET command 1: DS_PARAM_DEFINE_SETTINGS]
       Payload: [u16 num_settings][(u8 param_idx, u16 offset) × num_settings]
       Where num_settings is the sum of `len` over all settable
       parameters, and the entries are sorted by the order in your
       parameter dictionary, with each multi-element parameter
       expanded into its component (param_idx, 0), (param_idx, 1), ...
9.  [SET command 7: DS_PARAM_VISUALIZER_ENABLE = 1]
10. command(EFFECT_CMD_ENABLE, 0, NULL, &replySize, &reply)
```

Steps 4–7 are the **constant-params dance**. The engine treats `genb`,
`ienb`, `aonb`, and `gebf` as schema-defining: their values fix the
length of dependent multi-element parameters. If you DEFINE_SETTINGS
before fixing these, the engine will allocate slots based on the
default lengths in the static `akParams_` table (which are 20 by
default but might not match what you want). For safety, always send
them first.

After step 8, the engine is "schema ready" — it will accept commands
2 and 3 against the flat settings blob you defined.

After step 10 the engine actually starts processing audio when
`process()` is called.

### What the original service does

Look at `DsEffect.java`:

```
public DsEffect(int audioSessionId) {
    // ... reflection setup ...
    this.audioEffect = (AudioEffect) ctorAudioEffect.newInstance(
        EFFECT_TYPE_NULL, EFFECT_DS, 0, audioSessionId);
    // step 2: INIT is implicit in AudioEffect ctor
    _setDefineParams();    // step 3
    _setDefineSettings();  // step 8
    // (steps 4-7 happened earlier, when DsConfigParser parsed the XML
    //  and called DsAkSettings.setConstantAkParam for genb/ienb/aonb/gebf
    //  before the first DsEffect was ever constructed — the constant
    //  param values are baked into the static akParams_ table by then)
    // (step 9 is done lazily, only when first visualizer subscriber arrives)
    // (step 10 is the AudioEffect.setEnabled(true) called by Ds.setInitStatus)
}
```

The original always sets the constant params *via XML parse* before
constructing `DsEffect`, so the static `akParams_` table is already
correctly sized when DEFINE_SETTINGS runs. If you replicate this design
in DolbyX, you can keep the XML parse approach; if you go a different
route, just make sure constant params get pushed before DEFINE_SETTINGS
runs.

## Endianness, types, and memory layout

* All multi-byte integers in the protocol are **little-endian**.
* `int16` and `int32` are signed two's complement.
* The 4-CC parameter names are NUL-padded; do not include a trailing
  zero in the count. Comparisons are byte-exact.
* `effect_param_t` requires natural alignment of its `int32` /
  `uint32` fields. The payload following it can be unaligned.
* The reply parameter is just `int32` (set to 0 on success, negative
  on error). The engine writes it back into `*pReplyData` of the
  `command()` call.

## Error codes

The engine returns negative values for various failures. The most
common:

| Reply | Meaning |
|-------|---------|
| 0 | success |
| -1 | invalid argument (bad sizes, unknown param, out-of-range offset) |
| -2 | not running / dead |
| -3 | invalid state (e.g. param set before init) |
| -4 | operation not permitted (e.g. trying to set `gebg` via setDsApParam) |
| -5 | unknown / wrapping internal error |

`DsClient.translateErrorCodeToExceptions` maps these to standard Java
exceptions. For the daemon, you can either propagate as JSON error
codes or just ignore them and rely on UI state reconciliation via the
periodic `get_state` round-trip.

## Practical reminders

* The engine processes in **ACCUMULATE mode**: `process()` adds to the
  output buffer rather than overwriting it. Always `memset(out, 0,
  out_bytes)` before calling.
* The default sample rate is 44100 Hz. To run at 48000 Hz you have to
  use the `Ds1ap::New` hot-swap technique that DolbyX already
  implements (see `arm/ddp_processor.c`).
* The audio session ID for global mixing is **0**. This is the
  documented behaviour: session 0 = system output.
* `EffectCreate` returns -EINVAL if you pass anything other than the
  exact `(EFFECT_TYPE_NULL, EFFECT_DS)` UUID pair.
