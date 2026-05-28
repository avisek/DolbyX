# 03 — Binary Protocol with `libdseffect.so`

The engine's only public surface is the standard Android `AudioEffect`
HAL: a `process()` for audio and a `command()` for control. Every
control operation is a single `command()` call with `cmdCode ==
EFFECT_CMD_SET_PARAM` (5) or `EFFECT_CMD_GET_PARAM` (8).

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
the call is a GET (cmdCode 8), and into a small reply integer for SETs
(cmdCode 5).

## The engine's command dispatch surface

Naming the commands is `DsEffect.java`; their _actual_ dispatch
behaviour is what the engine binary does, which the
[ddp_probe harness](../../tools/ddp_probe/README.md) verifies. Group
them by what the engine actually accepts on each side:

| Code | Constant                       | SET?       | GET?   | Role                                                                                                                                                           |
| ---- | ------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `DS_PARAM_TUNING`              | (stub)     | (stub) | Reserved; Java has no caller and the engine has no dispatch                                                                                                    |
| 1    | `DS_PARAM_DEFINE_SETTINGS`     | yes (init) | —      | Cache layout + pre-population at init                                                                                                                          |
| 2    | `DS_PARAM_ALL_VALUES`          | yes        | —      | Bulk push of cache values (profile switching)                                                                                                                  |
| 3    | `DS_PARAM_SINGLE_DEVICE_VALUE` | **yes**    | **NO** | Point write into the cache. The engine's `Effect_getParameter` dispatcher does NOT route cmd 3 — every cmd 3 GET hits the catch-all and returns `-EINVAL(-22)` |
| 4    | `DS_PARAM_VISUALIZER_DATA`     | —          | yes    | Returns `vcbg ‖ vcbe` (= 40 int16s) — the only way to read DSP state                                                                                           |
| 5    | `DS_PARAM_DEFINE_PARAMS`       | yes (init) | —      | Names the 4-CC namespace; assigns DEFINE_PARAMS indices                                                                                                        |
| 6    | `DS_PARAM_VERSION`             | —          | yes    | Returns the 4-int16 engine version                                                                                                                             |
| 7    | `DS_PARAM_VISUALIZER_ENABLE`   | yes        | yes    | Visualizer-tap on/off                                                                                                                                          |

The bold "**NO**" in row 3 is the single biggest surprise to anyone
working from the AOSP convention (where SET and GET commands are
typically symmetric). At the libdseffect.so level **cmd 3 is
SET-only**. The host has to remember everything it has written — there
is no readback path through the standard parameter command. The two
GET paths the engine offers are cmd 4 (visualizer state) and cmd 6
(version).

(The engine also accepts cmd 7 GET — directly verified in
[tools/ddp_probe/](../../tools/ddp_probe/README.md) section 1
where a cmd 7 SET of `1` followed by a cmd 7 GET returns
`status=0, value=1`. It just round-trips the boolean the host
already wrote.)

### Sections in this document

The commands are described in three groups below: init-time
(commands 5 & 1, sent once), steady-state SET (commands 2, 3, 7) and
steady-state GET (commands 4, 6, 7). Two new sections at the end —
[Engine validation behavior](#engine-validation-behavior) and
[Settings cache lifecycle](#settings-cache-lifecycle) — capture what
the engine actually does internally, sourced from
[ddp_probe](../../tools/ddp_probe/README.md) engine logs.

## Init-time commands

These are sent once, in order, before any audio flows.

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

Empirically the engine does **not** validate the 4-CC names against
its internal AK registry: a DEFINE_PARAMS blob containing bogus names
like `xxxx` and `yyyy` is accepted with reply `0`. The engine just
logs `DS_PARAM_DEFINE_PARAMS [N]:xxxx` and the bogus index becomes a
no-op when referenced later — `ak_set` against it will log
`Wrong parameter index N` (see
[Engine validation behavior](#engine-validation-behavior)).

> **Implication for DolbyX v1**: the 24-parameter list in
> `arm/ddp_processor.c:g_param_names[]` works because `register_parameters`
> only sends those 24, and so the engine assigns them indices 0..23. But
> this means parameters NOT in that list cannot be referenced by index.
>
> **Recommendation for DolbyX v2**: send DEFINE_PARAMS with all 64
> canonical AK names from [02-ak-parameters.md](02-ak-parameters.md).
> Storage cost is 258 bytes; the gain is symmetry with the metadata
> table and access to the "Experimental" bucket (`endp`, `preg`,
> `pstg`, `mxou`, etc.) that the original UI hides.

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

The total `num_settings` is the sum of `len` over all _settable_
parameters (the result of `DsAkSettings.getNumElementsPerDevice()`).

For the standard 64-param table with the standard band counts
(`genb = ienb = aonb = 20`), this is approximately:

```
sum(len for all settable params) = 1+1+1+1+1+1+1+1+1+20+1+1+1+1+1+1+20+329+1+1+40+1+1+1+1+20+1+20+1+1+1+1+1+40+40+40+1+1+1+1+1+1
                                  = several hundred
```

The exact total depends on `aonb` (which sets `aobf` to length 40 and
`aobg` to length `(aonb+1)*2 = 42`).

> **Implication for DolbyX v1**: `arm/ddp_processor.c:register_parameters`
> always sends `(param_idx, 0)` — one entry per parameter, all at offset
> zero. The cache is therefore 24 slots wide, with each multi-element
> param taking only one slot. SET writes targeting `iebt`, `gebg`, or
> `vcbg` with `count=20` are accepted by the engine, but the values
> 1..19 land in the slots belonging to _the parameters that follow in
> the DEFINE_SETTINGS list_, silently overwriting them. The IEQ-preset
> apply only "works" for the first band; bands 1..19 corrupt
> neighbouring cache slots.
>
> Read-back via cmd 3 GET fails — but **the root cause is that
> cmd 3 GET doesn't exist in the engine at all** (see
> [Cmd 3 GET](#cmd-3-get-unimplemented) below), not slot-allocation.

> **Recommendation for DolbyX v2**: emit one entry per `(param_idx,
offset)` for every offset in every settable param's value array,
> matching the original DDP layout. Better yet, include all 64 params
> in DEFINE_SETTINGS so every AK param has a cache slot — the cost is
> ~2 KB of cache, the gain is access to "Experimental" writes plus the
> [pre-population side effect](#settings-cache-lifecycle).

## Steady-state SET commands

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

### Command 3 SET — `DS_PARAM_SINGLE_DEVICE_VALUE`

The workhorse. Writes a slice of one parameter on one device into the
settings cache. Layout:

```
[i32 device_id]
[i16 begin_setting_index]   ← the flat index from DEFINE_SETTINGS
[i16 count]                  ← number of int16 values that follow
[i16 v_0][i16 v_1]...[i16 v_(count-1)]
```

Total payload size: `4 + 2 + 2 + count*2 = 8 + count*2` bytes.

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

What the engine actually does on receiving a valid SET (engine log,
direct quote from `ddp_probe` run — `dvla=7` against an all-64-param
DEFINE_SETTINGS where `dvla` lands at flat index 322):

```
[EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE device:8 setting_index:322 length:1
[EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE settingsCache[device:0 setting_index:322] updated with value 7
[EffectDs] ak_set(43/dvla, 0) = 7
[EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE returned from ak_set()/ak_set_bulk()
```

(The `43/dvla` part is the **DEFINE_PARAMS** index, which is stable
across DEFINE_SETTINGS layouts. The `setting_index:322` part is the
**DEFINE_SETTINGS** flat index, which depends on which params the
host added to the cache and in what order.)

Two important details:

- **Value is not validated.** Writing 110 into `dvla` (range 0..10)
  succeeds with reply 0 and the engine logs `value 110` verbatim.
  Writing -2180 into `arbl` (range -2080..0) writes `-2180`. No
  clamping. See [Engine validation behavior](#engine-validation-behavior).
- **Every write fires `ak_set`.** The cache and the internal AK
  registry stay in lockstep — even for params Java considers
  read-only (writes to `bver`, `bndl`, `ver`, `vcbg`, `vcbe`, `endp`,
  `preg`, etc. all produce `ak_set(idx/name, offset) = V` log lines).
  See [Settings cache lifecycle](#settings-cache-lifecycle).

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
5. Read the reply (0 = success).

### Command 7 SET — `DS_PARAM_VISUALIZER_ENABLE`

Turns the visualizer tap on or off:

```
[i32 enable]   // 0 = off, 1 = on
```

The original service calls `setVisualizerOn(true)` when the first
client registers for visualizer events, and `setVisualizerOn(false)`
when the last unsubscribes. While off, cmd 4 returns 0-length / the
engine doesn't fill the values (and the suspended-state heuristic
fires after `COUNTER_THRESHOLD` empty reads).

## Steady-state GET commands

The engine's `Effect_getParameter()` dispatcher only routes three
commands: 4, 6, and 7. Everything else falls into the catch-all
and returns `-EINVAL(-22)` with the engine log line
`Effect_getParameter() Invalid command N. Returning -EINVAL(-22)`.

### Command 4 GET — `DS_PARAM_VISUALIZER_DATA`

Returns the concatenation of `vcbg ‖ vcbe`, both as int16 arrays of
length `genb` (= 20). Total output: 40 int16s = 80 bytes.

```
[input: empty payload of size genb × 2 × 2 = 80 bytes]
[output: i16[genb] gains, i16[genb] excitations]
```

The values are in the engine's standard 1/16 dB units. The UI converts
to float dB by dividing by 16. The visible range is `[-12, +36]` dB →
`[-192, +576]` int16.

The engine refills `vcbg`/`vcbe` from the DSP every audio block, so
the values change with the input audio and the active EQ curve. This
is the only path to read DSP state from outside.

### Command 6 GET — `DS_PARAM_VERSION`

```
[output: i16[4] version_components]
```

The 4 int16s are formatted as `"APPv1 version a.b.c.d"`. For the
v8.1 build the bundled `libdseffect.so` reports `2.0.4.0` (the
internal AK build version; distinct from `DS_VERSION_INTERNAL`
`1.8.0.0` in `Ds.java`).

### Command 7 GET — `DS_PARAM_VISUALIZER_ENABLE`

```
[output: i32 enable]   // 0 / 1
```

Just returns whatever boolean the host wrote with cmd 7 SET. There's
no internal logic that flips it.

## Cmd 3 GET — unimplemented

There is no cmd 3 GET. The engine's `Effect_getParameter()`
dispatcher only handles commands 4, 6, and 7; any other command code
hits the catch-all:

```
[EffectDs] Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)
```

This applies to every parameter regardless of whether it has a cache
slot, regardless of whether it's "settable" or "read-only", regardless
of count and offset. The
[ddp_probe harness](../../tools/ddp_probe/README.md) confirms this
with 42/42 cache slots returning -22 in one sweep.

The host therefore has to keep its own mirror of every write. In the
original DDP service that mirror is `DsAkSettings.values_` (Java).
For DolbyX v2 it's the daemon's in-memory state plus the persisted
`config.toml` overlay.

> **Implication for DolbyX v1**: `arm/ddp_processor.c:ds1_get_array`
> issues cmd 3 GET and treats the engine's `-EINVAL` reply as a
> read-failure that it silently swallows — `ds1_get_array` returns
> -1 to its caller, whose caller (`handle_command` for
> `DDP_CMD_GET_VIS`) ignores the return value and ships the
> zero-initialised buffer out. The visualizer bars in DolbyX v1 are
> reading the zero-fill from that buffer, not the engine's `vcbg`
> values. The fix is to use cmd 4 instead.

> **Implication for DolbyX v2**: the daemon's
> `engine.get_visualizer_data(session)` Engine-trait method should
> implement using cmd 4 directly. There is no fallback via cmd 3.

## Command 0 — `DS_PARAM_TUNING`

Not used by the standard service. The `DsEffect` class has a
`setTuningSettings(Map)` stub but it logs only and never actually
issues the command. The engine probably accepts the cmd code (the
dispatcher returns reply 0 for tuning per legacy AK convention) but
there's no observable behavior associated with it. Skip it.

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
4.  [SET command 1: DS_PARAM_DEFINE_SETTINGS]
       Payload: [u16 num_settings][(u8 param_idx, u16 offset) × num_settings]
       num_settings = sum of `len` over the parameters you want
       cache slots for. Each multi-element parameter expands into
       (param_idx, 0), (param_idx, 1), ... entries. The host must
       know the intended values of `genb`, `ienb`, `aonb` ahead of
       this step so the dependent multi-element params (`gebg`,
       `aobg`, `vcbg`, etc.) get the right slot count baked into
       the payload.
5.  [SET command 3 for `genb`, value = 20]
6.  [SET command 3 for `ienb`, value = 20]
7.  [SET command 3 for `aonb`, value = 20]
8.  [SET command 3 for `gebf`, values = the 20-element band freq array]
       (and `iebf`, `aobf`, `arbf` if you intend to set them later)
9.  [SET command 7: DS_PARAM_VISUALIZER_ENABLE = 1]
10. command(EFFECT_CMD_ENABLE, 0, NULL, &replySize, &reply)
```

Steps 5–8 are the **constant-params dance**. The engine doesn't
dynamically resize on these — by the time they arrive,
DEFINE*SETTINGS has already fixed the cache layout from the lens
the host chose. The point of the dance is to propagate the
constants into the engine's AK registry so the DSP reads them at
runtime, and (for safety) to keep them in sync with whatever lens
the host baked into the DEFINE_SETTINGS payload. The engine's
own static `akParams*` table has matching defaults
(`genb=ienb=aonb=20`), which is what the init-time `ak_get`
pre-population uses; a host that follows the same defaults gets
a self-consistent layout even before the dance runs (this is what
[tools/ddp_probe/](../../tools/ddp_probe/README.md) does
empirically, and is why the probe order works).

Sending cmd 3 SETs for these constants **before** DEFINE_SETTINGS
is not possible — cmd 3 addresses cache flat indices that don't
exist yet. The Java host (`DsAkSettings.defineSettings`) tracks
the values in its own state, builds DEFINE_SETTINGS with the
resized lens, then issues the cmd 3 SETs.

After step 4, the engine is "schema ready" — it accepts commands
2 and 3 against the flat settings blob you defined.

After step 10 the engine actually starts processing audio when
`process()` is called.

### A note on DEFINE_SETTINGS scope

The original DDP service restricts DEFINE_SETTINGS to the 42 params
in Java's `DsAkSettings.isParamSettable` whitelist. DolbyX v2's
research-vehicle goal is better served by **including all 64 params**:

- Cache cost is ~2 KB (`667` slots × 2 bytes) — negligible.
- Every param gets cache pre-population from the engine's internal
  AK state at DEFINE_SETTINGS time (see
  [Settings cache lifecycle](#settings-cache-lifecycle)).
- The "Experimental" bucket (`endp`, `mxou`, `preg`, `pstg`, `vol`,
  `ven`, `vcnb`, `vcbf`, `ocf`) becomes addressable via cmd 3 SET.
- The "ReadOnly" buckets get cache slots too, which doesn't hurt
  anything (the DSP either overwrites them every block or doesn't
  read them at runtime).

The empirical evidence that this works is in
[tools/ddp_probe/](../../tools/ddp_probe/README.md) — the harness
runs with all-64 DEFINE_SETTINGS and the engine emits `reply=0` for
every write.

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

The original always sets the constant params _via XML parse_ before
constructing `DsEffect`, so the static `akParams_` table is already
correctly sized when DEFINE_SETTINGS runs. If you replicate this design
in DolbyX, you can keep the XML parse approach; if you go a different
route, just make sure constant params get pushed before DEFINE_SETTINGS
runs.

## Endianness, types, and memory layout

- All multi-byte integers in the protocol are **little-endian**.
- `int16` and `int32` are signed two's complement.
- The 4-CC parameter names are NUL-padded; do not include a trailing
  zero in the count. Comparisons are byte-exact.
- `effect_param_t` requires natural alignment of its `int32` /
  `uint32` fields. The payload following it can be unaligned.
- The reply parameter is just `int32` (set to 0 on success, negative
  on error). The engine writes it back into `*pReplyData` of the
  `command()` call.

## Engine validation behavior

The engine's actual validation surface is much narrower than the AOSP
convention suggests. From direct examination of all error strings in
`libdseffect.so` and live runs of the
[ddp_probe harness](../../tools/ddp_probe/README.md), the engine
checks exactly these things, and nothing else:

### On SET (cmd 1, 2, 3, 5, 7)

| Check                              | Triggers when                                | Engine string                                                                               | Reply                        |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| Command-data validity              | psize ≠ 4 or missing payload                 | `EFFECT_CMD_SET_PARAM Invalid command data`                                                 | `-1`                         |
| Cache index range                  | `begin_setting_index + count > num_settings` | `DS_PARAM_SINGLE_DEVICE_VALUE setting_index N is invalid (number of settings defined is M)` | `-22`                        |
| Value-buffer size                  | size doesn't match the command's encoding    | `DS_PARAM_VISUALIZER_ENABLE Invalid value size N` (and similar)                             | `-22`                        |
| Param-index range (`ak_set` layer) | `param_idx >= num_defined_params`            | `_akSet: Wrong parameter index N`                                                           | (internal; cmd reply varies) |

What the engine does **NOT** check:

- **Value range.** Writing 110 into `dvla` (range 0..10) succeeds with
  reply 0; the engine logs `value 110` verbatim. Writing 9999, -2180,
  or any other int16 likewise succeeds. There are no clamp-related
  strings anywhere in the binary; clamping is exclusively a Java-side
  concern (`DsAkSettings.set` at `Ds.apk/.../DsAkSettings.java:278-326`).
- **4-CC name validity in DEFINE_PARAMS.** A DEFINE_PARAMS blob
  containing `[xxxx, dvla, yyyy]` is accepted with reply 0. The bogus
  4-CCs occupy param-index slots that simply don't resolve to anything
  in the engine's internal AK registry.
- **DEFINE_SETTINGS entry offset.** Sending entries with non-zero
  offsets on a scalar parameter is accepted with reply 0. (The engine
  string `Wrong start offset %i, the start offset must always be 0!`
  fires only in `ak_set_bulk` for specific param classes, not in the
  DEFINE_SETTINGS path.)
- **Settability of the target param.** The engine accepts cmd 3 SET
  against any flat index in the cache, regardless of whether the
  param Java would call settable. Writes to `bver`, `bndl`, `ver`,
  `vcbg`, `vcbe`, `endp`, `preg`, `vol`, `ven`, `vcnb`, `lcsz`, etc.
  all produce `ak_set(idx/name, 0) = V` engine log lines.

### On GET (cmd 4, 6, 7)

| Check                   | Triggers when                           | Reply |
| ----------------------- | --------------------------------------- | ----- |
| Command code recognized | Any cmd code other than 4, 6, 7         | `-22` |
| Value-buffer size       | Buffer too small for the requested data | `-22` |

In particular, cmd 3 GET ALWAYS returns -22 — the engine has no
dispatch for it.

### Error code summary

| Reply           | Source  | Meaning                                                                                                            |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| 0               | success | engine accepted; SET writes propagated to cache and `ak_set`                                                       |
| -1 (`-EPERM`)   | engine  | invalid command data (e.g. psize wrong)                                                                            |
| -22 (`-EINVAL`) | engine  | invalid command code (cmd 3 GET, etc.), bad setting_index, or wrong value-buffer size                              |
| -4              | Java    | `Ds.setDsApParam` host-side rejection (e.g. `iebt`/`gebg` going through the wrong API) — not emitted by the engine |

`DsClient.translateErrorCodeToExceptions` maps Java-side codes to
exceptions. For the daemon, propagate engine `-22` as
`ENGINE_REJECTED` and own all value-range validation up front
because the engine offers no second line of defense.

## Settings cache lifecycle

The "settings cache" is a `short[num_settings]` array per device,
allocated by the engine when it processes DEFINE_SETTINGS. Engine logs
during DEFINE_SETTINGS show three things:

1. **Cache allocation and indexing.** Each `(param_idx, offset)` entry
   in the DEFINE_SETTINGS payload gets a flat index `0..num_settings-1`.
   From a `ddp_probe` run with all 64 params expanded into their full
   value-array lengths:
   ```
   [EffectDs] DS_PARAM_DEFINE_SETTINGS count:667
   [EffectDs] DS_PARAM_DEFINE_SETTINGS Clearing cache...
   [EffectDs] DS_PARAM_DEFINE_SETTINGS [0]:0-bver.0
   [EffectDs] DS_PARAM_DEFINE_SETTINGS [1]:0-bver.1
   ...
   [EffectDs] DS_PARAM_DEFINE_SETTINGS [5]:1-bndl.0
   [EffectDs] DS_PARAM_DEFINE_SETTINGS [9]:4-vdhe.0
   ...
   ```
   The line format is `[flat_idx]:param_idx-name.offset`. The flat
   index is what cmd 3 SET addresses; the `param_idx-name` is the
   DEFINE_PARAMS slot.
2. **Pre-population from the AK registry.** For every entry, the
   engine calls its own `ak_get` to seed the cache slot with the
   engine's internal startup value — one log line per offset.
   Collapsed by param (real log emits e.g. 5 separate lines for
   `bver`):
   ```
   [EffectDs] ak_get(0/bver, 0..4)      ← 5 lines, one per offset
   [EffectDs] ak_get(1/bndl, 0..1)      ← 2 lines
   [EffectDs] ak_get(35/vcbg, 0..19)    ← initial visualizer gains, 20 lines
   [EffectDs] ak_get(36/vcbe, 0..19)    ← 20 lines
   [EffectDs] ak_get(37/ver, 0..3)      ← engine version, 4 lines
   [EffectDs] ak_get(55/endp, 0)        ← 1 line
   ```
   These engine-internal values then live in the cache. The host
   can't read them back (cmd 3 GET is unimplemented), but they're
   there.
3. **Each subsequent cmd 3 SET updates the cache _and_ forwards to
   `ak_set`.** Both log lines fire:
   ```
   [EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE settingsCache[device:0 setting_index:N] updated with value V
   [EffectDs] ak_set(<param_idx>/<name>, 0) = V
   [EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE returned from ak_set()/ak_set_bulk()
   ```
   This means the cache and the AK registry stay synchronized — the
   cache isn't a "stage and apply" buffer; writes propagate
   immediately into the engine's internal DSP-input state.

What the DSP does with that state then depends on the param:

- **Settable params** — DSP reads each block.
- **ReadOnly-Dynamic** (`vcbg`, `vcbe`, `vnnb`, `vnb*`) — DSP
  overwrites the cache+AK slot every block with its own computed
  value. Writes are clobbered.
- **ReadOnly-Static** (`bver`, `bndl`, `ver`) — DSP doesn't read the
  cache for these at runtime; they're internal identity constants.
  Writes succeed at the protocol level but have no observable effect.
- **Experimental** (`endp`, `mxou`, `preg`, etc.) — DSP reads them
  on the same audio block. The probe's section 7 directly demonstrates
  the raw-int16-reading property for the Settable bucket (`dvla`,
  `vmb`); the universal ak_set forwarding in section 5b means the
  same property applies to every Experimental param.

The bucket classification lives in
[02-ak-parameters.md](02-ak-parameters.md#engine-vs-java-settability).

## Practical reminders

- The engine processes in **ACCUMULATE mode**: `process()` adds to the
  output buffer rather than overwriting it. Always `memset(out, 0,
out_bytes)` before calling.
- The default sample rate is 44100 Hz. To run at 48000 Hz you have to
  use the `Ds1ap::New` hot-swap technique that DolbyX already
  implements (see `arm/ddp_processor.c`).
- The audio session ID for global mixing is **0**. This is the
  documented behaviour: session 0 = system output.
- `EffectCreate` returns -EINVAL if you pass anything other than the
  exact `(EFFECT_TYPE_NULL, EFFECT_DS)` UUID pair.
