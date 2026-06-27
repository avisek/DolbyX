# AK-direct parameter surface; cmd protocol for lifecycle

The ARM engine shim binds to `libdseffect.so` two ways, split by surface.
**Parameters** (read / write / batch) go through the engine's exported AK
accessors — `ak_find` (4-CC → ref), `ak_set` / `ak_set_bulk` (write),
`ak_get` / `ak_get_bulk` (read) — *not* the cmd protocol's DEFINE_PARAMS +
DEFINE_SETTINGS handshake and cmd 2 / 3 / 4. **Lifecycle** (EffectCreate, INIT,
SET_CONFIG, ENABLE / DISABLE, `process`, version) stays on the cmd protocol.

The cmd param path is a thin wrapper over AK. `tools/ddp_probe/akctl_probe.c`
(`make -C tools/ddp_probe akctl`) shows cmd 3 SET ≡ `ak_set` **bit-for-bit** at
the DSP: two handles with identical history, one written via cmd 3
(cache = 160 / registry = 160), one via bare `ak_set` (cache = 0 / registry =
160), produce byte-identical output. `ak_set` only stores into the registry;
coefficient recompute is `ak_update` inside `ak_process`, which reads the
registry **live every block** — so there is no commit / dirty step the cmd path
performs and a bare write doesn't. (Structural params — band count / centre
frequencies — are the one subtlety: their filterbank re-derive is commit-gated,
but *identically* for both paths; see [Structural-param commit](#structural-param-commit-lives-in-the-shim)
below.) The handshake merely builds the name→ref and
flat-index tables that `ak_find` + `(ref, elem)` addressing make unnecessary,
plus a settings-cache write the DSP ignores.

Going AK-direct on the param surface drops the init handshake; drops the
flat-index table (and with it the `begin + count` straddle bug — `ddp_probe`
#8b); gives a **real per-param GET** via `ak_get` (the clamped value the DSP
actually uses — the engine has no cmd 3 GET, so [ADR-0002](0002-backend-agnostic-engine-qemu-default.md)'s
original daemon-mirror-only read story is superseded); exposes authoritative metadata
(`ak_get_min`/`max`/`length`/`type`/`flags` + name/description strings) for free;
is name-based natively; and simplifies the future Unicorn backend (fewer, leaner
ARM entry points, no `effect_param_t` marshalling). The blast radius is the shim
only — the `Engine` trait and the daemon↔subprocess protocol stay name-based,
gaining `get_param` / `get_params` (and the `GetParam` / `GetParams` opcodes)
now that a read is a single `ak_get` / `ak_get_bulk`. This also folds the
visualizer in: `vcbg`/`vcbe` are two ReadOnly leaves read by that same
`get_params` path, so v2 needs no cmd-4 visualizer call.

Lifecycle stays on cmd because it has no host-side wrapper complexity to remove —
its complexity is engine-internal orchestration the cmd handler already
encapsulates. SET_CONFIG (cmd 1) is the case in point
(`tools/ddp_probe/setconfig_probe.c`, `make setconfig`): one
`command(EFFECT_CMD_SET_CONFIG)` validates the config, rebuilds the `Ds1ap` at
the new rate via `Ds1ap::New` → `ak_set_input_config`, re-applies every param,
and re-inits the audio buffer. Driving that by hand against the internals is
exactly what v1's `Ds1ap::New` hot-swap does — partially and buggily (leaks the
old `Ds1ap`, leaves a stale buffer, no validation). ENABLE / DISABLE likewise
carry a graceful crossfade that `ak_start` / `ak_stop` don't (`setconfig_probe`
Sc9: ~23-block wet→dry on DISABLE, after which the engine deposits the dry input
itself — so WRITE-mode bypass is `OUT == IN`, no host copy). cmd lifecycle is
simpler *and* safer; AK-direct there would be harder *and* riskier.

Cost: AK-direct couples to one internal context offset (`H + 0x44`,
double-deref → AK handle) plus the exported `ak_*` symbols — not a stable
ABI. Accepted because the
binary is EOL and bundled, version-pinned with the repo
([ADR-0009](0009-bundle-libdseffect-so.md)); v1 and the probes already depend on
these offsets; and the coupling is encapsulated behind the backend FFI boundary
with `// SAFETY:` notes. The cmd protocol's per-device settings cache is bypassed
(the AK registry is single-set) — acceptable, per-device routing is a non-goal.

## Structural-param commit lives in the shim

The "reads the registry live every block" claim holds for the per-block-smoothed
values (gains, thresholds), but each feature's filterbank *structure* — band count
+ centre frequencies — is **commit-gated**. The engine keeps a per-feature
validity word (GEQ `0x5c0`, IEQ `0x718`, AO `0x870`, AR `0x9c8`); a count/frequency
write only stages it, and the filterbank re-derives at the next `process` block
only once the group's **commit leaf** (its last payload array) is re-written, which
sets bit `0x40`. The four groups: GEQ→`gebg`, IEQ→`iebt`, AO→`aobg`, AR→`arbh`.
This is identical for cmd 3 and `ak_set` (both stage the same way, both commit by
writing the leaf), so the bit-for-bit equivalence above is unaffected. Evidence:
[`reshape_probe`](../../tools/ddp_probe/README.md#reshape_probe--runtime-reshape-of-structural-constants-make-reshape),
[docs/ddp/02](../ddp/02-ak-parameters.md#changing-them-at-runtime-the-commit-protocol).

The quirk is hidden **inside the shim**, never above it. `set_param` / `set_params`
own a static 4-group → commit-leaf map — engine-binding knowledge, versioned with
the binary, *not* a column in the `ParameterDef` table ([ADR-0004](0004-parameter-metadata-as-single-source-of-truth.md)),
which is product metadata. After staging a batch's writes, the shim re-writes each
touched group's commit leaf once, with its current value (a local `ak_get`) unless
the batch already carried it — **touch = commit**. So `set_param("genb", &[10])`
commits on its own; the daemon, the `Engine` trait, and `ParameterDef` never
mention commit leaves. No daemon↔engine round-trip — the `ak_get` is local to the
shim. And storage is fixed-capacity-40: a count change never zeroes the
out-of-range slots ([`reshape_probe` finding D](../../tools/ddp_probe/README.md#reshape_probe--runtime-reshape-of-structural-constants-make-reshape)),
so there is no array re-alignment to do — the leaf touch is the whole rule.

**Rejected — poking bit `0x40` directly** in the validity word (via
`ak_data(ak_parent(ref))` + the hardcoded offset). It skips the value re-write, but
couples to struct *offsets* instead of stable param *names*, must faithfully
replicate the preupdate read-modify-write (`bic #0x04, orr #0x40`) and the bitfield
state machine, races `root_preupdate` (which touches the same word every block),
and adds a second, `unsafe` access path whose failure mode is silent corruption.
Touch-the-leaf uses only the AK API this ADR standardises on and fails cleanly —
the simpler option despite "set a bit" sounding lighter.
