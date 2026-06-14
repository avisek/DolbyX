# AK API — `libdseffect.so`'s internal Audio Kernel

**AK** (Audio Kernel) is the framework `libdseffect.so` is built on. It is not
just the parameter system [02](02-ak-parameters.md) describes — it's a full
embedded audio-processing graph (objects, buses, processing nodes) with a
parameter layer on top. The host-facing [binary protocol](03-binary-protocol.md)
(cmd 0–7) is a thin wrapper over it.

The engine exports the AK functions as ordinary symbols, so a process that
`dlopen`s the engine can call them directly. That's how
[`ddp_probe`](../../tools/ddp_probe/README.md) reads live DSP state
(experiment 9) and enumerates the engine's true metadata (experiment 10).

> **Scope.** Reverse-engineered from the v8.1 `libdseffect.so` and
> **version-pinned to that binary** — the symbol behaviour and context offsets
> below are not a stable ABI. Use AK as an **offline / research tool** (live
> introspection, generating the metadata table), **not** the production runtime
> path: production drives the engine through the cmd protocol, which is the
> contract the engine is designed for. See the
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
| 0/1 `INIT`/`CONFIG` | `ak_open` / `ak_set_input_config`             |
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

- A ref with the low bit **clear** (e.g. `0`) resolves to the **root container**
  at depth 0 — which `ak_enum`/`ak_find` then reject, so it's not an enumerable
  parent.
- **Root-for-enumeration is ref `1`** — the engine's own `ak_find`/`ak_enum`
  calls pass `1` as the parent.
- The host's 64 refs are tagged values like `3`, `0xb`, `0x31` — leaves nested
  under root.

## Accessor reference

All take `(handle, ref, …)` and resolve the ref internally.

| Function                                            | Signature → returns                  | Notes                                                                 |
| --------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `ak_get`                                            | `(h, ref, elem) → int`               | one element, clamped. **A shim over `ak_get_bulk(count=1, stride=1)`.** |
| `ak_get_bulk`                                        | `(h, ref, start, count, stride, dst)`| the real reader. **stride 4 = packed int16, 1 = int32.**              |
| `ak_set`                                            | `(h, ref, elem, val) → ok`           | single-element write. **Pure store — no recompute** (wraps the bulk-set core). |
| `ak_set_bulk`                                        | `(h, ref, start, count, stride, src)`| batch write.                                                          |
| `ak_get_name`                                        | `(h, ref) → u32`                     | 4-CC, packed little-endian.                                           |
| `ak_get_min` / `ak_get_max`                          | `(h, ref) → int`                     | engine's own clamp bounds (authoritative).                            |
| `ak_get_length`                                      | `(h, ref) → int`                     | array element count.                                                  |
| `ak_get_frac_bits`                                   | `(h, ref) → int`                     | fixed-point fractional bits; unit = 1/2ⁿ (4 ⇒ 1/16 dB).               |
| `ak_get_type` / `ak_get_flags` / `ak_get_size` / `ak_get_offset` | `(h, ref) → int`        | type tag, flags, byte size, struct offset.                            |
| `ak_get_string`                                      | `(h, ref, …) → char*`                | string labels (enum-option names).                                    |
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
- **`ak_set` doesn't recompute.** It only stores into the registry. The DSP's
  coefficient recompute (`ak_update`) runs inside `ak_process`, which reads the
  registry **live every block** — so a bare `ak_set` is enough for the new value
  to take effect (matches the cache-poke result in
  [`ddp_probe` #7](../../tools/ddp_probe/README.md)).

## Two layers: params and framework

The param accessors sit on top of the AK **framework runtime**:

- **Lifecycle:** `ak_open` / `ak_close`, `ak_start` / `ak_stop`, `ak_size`, `ak_needs`.
- **Processing:** `ak_process`, `ak_process_loop`, `ak_update`, `ak_update_step`.
- **I/O config:** `ak_set_input_config`, `ak_rate_hz` / `ak_rate_code`, `ak_get_output_buffer`.
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
| `visq`                        | Visualizer      | the `vcb*` / `vnb*` slots              |
| `fqmf` / `rqmf` / `fshq` / `rshq` | QMF filterbanks | `hdrm`                            |

Each node carries its own `ver`, `on`, and params, all with **true ranges and
`frac_bits`** straight from the engine.

## Why this matters: authoritative metadata

`DEFINE_PARAMS` only ever sees the 64 names the **host** sends; the engine's tree
is the ground truth, and it disagrees with the hand-transcribed Java table
[02](02-ak-parameters.md) in more than one way:

- **Ranges:** `vmb` is `[0..192]` (not 240), `vol` `[-2080..480]` (not -2048).
- **Lengths:** `gebg` is **len 40**, not 20.
- **Hidden root params:** `scpe` (`[0..2]`) and `test` (`[0..1]`) — never exposed by Java.
- **Unit scale:** per-param `frac_bits` (the engine's own fixed-point exponent),
  which the docs otherwise hardcode (e.g. "÷16").

[`ddp_probe` experiment 10](../../tools/ddp_probe/README.md) dumps the full table
(name · length · range · frac_bits) by walking the tree — the exact data a
`parameters.toml` generator should emit, instead of transcribing Java by hand.

## Symbol offsets (v8.1 `libdseffect.so`)

For re-derivation against this build (`.text` offsets):

```
ak_resolve 0x19e1c   ak_find    0x1a0b4   ak_enum        0x1a1ec   ak_count_defs 0x195cc
ak_get     0x1a904   ak_get_bulk 0x1a5a4  ak_set         0x1af58   ak_set_bulk   0x1b070
ak_get_name 0x1a2a0  ak_get_min 0x1a2d4   ak_get_max     0x1a308   ak_get_length 0x1a424
ak_get_type 0x1a26c  ak_get_flags 0x1a574 ak_get_frac_bits 0x1a33c  ak_get_string 0x1a370
```
