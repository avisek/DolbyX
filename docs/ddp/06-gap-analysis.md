# 06 — Gap Analysis & Migration Plan

This document compares the current DolbyX implementation against the
original DDP service, calls out every meaningful divergence, and
proposes the minimal set of code changes to bring DolbyX to faithful
parity. It also marks places where DolbyX should _intentionally
diverge_ (because the desktop context is different from Android), so
that "fix it" doesn't mean "blindly copy Android".

The goal stated up front:

> Keep DolbyX's implementation close to the original DDP, using
> similar APIs to minimize complexity. Preserve the original DDP's
> default behavior, look and feel as default. Going forward, extend
> the capabilities beyond what the original DDP did, exposing every
> `libdseffect.so`-supported parameter through an Advanced section.

Each section below has the same structure:

1. **What the original does** — paraphrased from the decompiled sources
2. **What DolbyX does today** — citing the file:line in the repo
3. **Impact** — what users notice (or don't)
4. **Recommended fix** — the smallest change that closes the gap

Issues are sorted in roughly descending order of impact.

---

## Issue: visualizer returns gains only, not excitations

### What the original does

The visualizer endpoint `DS_PARAM_VISUALIZER_DATA` (command 4) returns
**40 int16s**: the first 20 are `vcbg` (the EQ gain curve in 1/16 dB),
the second 20 are `vcbe` (the live spectral excitations in 1/16 dB).
The UI splits them and feeds both to the painter — `mGainsUi[]`
becomes the curve overlay, `mExcitations[]` becomes the spectrum bars
(red/yellow/blue).

Source: `Ds.apk/android/dolby/ds/Ds.java:getVisualizerData`,
`DsClient.java:onVisualizerUpdated`,
`GraphicVisualiserPainter.java:onDraw`.

### What DolbyX does today

`arm/ddp_processor.c:389` only reads `vcbg`:

```
if (cmd == DDP_CMD_GET_VIS) {
    int16_t vis_data[20] = {0};
    ds1_get_array(VCBG_INDEX, vis_data, 20);
    write_exact(STDOUT_FILENO, vis_data, sizeof(vis_data));
}
```

`daemon/http.c:vis_pump_thread` broadcasts those 20 int16s as
`{"type":"vis","bands":[…]}`. The UI's `visualizer.js:updateVisBars`
quantizes them to grid cells and draws bars from them.

### Engine-level evidence

`ds1_get_array` issues a cmd 3 GET. The engine's
`Effect_getParameter()` dispatcher has no case for cmd 3 — it falls
through to the catch-all:

```
[EffectDs] Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)
```

`ds1_get_array` checks `r == 0 && ep->status == 0` and returns -1
when either fails (which is always, for cmd 3 GET). But the caller
in `handle_command` for `DDP_CMD_GET_VIS` ignores the return code
and ships the calloc'd zero buffer to the daemon. See
[tools/ddp_probe/](../../tools/ddp_probe/README.md) section 3 for
the engine log evidence.

### Impact

The "spectrum bars" the user sees in DolbyX are showing **zeros**,
not the EQ curve and not the audio energy. The bars don't react to
music. There is no excitation data anywhere in the pipeline.

The EQ curve is separately drawn from `state.geq` stored in
`ProfileState`, so the curve overlay works correctly; only the
spectrum-bar layer is broken. The fix below uses cmd 4 instead,
which **is** implemented by the engine.

### Recommended fix

Switch the processor to use **command 4** (`DS_PARAM_VISUALIZER_DATA`)
which returns 40 int16s natively, then split them.

In `arm/ddp_processor.c`:

```c
#define DS_PARAM_VISUALIZER_DATA 4

/* Replace the DDP_CMD_GET_VIS handler */
if (cmd == DDP_CMD_GET_VIS) {
    /* Use command 4 to fetch both gains and excitations atomically */
    int16_t both[40];
    int total = sizeof(effect_param_t) + sizeof(int32_t) + sizeof(both);
    uint8_t *buf = calloc(1, total);
    effect_param_t *ep = (effect_param_t *)buf;
    ep->status = 0;
    ep->psize  = 4;
    ep->vsize  = sizeof(both);
    *(int32_t *)(buf + sizeof(effect_param_t)) = DS_PARAM_VISUALIZER_DATA;
    uint32_t rs = total;
    (*g_handle)->command(g_handle, EFFECT_CMD_GET_PARAM, total, buf, &rs, buf);
    if (ep->status == 0) {
        memcpy(both, buf + sizeof(effect_param_t) + sizeof(int32_t), sizeof(both));
    } else {
        memset(both, 0, sizeof(both));
    }
    free(buf);
    write_exact(STDOUT_FILENO, both, sizeof(both));   /* 80 bytes */
    return 0;
}
```

Update the protocol contract:

```c
/* ddp_protocol.h */
/*
 * CMD_GET_VIS: Request visualizer state.
 *   Client → Proc: uint32 0xFFFFFFF2
 *   Proc → Client: int16[20] gains_q4 + int16[20] excitations_q4
 *
 * Both arrays are in 1/16 dB units (signed). Divide by 16 for dB.
 * Visible range is approximately [-12, +36] dB.
 */
```

Update `daemon/main.c:ctrl_extra` to expect 80 bytes instead of 40:

```c
case 0xFFFFFFF2: *reply_len = 80; return 0; /* GET_VIS */
```

Update `daemon/http.c:vis_pump_thread`:

```c
int16_t bands[40];   /* gains[20] + excitations[20] */
proc_ctrl(g_procs[i], cmd_pkt, 4, (BYTE *)bands, 80);
/* Broadcast both arrays */
char json[1024];
int n = snprintf(json, sizeof(json),
    "{\"type\":\"vis\",\"gains\":[");
for (int i = 0; i < 20; i++)
    n += snprintf(json+n, sizeof(json)-n, "%s%d", i?",":"", bands[i]);
n += snprintf(json+n, sizeof(json)-n, "],\"excitations\":[");
for (int i = 20; i < 40; i++)
    n += snprintf(json+n, sizeof(json)-n, "%s%d", i==20?"":",", bands[i]);
n += snprintf(json+n, sizeof(json)-n, "]}");
ws_broadcast(json, n);
```

Update `ui/src/app.js` to wire `excitations` to the bars and `gains`
to the EQ curve:

```js
if (msg.type === 'vis' && msg.excitations) updateVisBars(msg.excitations) // was msg.bands
```

(Then `state.geq` from set_geq round-trips drives the EQ curve, and
`msg.gains` from the visualizer pump can either be ignored — since the
curve is a UI-driven artifact — or used for verification.)

---

## Issue: only `vcbg` is registered, not `vcbe`

### What the original does

Both `vcbg` and `vcbe` are registered in the parameter table.
Neither is in Java's `isParamSettable` whitelist, so neither has a
flat-index slot in DEFINE_SETTINGS in the standard build. The
original service reads them via **command 4** (`DS_PARAM_VISUALIZER_DATA`),
which returns `vcbg||vcbe` as 40 int16s in one call without needing
DEFINE_SETTINGS slots.

### Engine-level evidence

Cmd 3 GET is unimplemented in the engine — see the previous issue.
The only working read paths are cmd 4 (visualizer) and cmd 6
(version). So vcbe could never have been read via cmd 3 anyway; the
old "either command 3 or command 4" framing was wrong.

### What DolbyX does today

`arm/ddp_processor.c:g_param_names[]` contains `vcbg` at index 23 but
**not** `vcbe`. The dictionary is incomplete but irrelevant for the
visualizer pump — that needs to use cmd 4 (which doesn't reference
the parameter dictionary at all).

### Impact

Minor — command 4 doesn't need the DEFINE_SETTINGS slot or even a
DEFINE_PARAMS entry. But the missing `vcbe` is a correctness issue
for any future code that wants to use cmd 4's full 40-int16 return.

### Recommended fix

Add `vcbe` to `g_param_names[]`. While you're there, also add `vcbf`
(visualizer band frequencies) so `getBandFrequencies` works. See the
"complete parameter migration" section below for the full proposed
list.

---

## Issue: visualizer not explicitly enabled

### What the original does

`DsService.startVisualizer` calls `ds_.setVisualizerOn(true)` →
`DsEffect.setVisualizerOn(true)` → command 7
(`DS_PARAM_VISUALIZER_ENABLE`) with payload `int32 1`. This happens
when the first client subscribes via `registerVisualizerData`.

When the last subscriber unregisters, `DsService.stopVisualizer` calls
`setVisualizerOn(false)` to turn the tap off.

### What DolbyX does today

`arm/ddp_processor.c:518` sets `vcnb=20` at startup and assumes the
visualizer auto-engages. Command 7 is never sent.

### Impact

Likely none in practice — most builds of `libdseffect.so` have the
visualizer tap auto-enabled when `vcnb > 0`. But if for any reason it
doesn't, you would silently get all-zero visualizer reads forever.
Cheap insurance.

### Recommended fix

In `arm/ddp_processor.c`, add a helper and call it after
`register_parameters`:

```c
#define DS_PARAM_VISUALIZER_ENABLE 7

static int ds1_set_visualizer_enable(int on) {
    int32_t v = on ? 1 : 0;
    return ds1_set_raw(DS_PARAM_VISUALIZER_ENABLE, &v, sizeof(v));
}

/* … in main, after register_parameters and ds1_set_value(VCNB_INDEX, 20) … */
ds1_set_visualizer_enable(1);
```

You could also optionally add `DDP_CMD_SET_VIS_ENABLE` to the IPC
protocol for the daemon to toggle it on/off when the WS client list
becomes empty — but that's a microoptimization (the engine spends very
little CPU on the tap).

---

## Issue: flat GEQ storage

### What the original does

Each profile maintains 4 separate GEQ curves, one per IEQ preset slot
(Off, Open, Rich, Focused). Switching IEQ preset reloads the stored
curve for that `(profile, preset)` pair. The total state is `6 × 4 ×
20 × int16 = 960 bytes`.

Source: `DsProfileSettings.geqBandGains_[preset][band]`,
`DsProfileSettings.setIeqPreset` / `setGeq`.

### What DolbyX does today

`daemon/http.h:ProfileState`:

```c
typedef struct {
    int16_t params[DDP_PARAM_COUNT];
    int     ieq_mode;
    int16_t geq[20];   /* 20-band graphic EQ gains */
} ProfileState;
```

One `geq[20]` per profile. Switching IEQ preset doesn't restore a
preset-specific GEQ — the user's customizations are scoped per
profile, not per (profile, IEQ preset).

### Impact

Users who customize GEQ while one IEQ preset is active and then switch
IEQ presets will see their customization carry over to the new
preset, then be lost when they switch back. This is the most
user-visible behavioural divergence from the original.

### Recommended fix

In `daemon/http.h`:

```c
typedef struct {
    int16_t params[DDP_PARAM_COUNT];
    int     ieq_mode;
    int16_t geq[4][20];   /* per-IEQ-preset graphic EQ gains */
} ProfileState;
```

In `daemon/http.c:save_config` and `load_config`, write/read the GEQ
as a 2D array. The TOML format can stay backwards-compatible by adding
an array-of-arrays:

```toml
[Music]
ieq_mode = "rich"
geq_off = [0, 0, 0, ...]
geq_open = [0, 0, 0, ...]
geq_rich = [+10, +5, 0, ...]
geq_focused = [0, 0, 0, ...]
```

(Optionally migrate existing single-`geq` configs by copying the value
into all four slots on first load.)

In `daemon/http.c:apply_profile_to_processors`:

```c
int16_t *geq = g_profile_states[g_current_profile].geq[CUR_IEQ];
```

In the WS handler `set_geq` (line 673), pass `CUR_IEQ` to select which
preset's storage gets written.

In the WS handler `set_ieq` (line 619), after switching to a preset,
also re-push the GEQ for that `(profile, preset)`:

```c
if (preset != DDP_IEQ_MANUAL) {
    /* … existing setIeqPreset and ieon/iea pushes … */
    /* Also push the stored GEQ for this preset */
    int16_t *geq = g_profile_states[g_current_profile].geq[preset];
    BYTE geq_pkt[44]; int16_t geq_reply[20];
    DWORD c2 = DDP_CMD_SET_GEQ;
    memcpy(geq_pkt, &c2, 4);
    memcpy(geq_pkt + 4, geq, 40);
    forward_cmd(geq_pkt, 44, (BYTE *)geq_reply, 40);
}
```

This brings the 6 × 4 × 20 model to DolbyX with minimal disruption to
the existing protocol (the `set_geq` WS message keeps the same shape).

---

## Issue: DEFINE_SETTINGS uses offset 0 only

### What the original does

For multi-element parameters (`gebg` length 20, `iebt` length 20,
etc.), DEFINE_SETTINGS sends one `(param_idx, offset)` entry **per
element** — so `gebg` consumes 20 consecutive flat indices.

Source: `DsAkSettings.defineSettings()`.

### What DolbyX does today

`arm/ddp_processor.c:register_parameters`:

```c
for (int i = 0; i < np; i++) {
    sbuf[pos++] = i;
    *(int16_t *)(sbuf + pos) = 0; pos += 2;
}
```

One entry per parameter, all at offset 0. So `gebg` gets 1 flat slot
even though it has 20 elements.

### Engine-level evidence

[tools/ddp_probe/](../../tools/ddp_probe/README.md) directly
demonstrates the underlying primitive: a cmd 3 SET with
`begin_setting_index=43, count=20` against `gebf` (which has 20
allocated slots in the harness's all-64 DEFINE_SETTINGS) yields:

```
[EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE device:8 setting_index:43 length:20
[EffectDs] DS_PARAM_SINGLE_DEVICE_VALUE settingsCache[device:0 setting_index:43-62] updated with new values
```

The engine writes `count` sequential cache slots starting at
`begin_setting_index`, with one validation only: `begin + count <=
num_settings`. It has no concept of "param boundary". Section 8
confirms the boundary check: a SET addressing `flat=767` against a
667-slot cache returns `-22` with engine log `setting_index 767 is
invalid (number of settings defined is 667)`.

In the DolbyX v1 compressed layout each multi-element parameter
occupies a single flat slot, so `num_settings = 24` and `gebg` sits
at flat index 21. A `count=20` SET against `gebg` therefore
addresses slots 21..40 — which extends past the 24-slot cache.

Probe section 8's boundary test resolves which side of the cache
bound the engine actually enforces: a `SET flat=662 count=20`
against a 667-slot cache returns **reply=0**. The engine validates
`begin` against the cache total but does **not** enforce
`begin + count <= cache_total`. So v1's `gebg`-with-count=20 SET
is accepted; band 0 lands in `gebg`'s only slot correctly, and
bands 1..19 spill into the cache slots of whichever parameters
happen to follow `gebg` (in v1: `vcnb`, `vcbg`) plus three slots
of adjacent memory past the cache buffer.

### Impact

This is the most insidious bug in DolbyX v1's init handshake:

- **SET command 3 with `count=20` against `gebg` writes the first
  band into the `gebg` slot correctly, but bands 1..19 spill into
  the cache slots belonging to the parameters that follow `gebg` in
  DolbyX's compressed DEFINE_SETTINGS list** (and past the cache
  boundary into adjacent memory), silently overwriting them. The
  IEQ-preset apply appears to work — the user hears _something_ —
  but the resulting state is a corrupted mash of several params at
  once.
- **GET command 3 doesn't fail because of slot-allocation; it fails
  because cmd 3 GET is unimplemented in the engine entirely.** See
  the visualizer issue above. The two bugs are independent.

The DEFINE_SETTINGS bug has been masked because:

- The visualizer is broken for a different reason (cmd 3 GET not
  implemented), so the bug shows up as zero visualizer bars rather
  than corrupted ones.
- Some of the corrupted slots belong to no-op params or to params
  whose default value coincidentally matches the bleed value.

### Recommended fix

Build the DEFINE_SETTINGS payload from a parameter table that includes
each parameter's length:

```c
typedef struct {
    char name[5];   /* 4 chars + NUL */
    int  len;       /* number of int16 elements */
} ddp_param_t;

static const ddp_param_t g_params[] = {
    { "endp", 1 },  { "vdhe", 1 },  { "dhsb", 1 },  { "dssb", 1 },
    { "dssf", 1 },  { "ngon", 1 },  { "dvla", 1 },  { "dvle", 1 },
    { "dvme", 1 },  { "ieon", 1 },  { "iea",  1 },  { "deon", 1 },
    { "dea",  1 },  { "ded",  1 },  { "plmd", 1 },  { "aoon", 1 },
    { "vmb",  1 },  { "vmon", 1 },  { "geon", 1 },  { "plb",  1 },
    { "iebt", 20 }, { "gebg", 20 }, { "vcnb", 1 },
    { "vcbg", 20 }, { "vcbe", 20 }, { "vcbf", 20 },
    /* … any further params you want to expose */
};
#define NUM_PARAMS  (sizeof(g_params) / sizeof(g_params[0]))

static void register_parameters(void) {
    /* DEFINE_PARAMS — one 4-CC per parameter */
    int total_settings = 0;
    for (size_t i = 0; i < NUM_PARAMS; i++) total_settings += g_params[i].len;

    uint8_t pbuf[2 + NUM_PARAMS * 4];
    int pos = 0;
    *(int16_t *)(pbuf + pos) = NUM_PARAMS; pos += 2;
    for (size_t i = 0; i < NUM_PARAMS; i++) {
        memcpy(pbuf + pos, g_params[i].name, 4);
        pos += 4;
    }
    ds1_set_raw(DS_PARAM_DEFINE_PARAMS, pbuf, pos);

    /* DEFINE_SETTINGS — one (param_idx, offset) per element */
    uint8_t sbuf[2 + 1024 * 3];   /* generous, then we'll trim */
    pos = 0;
    *(int16_t *)(sbuf + pos) = total_settings; pos += 2;
    for (size_t i = 0; i < NUM_PARAMS; i++) {
        for (int o = 0; o < g_params[i].len; o++) {
            sbuf[pos++] = (uint8_t)i;
            *(int16_t *)(sbuf + pos) = (int16_t)o; pos += 2;
        }
    }
    ds1_set_raw(DS_PARAM_DEFINE_SETTINGS, sbuf, pos);
}
```

Combined with the constant-params dance (next issue), this brings the
DolbyX init flow to faithful parity with the original.

---

## Issue: constant params not sent before DEFINE_SETTINGS

### What the original does

Before DEFINE_SETTINGS, the engine receives values for the four
"constant" parameters that determine array lengths:

- `genb = 20` (GEQ band count)
- `ienb = 20` (IEQ band count)
- `aonb = 20` (Audio Optimizer / Audio Regulator band count)
- `gebf = [43, 129, ..., 18777]` (GEQ band frequencies)

These come from `<constant>` in `ds1-default.xml`, parsed and pushed
by `DsAkSettings.setConstantAkParam`. The static `akParams_` table is
mutated in-place to update the lengths of dependent parameters.

### What DolbyX does today

`arm/ddp_processor.c` doesn't send these explicitly. `vcnb` is set to
20 in `main`, but `genb`, `ienb`, `aonb`, `gebf` are never sent.

### Impact

In practice, the engine's defaults appear to match (all four are 20
and `gebf` has a sensible default). But this is fragile — if Dolby
ever ships a build with different defaults, DolbyX would silently
mis-size its arrays.

### Recommended fix

Add a `setup_constants` step before `register_parameters`:

```c
static const int16_t g_gebf_default[20] = {
    43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550,
    2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777
};

static void setup_constants(void) {
    /* These MUST be sent before DEFINE_SETTINGS so the engine sizes its
     * internal flat-settings buffer correctly for multi-element params. */
    int16_t v;
    v = 20; ds1_set_value(idx_of("genb"), v);
    v = 20; ds1_set_value(idx_of("ienb"), v);
    v = 20; ds1_set_value(idx_of("aonb"), v);
    ds1_set_array(idx_of("gebf"), g_gebf_default, 20);
}
```

This requires adding `genb`, `ienb`, `aonb`, `gebf` to the parameter
list (and registering them via `DEFINE_PARAMS` first, which is fine
because that step doesn't depend on lengths).

The order becomes:

```
1. EffectCreate → INIT
2. DEFINE_PARAMS (with all params including the constants)
3. setup_constants() — sends genb/ienb/aonb/gebf via command 3
4. DEFINE_SETTINGS — now correctly sized
5. setVisualizerOn(1)
6. apply_profile (default)
7. EFFECT_CMD_ENABLE
```

---

## Issue: parameter dictionary too small (24 vs 64)

### What the original does

The parameter table has 64 entries. Almost half are settable. The
service exposes generic `setDsApParam("name", int[])` to write any of
them.

### What DolbyX does today

`g_param_names[]` has 24 entries, hard-coded by index. Adding a new
param means adding it to:

- `g_param_names[]`
- `DDP_PARAM_*` enum in `ddp_protocol.h`
- The 6 entries in `g_profiles[][DDP_PARAM_COUNT]`
- The TOML save / load code in `daemon/http.c`
- The Web UI control row markup

That's a five-place edit per new parameter. The Advanced section goal
(every settable param in the UI) becomes a 40+ × 5-place chore.

### Recommended fix

Replace the hardcoded enum with a metadata-driven table. Define each
parameter in one place with its name, length, default per profile,
range, and UI category:

```c
/* ddp_params.h */

typedef enum {
    DDP_PARAM_KIND_TOGGLE,   /* 0/1 — UI: switch */
    DDP_PARAM_KIND_TRISTATE, /* 0/1/2 — UI: switch (on uses 2) */
    DDP_PARAM_KIND_INT,      /* 0..N — UI: slider */
    DDP_PARAM_KIND_DB,       /* 1/16 dB — UI: dB slider */
    DDP_PARAM_KIND_HZ,       /* int Hz — UI: log slider */
    DDP_PARAM_KIND_ARRAY,    /* multi-element — UI: per-band sliders */
    DDP_PARAM_KIND_READONLY, /* UI presentation: not exposed for edit.
                              * NB: this is a UI classification only —
                              * the engine accepts writes to any
                              * declared param; whether the DSP reads
                              * the new value depends on the param's
                              * role. See ddp/02 "Engine vs Java
                              * settability". */
} ddp_param_kind_t;

typedef struct {
    const char *name;       /* 4-CC */
    int         len;
    int         lower;
    int         upper;
    ddp_param_kind_t kind;
    const char *category;   /* "basic" | "ieq" | "geq" | "vis" | "advanced.headphone" | … */
    const char *label;      /* UI display name */
    int16_t default_value;  /* used when no per-profile override */
} ddp_param_t;

extern const ddp_param_t g_ddp_params[];
extern const int          g_ddp_params_count;
```

Then `register_parameters` enumerates all of them, `apply_profile`
walks the table and pushes each, and the daemon serialises them by
name (stable across reorderings) instead of by index.

For the Web UI, the daemon can serve the parameter metadata at
`/params.json`, and the UI generates the Advanced section dynamically
without knowing which parameters exist:

```js
const meta = await (await fetch('/params.json')).json()
for (const p of meta.params) {
  if (p.category.startsWith('advanced.')) {
    renderAdvancedControl(p, state.params[p.name])
  }
}
```

This is the foundation for the planned "every parameter is exposable"
goal. It also means adding a new parameter is a one-place edit
(`g_ddp_params` table) and the UI auto-discovers it.

> **Superseded by v2 plan.** The v2 epic ([#8](https://github.com/avisek/DolbyX/issues/8))
> supersedes the `/params.json` proposal above: the v2 daemon
> injects parameter metadata (and the initial state snapshot) into the served
> `index.html` as `window.__BOOTSTRAP__`, eliminating the pre-paint HTTP
> round-trip. The single-source-of-truth and auto-discovery properties are
> preserved; only the delivery mechanism changes.

---

## Issue: host registers two dead params, omits two real ones

### What the original does

`DsAkSettings.akParams_` is the 64-name `DEFINE_PARAMS` contract, and two
of its names are wrong. `mxou` and `lcsz` are **node** params, not engine
root leaves; meanwhile two real root leaves — `scpe` (Surround Compressor
enable, `[0..2]`) and `test` (Peak Limiter test mode, `[0..1]`) — are
missing. The original ships this list; the bug is invisible because
`mxou`/`lcsz` were never functional anyway.

### Engine-level evidence

[tools/ddp_probe/](../../tools/ddp_probe/README.md) experiment 10
resolves every host name against the live AK tree:

```
mxou -> ref 0  (dead)      lcsz -> ref 0  (dead)
scpe -> ref 71 [0..2]      test -> ref 139 [0..1]
```

Ref 0 is a dead, unresolved ref — `ak_set` forwards but the resolve fails
and the write is dropped, so as host params `mxou`/`lcsz` are no-ops.
`scpe`/`test` resolve to real leaves and would be settable if registered. ∴ correct host set =
Java's 64 − {`mxou`, `lcsz`} + {`scpe`, `test`}. Full detail in
[02 → Java's list vs the engine's root leaves](02-ak-parameters.md#javas-list-vs-the-engines-root-leaves).

### What DolbyX does today

`arm/ddp_processor.c:g_param_names[]` is a 24-name subset that includes
none of the four, so v1 isn't bitten yet — but it **inherits Java's buggy
contract** the moment the dictionary grows toward parity by transcribing
the Java list.

### Impact

Low today, latent later. Anyone extending the dictionary toward the full
set from Java registers two dead names and silently omits two real
features (notably the Surround Compressor).

### Recommended fix

When building the metadata-driven table (issue above), **seed it from the
engine tree, not from Java** — `ddp_probe dump tree` enumerates the real
root leaves with authoritative ranges, frac bits, and descriptions. Drop
`mxou`/`lcsz`; add `scpe`/`test` (DolbyX v2 classifies both as
Experimental — engine-surfaced, hidden by the original UI). The v2 plan
bakes this in: [Slice 03 — parameter metadata](../issues/03-parameter-metadata.md).

---

## Issue: parameters indexed by position, breaking backwards compat

### What the original does

The Java client sends `setDsApParam(handle, "iea", int[])` with the
parameter name as a string. The service looks it up via
`DsAkSettings.getAkParamIndex` and translates to a flat index.
Reordering / extending the parameter table is fine — names are stable.

### What DolbyX does today

`DDP_PARAM_*` enum values are positional indices. The daemon sends
`(uint16 param_idx, int16 value)` over the IPC pipe; the processor
treats `param_idx` as both the position in `g_param_names` AND the
flat index in DEFINE_SETTINGS.

If you add a new parameter or reorder them, the saved TOML configs
become invalid (because the indices shift), and old Web UI JavaScript
falls out of sync.

### Recommended fix

Change the IPC protocol to carry parameter **names**, not indices.

For the most common case (scalar params), a 4-byte name + 2-byte value
is barely larger than a 2-byte index + 2-byte value:

```c
/*
 * CMD_SET_PARAM v2:
 *   Client → Proc: uint32 0xFFFFFFF0 + char[4] name + int16 value
 *   Proc → Client: uint32 status
 */
#define DDP_CMD_SET_PARAM_V2  0xFFFFFFEC

if (cmd == DDP_CMD_SET_PARAM_V2) {
    char name[5] = {0};
    int16_t value;
    if (read_exact(STDIN_FILENO, name, 4) < 0) return -1;
    if (read_exact(STDIN_FILENO, &value, 2) < 0) return -1;
    int idx = lookup_param_index(name);
    /* … the rest as before, using `idx` */
}
```

The Web UI then sends `set_param` with `"name": "dvla"` instead of
`"index": 6`. Migration of existing TOMLs is a one-time pass on
load.

This changes the IPC contract — but it's a semver-compatible move
because the old `0xFFFFFFF0` handler can stay and a `_V2` opcode is
preferred.

---

## Issue: 5-bit DsClientSettings digest pattern not used

### What the original does

The 5 master toggles (GEQ, Dialog Enhancer, Volume Leveler, Headphone
Virtualizer, Speaker Virtualizer) are exposed as a single
`DsClientSettings` Parcelable that gets pushed in one AIDL call.
Internally the service diffs against the cached version and pushes
only the changed bits via command 3.

This pattern matters for two reasons:

1. The engine sees one bulk update for all 5 toggles, not 5 independent
   ones, when a profile is loaded.
2. The service can fire `onProfileSettingsChanged(profile)` (event 3)
   instead of one `onDsApParamChange` per toggle (event 8) — UIs
   subscribed to event 3 get a single, atomic refresh.

### What DolbyX does today

Each toggle goes through the generic `set_param` WS command. The
daemon pushes via command 3 individually. This works but doesn't have
the atomic semantics.

### Impact

For a single-UI scenario, low. The user toggles a switch; the WS round
trip takes ~10 ms; the bar appears flipped. There's no observable
problem.

If you ever add a second client (system tray, CLI, mobile companion
app), the lack of atomic profile-settings-changed events means each
client has to subscribe to all individual `set_param` ack events and
reconstruct the digest themselves, which is more code.

### Recommended fix

Add a `set_profile_settings` WS command:

```js
ws.send({
  cmd: 'set_profile_settings',
  settings: {
    geon: false,
    deon: true,
    dvle: true,
    vdhe: true,
    vspe: false,
  },
})
```

The daemon translates the 5 booleans into the 5 corresponding
`(name, value)` engine writes (with `vdhe` and `vspe` mapping `true → 2`,
not `true → 1`), pushes them in a single critical section, then
broadcasts the resulting state to all clients.

Then `FragSwitches`-equivalent UI code becomes:

```js
function flipSwitch(name) {
  const newSettings = { ...currentDigest, [name]: !currentDigest[name] }
  send({ cmd: 'set_profile_settings', settings: newSettings })
}
```

This also surfaces a useful insight: in the original, the **virtualizer
on/off** translates to `vdhe = 0 / 2` (not `0 / 1`). The current
DolbyX code has been setting `vdhe = 1` when the user wants
"Surround Virtualizer ON". This means the headphone HRTF is engaged
unconditionally — including when the user is on a desktop speaker
output that already has its own spatialization. The "auto" semantics
of value `2` would be more correct for a desktop player. This is
worth fixing alongside the digest.

---

## Issue: power-off handling

(DolbyX zeroes parameters via an OFF profile; the original DDP issues
EFFECT_CMD_DISABLE.)

### What the original does

`DsClient.setDsOn(false)` calls `AudioEffect.setEnabled(false)` which
sends `EFFECT_CMD_DISABLE` to the engine. The engine performs a
**graceful disable crossfade of exactly 5512 samples** (~125 ms at
44.1 kHz), then starts returning `-ENODATA` from `process()`; the
framework then treats subsequent blocks as bypass. (Re-ENABLE
crossfades over 7560 samples / ~171 ms, asymmetrically.) Calls are
**idempotent** — a second DISABLE while already disabled returns
reply 0 with engine log `EFFECT_CMD_DISABLE - Already disabled,
ignoring.`. **Parameter state survives the cycle** — neither the
settings cache nor the AK registry is touched.

Source: `Ds.java:24` hard-codes `useOffProfileForDsOff = false`. See
[05-profiles-and-persistence.md → "What 'OFF' means"](05-profiles-and-persistence.md#what-off-means-in-the-original-ddp)
for the full empirical picture.

### Engine-level evidence

From [tools/ddp_probe/](../../tools/ddp_probe/README.md) section 6:

```
[EffectDs] EFFECT_CMD_DISABLE Starting graceful disable over 5512 samples
... (process() returns 0 for crossfade, then -ENODATA) ...
[EffectDs] Effect_process() Graceful disable finished. Returning -ENODATA
[EffectDs] EFFECT_CMD_DISABLE - Already disabled, ignoring.
[EffectDs] EFFECT_CMD_ENABLE Starting graceful enable over 7560 samples
[EffectDs] EFFECT_CMD_ENABLE - Already enabled, ignoring.
```

The same probe verifies parameter persistence: `set dvla=7; DISABLE;
ENABLE; set dvla=3` returns reply 0 on both writes, and a subsequent
process() block produces output consistent with the new value.

### What DolbyX does today

`daemon/http.c:apply_profile_to_processors` sends
`DDP_PROFILE_OFF = 6` which has all parameters zeroed. Power-on
re-applies the saved profile. There's a brief discontinuity at each
toggle.

### Impact

Subjectively audible: when the user presses power, the existing
processing chain's accumulated state (compressor envelopes, leveler
integrator, etc.) is reset. This is the classic "it sounds slightly
different right after I touch the switch" artifact.

### Recommended fix

Two options. The cleaner is to send `EFFECT_CMD_DISABLE` to the engine
on power-off:

```c
/* In ddp_processor.c, add a new control opcode */
#define DDP_CMD_SET_ENABLED 0xFFFFFFEB

if (cmd == DDP_CMD_SET_ENABLED) {
    uint32_t enabled = 0;
    if (read_exact(STDIN_FILENO, &enabled, 4) < 0) return -1;
    uint32_t rs = 4; int32_t r = -1;
    (*g_handle)->command(g_handle, enabled ? EFFECT_CMD_ENABLE : EFFECT_CMD_DISABLE,
                         0, NULL, &rs, &r);
    write_exact(STDOUT_FILENO, &r, 4);
    return 0;
}
```

Then `apply_profile_to_processors` sends `DDP_CMD_SET_ENABLED 0` for
power-off and `DDP_CMD_SET_ENABLED 1` for power-on — never touching
any parameter. The "OFF profile" can stay as a fallback / reset
mechanism but isn't on the hot path.

The simpler option (no engine call): in the `audio_thread` of the
daemon, when `g_current_power == 0`, **skip the call to
`process()` entirely** — just `memcpy(out, in, bytes)` instead. This
gives a perfect bypass with zero engine state mutation. It does mean
the gain staging (pre-gain / post-gain) also bypasses, which may or
may not be what you want.

I'd recommend the cleaner option for fidelity to the original.

---

## Issue: no `setSelectedProfile` via command 2 (bulk push)

### What the original does

Switching profile sends **command 2** (`DS_PARAM_ALL_VALUES`) — one
big blob containing all settable parameter values for the new profile,
applied atomically.

### What DolbyX does today

`apply_profile` in `arm/ddp_processor.c` and `apply_profile_to_processors`
in the daemon both loop and send `DDP_CMD_SET_PARAM` for each
parameter individually. ~20 round trips per profile change.

### Impact

Low. Profile changes happen rarely (user-initiated). But during a
profile change, audio briefly hears each individual parameter
update — in theory you could hear the surround virtualizer turn on
half a millisecond before the leveler turns off, etc. In practice the
engine processes in 256-sample blocks and parameter changes apply at
block boundaries, so the audible artifact is negligible.

### Recommended fix

Implement command 2 in the processor and have the daemon send one
bulk push. This is mostly a hygiene improvement; not strictly needed.

```c
/* In ddp_processor.c, add a bulk_set helper */
static int ds1_set_all_values(int device_id, const int16_t *values, int total_settings) {
    int bufsize = 2 + (4 + total_settings * 2);
    uint8_t *buf = calloc(1, bufsize);
    int pos = 0;
    *(int16_t *)(buf + pos) = 1; pos += 2;          /* num_devices */
    *(int32_t *)(buf + pos) = device_id; pos += 4;
    memcpy(buf + pos, values, total_settings * 2);
    int r = ds1_set_raw(DS_PARAM_ALL_VALUES, buf, bufsize);
    free(buf);
    return r;
}
```

Then `apply_profile` builds the full `int16[total_settings]` array
once and pushes it.

For the UI->daemon wire, you don't need a new command — the daemon
internally does the optimization when handling `set_profile`.

---

## Issue: no originator-aware broadcast

### What the original does

Every `set_*` AIDL transaction takes a `handle` parameter. When the
service broadcasts the change event, it skips the originator's
callback. Multiple clients can coexist without echo loops.

### What DolbyX does today

`ws_broadcast` sends to all connected clients including the
originator. With one Web UI it doesn't matter (the UI updates its
state locally before sending the WS message, so the echo just
re-renders the same state).

### Impact

Low for current single-UI deployment. Medium if you ever add:

- A system tray icon
- A CLI control utility
- A mobile companion app
- A Stream Deck profile

In those scenarios the echo causes spurious re-renders on the
originator and complicates deduplication.

### Recommended fix

Tag each WebSocket connection with a serial integer at handshake. Add
a `originator_id` field to outbound state messages. Modify
`ws_broadcast` to take an exclude argument:

```c
void ws_broadcast_except(SOCKET origin, const char *json, int len);
```

The handler functions pass their connection's socket as the origin.

For trivial protocols, an even simpler pattern is to skip the
broadcast entirely and let the originator process its own response —
all OTHER clients get the state via either polling (`get_state`) or
a separate "state_changed" event. But this is more bookkeeping than
just suppressing on broadcast.

---

## Issue: no suspended-state detection

### What the original does

The visualizer pump tracks consecutive empty reads. After
`COUNTER_THRESHOLD` consecutive reads where all bands are zero, it
fires `onVisualizerSuspended(true)`. The UI greys out the panel and
stops repainting. When non-zero data resumes, it transitions back.

### What DolbyX does today

`vis_pump_thread` runs unconditionally and broadcasts whatever it
gets. The UI shows zero-height bars when nothing is playing.

### Impact

Cosmetic. Zero bars are still rendered nicely (just a flat bottom
edge). But on resource-constrained Web UI clients (older mobiles,
slow tablets), the constant 30 fps redraw of zero data wastes CPU.

### Recommended fix

Add a counter to `vis_pump_thread`. After ~10 consecutive reads where
`max(|excitations|) < threshold`, broadcast a `{"type":"vis_suspended","suspended":true}` message and skip subsequent broadcasts. Resume on the
first non-zero read.

```c
/* In vis_pump_thread */
static int silence_counter = 0;
static int suspended = 0;

int max_abs = 0;
for (int i = 20; i < 40; i++) {
    int v = bands[i] < 0 ? -bands[i] : bands[i];
    if (v > max_abs) max_abs = v;
}

if (max_abs < 16) {  /* less than 1 dB of activity */
    silence_counter++;
    if (silence_counter >= 10 && !suspended) {
        suspended = 1;
        ws_broadcast("{\"type\":\"vis_suspended\",\"suspended\":true}", 41);
    }
} else {
    silence_counter = 0;
    if (suspended) {
        suspended = 0;
        ws_broadcast("{\"type\":\"vis_suspended\",\"suspended\":false}", 42);
    }
}

if (!suspended) {
    /* … existing broadcast logic … */
}
```

UI side, render zeros and dim the panel when suspended.

---

## Issue: visualizer drives EQ curve via separate state instead of from `vcbg`

### What the original does

The visualizer event delivers BOTH the live EQ curve (`vcbg`, what the
engine is currently applying) AND the audio energy (`vcbe`). The UI
draws the curve overlay from the engine-reported `vcbg`, not from a
local-only state.

This means the curve reflects whatever the engine wrote into its
internal `vcbg` state for the most recent audio block. (The engine
silently clamps writes into its AK registry to its own range — see
[03-binary-protocol.md → Engine validation behavior](03-binary-protocol.md#engine-validation-behavior)
— in addition to any Java-layer clamping before the value reaches the
engine.)

### What DolbyX does today

The EQ curve is drawn from `state.geq` (the daemon's record of the
last `set_geq` round-trip return value). This is mostly equivalent —
the daemon's stored gains came from the engine's reply — but it
double-stores the data.

### Impact

Negligible in normal operation. There's a theoretical edge case where
some other client (or future automation) changes a profile parameter
that affects the IEQ curve, and the daemon's `state.geq` is stale.
The `vcbg` polling would catch this; the local state wouldn't.

### Recommended fix

Once the visualizer pump emits both `gains` and `excitations`
(see the first issue), the UI could optionally use `gains` to render
the EQ curve, falling back to `state.geq` only between vis updates
for low-latency drag rendering.

The simplest implementation: keep `state.geq` as the authoritative
source for the curve, but add a debug "engine-reported curve" display
that draws `vcbg` overlaid in a second colour. This makes any
discrepancy immediately visible.

---

## Issue: GEQ band gains stored in raw 1/16 dB units in the UI

### What the original does

The UI works in floating-point dB (`DsConstants.GEQ_BAND_GAIN_RANGE =
{-36, +36}`). The conversion `int16 = round(dB × 16)` happens at the
service layer (`DsProfileSettings.setGeq`), so the wire and the UI
are decoupled.

### What DolbyX does today

The Web UI works in raw `int16` units in the range `-500..+500`
(`ui/src/visualizer.js:gainToY`). The user never sees dB.

### Impact

- Cosmetic: the user has no idea how much gain they've added in dB
  terms.
- Compatibility: the values are not directly comparable to the
  factory-default GEQ curves (which are also in 1/16 dB).

### Recommended fix

Make the UI display dB, internally store dB (as `Number`), and
convert at the WS boundary:

```js
// In visualizer.js
function gainToY(gain_db) {
  return svgH * (1 - (gain_db + 36) / 72)
}
function yToGain(y) {
  return Math.round((1 - y / svgH) * 720) / 10 // 0.1 dB resolution
}

// In sendDrag — convert to int16 1/16 dB before sending
const bands20_q4 = bands20.map((db) => Math.round(db * 16))
send({ cmd: 'set_geq', bands: bands20_q4 })
```

And on receive:

```js
// In setEqFromGains
const bands_db = state.geq.map((q4) => q4 / 16)
```

Optional: add a tooltip showing `"-2.5 dB"` next to each band thumb
during drag.

---

## Issue: DolbyX param indexing breaks if g_param_names changes

### What the original does

Parameter look-up is by 4-CC string, not index. Changing the dictionary
order or adding new parameters doesn't break anything.

### What DolbyX does today

Captured in "parameters indexed by position" above.

### Impact / fix

See that issue.

---

## Architectural target diagram

> **Note.** The diagram below is the gap-analysis-era target. The actual v2
> design ([the v2 epic, #8](https://github.com/avisek/DolbyX/issues/8))
> supersedes the `/params.json` delivery shown here — metadata and initial
> state are injected into `index.html` as `window.__BOOTSTRAP__`
> (bootstrap injection).

After applying the high-impact fixes, the structural target is:

```
┌──────────────────────────────────────────────────────────────────┐
│ Browser UI (any platform)                                         │
│  - WebSocket: ws://localhost:9876/ws                              │
│  - Renders from /params.json metadata + state messages            │
│  - dB units throughout                                            │
└────────────────────────────┬─────────────────────────────────────┘
                             │ JSON over WebSocket
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ dolbyx daemon                                                     │
│  - HTTP/WS server (existing)                                      │
│  - Parameter metadata table (g_ddp_params) — single source of truth│
│  - ProfileState[6]: params[N] + ieq_mode + geq[4][20]             │
│  - 6×4×20 GEQ matrix, IEQ-preset-aware GEQ writes                 │
│  - originator-aware ws_broadcast_except                           │
│  - 5-bool digest support: set_profile_settings command            │
│  - Power on/off via EFFECT_CMD_ENABLE/DISABLE, not OFF profile    │
│  - TOML persistence of profile params + 6×4×20 GEQ + IEQ modes    │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Named pipe / Unix socket
                             │ Parameter names (4-CC), not indices
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ ddp_processor (QEMU)                                              │
│  - Init handshake:                                                │
│      EffectCreate → INIT                                          │
│      DEFINE_PARAMS (full table)                                   │
│      genb=20, ienb=20, aonb=20, gebf=[…]    (constants)           │
│      DEFINE_SETTINGS (with proper offsets per element)            │
│      DS_PARAM_VISUALIZER_ENABLE = 1                               │
│      EFFECT_CMD_ENABLE                                            │
│  - DDP_CMD_GET_VIS uses command 4 → 80 bytes                      │
│  - DDP_CMD_SET_PROFILE uses command 2 (bulk)                      │
│  - DDP_CMD_SET_PARAM_V2 uses 4-CC names                           │
│  - DDP_CMD_SET_ENABLED for power on/off                           │
└────────────────────────────┬─────────────────────────────────────┘
                             │ effect_handle_t.command
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ libdseffect.so (unchanged)                                        │
└──────────────────────────────────────────────────────────────────┘
```

## Recommended migration order

To minimize disruption, apply fixes in this order. Each step is
mostly independent and can ship as a separate PR.

| Step | Issue                                                      | Risk   | Notes                                                                                        |
| ---- | ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| 1    | Init handshake fixes (constants + DEFINE_SETTINGS offsets) | Low    | Pure correctness; default behaviour shouldn't change but becomes robust to engine variations |
| 2    | Visualizer returns gains+excitations                       | Low    | New 80-byte format — single coordinated change to processor + daemon + UI                    |
| 3    | Explicit visualizer enable                                 | Low    | One extra command at startup                                                                 |
| 4    | Power on/off via EFFECT_CMD_ENABLE                         | Low    | Cleaner audio behaviour                                                                      |
| 5    | Suspended-state detection                                  | Low    | Tiny CPU saving; new WS event type                                                           |
| 6    | 6 × 4 × 20 GEQ storage                                     | Medium | Schema change in TOML; migration code needed                                                 |
| 7    | Parameter metadata table + name-based IPC                  | Medium | Larger refactor; foundation for Advanced section                                             |
| 8    | 5-bool digest API                                          | Low    | Optional; nice for future multi-client                                                       |
| 9    | Originator-aware broadcast                                 | Low    | Optional; nice for future multi-client                                                       |
| 10   | Bulk profile push (command 2)                              | Low    | Optional; cleaner profile transitions                                                        |

After steps 1-7, DolbyX should reproduce every observable behavior of
the original DDP UI on Android, plus expose the foundation for the
Advanced section. Steps 8-10 are pure architectural hygiene.

## Testing the fixes

A reasonable smoke-test sequence after each change:

1. **Visualizer fidelity**: play a known music track, verify the
   spectrum bars react and the EQ curve overlay matches `state.geq`.
2. **IEQ preset round-trip**: set a custom GEQ on Music+Rich, switch
   to Music+Open and customize differently, switch back to Music+Rich
   — the original Rich curve should be restored exactly.
3. **Profile switch**: change between Movie / Music / Game / Voice and
   verify the audio character matches the published `ds1-default.xml`
   characteristics (bass-heavy on Movie, balanced on Music, fast
   transients on Game, dialogue-forward on Voice).
4. **Power toggle**: toggle DolbyX power off and on — audio should
   crossfade smoothly to bypass (~125 ms) and back to processed
   (~171 ms) at 44.1 kHz (the engine's built-in graceful
   disable/enable). Parameter state must survive the toggle:
   re-enabling should resume processing with the same profile
   settings, no perceptible parameter discontinuity. See
   [05-profiles-and-persistence.md → "What 'OFF' means"](05-profiles-and-persistence.md#what-off-means-in-the-original-ddp).
5. **Persistence**: customize a few things, kill the daemon, restart
   it, verify the customization is restored.

## Future: extending beyond DDP

The metadata-driven parameter table opens the door to the Advanced
section. Some parameter groups that DDP shipped but the original UI
never exposed:

- **Volume Leveler tuning** (`dvli`, `dvlo`, `dvmc`, `dvme`) — the
  reference loudness levels, the modeler enable. Lets users tune the
  leveler for their playback context (-20 LKFS for movies, -14 LKFS
  for music, etc.).
- **Headphone reverb gain** (`dhrg`) — controls the wet/dry mix of
  the simulated room reverb. Some users prefer a "dryer" Dolby
  Headphone sound.
- **Speaker angle** (`dssa`) — for users who actually use desktop
  speakers and want to tune the virtualizer for their setup.
- **Audio Regulator thresholds** (`arbl`, `arbh`, `arbi`, `arod`,
  `artp`) — exposes the multi-band compressor's per-band settings.
  This is the "audiophile" knob that lets users customize the
  compressor's behaviour per frequency band.
- **Audio Optimizer band gains** (`aobg`) — the per-device EQ that
  the engine uses for speaker compensation. On a desktop speaker
  setup, exposing this as a 20-band per-channel EQ gives users the
  same "calibrate for my speakers" capability that Android has for
  its known device profiles.

For each, the parameter metadata table (`g_ddp_params`) declares the
range and UI kind, and the Web UI auto-renders. No protocol changes
needed beyond the metadata-driven foundation.

This is the technical justification for why issue 7 (parameter
metadata table) is the most important architectural step — every
Advanced parameter you want to add later is essentially free once
that's in place.
