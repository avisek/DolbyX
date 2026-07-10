# Slice 07 — `ddp-engine-arm`: AK-direct params + commit leaf + vis tail

**Goal.** The ARM shim serves `SetParams` / `GetParams` through the
engine's exported AK accessors and appends the 160-byte vis tail to every
`Process` reply — completing the engine protocol surface.

**Blocked by:** Slice 06.
**Mode:** AFK — every call pattern here is already proven by
`akctl_probe`; the harness from Slice 06 extends.

## What to build

(ADR-0010 — `docs/adr/0010-ak-direct-params-cmd-lifecycle.md`) The parameter
surface binds to `ak_find` (4-CC → ref), `ak_set_bulk`, `ak_get_bulk` —
**not** the cmd protocol. cmd 3 SET ≡ `ak_set` bit-for-bit at the DSP
(proven by `akctl_probe`; the cmd path only adds a name→ref table, a
flat-index map, and a dead settings-cache write). Going direct drops the
handshake, drops the flat-index footgun, and is name-based natively.

- **`SetParams` (0x10)**: resolve each 4-CC via `ak_find` (resolve all
  once at session init; cache per handle), write each entry with
  `ak_set_bulk`. Stride is fixed at **4** (packed int16) — a count=1 bulk
  write hits the same clamp+store core as the scalar accessors, so
  clamping, write-protect (`0x2`), no-recompute, and structural-commit
  behave identically. All values land before the next `process` block —
  the batch applies atomically on one audio block (the DSP recomputes from
  the registry per block).
- **Structural-param commit (touch = commit).** Band count / centre
  frequencies are *staged* by the engine; the filterbank re-derives only
  when the group's **commit leaf** (its last payload array) is rewritten —
  even unchanged. Static 4-group map, shim-internal (never in
  `ParameterDef`, never above the trait):

  | Group (structural params) | Commit leaf |
  |---|---|
  | `genb`, `gebf` | `gebg` |
  | `ienb`, `iebf` | `iebt` |
  | `aonb`, `aocc`, `aobf` | `aobg` |
  | `arnb`, `arbf` | `arbh` |

  After staging a batch, touch each affected group's commit leaf with its
  current value (local `ak_get_bulk` → `ak_set_bulk`; no daemon
  round-trip). Storage is fixed-capacity (40), so a count change never
  re-aligns arrays — only commits.
- **`GetParams` (0x11)**: loop `ak_get_bulk` per name, count = the leaf's
  engine length (`ak_get_length`). Returns the live **clamped** registry
  values the DSP actually uses — the only true per-param read (the engine
  has no cmd 3 GET; its real GET paths — cmd 4 visualizer, cmd 6 version,
  cmd 7 echo — are not general reads).
- **Vis tail**: after each `process()`, append `vnbg ‖ vnbe ‖ vcbg ‖ vcbe`
  (4 × 20 i16 = 160 bytes) to the `Process` reply via local `ak_get_bulk`
  — one per array, no extra round-trip, no dedicated opcode. Rides
  **every** reply, including bypassed blocks (vis is process-driven, not
  power-gated).

## Behaviors to test (harness from Slice 06)

1. [ ] `SetParams` batch of scalars (`dvla`, `deon`) → `GetParams` reads
       them back.
2. [ ] Out-of-range write is silently clamped: set `vmb = 480`, read back
       192 (probe §7 ground truth).
3. [ ] Write to a write-protected leaf (`vnnb`) is a silent no-op; status
       still 0.
4. [ ] Structural reshape: set `genb = 20` + 20-band `gebf` + `gebg` in
       one batch → `GetParams("genb")` = 20 and the engine's native grid
       readout stays consistent (10 → 20-band reshape works from power-on
       state).
5. [ ] Commit-leaf touch fires even when the commit leaf itself isn't in
       the batch (set only `genb`/`gebf` → reshape still applies).
6. [ ] `GetParams(["ver"])` returns the version slots for a formatted
       `2.0.4.0`.
7. [ ] Every `Process` reply carries exactly 160 extra bytes; with a tone
       playing and `ven = 1`, `vnbg`/`vnbe` are non-zero and `vc*` == `vn*`
       (custom grid not yet reconfigured).
8. [ ] `SetParams` on session A doesn't affect session B (AK registries
       are per-handle).

## Tracer bullet

Harness test: `SetParams [("dvla", [8])]` → `GetParams ["dvla"]` returns
`[8]`; then `SetParams [("dvla", [200])]` → reads back the engine clamp
(10).

**Mock policy.** Real engine under qemu; nothing mocked.

## References

- Epic: engine protocol table, validation section (clamp semantics)
- ADR-0010 (`docs/adr/0010-ak-direct-params-cmd-lifecycle.md`)
- `docs/ddp/07-ak-api.md` — AK accessors, per-handle
  registries
- `docs/ddp/03-binary-protocol.md#the-ak-registry-read-path`
- `tools/ddp_probe/README.md` —
  `akctl_probe` (§5b), clamp evidence (§7), reshape_probe
