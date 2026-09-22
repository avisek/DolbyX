# AK-direct parameter surface; cmd protocol for lifecycle

The ARM shim binds `libdseffect.so` two ways, split by surface.
**Parameters** (set/get, batch) go through the engine's exported AK
accessors — `ak_find` plus the bulk pair `ak_set_bulk` / `ak_get_bulk`
(a scalar accessor is just a count=1 bulk call) — *not* the cmd
protocol's DEFINE_PARAMS + DEFINE_SETTINGS handshake and cmds 2/3/4.
**Lifecycle** (EffectCreate, INIT, SET_CONFIG, ENABLE/DISABLE, `process`)
stays on the cmd protocol.

**Why AK-direct for params.** The cmd param path is a thin wrapper over
AK: cmd 3 SET ≡ `ak_set` **bit-for-bit** at the DSP — the DSP recomputes
from the AK registry live every block; the handshake only builds lookup
tables that `ak_find` addressing makes unnecessary, plus a
settings-cache write the DSP ignores (proven:
[`akctl_probe`](../../tools/ddp_probe/README.md)). Going direct drops
the init handshake and the flat-index table (with its `begin + count`
straddle bug), gives a **real per-param GET** of the live clamped
registry (the engine has no cmd 3 GET), is name-based natively, and
leaves fewer, leaner ARM entry points for the future Unicorn backend.
The visualizer folds in for free: the shim appends the four
ReadOnly-Dynamic arrays — plus the `gebg` in force, read from the same
registry — to every `Process` reply (the **vis tail**), so v2 needs no
cmd-4 call.

**Why lifecycle stays cmd.** Its complexity is engine-internal
orchestration the cmd handler already encapsulates: SET_CONFIG
validates, rebuilds the `Ds1ap` at the new rate, re-applies every param,
re-inits buffers — v1 drove those internals by hand, partially and
buggily — and DISABLE runs a graceful wet→dry crossfade that `ak_stop`
lacks ([`setconfig_probe`](../../tools/ddp_probe/README.md)). AK-direct
there would be harder *and* riskier.

**Cost.** Couples to one internal context offset (`H + 0x44` → AK
handle) plus the exported `ak_*` symbols — not a stable ABI. Accepted:
the binary is EOL and version-pinned with the repo
([ADR-0009](0009-bundle-libdseffect-so.md)), v1 and the probes already
depend on these offsets, and the coupling stays behind the backend FFI
boundary with `// SAFETY:` notes. The cmd protocol's per-device settings
cache is bypassed — fine, per-device routing is a non-goal.

## Structural-param commit: touch the leaf, in the shim

One exception to "the registry is read live": each feature's filterbank
*structure* (band count + centre frequencies) is **commit-gated** — a
write only stages it until the group's **commit leaf** (its last payload
array) is rewritten. Identical for cmd 3 and `ak_set`, so the
equivalence above is unaffected. Evidence:
[`reshape_probe`](../../tools/ddp_probe/README.md#reshape_probe--runtime-reshape-of-structural-constants-make-reshape),
[ddp/02](../ddp/02-ak-parameters.md#changing-them-at-runtime-the-commit-protocol).

The quirk hides **inside the shim**, never above it: after staging a
batch, `set_params` re-writes each touched group's commit leaf with its
current value — **touch = commit**, even unchanged, no daemon
round-trip. The static 4-group → leaf map is engine-binding knowledge
versioned with the binary — *not* a `ParameterDef` column
([ADR-0004](0004-parameter-metadata-as-single-source-of-truth.md)); the
daemon and the `Engine` trait never see commit leaves.

**Rejected — poking commit bit `0x40` directly** in the per-feature
validity word: it couples to struct *offsets* instead of stable param
*names*, must replicate the engine's read-modify-write and bitfield
state machine, races `root_preupdate` (which touches the same word every
block), and fails as silent corruption. Touch-the-leaf uses only the AK
API this ADR standardises on and fails cleanly.
