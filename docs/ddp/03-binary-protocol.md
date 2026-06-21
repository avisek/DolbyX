# 03 — Binary Protocol with `libdseffect.so`

The engine's only public surface is the standard Android `AudioEffect`
HAL: a `process()` for audio and a `command()` for control. Parameter
traffic is `command()` with `cmdCode == EFFECT_CMD_SET_PARAM` (5) or
`EFFECT_CMD_GET_PARAM` (8); lifecycle uses the other effect command
codes — `EFFECT_CMD_INIT` (0), `EFFECT_CMD_SET_CONFIG`
([1, sample rate / channels](#effect_cmd_set_config-effect-command-1)),
`EFFECT_CMD_ENABLE` / `DISABLE` (3 / 4).

> **Two numbered namespaces.** The *effect command code* (the `cmdCode`
> argument: 0 INIT, 1 SET_CONFIG, 3 ENABLE …) is distinct from the
> *`DS_PARAM_*` selector* (the first int32 of a SET_PARAM payload: 1
> DEFINE_SETTINGS, 2 ALL_VALUES, 3 SINGLE_DEVICE_VALUE …). Section titles
> like "Command 1" below mean the `DS_PARAM_*` selector unless prefixed
> `EFFECT_CMD_`.
>
> **v2 note.** DolbyX v2 drives params through the AK accessors directly
> (no DEFINE_PARAMS / DEFINE_SETTINGS handshake, no cmd 2 / 3), keeping the
> cmd protocol for lifecycle — the AK-direct binding
> ([ADR-0010](../adr/0010-ak-direct-params-cmd-lifecycle.md)). This doc
> stays the reference for the cmd path the engine accepts; [07](07-ak-api.md)
> covers the AK path that supersedes it for params.

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
| 4    | `DS_PARAM_VISUALIZER_DATA`     | —          | yes    | Returns `vcbg ‖ vcbe` (= 40 int16s) — the only *protocol* read of DSP state (in-process `ak_get` reads any registry value)                                      |
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
> **Recommendation for DolbyX v2**: send DEFINE_PARAMS with the 54
> surfaced AK names from [02-ak-parameters.md](02-ak-parameters.md)
> (drops 10 unreadable engine-internal slots: `bver`, `bndl`, `ver`,
> `lcmf`, `lcvd`, `lcpt`, `vnnb`, `vnbf`, `vnbg`, `vnbe`).
> Storage cost is ~220 bytes; the gain is symmetry with the metadata
> table and access to the "Experimental" bucket (`endp`, `preg`,
> `pstg`, `scpe`, etc.) that the original UI hides.

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
> offset)` for every offset in every surfaced param's value array,
> matching the original DDP layout. DolbyX v2 includes all 54 surfaced
> AK params (drops the 10 unreadable slots — see DEFINE_PARAMS
> recommendation above and the "DEFINE_SETTINGS scope" subsection
> below) so every surfaced param has a cache slot — the cost is
> ~0.8 KB of cache, the gain is access to "Experimental" writes plus
> the [pre-population side effect](#settings-cache-lifecycle).

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

- **Stored raw, then clamped.** Writing 210 into `dvla` (range 0..10)
  succeeds with reply 0; the engine logs `value 210` verbatim into the
  cache, but the forwarded `ak_set` **clamps** the registry copy to 10.
  The cache and registry **diverge** on out-of-range writes, and the DSP
  reads the clamped registry. See
  [Engine validation behavior](#engine-validation-behavior).
- **Every write fires `ak_set`.** The cache gets the raw value, the AK
  registry the clamped one — even for params Java considers read-only
  (writes to `bver`, `bndl`, `ver`, `vcbg`, `vcbe`, `endp`, `preg`, etc.
  all produce `ak_set(idx/name, offset) = V` log lines). See
  [Settings cache lifecycle](#settings-cache-lifecycle).

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

The DSP writes `vcbg`/`vcbe` into the **AK registry** every audio block
(not the settings cache), so the values change with the input audio and
the active EQ curve. cmd 4 fetches them from that registry with the
engine's own `ak_get_bulk` (once each for `vcbg`/`vcbe`); it's the only
*protocol* path to DSP state, but in-process `ak_get` reads the same
registry directly — and most other params too. See
[the AK registry read path](#the-ak-registry-read-path).

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

> **Implication for DolbyX v2**: there's no cmd 3 GET, but v2's AK-direct
> binding ([ADR-0010](../adr/0010-ak-direct-params-cmd-lifecycle.md))
> provides a *real* per-param GET via `ak_get` (next section), surfaced as
> the `GetParam` / `GetParams` opcodes. The visualizer leaves `vcbg`/`vcbe`
> are read through that same path (`get_params`), not cmd 4 — so v2 doesn't
> use cmd 4 at all.

## The AK registry read path

The "no GET" limit is a *protocol* limit. `libdseffect.so` exports its
own AK accessors — `ak_get`, `ak_get_bulk`, `ak_get_name`, `ak_get_min`,
`ak_get_max` — and they're reachable from fixed offsets in the effect
context, so the process that hosts the engine (the `ddp_probe` harness
today; the `dolbyx-engine-arm` subprocess in v2) can read most params'
**live registry** value — what the DSP actually uses, not just the cmd-4
visualizer slots. cmd 4 itself reads `vcbg`/`vcbe` from this registry via
`ak_get_bulk` — the disassembled handler calls it once per param; the
per-element `ak_get` lines in the engine log are that bulk call's internal
loop, not separate calls.

```c
void*     handle = *(void**)(*(void**)((char*)H + 0x44));  // pDs1ap, 2 derefs
uint32_t* refs   = *(uint32_t**)((char*)H + 0xb4);         // tagged refs, DEFINE_PARAMS order
int v = ak_get(handle, refs[param_index], elem);           // one value (what the probe uses)
```

The probe reads element-wise via `ak_get` and never calls `ak_get_bulk`
directly — but the cmd-4 handler does (`ak_get_bulk(handle, refs[idx], 0,
bands, 4, dst)`, stride 4 = packed int16), and #9a shows that path matches
the element-wise read 40/40, so the signature is confirmed. A handful of
slots (`mxou`, `lcsz`) have a `0` ref in that array and aren't reachable
this way — they're node params, not root leaves, so the host's root-level
registration resolves them to ref 0 (the Java param-set discrepancy; see
[02](02-ak-parameters.md#javas-list-vs-the-engines-root-leaves)).

What it establishes (see [ddp_probe](../../tools/ddp_probe/README.md) #9):

- **A real GET.** `ak_get` reproduces cmd 4 — both the 20 gains (`vcbg`) and
  the 20 excitations (`vcbe`) match (#9a); any other reachable param reads
  back live (the clamped value the DSP uses — see
  [validation](#engine-validation-behavior)).
- **True ranges.** `ak_get_min`/`ak_get_max` give the engine's own clamp
  bounds. #9c audits a sample and finds `vmb` (`[0..192]`) and `vol`
  (`[-2080..480]`) diverge from the Java table — so treat the table as
  advisory and validate per-param, not just for those two.
- **What moves at runtime.** A registry value-diff across `process()`
  blocks shows only the visualizer slots (`vcbe`/`vnbe`) change value; the
  gains track the EQ curve, not the audio. (A value-diff can't see an
  idempotent same-value rewrite, so this bounds what *changes*, not every
  slot the DSP writes.)

v2 exposes this to the daemon as the `GetParam` opcode over the
[binary protocol](../REARCHITECTURE_PLAN.md) (the AK-direct binding,
[ADR-0010](../adr/0010-ak-direct-params-cmd-lifecycle.md)), giving a true
read-back (verification, defaults, engine-computed state) on top of the
daemon's own state model. Caveat: it only works where `libdseffect.so` is
in-process — the cross-process Android HAL can't reach the engine heap —
and the offsets are pinned to this EOL build.

For the full AK accessor surface (`ak_set`, `ak_enum`, `ak_find`, the
ref/`ak_resolve` tree model, and reading the engine's authoritative param
metadata), see [07 — AK API](07-ak-api.md).

## Command 0 — `DS_PARAM_TUNING`

Not used by the standard service. The `DsEffect` class has a
`setTuningSettings(Map)` stub but it logs only and never actually
issues the command. The engine probably accepts the cmd code (the
dispatcher returns reply 0 for tuning per legacy AK convention) but
there's no observable behavior associated with it. Skip it.

## The mandatory init handshake

> **v2 note.** This is the **cmd-protocol** setup. DolbyX v2's AK-direct
> binding ([ADR-0010](../adr/0010-ak-direct-params-cmd-lifecycle.md)) skips
> DEFINE_PARAMS / DEFINE_SETTINGS entirely — it resolves refs with `ak_find`
> and writes via `ak_set`, needing only the lifecycle commands (INIT,
> optionally SET_CONFIG, ENABLE). The sequence below is what the engine
> accepts and what v1 sends.

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
research-vehicle goal is better served by **including the 54 surfaced
params** (everything from
[02-ak-parameters.md](02-ak-parameters.md) except the 10 unreadable
engine-internal slots — `bver`, `bndl`, `ver`, `lcmf`, `lcvd`,
`lcpt`, `vnnb`, `vnbf`, `vnbg`, `vnbe`):

- Cache cost is ~0.8 KB (`~422` slots × 2 bytes) — negligible.
- Every surfaced param gets cache pre-population from the engine's
  internal AK state at DEFINE_SETTINGS time (see
  [Settings cache lifecycle](#settings-cache-lifecycle)).
- The "Experimental" bucket (`endp`, `preg`, `pstg`, `vol`, `ven`,
  `vcnb`, `vcbf`, `ocf`, `scpe`, `test`) becomes addressable via cmd 3 SET.
- The "ReadOnly" bucket (`vcbg`, `vcbe`) gets cache slots too, which
  doesn't hurt anything (the DSP overwrites them every block; the
  host reads them out-of-band via cmd 4).
- The 10 excluded slots are skipped because they have no host read
  path — the engine version surfaces via cmd 6 → bootstrap
  `engine.version`, and the rest carry no DolbyX-visible state.

The empirical evidence that the all-cache variant works is in
[tools/ddp_probe/](../../tools/ddp_probe/README.md) — the harness
runs with all-64 DEFINE_SETTINGS and the engine emits `reply=0` for
every write; subsetting to 54 is purely a host-side choice.

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

## `EFFECT_CMD_SET_CONFIG` (effect command 1)

Sets the audio I/O config — sample rate, channel count, PCM format. In
Android this is **framework-driven**: AudioFlinger emits it when the effect
attaches to an output thread, so `DsEffect.java` has no caller and
`DsConfigParser.java` has no rate logic. v1 instead changed rate by hand via
the `Ds1ap::New` hot-swap; cmd 1 does the same thing correctly and
**supersedes** it (proven in
[`setconfig_probe`](../../tools/ddp_probe/README.md)).

**Payload** is the real AOSP `effect_config_t` — two 32-byte
`buffer_config_t` (input, then output), little-endian:

```
buffer_config_t (32 B):
  [u32 frameCount][ptr raw][u32 samplingRate][u32 channels]  // channels mask: stereo=3 (only usable value)
  [ptr getBuffer][ptr releaseBuffer][ptr cookie]             // 12-byte buffer_provider (unused; NULL)
  [u8 format][u8 accessMode][u16 mask]                       // format PCM16=1 ; accessMode 0=WRITE/2=ACCUMULATE ; mask ignored
```

(The simplified struct in `arm/audio_effect_defs.h` is corrected to this;
`setconfig_probe.c`'s `cfg_t` is the authoritative layout.)

**Mechanism** (the `Effect_command` cmd-1 branch): validate → if rate +
channels are unchanged, no-op (reply 0) → else cache the config, then
`Effect_reinit` deletes the old `Ds1ap` and builds a new one at the requested
rate (`Ds1ap::New` → `ak_open` → `ak_set_input_config` → `ak_rate_code`),
`Effect_setConfig` re-applies the cached AK params, and the audio buffer is
re-inited → reply 0.

**Validation is three-tiered** — envelope, then fields, then the reconfig
itself — and where the error surfaces differs per tier:

| Tier / case                                                       | `command()` | `*pReplyData` | handle              |
| ----------------------------------------------------------------- | ----------- | ------------- | ------------------- |
| valid; rate or channels changed                                   | 0           | 0             | reconfigured        |
| valid; unchanged                                                  | 0 (no-op)   | 0             | unchanged           |
| **envelope**: `cmdSize ≠ 64`, null, or `*replySize ≠ 4`           | **−22**     | untouched     | intact              |
| **field**: `in ≠ out`, `fmt ≠ PCM16`, `ch` mask `∉ {1,3}`, `acc ∉ {0,2}` | 0    | **−22**       | intact              |
| **reconfig**: rate `∉ {44100,48000,32000}`                        | 0           | 0             | falls back to 44100 |
| **reconfig**: channels = mono                                     | 0           | **−22**       | **poisoned**        |

A field reject returns 0 — **always check `*pReplyData`, not just the return**.
The two reconfig rows are the surprises (`setconfig_probe` Sc5/Sc6):

- **Silent rate fallback.** `Effect_reinit` gates the rate to **{44100, 48000,
  32000}**; any other rate **silently falls back to 44100 and still replies 0
  (success)**. Validate the rate host-side (or read it back via
  `ak_bus_get_rate` on bus 0).
- **Mono poisons the handle.** A mono mask (1) *passes* the field check, but
  `Effect_reinit` only accepts channel counts {2, 6, 8} — and it tears down the
  old graph *before* that check. So mono leaves `Ds1ap` NULL: reply −22 and the
  handle is unusable. **Stereo (mask 3) is the only working value** — the effect
  layer is hard-limited to stereo even though the `Ds1ap` core supports 6/8.

**accessMode is a real knob, not hard-wired.** The engine honours **WRITE (0)**
(`out[i] = processed`) and **ACCUMULATE (2)** (`out[i] += processed`) —
`setconfig_probe` Sc7 proves it behaviourally. v1/AudioFlinger pick ACCUMULATE,
which is why `process()` needs the pre-`memset` (below); WRITE would overwrite
and need none — so DolbyX v2 picks **WRITE** and drops the per-block zeroing.

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

What the engine does **NOT** check at the protocol/cache layer (but see
the value-range note — the registry *does* clamp):

- **Value range — raw in the cache, clamped in the registry.** A cmd 3
  SET writes the value to two places: the **raw** int16 into the settings
  cache (the engine logs `value 210` verbatim for `dvla`, range 0..10),
  and a forwarded `ak_set` that **clamps** the copy in the AK registry to
  the engine's own range. The DSP reads the **clamped registry**, not the
  raw cache (proven by a cache poke the DSP ignores — ddp_probe #7), so an
  out-of-range write is silently clamped, not honoured. The clamp emits no
  log string (why an earlier string scan missed it); read the clamped
  value back with `ak_get`, and the range with `ak_get_min`/`ak_get_max`
  — which differ from the Java table for `vmb` (`[0..192]`, not `..240`)
  and `vol` (`[-2080..480]`). Java clamps too
  (`DsAkSettings.set` at `Ds.apk/.../DsAkSettings.java:278-326`).
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
  `vcbg`, `vcbe`, `endp`, `preg`, `vol`, `ven`, `vcnb`, etc.
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
| 0               | success | engine accepted; SET writes the raw value to the cache and a clamped copy via `ak_set`                              |
| -1 (`-EPERM`)   | engine  | invalid command data (e.g. psize wrong)                                                                            |
| -22 (`-EINVAL`) | engine  | invalid command code (cmd 3 GET, etc.), bad setting_index, or wrong value-buffer size                              |
| -4              | Java    | `Ds.setDsApParam` host-side rejection (e.g. `iebt`/`gebg` going through the wrong API) — not emitted by the engine |

`DsClient.translateErrorCodeToExceptions` maps Java-side codes to
exceptions. For the daemon, propagate engine `-22` as `ENGINE_REJECTED`
and still own value-range validation up front: the engine clamps to its
own `ak_get_min`/`ak_get_max` (a silent second line), but those ranges
differ from the published table for some params, so a host that validates
gives predictable, inspectable behaviour rather than relying on a hidden
clamp.

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
   The cache gets the **raw** value; `ak_set` **clamps** its copy into
   the AK registry. The two stores **diverge** on out-of-range writes,
   and the DSP reads the **registry**, not the cache (ddp_probe #7) — so
   the cache is a raw host-side record, not the engine's DSP-input state.

What the DSP does with that state then depends on the param. DolbyX v2
surfaces three buckets, each derived from observed DSP behaviour:

- **Settable params** — the DSP reads them from the clamped registry
  each block.
- **ReadOnly** (`vcbg`, `vcbe`) — the DSP overwrites the **registry**
  slot every block with its own computed value (the cache slot is never
  touched). The host reads them via cmd 4 or `ak_get`.
- **Experimental** (`endp`, `preg`, `scpe`, etc.) — read from the
  registry on the same audio block. Probe section 7 shows the clamped
  registry (not the raw cache) drives the DSP, proven by a cache poke the
  DSP ignores; the universal ak_set forwarding in section 5b extends this
  to every Experimental param.

A fourth group of 10 AK slots is **excluded** from DolbyX v2's
surfaces (DEFINE_PARAMS, DEFINE_SETTINGS, metadata table, UI) because
they share one trait — no host read path:

- Engine-internal identity / license slots: `bver`, `bndl`, `ver`,
  `lcmf`, `lcvd`, `lcpt`. DSP doesn't read them at runtime;
  the engine pre-populates them from its internal AK registry at
  DEFINE_SETTINGS time. Writes succeed at the protocol level but
  have no observable effect. The engine version string (`ver`) is
  reachable via cmd 6 and surfaces as `engine.version` on the
  bootstrap rather than as an AK parameter.
- Native-visualizer slots: `vnnb`, `vnbf`, `vnbg`, `vnbe`. No cmd 4
  path, but `ak_get` reads them (ddp_probe #9): `vnbg`/`vnbe` **are**
  live and audio-tracking — yet a byte-for-byte **mirror** of
  `vcbg`/`vcbe` regardless of `vnbf`/`vnnb`, so they carry nothing extra.
  Excluded because they duplicate the `vcb*` channel the visualizer
  already rides.

The bucket classification lives in
[02-ak-parameters.md](02-ak-parameters.md#engine-vs-java-settability).

## Practical reminders

- `process()` deposits per the output **accessMode** chosen at SET_CONFIG:
  ACCUMULATE (2) **adds** to the output buffer (v1/AudioFlinger default — so
  `memset(out, 0, out_bytes)` before every call), WRITE (0) **overwrites** it
  (no memset needed; DolbyX v2 uses WRITE). See
  [SET_CONFIG](#effect_cmd_set_config-effect-command-1).
- A **disabled** effect still deposits per accessMode: `EFFECT_CMD_DISABLE`
  crossfades wet→dry over ≈120 ms (blocks return `0`), then bypassed blocks
  return `-ENODATA` and write the **dry input** — WRITE gives `OUT == IN`,
  ACCUMULATE adds it (`setconfig_probe` Sc9; a never-enabled effect skips the
  crossfade and bypasses from the first block). A WRITE host thus needs no
  passthrough copy of its own.
- `process()` also **clobbers its own input buffer** (enabled or
  disabled). Pass a scratch copy if you still need the original PCM.
- The default sample rate is 44100 Hz. To run at 48000 or 32000 Hz, send
  `EFFECT_CMD_SET_CONFIG` ([above](#effect_cmd_set_config-effect-command-1)) —
  it rebuilds the engine at the new rate and supersedes v1's manual
  `Ds1ap::New` hot-swap. Other rates silently fall back to 44100.
- The audio session ID for global mixing is **0**. This is the
  documented behaviour: session 0 = system output.
- `EffectCreate` returns -EINVAL if you pass anything other than the
  exact `(EFFECT_TYPE_NULL, EFFECT_DS)` UUID pair.
