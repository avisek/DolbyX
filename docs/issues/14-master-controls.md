# Slice 14 — Master controls (Surround Virtualizer / Dialog Enhancer / Volume Leveller)

**Goal.** The main screen shows the three signature DDP controls — each a
toggle + amount slider. Adjusting one writes the backing AK param(s) to the
active profile, flushes to the engine, persists, and broadcasts.

**Blocked by:** Slice 10.
**Mode:** AFK.

## What to build

- **`MasterControls.tsx`** holding the `MASTER_CONTROLS` descriptor —
  three ordered `(label, enable, amount)` entries:

  | Control | Enable | Amount |
  |---|---|---|
  | Surround Virtualizer | `vdhe` (Tristate, on = 2) | `dhsb` |
  | Dialog Enhancer | `deon` | `dea` |
  | Volume Leveller | `dvle` | `dvla` |

  A curated UI overlay, *not* an engine category or `ParameterDef` field —
  the same params also appear in the Advanced panel under their feature
  categories. Each half resolves its `kind`, range, and `frac_bits` from
  the bootstrap `params` by 4-CC — nothing hardcoded beyond the 4-CCs.
- Bespoke toggle + amount-slider widgets; edits go through
  `edit_profile` against the active profile (1-entry batches; continuous
  drags debounced ~60 ms like all continuous controls).
- **`lib/units.ts`** (UI) + **`ddp-state/src/conversion.rs`** (daemon):
  int16 1/16-dB ↔ display dB helpers, driven by `frac_bits` — the UI is
  the only layer that converts (epic invariant). `proptest` gate on the
  Rust side for invertibility (dB ↔ 1/16 dB, dB-clamp ↔ engine-clamp);
  Vitest mirror on the TS side.

## Behaviors to test

1. [ ] The three controls render from the descriptor, halves resolved
       against bootstrap metadata (kind/range/frac).
2. [ ] Toggling Volume Leveller writes its enable to the active profile →
       1-entry `set_params` on the Stub.
3. [ ] Dragging Dialog Enhancer amount writes `dea` (debounced) with
       correct dB → i16 conversion.
4. [ ] Surround Virtualizer toggle maps per `Tristate { on: 2 }`
       (off = 0, on = 2 — not 1).
5. [ ] Values are per-profile: switching profiles shows that profile's
       values.
6. [ ] Edits persist across daemon restart.
7. [ ] A master-control edit broadcasts to other clients, originator
       suppressed.
8. [ ] `proptest`: i16 ↔ dB round-trips within quantization; clamps
       agree with `ParameterDef` min/max.
9. [ ] qemu replay: engine-side `get_params` confirms the written values
       (clamped registry).

## Tracer bullet

WS `edit_profile` carrying the Volume Leveller amount on Music → assert
Stub recorded the write and `config.toml` persisted it.

**Mock policy.** Stub for dispatch; UI via `@solidjs/testing-library` +
mocked WS; behavior 9 real.

## References

- Epic: invariants (i16 rule, single write path), wire protocol
- `docs/ddp/02-ak-parameters.md` — `vdhe`
  on = 2, param semantics
- CONTEXT.md — "Master control"
