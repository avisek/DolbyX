# `ddp_probe` — libdseffect.so evidence harness

This harness is the empirical source of truth for everything the
`docs/ddp/` reference and `docs/REARCHITECTURE_PLAN.md` say about how
`libdseffect.so` actually behaves at the AudioEffect HAL boundary.

Run it whenever you want to verify a claim, debug a regression after
swapping the engine binary, or generate fresh evidence to support a
new doc edit.

## What it proves

The harness drives the engine through eight focused experiments and
prints the engine's own internal log lines (`__android_log_print`
output) to stderr alongside a stdout summary. The combination
establishes the following facts:

| # | Finding | Evidence (engine log substring) |
|---|---------|-------------------------------|
| 1 | Init handshake (DEFINE_PARAMS, DEFINE_SETTINGS with all 64 params, VISUALIZER_ENABLE, ENABLE) is accepted by the engine; cmd 7 GET round-trips the visualizer-enable bit | `DEFINE_PARAMS count:64`, `DEFINE_SETTINGS count:667`; cmd 7 GET stdout `status=0, value=1` after the matching SET |
| 2 | The engine accepts every int16 value via cmd 3 SET with reply 0 — no range validation, no clamping | `settingsCache[device:0 setting_index:N] updated with value 110` for `dvla` (range 0..10), `value -2180` for `arbl` (range -2080..0) |
| 3 | Cmd 3 GET is NOT in the engine's GET dispatcher | `Effect_getParameter() Invalid command 3. Returning -EINVAL(-22)` |
| 4 | cmd 4 returns dynamic vcbg‖vcbe filled by the DSP each block. Two snapshots taken either side of a substantial audio-shape change differ in 40/40 slots, confirming the per-block refresh | non-zero gains/excitations in the stdout summary; "40/40 slots differ from snapshot A" |
| 5 | cmd 6 returns the 4-int16 engine version | `components=2.0.4.0` in the stdout summary |
| 5b | A representative sample of cmd 3 SETs against "ReadOnly"/static params (`bver`, `bndl`, `ver`, `vcbg`, `vcbe`, etc.) and "Experimental" params (`endp`, `mxou`, `vol`, etc.) — all 15 forward to `ak_set`. The pattern is uniform across the dispatch path; the probe samples rather than enumerates every name | `ak_set(0/bver, 0) = 9999`, `ak_set(37/ver, 0) = 4242`, `ak_set(55/endp, 0) = 2`, etc. |
| 6 | EFFECT_CMD_ENABLE/DISABLE perform a graceful crossfade — ENABLE over 7560 samples (~171 ms @ 44.1 kHz), DISABLE over 5512 samples (~125 ms); second call is idempotent; engine returns -ENODATA from process() after the disable crossfade completes; parameter state (cache + AK registry) survives a full DISABLE→ENABLE cycle and the post-cycle value takes immediate effect at the DSP (pre/post measurements bracket the cycle) | `EFFECT_CMD_ENABLE Starting graceful enable over 7560 samples`, `EFFECT_CMD_DISABLE Starting graceful disable over 5512 samples`, `Already enabled, ignoring.`, `Already disabled, ignoring.`, `Effect_process() Graceful disable finished. Returning -ENODATA`; stdout `pre-cycle dvla=7 peak=17` vs `post-cycle dvla=3 peak=2` |
| 7 | The DSP reads raw int16 from the cache — out-of-range writes produce out-of-range behavior, not clamped behavior. `vmb=480` amplifies ~10× past the declared 240 limit; `vmb=-100` attenuates rather than acting like `vmb=0` | stdout sweep table |
| 8 | Cache writes addressing a flat index past `cache_total` are rejected with -22; but the engine only checks `begin` — a `count=20` SET starting at `cache_total - 5` is accepted with reply 0, so writes straddling the cache edge corrupt adjacent memory rather than failing safe; bogus 4-CCs in DEFINE_PARAMS are accepted silently | `setting_index 767 is invalid (number of settings defined is 667)`; stdout "SET flat=662 count=20 ... -> reply=0"; absence of error for `DEFINE_PARAMS [xxxx, dvla, yyyy]` |

The DEFINE_SETTINGS pre-population effect (engine fires
`ak_get(0/bver, 0..4)` etc. to seed the cache from its own AK
registry at init) is visible at the start of `engine.log` and isn't
gated by any specific experiment in the probe — it always fires.

## Note on init order

The probe sends DEFINE_PARAMS → DEFINE_SETTINGS → cmd 3 SET for
`genb`/`ienb`/`aonb`/`gebf`. cmd 3 addresses cache flat indices,
so it can only follow DEFINE_SETTINGS — the engine doesn't allow
schema-defining SETs ahead of cache allocation. The probe's
hard-coded element lengths in `G[]` (e.g. `aobg=42`) match the
engine's static `akParams_` defaults (`genb=ienb=aonb=20`,
`aocc=2`), so the cache layout is self-consistent before the
constants are echoed back. This mirrors the Java
`DsAkSettings.defineSettings` flow, which also builds the
DEFINE_SETTINGS payload using host-side knowledge of the
constants and then issues the cmd 3 SETs afterwards. See
[../../docs/ddp/03-binary-protocol.md](../../docs/ddp/03-binary-protocol.md#the-mandatory-init-handshake)
for the protocol-level discussion.

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
grep -E "settingsCache.*value 110" engine.log
grep -E "ENODATA" engine.log

# Behavioral checks (stdout — `make run` writes the summary):
make run 2>/dev/null | grep -E "cmd 7. GET .* value=1"        # cmd 7 GET works
make run 2>/dev/null | grep -E "40/40 slots differ"           # vcbg/vcbe refresh
make run 2>/dev/null | grep -E "post-cycle dvla=3"            # persistence test
make run 2>/dev/null | grep -B1 "begin+count=682" | grep "flat=662"  # begin-only bounds
```

If any of these come back empty, the engine binary has changed
behavior — the docs need an updated review.

## Files

```
tools/ddp_probe/
├── README.md            # this file
├── Makefile             # cross-compile + qemu-arm-static invocation
├── ddp_probe.c          # the consolidated probe (8 experiments)
└── liblog_stub.c        # verbose __android_log_print → stderr
```

The harness re-uses `arm/audio_effect_defs.h` via `-I` rather than
duplicating it — there's one canonical ABI definition for
`effect_param_t`, `audio_buffer_t`, `effect_descriptor_t`, etc.
