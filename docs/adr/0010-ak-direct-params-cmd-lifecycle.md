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
performs and a bare write doesn't. The handshake merely builds the name→ref and
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
