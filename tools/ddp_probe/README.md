# `ddp_probe` — libdseffect.so evidence harness

This harness is the empirical source of truth for everything the
`docs/ddp/` reference and the v2 epic ([#8](https://github.com/avisek/DolbyX/issues/8)) say about how
`libdseffect.so` actually behaves at the AudioEffect HAL boundary.

Run it whenever you want to verify a claim, debug a regression after
swapping the engine binary, or generate fresh evidence to support a
new doc edit.

## What it proves

The harness drives the engine through ten focused experiments and
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
| 5b  | A representative sample of cmd 3 SETs against "ReadOnly"/static params (`bver`, `bndl`, `ver`, `vcbg`, `vcbe`, etc.) and "Experimental" params (`endp`, `preg`, `pstg`, etc.) — all 15 forward to `ak_set`. The pattern is uniform across the dispatch path; the probe samples rather than enumerates every name                                                                                                                       | `ak_set(0/bver, 0) = 9999`, `ak_set(37/ver, 0) = 4242`, `ak_set(55/endp, 0) = 2`, etc.                                                                                                                                                                                                                                           |
| 6   | EFFECT_CMD_ENABLE/DISABLE perform a graceful crossfade — ENABLE over 7560 samples (~171 ms @ 44.1 kHz), DISABLE over 5512 samples (~125 ms); second call is idempotent; engine returns -ENODATA from process() after the disable crossfade completes; parameter state (cache + AK registry) survives a full DISABLE→ENABLE cycle and the post-cycle value takes immediate effect at the DSP (pre/post measurements bracket the cycle) | `EFFECT_CMD_ENABLE Starting graceful enable over 7560 samples`, `EFFECT_CMD_DISABLE Starting graceful disable over 5512 samples`, `Already enabled, ignoring.`, `Already disabled, ignoring.`, `Effect_process() Graceful disable finished. Returning -ENODATA`; stdout `pre-cycle dvla=7 peak=93` vs `post-cycle dvla=3 peak=88` |
| 6b  | `process()` **accumulates** into the output and **clobbers its input**. Pre-filling the output yields `prior + input`, so the host must zero it every block (a disabled `-ENODATA` block then passes the input through). The input is overwritten too — enabled leaves that block's output, disabled leaves ~noise — so pass a scratch copy if you need the original PCM | stdout `Test A: … accumulate-match=512/512`; `input after enabled block N` == that block's output; `input after process()` `peak≈394` (disabled) |
| 7   | **The DSP reads the clamped registry, not the raw cache.** A direct cache poke (registry frozen, verified via `ak_get`) leaves the output unchanged (`0/512`) while the matching `SET` changes `512/512`. Out-of-range sweep pairs collapse because `ak_set` clamps both to the same value: `vmb=240 ≡ vmb=480` (→192), `dvla=10 ≡ dvla=200` (→10). (The leveler/maximizer are stateful, so the cache-poke runs first on a clean path with reproducibility gates — sweep peaks are trends, not exact.) | stdout `POKE cache=160 … 0/512 … DSP READS CLAMPED REGISTRY`; sweep `dvla=10/200 peak=51`, `vmb=240/480 peak≈32764`                                                                                                                                                                                                               |
| 8   | Cache writes addressing a flat index past `cache_total` are rejected with -22; but the engine only checks `begin` — a `count=20` SET starting at `cache_total - 5` is accepted with reply 0, so writes straddling the cache edge corrupt adjacent memory rather than failing safe (this destructive SET, #8b, runs **last**); bogus 4-CCs in DEFINE_PARAMS are accepted silently                                                       | `setting_index 767 is invalid (number of settings defined is 667)`; stdout "SET flat=662 count=20 ... -> reply=0"; absence of error for `DEFINE_PARAMS [xxxx, dvla, yyyy]`                                                                                                                                                       |
| 9   | **The engine's own `ak_get` reads the live AK registry** (reachable from fixed context offsets). `ak_get` reproduces cmd 4 — both the 20 gains (`vcbg`) and the 20 excitations (`vcbe`); the native `vnbg`/`vnbe` have no cmd-4 path but are readable and **equal** the custom `vcbg`/`vcbe` here — only because the engine seeds the custom band grid to the native one (`vc*` is `vn*` resampled; `make vis` remaps `vcbf` to prove they diverge); `ak_get_min/max` expose the engine's true ranges, audited for a sample where `vmb` (`[0..192]`) and `vol` (`[-2080..480]`) differ from the Java table; a runtime value-diff shows only the visualizer slots change during `process()`     | stdout `(a) ak_get vs cmd 4: gains 20/20, excitations 20/20 match`, `(b) vnbg == vcbg: 20/20, vnbe == vcbe: 20/20`, `(c) vmb engine[0..192] … <- TABLE WRONG`, `(d) registry slots that CHANGED across runtime: vnbe vcbe`                                                                                                                                                   |
| 10  | **Java's param set disagrees with the engine's root.** Set-diffs the engine's real root leaves against the host's DEFINE_PARAMS list (`G[]`, verbatim `DsAkSettings`), so it discovers the mismatch rather than asserting it: two **phantoms** (`mxou`/`lcsz`) aren't root leaves — they're node params (nested under DSP nodes in `dump-tree`), so their flat registration gets **ref 0** (dead, the write is dropped) — and two real root leaves (`scpe`/`test`) are omitted. Correct host set = Java's 64 − {`mxou`,`lcsz`} + {`scpe`,`test`}. Full authoritative tree + metadata: `make dump-tree`. | stdout `mxou -> ref 0  (not a root leaf; see dump tree)`, `lcsz -> ref 0 …`, `scpe -> ref 71  [0 .. 2] frac=0`, `test -> ref 139  [0 .. 1] frac=0` |

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
on **10-band / `aocc=1`** (see [Dumping the engine's AK tree](#dumping-the-engines-ak-tree));
the Java `DsAkSettings.defineSettings` flow — and this probe — write
the 20-band constants via cmd 3 afterwards. See
[../../docs/ddp/03-binary-protocol.md](../../docs/ddp/03-binary-protocol.md#the-mandatory-init-handshake)
for the protocol-level discussion.

## Dumping the engine's AK tree

The engine self-describes its whole parameter tree; the probe dumps it four
ways (all exit before the experiments, with the engine log silenced):

```bash
make dump-tree       # branch-drawn AK tree: per-leaf type/flags/size/off/range/frac + desc
make dump-defaults   # each root param's power-on default (4-CC = value)
make dump-types      # root leaves as a flat table + write-protection probe
make dump-docs       # every def's name · description · long help (rule-divided)
```

`dump tree` walks the engine's own object graph (`ak_enum` from root = ref 1),
**branch-drawn** for readability. Each leaf carries the full per-param metadata
— `type`, the `flags` word (incl. the write-protect bit `0x2`), byte `size`,
struct `offset`, `len`, range, and `frac_bits` (the fixed-point scale, e.g.
`gebg`/`vmb` = 4 ⇒ 1/16) — plus the human-readable **name and description**
(`ak_get_string`). **248 defs**, far past the host's 64: it surfaces the
internal DSP node graph (`dvle`, `dele`, `gq`, `visq`, …) and is the ground
truth a `parameters.toml` generator should emit. cmd 3 GET is unimplemented, so
this uses the engine's **own** accessors (the probe `dlopen`s
`libdseffect.so`) — see
[../../docs/ddp/07-ak-api.md](../../docs/ddp/07-ak-api.md).

`dump defaults` lists the **root leaves only** — the host-addressable set —
read straight after open, before any SET, so the registry still holds the
engine's intrinsic defaults. That set is the *correct* one (experiment 10):
`scpe`/`test` present, `mxou`/`lcsz` absent (node params Java mis-listed).

`dump types` is the same per-leaf metadata as a quick **flat table of the root
leaves** — the def `type` (`3` = value, `2` = opaque/by-ref), the instance
`flags` word, byte `size`, and struct `offset` — then a **write-protection
probe**: it hits a sample of params through all three write paths (public
`ak_set`, the forcing `ak_set_internal`, and a cmd-3 SET), reads each back, and
reports each path's return. Headline finding: the engine carries its **own**
read-only marker, the `flags` write-protect bit `0x2` — the 10 leaves
`bver ver bndl lcvd vcbg vcbe vnnb vnbf vnbg vnbe`. Public `ak_set` and the
cmd-3 protocol path both **reject** a write to a read-only leaf (value
unchanged; `ak_set` returns `0`); only `ak_set_internal` forces it. So
`vcbg`/`vcbe` writes are *rejected*, not
"written then clobbered" — the DSP fills them and cmd 4 reads them. See
[../../docs/ddp/07-ak-api.md](../../docs/ddp/07-ak-api.md#per-param-type--flags).

`dump docs` is the engine's **own documentation** — every def's display name,
one-line description, and the **long help string** (`ak_get_string` idx 2): the
last of the three engine strings, and the only one no other dump shows. All 248
defs in tree order, rule-divided, with an `a/b/c` path crumb to disambiguate
repeated 4-CCs (26 `ver`s, 21 `on`s, 15 `hdrm`s). **75 defs carry help** — e.g.
`plmd` enumerates its `DAP_PLMD_*` modes. Strings print verbatim, so the
engine's own line breaks structure the longer entries.

Headline finding: the engine boots a uniform **10-band / single-channel**
config — `genb=ienb=aonb=arnb=10`, `aocc=1`, freq tables = the 10 ISO
bands `[32,64,125,…,16000]` zero-padded. The 20-band layout the rest of
the stack assumes is host-applied, not intrinsic. Notable settable
defaults: `dvla=7`, `dvle=1`, `dssf=20`, `dhsb=dssb=96`, `dssa=10`,
`ngon=2`, `vmon=2`, `vmb=144`, `plmd=4`, `dvli=dvlo=-320`, `arbl=-192×40`,
`artp=16`, `scpe=2`.

## Companion probes

Three focused probes sit alongside `ddp_probe`, sharing the same build (`arm/`
staging, `qemu-arm-static`, the noisy `liblog_stub`). All three underpin the
AK-direct binding decision
([ADR-0010](../../docs/adr/0010-ak-direct-params-cmd-lifecycle.md)).

### `akctl_probe` — AK-direct parameter control (`make akctl`)

Can the engine shim drive params through the AK accessors directly, skipping
the cmd protocol's param surface? It proves:

- **No handshake.** `ak_find` resolves refs by name (no DEFINE_PARAMS) and a
  full GEQ runs driven only by `ak_set`; `ak_get` reads it back — the real
  per-param GET the cmd protocol lacks.
- **cmd 3 ≡ `ak_set`, bit-for-bit.** Two handles on identical histories, one
  boosted via cmd 3 (cache = 160 / registry = 160), one via bare `ak_set`
  (cache = 0 / registry = 160), produce byte-identical output — the cmd path's
  settings-cache write is dead weight; the DSP reads the registry, which
  `ak_update` recomputes from live every block.

### `setconfig_probe` — `EFFECT_CMD_SET_CONFIG` / sample rate (`make setconfig`)

Reverse-engineers the cmd-1 lifecycle command (see
[../../docs/ddp/03-binary-protocol.md](../../docs/ddp/03-binary-protocol.md#effect_cmd_set_config-effect-command-1)).
Sends real SET_CONFIG and reads the live rate via `ak_bus_get_rate`:

- SET_CONFIG → 48000 / 32000 is honoured in-process (Ds1ap rebuilt via
  `Ds1ap::New`); the GEQ then processes at the new rate. It supersedes — and
  replicates for contrast (Sc8) — v1's manual hot-swap.
- **Silent fallback:** an unsupported rate (e.g. 96000) replies success but
  falls back to 44100 — the host must validate.
- **Field sweep (Sc6):** maps each field's accepted set across the three
  validation tiers (−22 return vs reply −22 vs silent fallback): rate
  {32000,44100,48000}, **stereo-only** (mono passes the field check then
  *poisons the handle*), format PCM16, accessMode {0,2}, size exactly 64.
- **accessMode (Sc7):** WRITE vs ACCUMULATE is a real behavioural knob — WRITE
  overwrites the output buffer, ACCUMULATE adds; "ACCUMULATE mode" is the host's
  choice, not hard-wired.
- **Disabled passthrough (Sc9):** a disabled `process()` still fills the output
  per accessMode. `EFFECT_CMD_DISABLE` crossfades wet→dry over ~23 blocks
  (return 0), then bypassed blocks return `-ENODATA` and deposit the **dry
  input**: WRITE gives `OUT == IN` (512/512, same for a never-enabled session),
  ACCUMULATE adds it. So a WRITE-mode host needs no passthrough copy of its own.

### `reshape_probe` — runtime reshape of structural constants (`make reshape`)

Can the "structural constant" params (`genb`/`gebf`, `ienb`/`iebf`, `aonb`/`aobf`,
`aocc`, `arnb`/`arbf`) change at runtime, or are they frozen once the graph is
built? They aren't write-protected, so `ak_set` stores them — the real question is
whether a write *reshapes* the live DSP. Isolating a feature and watching where a
band boost or limit lands, it shows:

- **A. They reshape at runtime — gated by a commit.** A band-count / frequency
  write is **inert until the band gains are re-written**; that gains write
  re-derives the filterbank, no `SET_CONFIG`, enable cycle, or rebuild. Moving
  `gebf[4]` 431→6000 Hz *alone* leaves the boost at 431 (`x1.94`); re-writing
  `gebg` moves it to 6000 (`x2.60`). Raising `genb` 10→20 *alone* does nothing;
  re-writing `gebg` wakes band 15 (`x3.16`) — and that gains write triggers the
  recompute **even with identical values** (presence, not a value delta). The
  commit matches the engine's **own help text** (`dump docs`): GEQ
  `genb`→`gebf`→`gebg`; IEQ `ienb`→`iebf`→`iebt`; AO `aocc`/`aonb`→`aobf`→`aobg`.
- **B. Among the commit writes, order is free.** Driving the GEQ between two
  orthogonal shapes (band 4 @ 431 Hz ↔ band 15 @ 7063 Hz) in **all six orders**
  of `genb`/`gebf`/`gebg` lands the *identical* shape (0 % spread), raising or
  lowering the band count alike — even orders that write the gains **first**. So
  "commit *order*" isn't a constraint; **commit *presence*** is.
- **C. Same protocol on a second, unrelated DSP — and it pins the commit leaf.**
  The Audio Regulator (a multiband distortion limiter, not an EQ) follows the same
  gate: moving a limiting band's centre (`arbf`) is inert until committed. Its
  band config has *three* payload arrays (`arbi` isolates, `arbl`/`arbh`
  thresholds), and only the **last**, `arbh`, commits (`x0.65`→`x0.96`) —
  `arbi`/`arbl` are stagers like `gebf`. (The thresholds are live-smoothed; the
  `arbh` write re-derives the band *structure*.) So "re-write the last array to
  commit" is general, not a GEQ quirk.
- **D. Storage is fixed-capacity; a count change never breaks the arrays.** The
  arrays are allocated full (`ak_get_length` = **40**) at `ak_open` and never
  resize. Filling all 40 slots, then shrinking `genb` 20→5, leaves the
  out-of-range slots **untouched** (tail non-zero `70`→`70`); a commit + 40
  process blocks doesn't zero them either (the recompute reads only the active
  slots); growing back re-exposes the old values. So a count change has **no
  "wrong-sized array" transient to repair** — the commit is all it needs. This is
  why "update a param" stays simple: write it, then touch the group's commit leaf.
- **Mechanism, in the binary.** Each freq/gain array has a `*_preupdate` write
  hook (`gebf_preupdate`/`gebg_preupdate`, …) that only flips a bit in a
  per-feature validity word (GEQ `0x5c0`, IEQ `0x718`, AO `0x870`, AR `0x9c8`):
  stagers set a "dirty" bit (`gebf`→`0x02`), the **commit leaf sets bit `0x40`**.
  Counts have no hook — they're polled in `root_preupdate` (every block, inside
  `ak_update`) and a change only *invalidates* (`bic #0x3d`), never sets `0x40`.
  The `egq` recompute (`dlb_polylog_pow`) runs at the next process block off the
  *current* stored state when `0x40` is present — so write order is unobservable,
  and only the commit-array write triggers it. See
  [02 — Changing them at runtime](../../docs/ddp/02-ak-parameters.md#changing-them-at-runtime-the-commit-protocol).

### `vis_native_probe` — native vs custom visualizer bands (`make vis`)

The visualizer has **two** band families, and they're one source plus a view of
it — not two measurements (engine help text, `make dump-docs`):

- **Native (`vn*`)** — the engine's own filterbank bands, the ground truth, in
  two halves. `vnnb`/`vnbf` *report* the count + centre frequencies — a
  **rate-derived grid** (read-only); the DSP fills `vnbg`/`vnbe` each block.
- **Custom (`vc*`)** — the native data **interpolated onto a host-set grid**.
  `vcnb`/`vcbf` are **writable**; the engine resamples onto them, filling
  `vcbg`/`vcbe` (the pair cmd 4 returns).

`ddp_probe` #9 saw `vnbg`/`vnbe` == `vcbg`/`vcbe` only because the engine **seeds
the custom grid to the native grid** at startup — an identity it never disturbed.
This probe disturbs it:

- **A. Default config — they coincide.** Untouched, `vcbf` == `vnbf` (0/20 differ),
  so `vcbg`==`vnbg` and `vcbe`==`vnbe`, 20/20. The "mirror."
- **B. Remap `vcbf`, they split.** Writing a different grid ([120,240,…,2400] Hz)
  swings the custom pair by **max |Δ|≈430** (whole bands relocated by frequency)
  while the native pair holds to **≈8** (smoother noise); `vcbg`==`vnbg` collapses
  to 1/20. So `vc*` is `vn*` resampled, not a copy.
- **C. Change the rate, the native grid moves.** `SET_CONFIG` to 48k/44.1k/32k
  and re-read: `vnnb`/`vnbf` flip to the engine's rate-indexed `.constdata` array
  — **20/20/19** bands — proving the native grid is rate-derived, not host-set and
  not per-block. The arrays stay **20-wide** at every rate; only `vnnb` of each is
  live, and at 32k the unused 20th slot is *stale, not zeroed* (`vnbf[19]`=0 but
  `vnbg[19]`/`vnbe[19]` keep junk) — so gate on `vnnb`.

Neither family is redundant: `vn*` is the zero-config ground truth, `vc*` the
host-configurable view. See
[02 — Visualizer bands](../../docs/ddp/02-ak-parameters.md).

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
make            # build all probes + the noisy liblog override
make run        # ddp_probe; stdout = summary, stderr = engine log
make run-log    # like run but stderr -> engine.log for grepping
make akctl      # akctl_probe — AK-direct param control (see Companion probes)
make setconfig  # setconfig_probe — EFFECT_CMD_SET_CONFIG / sample rate
make reshape    # reshape_probe — runtime reshape of structural constants (commit gates it; order is free)
make vis        # vis_native_probe — native vs custom bands (vc* is vn* resampled; native grid rate-derived)
```

The `liblog_stub.c` here is a verbose drop-in replacement for
`arm/stubs/liblog_stub.c`. It forwards `__android_log_print` calls to
stderr so the engine's `DS_PARAM_*`, `ak_set`, `ak_get`, and
`EFFECT_CMD_*` traces become visible. The production v1 daemon keeps
its silent stub; this is purely for development.

## Verifying a doc citation

Every claim in the updated `docs/ddp/` files or the v2 epic/issues
([#8](https://github.com/avisek/DolbyX/issues/8) and its sub-issues) that's empirical can be re-checked:

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
make run 2>/dev/null | grep -E "vnbg == vcbg: 20/20, vnbe == vcbe: 20/20"        # native==custom (grid seeded to native; see make vis)
make run 2>/dev/null | grep -E "vmb .*0\.\.192.*TABLE WRONG"         # engine range != Java table
make run 2>/dev/null | grep -E "accumulate-match=512/512"            # process() ACCUMULATE mode
make run 2>/dev/null | grep -B1 "begin+count=682" | grep "flat=662"  # begin-only bounds (#8b, last)
make run 2>/dev/null | grep -E "mxou -> ref 0|scpe -> ref"           # exp 10: Java param-set discrepancy
make dump-tree     | grep -E "^# 248 defs"                           # engine self-describes 248 defs (full metadata)
make dump-defaults | grep -E "^scpe |^test "                         # correct host set: scpe/test present, mxou/lcsz gone
make dump-docs     | grep -E "^# 248 defs, 75 with help"             # 75 of 248 defs carry the long help string
```

If any of these come back empty, the engine binary has changed
behavior — the docs need an updated review.

## Files

```
tools/ddp_probe/
├── README.md            # this file
├── Makefile             # cross-compile + qemu-arm-static invocation
├── ddp_probe.c          # the consolidated probe (10 experiments + dump)
├── akctl_probe.c        # AK-direct param control (cmd 3 ≡ ak_set, no handshake)
├── setconfig_probe.c    # EFFECT_CMD_SET_CONFIG / sample-rate RE
├── reshape_probe.c      # runtime reshape of structural constants (gebg commit; order-free)
├── vis_native_probe.c   # native (vn*) vs custom (vc*) bands — vc* is vn* resampled; native grid rate-derived
└── liblog_stub.c        # verbose __android_log_print → stderr
```

The harness re-uses `arm/audio_effect_defs.h` via `-I` rather than
duplicating it — there's one canonical ABI definition for
`effect_param_t`, `audio_buffer_t`, `effect_descriptor_t`, etc.
