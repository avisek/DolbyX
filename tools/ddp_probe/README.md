# `ddp_probe` — libdseffect.so evidence harness

This harness is the empirical source of truth for everything the
`docs/ddp/` reference and `docs/REARCHITECTURE_PLAN.md` say about how
`libdseffect.so` actually behaves at the AudioEffect HAL boundary.

Run it whenever you want to verify a claim, debug a regression after
swapping the engine binary, or generate fresh evidence to support a
new doc edit.

## What it proves

The harness drives the engine through nine focused experiments and
prints the engine's own internal log lines (`__android_log_print`
output) to stderr alongside a stdout summary. The combination
establishes the following facts:

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence (engine log substring)                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Init handshake (DEFINE_PARAMS, DEFINE_SETTINGS with all 64 params, VISUALIZER_ENABLE, ENABLE) is accepted by the engine; cmd 7 GET round-trips the visualizer-enable bit                                                                                                                                                                                                                                                              | `DEFINE_PARAMS count:64`, `DEFINE_SETTINGS count:667`; cmd 7 GET stdout `status=0, value=1` after the matching SET                                                                                                                                                                                                               |
| 2   | **Two parameter stores.** A cmd 3 SET writes the **raw** value to the settings cache (reply 0, no protocol validation) **and** forwards to `ak_set`, which **clamps** to the engine's range. Cache and AK registry diverge on any out-of-range write                                                                                                                                                                                    | `settingsCache[device:0 setting_index:N] updated with value 210` (cache, raw); stdout `dvla: SET 210 -> cache(raw)=210 ak_get(clamped)=10 engine[0..10]`                                                                                                                                                                          |
| 3   | Cmd 3 GET is NOT in the engine's GET dispatcher — but `ak_get` (the engine's own getter, #9) reads any value live                                                                                                                                                                                                                                                                                                                     | `Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)`; stdout `ak_get is the real getter — reads it live: dvla=7`                                                                                                                                                                                                     |
| 4   | cmd 4 returns dynamic vcbg‖vcbe filled by the DSP each block. Two snapshots taken either side of a substantial audio-shape change differ in 40/40 slots, confirming the per-block refresh                                                                                                                                                                                                                                             | non-zero gains/excitations in the stdout summary; "40/40 slots differ from snapshot A"                                                                                                                                                                                                                                           |
| 5   | cmd 6 returns the 4-int16 engine version                                                                                                                                                                                                                                                                                                                                                                                              | `components=2.0.4.0` in the stdout summary                                                                                                                                                                                                                                                                                       |
| 5b  | A representative sample of cmd 3 SETs against "ReadOnly"/static params (`bver`, `bndl`, `ver`, `vcbg`, `vcbe`, etc.) and "Experimental" params (`endp`, `mxou`, `vol`, etc.) — all 15 forward to `ak_set`. The pattern is uniform across the dispatch path; the probe samples rather than enumerates every name                                                                                                                       | `ak_set(0/bver, 0) = 9999`, `ak_set(37/ver, 0) = 4242`, `ak_set(55/endp, 0) = 2`, etc.                                                                                                                                                                                                                                           |
| 6   | EFFECT_CMD_ENABLE/DISABLE perform a graceful crossfade — ENABLE over 7560 samples (~171 ms @ 44.1 kHz), DISABLE over 5512 samples (~125 ms); second call is idempotent; engine returns -ENODATA from process() after the disable crossfade completes; parameter state (cache + AK registry) survives a full DISABLE→ENABLE cycle and the post-cycle value takes immediate effect at the DSP (pre/post measurements bracket the cycle) | `EFFECT_CMD_ENABLE Starting graceful enable over 7560 samples`, `EFFECT_CMD_DISABLE Starting graceful disable over 5512 samples`, `Already enabled, ignoring.`, `Already disabled, ignoring.`, `Effect_process() Graceful disable finished. Returning -ENODATA`; stdout `pre-cycle dvla=7 peak=93` vs `post-cycle dvla=3 peak=88` |
| 6b  | `process()` **accumulates** into the output and **clobbers its input**. Pre-filling the output yields `prior + input`, so the host must zero it every block (a disabled `-ENODATA` block then passes the input through). The input is overwritten too — enabled leaves that block's output, disabled leaves ~noise — so pass a scratch copy if you need the original PCM | stdout `Test A: … accumulate-match=512/512`; `input after enabled block N` == that block's output; `input after process()` `peak≈394` (disabled) |
| 7   | **The DSP reads the clamped registry, not the raw cache.** A direct cache poke (registry frozen, verified via `ak_get`) leaves the output unchanged (`0/512`) while the matching `SET` changes `512/512`. Out-of-range sweep pairs collapse because `ak_set` clamps both to the same value: `vmb=240 ≡ vmb=480` (→192), `dvla=10 ≡ dvla=200` (→10). (The leveler/maximizer are stateful, so the cache-poke runs first on a clean path with reproducibility gates — sweep peaks are trends, not exact.) | stdout `POKE cache=160 … 0/512 … DSP READS CLAMPED REGISTRY`; sweep `dvla=10/200 peak=51`, `vmb=240/480 peak≈32764`                                                                                                                                                                                                               |
| 8   | Cache writes addressing a flat index past `cache_total` are rejected with -22; but the engine only checks `begin` — a `count=20` SET starting at `cache_total - 5` is accepted with reply 0, so writes straddling the cache edge corrupt adjacent memory rather than failing safe (this destructive SET, #8b, runs **last**); bogus 4-CCs in DEFINE_PARAMS are accepted silently                                                       | `setting_index 767 is invalid (number of settings defined is 667)`; stdout "SET flat=662 count=20 ... -> reply=0"; absence of error for `DEFINE_PARAMS [xxxx, dvla, yyyy]`                                                                                                                                                       |
| 9   | **The engine's own `ak_get` reads the live AK registry** (reachable from fixed context offsets). `ak_get` reproduces cmd 4 — both the 20 gains (`vcbg`) and the 20 excitations (`vcbe`); `vnbg`/`vnbe` have no cmd-4 path but are readable and both **mirror** `vcbg`/`vcbe`; `ak_get_min/max` expose the engine's true ranges, audited for a sample where `vmb` (`[0..192]`) and `vol` (`[-2080..480]`) differ from the Java table; a runtime value-diff shows only the visualizer slots change during `process()`     | stdout `(a) ak_get vs cmd 4: gains 20/20, excitations 20/20 match`, `(b) vnbg == vcbg: 20/20, vnbe == vcbe: 20/20`, `(c) vmb engine[0..192] … <- TABLE WRONG`, `(d) registry slots that CHANGED across runtime: vnbe vcbe`                                                                                                                                                   |

The DEFINE_SETTINGS pre-population effect (engine fires
`ak_get(0/bver, 0..4)` etc. to seed the cache from its own AK
registry at init) is visible at the start of `engine.log` and isn't
gated by any specific experiment in the probe — it always fires.

## Note on init order

The probe sends DEFINE_PARAMS → DEFINE_SETTINGS → cmd 3 SET for
`genb`/`ienb`/`aonb`/`gebf`. cmd 3 addresses cache flat indices,
so it can only follow DEFINE_SETTINGS — the engine doesn't allow
schema-defining SETs ahead of cache allocation. The probe's
hard-coded `G[]` lengths (e.g. `aobg=42`) match the standard
**20-band stereo** config (`genb=ienb=aonb=20`, `aocc=2`) — which is
*host-established, not an engine default*. The engine actually powers
on **10-band / `aocc=1`** (see [Dumping engine defaults](#dumping-engine-defaults));
the Java `DsAkSettings.defineSettings` flow — and this probe — write
the 20-band constants via cmd 3 afterwards. See
[../../docs/ddp/03-binary-protocol.md](../../docs/ddp/03-binary-protocol.md#the-mandatory-init-handshake)
for the protocol-level discussion.

## Dumping engine defaults

`DUMP_DEFAULTS=1` (or `make dump`) prints every param's intrinsic
power-on default and exits. cmd 3 GET is unimplemented, so the probe
can't *ask* over the protocol — instead it calls the engine's **own**
getter, `ak_get`, on every param (the probe `dlopen`s `libdseffect.so`,
so its exported AK API is ours). The AK registry already holds the
defaults right after the init handshake, before any SET, so no seed
trick is needed. `ak_get`/`ak_get_bulk` reach the registry from fixed
context offsets — see experiment 9 and the `ak_attach` comment in
`ddp_probe.c`. (`mxou`/`lcsz` print `(not in AK)` because their entry in the
probe-read tagged-ref array at `H+0xb4` is `0` — *not* because the engine
lacks them: the engine resolves both at runtime, e.g. `ak_get(56/mxou, 0)` at
DEFINE_SETTINGS and `ak_set(56/mxou, 0) = 2` on a write. The probe just can't
build a ref for them from that array, so it skips them rather than passing a
0 ref to `ak_get`.)

Headline finding: the engine boots a uniform **10-band / single-channel**
config — `genb=ienb=aonb=arnb=10`, `aocc=1`, freq tables = the 10 ISO
bands `[32,64,125,…,16000]` zero-padded. The 20-band layout the rest of
the stack assumes is host-applied, not intrinsic. Notable settable
defaults: `dvla=7`, `dvle=1`, `dssf=20`, `dhsb=dssb=96`, `dssa=10`,
`ngon=2`, `vmon=2`, `vmb=144`, `plmd=4`, `dvli=dvlo=-320`, `arbl=-192×40`,
`artp=16`.

## Prerequisites

- `apt install gcc-arm-linux-gnueabihf qemu-user-static`
- The `arm/` build (libstdc++/libm/libc/libdl stubs and a copy of
  `libdseffect.so`) must already exist at `../../arm/build/lib/`. If
  not, run `make -C ../../arm` from the repo root first.

The harness deliberately reuses the existing `arm/` library staging
rather than duplicating it, so the engine binary and stub libraries
stay in lockstep with the production v1 build.

## Running it

```bash
make            # build the probe + the noisy liblog override
make run        # run; stdout = summary, stderr = engine log
make run-log    # like run but stderr -> engine.log for grepping
```

The `liblog_stub.c` here is a verbose drop-in replacement for
`arm/stubs/liblog_stub.c`. It forwards `__android_log_print` calls to
stderr so the engine's `DS_PARAM_*`, `ak_set`, `ak_get`, and
`EFFECT_CMD_*` traces become visible. The production v1 daemon keeps
its silent stub; this is purely for development.

## Verifying a doc citation

Every claim in the updated `docs/ddp/` files or
`docs/REARCHITECTURE_PLAN.md` that's empirical can be re-checked:

```bash
make run-log
grep -E "Invalid command 3" engine.log
grep -E "Starting graceful enable over 7560 samples" engine.log
grep -E "Starting graceful disable over 5512 samples" engine.log
grep -E "ak_set.0/bver, 0. = 9999" engine.log
grep -E "settingsCache.*updated with value 210" engine.log    # raw cache write (dvla=210)
grep -E "ENODATA" engine.log

# Behavioral checks (stdout — `make run` writes the summary):
make run 2>/dev/null | grep -E "cmd 7. GET .* value=1"               # cmd 7 GET works
make run 2>/dev/null | grep -E "40/40 slots differ"                  # cmd 4 vcbg/vcbe refresh
make run 2>/dev/null | grep -E "cache\(raw\)=210 .*ak_get\(clamped\)=10"  # cache raw vs registry clamp
make run 2>/dev/null | grep -E "DSP READS CLAMPED REGISTRY"          # DSP reads registry, not cache
make run 2>/dev/null | grep -E "ak_get vs cmd 4: gains 20/20, excitations 20/20" # ak_get == cmd 4 (both halves)
make run 2>/dev/null | grep -E "vnbg == vcbg: 20/20, vnbe == vcbe: 20/20"        # vnbg/vnbe are live mirrors
make run 2>/dev/null | grep -E "vmb .*0\.\.192.*TABLE WRONG"         # engine range != Java table
make run 2>/dev/null | grep -E "accumulate-match=512/512"            # process() ACCUMULATE mode
make run 2>/dev/null | grep -B1 "begin+count=682" | grep "flat=662"  # begin-only bounds (#8b, last)
```

If any of these come back empty, the engine binary has changed
behavior — the docs need an updated review.

## Files

```
tools/ddp_probe/
├── README.md            # this file
├── Makefile             # cross-compile + qemu-arm-static invocation
├── ddp_probe.c          # the consolidated probe (9 experiments)
└── liblog_stub.c        # verbose __android_log_print → stderr
```

The harness re-uses `arm/audio_effect_defs.h` via `-I` rather than
duplicating it — there's one canonical ABI definition for
`effect_param_t`, `audio_buffer_t`, `effect_descriptor_t`, etc.
