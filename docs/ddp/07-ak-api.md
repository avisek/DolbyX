# AK API — `libdseffect.so`'s internal Audio Kernel

**AK** (Audio Kernel) is the framework `libdseffect.so` is built on. It is not
just the parameter system [02](02-ak-parameters.md) describes — it's a full
embedded audio-processing graph (objects, buses, processing nodes) with a
parameter layer on top. The host-facing [binary protocol](03-binary-protocol.md)
(cmd 0–7) is a thin wrapper over it.

The engine exports the AK functions as ordinary symbols, so a process that
`dlopen`s the engine can call them directly. That's how
[`ddp_probe`](../../tools/ddp_probe/README.md) reads live DSP state
(experiment 9) and enumerates the engine's true metadata + descriptions (the
`dump` command).

> **Scope.** Reverse-engineered from the v8.1 `libdseffect.so` and
> **version-pinned to that binary** — the symbol behaviour and context offsets
> below are not a stable ABI. DolbyX v2 drives the **parameter surface** through
> these AK accessors in production (the AK-direct binding,
> [ADR-0010](../adr/0010-ak-direct-params-cmd-lifecycle.md)) and keeps the cmd
> protocol only for **lifecycle** (init / config / enable / `process`); the
> offset + symbol coupling is pinned to this binary and encapsulated behind the
> backend FFI boundary. The dump / introspection uses below double as the
> offline metadata-table generator. See the
> [AK registry read path](03-binary-protocol.md#the-ak-registry-read-path) in 03.

## The cmd protocol is AK underneath

Every command bottoms out in an AK call — the protocol is the documented
wrapper, AK is the internals it wraps:

| cmd                 | AK call                                       |
| ------------------- | --------------------------------------------- |
| 2 `ALL_VALUES`      | `ak_set_bulk`                                 |
| 3 `SET`             | `ak_set` (+ the raw settings-cache write)     |
| 4 `VISUALIZER`      | `ak_get_bulk` (×2: `vcbg`, `vcbe`)            |
| 6 `VERSION`         | `ak_bundle_version_get_bulk`                  |
| 0 `INIT`            | `ak_open`                                     |
| 1 `CONFIG`          | `ak_set_input_config` → `ak_rate_code` (rebuild via `Ds1ap::New`) |
| `process()`         | `ak_process` → `ak_update` (coeff recompute)  |

## Reaching AK in-process

The accessors need the AK handle and a parameter **ref**, both reachable from
fixed offsets in the `effect_handle_t` context `H`:

```c
void*     handle = *(void**)(*(void**)((char*)H + 0x44));  // pDs1ap, 2 derefs
uint32_t* refs   = *(uint32_t**)((char*)H + 0xb4);         // host's 64 refs, DEFINE_PARAMS order
```

`refs[i]` is the tagged ref the engine assigned to the i-th name the host sent
in `DEFINE_PARAMS`. The offsets `0x44` / `0xb4` are specific to this build.

## Refs and `ak_resolve`

A ref is **not a pointer** — it's a tagged path into the AK object tree: the low
bit is a flag, the rest is a bit-packed sequence of child indices.
`ak_resolve(ref, &slot)` decodes it, walks root→leaf, and writes the resolved
object to `*slot`. **Every accessor calls `ak_resolve` first.**

- A ref with the low bit **clear** (e.g. `0`) **doesn't resolve** — `ak_resolve`
  returns 0 (not resolved), so every accessor bails: a read yields NULL, a write
  is dropped, `ak_enum`/`ak_find` find no child. `0` is the dead / absent ref.
- **Root-for-enumeration is ref `1`** — the engine's own `ak_find`/`ak_enum`
  calls pass `1` as the parent.
- The host's 64 refs are tagged values like `3`, `0xb`, `0x31` — leaves nested
  under root.

## Accessor reference

All take `(handle, ref, …)` and resolve the ref internally.

| Function                                            | Signature → returns                  | Notes                                                                 |
| --------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `ak_get`                                            | `(h, ref, elem) → int`               | one element — the stored, already-clamped value. **A shim over `ak_get_bulk(count=1, stride=1)`.** |
| `ak_get_bulk`                                        | `(h, ref, start, count, stride, dst)`| the real reader. **stride 4 = packed int16, 1 = int32.**              |
| `ak_set`                                            | `(h, ref, elem, val) → ok`           | single-element write. **Clamps to `[min,max]`, then stores; no recompute** (wraps the bulk-set core). |
| `ak_set_bulk`                                        | `(h, ref, start, count, stride, src)`| batch write.                                                          |
| `ak_get_name`                                        | `(h, ref) → u32`                     | 4-CC, packed little-endian.                                           |
| `ak_get_min` / `ak_get_max`                          | `(h, ref) → int`                     | engine's own clamp bounds (authoritative).                            |
| `ak_get_length`                                      | `(h, ref) → int`                     | array element count.                                                  |
| `ak_get_frac_bits`                                   | `(h, ref) → int`                     | fixed-point fractional bits; unit = 1/2ⁿ (4 ⇒ 1/16 dB).               |
| `ak_get_type`                                       | `(h, ref) → int`                     | def **type tag**: `3` = value (inline storage), `2` = opaque / by-reference. |
| `ak_get_flags` / `ak_set_flags`                     | `(h, ref) → int` / `(h, ref, set, clr)` | instance **flag word**; bit `0x2` = write-protected. `ak_set_flags`: `flags = (flags \| set) & ~clr`. |
| `ak_get_size` / `ak_get_offset`                     | `(h, ref, int* out) → 0/-2`          | byte **size** / struct **offset**, written through `out`.             |
| `ak_get_string`                                      | `(h, ref, 0, idx) → char*`           | **display strings**: `idx` 0 = name, 1 = description, 2 = long help.   |
| `ak_find`                                            | `(h, parent_ref, packed_4cc) → ref`  | resolve a name → ref **without** DEFINE_PARAMS.                       |
| `ak_enum`                                            | `(h, parent_ref, i) → ref`           | i-th child ref; `0` past the last.                                    |
| `ak_count_defs`                                      | `(obj*, &n)`                         | recursive count of all defs under an object.                          |

Plus `ak_resolve`, `ak_reset` / `ak_param_reset`, `ak_persist` /
`ak_finished_restore`, and the `ak_name_to_ints` / `ak_ints_to_name` /
`ak_name_unpack` 4-CC codec.

Two facts worth holding onto:

- **`ak_get` *is* `ak_get_bulk`.** It's a 48-byte shim calling `ak_get_bulk`
  with `count=1`. A per-element read loop and a single bulk read hit the same
  code; the engine log labels every element `ak_get(idx/name, e)` either way (so
  the per-element log lines under cmd 4 are `ak_get_bulk`'s internal loop, not a
  separate path).
- **`ak_set` honours the write-protect bit, clamps, then stores — but never recomputes.** The
  shared store core (`0x1ab7c`, reached by both `ak_set` and `ak_set_bulk`) bails on a
  write-protected leaf (storing nothing; see
  [Per-param type & flags](#per-param-type--flags)); otherwise it saturates the value to
  the param's `[min, max]` *before* writing — so the registry physically holds the
  **clamped** value, which is why it diverges from the raw settings cache (see
  [03](03-binary-protocol.md)). What it does *not* do is recompute coefficients:
  that's `ak_update`, inside `ak_process`, which reads the registry **live every
  block** — so a bare `ak_set` still takes effect (matches the cache-poke result
  in [`ddp_probe` #7](../../tools/ddp_probe/README.md); and
  [`akctl_probe`](../../tools/ddp_probe/README.md) shows cmd 3 SET ≡ `ak_set`
  **bit-for-bit** at the DSP — the basis for the AK-direct binding,
  [ADR-0010](../adr/0010-ak-direct-params-cmd-lifecycle.md)).

## Names & descriptions

Every def also carries a small **string table**, read with
`ak_get_string(h, ref, 0, idx)` — `idx` 0 = display name, 1 = one-line
description, 2 = long help (mostly nodes). Human-authored, not just the 4-CC,
straight from the binary:

| ref           | name                               | description                                                            |
| ------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `vol`         | Volume                             | The gain the user would like the Audio Processing Platform to apply…  |
| `iebt`        | Intelligent Equalizer Band Targets | Specifies the band target levels for the Intelligent Equalizer.       |
| `amou`        | Amount                             | Controls the amount of dialog boost.                                  |
| `duck`        | Ducking                            | Controls the amount of attenuation to apply to channels that do not contain dialog. |
| `dele` (node) | Dialog Enhancer                    | Improves the clarity and intelligibility of dialog.                  |

So a generated `parameters.toml` can carry an authoritative name + description
per param — zero hand-transcription — next to the range/length/`frac_bits`.

## Per-param type & flags

Each param resolves to an **instance object** (`flags`, `offset`, `size`, + a pointer
to its def) and a shared **def** (`type`, `name`, `min`, `max`, `frac_bits`, + the
string table). Two more facets the engine self-describes, on top of range/length:

- **`ak_get_type`** — `3` = a normal **value** param (inline storage, real range, a
  byte `size` and `offset`); `2` = an **opaque / by-reference** slot (`size 0`,
  full-int16 "range"). The 9 type-2 leaves are the build/version (`bver`, `ver`,
  `bndl`), license vendor (`lcvd`), and visualizer outputs (`vcbg`, `vcbe`, `vnbf`,
  `vnbg`, `vnbe`) — the engine owns their backing store; the host only reads them
  (cmd 4 / `ak_get`).
- **`ak_get_flags`** — the load-bearing bit is **`0x2` = write-protected (read-only)**.
  The store core checks it first: **public `ak_set`/`ak_set_bulk` store nothing and
  return `0`** (the unchanged value, not `-4`); only `ak_set_internal`/`ak_set_bulk_internal`
  (the forcing path the DSP uses for computed slots) bypass it. The **10 write-protected leaves** are
  `bver ver bndl lcvd vcbg vcbe vnnb vnbf vnbg vnbe`. (`vnnb` is the clean case — a
  type-3 scalar *with* storage that's still read-only; `vcbg`/`vcbe` are additionally
  zero-length, so even the internal setter no-ops on them.)

**How the visualizer outputs are sourced.** These by-ref leaves hold no data —
each has a get-bulk accessor, and they split the native `vn*` family in two.
`vnnb`/`vnbf` are the **rate-derived grid**: `vnbf_get_bulk` returns the native
centre-freq array for the live bus rate (one per supported rate — 20 bands
@48k/44.1k, 19 @32k), and `root_preupdate` writes the count `vnnb` from that rate
on each (re)config (dirty-gated, not per block). `vnbg`/`vnbe` are the **per-block
measurements**: their accessors (`vnbg_get_bulk`/`vnbe_get_bulk`) forward to the
`visq` node the DSP rewrites every block. So the grid moves only with the sample
rate; the measurements move every block.

This is **engine-authoritative and different from Java's `isParamSettable`**: Java
marks 22 names non-settable, but the engine write-protects only 10 of them — `preg`,
`pstg`, `endp`, `ocf`, `vol`, `vcnb`, … are Java-hidden yet engine-writable (and the
license `lcmf`/`lcpt` are writable; only the vendor `lcvd` is locked). `ak_set` itself
returns the **stored (clamped) value** on success, `0` on rejection — a value, not a
status. `ddp_probe dump types` prints the full type/flags/size/len/offset table plus a
three-path write probe (public vs internal vs cmd 3) that reports each path's return —
confirming public `ak_set` returns `0` on a read-only leaf and that the **cmd-3
protocol path honours the write-protect bit**, so production cannot overwrite one.

## Two layers: params and framework

The param accessors sit on top of the AK **framework runtime**:

- **Lifecycle:** `ak_open` / `ak_close`, `ak_start` / `ak_stop`, `ak_size`, `ak_needs`.
- **Processing:** `ak_process`, `ak_process_loop`, `ak_update`, `ak_update_step`.
- **I/O config:** `ak_set_input_config` → `ak_rate_code` (Hz→code, the set
  path); `ak_rate_hz` is the inverse code→Hz lookup table (not a handle
  accessor); `ak_bus_get_rate` reads the live bus-0 rate; `ak_get_output_buffer`.
- **Object tree & buses:** `ak_obj_*` (open / assign / update / process),
  `ak_parent`, `ak_bus_*` (rate, blksz, channels, data).

The cmd protocol's lifecycle commands bottom out here; the param commands bottom
out in the accessor table above.

## What the tree looks like

`ak_enum` from root (ref `1`) walks the whole thing — **248 defs**, far past the
host's 64. Root's children are framework fields (`bver`, `ver`, `bndl`), the
**DSP node graph**, and the flat host params as depth-0 leaves. The nodes are
the signal path; several map directly to DDP features in
[02](02-ak-parameters.md) (roles inferred from their params):

| Node                          | Role            | Sample params                          |
| ----------------------------- | --------------- | -------------------------------------- |
| `dvle`                        | Volume leveler  | `lvla`, `agc`, `mode`, `coef[20]`, `dig[20]` |
| `dele`                        | Dialogue enhancer | `amou`, `duck`, `dig[20]`            |
| `gq`                          | Graphic EQ      | `gain`                                 |
| `dvsq`                        | Virtualizer     | `angl`, `ofmt`                         |
| `visq`                        | Visualizer      | `excd[20]`, `disg[20]`, `dcg[20]`, `dce[20]` |
| `fqmf` / `rqmf` / `fshq` / `rshq` | QMF filterbanks | `hdrm` (`fshq`/`rshq`), `mxin` (`fqmf`), `zero[8]` (`rqmf`) |

Each node carries its own `ver`, `on`, and params, all with **true ranges and
`frac_bits`** straight from the engine. (The root `vcb*`/`vnb*` arrays cmd 4 reads
are separate leaves — the visualizer's *outputs*, not `visq`'s children.)

## Why this matters: authoritative metadata

`DEFINE_PARAMS` only ever sees the 64 names the **host** sends; the engine's tree
is the ground truth, and it disagrees with the hand-transcribed Java table
[02](02-ak-parameters.md) in more than one way:

- **Ranges:** `vmb` is `[0..192]` (not 240), `vol` `[-2080..480]` (not -2048).
- **Lengths:** the EQ band arrays (`gebg`, `gebf`, `iebt`, `iebf`, `aobf`, …) are
  **len 40** — the engine's max band count (`genb`/`ienb` ≤ 40), of which the host
  fills the first 20; `aobg` is **329**, not 42. A length is the array's capacity,
  not the value count you must send.
- **Param-set bugs:** Java omits real root leaves `scpe` (`[0..2]`) and `test`
  (`[0..1]`), and *includes* `mxou`/`lcsz` — which are node params, not root
  leaves, so the engine assigns them ref 0 (dead). The correct host set is
  Java's 64 − {`mxou`, `lcsz`} + {`scpe`, `test`} (`ddp_probe` experiment 10).
- **Unit scale:** per-param `frac_bits` (the engine's own fixed-point exponent),
  which the docs otherwise hardcode (e.g. "÷16").

[`ddp_probe`'s dump](../../tools/ddp_probe/README.md#dumping-the-engines-ak-tree)
walks the tree for this: `dump tree` emits name · description · length · range ·
frac_bits and `dump defaults` the power-on values — the exact data a
`parameters.toml` generator should emit, instead of transcribing Java by hand.
`dump docs` adds the field the others omit: the engine's **long help string**
(`ak_get_string` idx 2), present on 75 of the 248 defs.

## Symbol offsets (v8.1 `libdseffect.so`)

For re-derivation against this build (`.text` offsets):

```
ak_resolve 0x19e1c   ak_find    0x1a0b4   ak_enum        0x1a1ec   ak_count_defs 0x195cc
ak_get     0x1a904   ak_get_bulk 0x1a5a4  ak_set         0x1af58   ak_set_bulk   0x1b070
ak_get_name 0x1a2a0  ak_get_min 0x1a2d4   ak_get_max     0x1a308   ak_get_length 0x1a424
ak_get_type 0x1a26c  ak_get_flags 0x1a574 ak_get_frac_bits 0x1a33c  ak_get_string 0x1a370
ak_get_size 0x1a3d8  ak_get_offset 0x1a47c ak_set_flags 0x1a4c8  ak_set_internal 0x1afa4  ak_set_bulk_internal 0x1b0a4

clamp+store core 0x1ab7c  (ak_set/ak_set_bulk converge here; a write-protected leaf bails with
internal status -4 — the public setters surface that as a 0 return, storing nothing — else
saturates to [min,max] then stores; the *_internal variants skip the write-protect check)
```
