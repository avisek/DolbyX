# Slice 08 — `QemuBackend` + supervisor respawn + swap & replay

**Goal.** The daemon's default engine is the real one: `QemuBackend`
spawns the shared `qemu-arm-static` subprocess, `EngineSupervisor`
initializes sessions against it and respawns it on crash, and the Slice 04
integration suite replays green under `cargo test --features qemu`.

**Blocked by:** Slices 04, 07.
**Mode:** HITL — first daemon-driven qemu green may need manual debugging
(silent engine failures look like clean exits).

## What to build

- **`QemuBackend`** (`ddp-engine/src/qemu.rs`), implementing `Engine`:
  spawns **one** `qemu-arm-static <ddp-engine-arm>` subprocess (engine
  binary + `libdseffect.so` resolved beside the daemon binary), speaks
  the shared `protocol.rs` framing over stdin/stdout, multiplexes all
  sessions onto it. On Windows it will spawn via `wsl.exe` stdio — that
  arrives in Slice 12; keep the spawn command a seam.
- **Host-side validation, behind the trait** (surface unchanged): reject
  non-stereo and rates outside {44100, 48000, 32000} up front. Engine
  footguns being guarded: an out-of-set rate **silently falls back to
  44100** (still replying success); a **mono** channel mask **poisons the
  handle** (graph torn down before rejecting, `Ds1ap` NULL). Never send
  mono.
- **Session init sequence** (in `EngineSupervisor`, per
  ADR-0010 (`docs/adr/0010-ak-direct-params-cmd-lifecycle.md`)):
  `create_session` (INIT + SET_CONFIG at the session's rate — shim-side
  from Slice 06) → one `set_params` of the **resolved active profile**
  (+ selected EQ preset when those exist — before Slice 10 this is
  whatever `State` resolves, which is fine) → `set_enabled(power)`. No
  separate constant-params step; no `VISUALIZER_ENABLE` cmd 7 (`ven = 1`
  rides the profile apply from Slice 10 on). A session created while
  power is off starts disabled.
- **Respawn on crash**: supervisor detects subprocess death, respawns,
  recreates every live session (same rates), replays each session's
  resolved params + enable state; sessions keep their external ids —
  transparent to `AudioServer`/UI.
- **Real `readouts`**: on main-session init, `get_params` the 8
  ReadOnly-Static names, fill the snapshot `readouts`; `ver` formats as
  `2.0.4.0`.
- **Swap**: default daemon configuration binds `QemuBackend`.
  `StubBackend` stays for fast inner-loop tests; the `qemu` cargo feature
  binds the integration suite to the real engine
  (`ddp-daemon/tests/e2e_qemu.rs`). From Slice 10 on, every feature slice
  replays its integration tests under `--features qemu` as an acceptance
  tick.

## Behaviors to test

1. [ ] `QemuBackend::start` spawns exactly one subprocess; two
       `create_session` calls multiplex onto it.
2. [ ] Slice 04's integration tests pass under
       `cargo test --features qemu` (power toggle persisted end-to-end
       against the real engine).
3. [ ] `create_session(96000)` and mono configs are rejected host-side
       with a clear error; the engine never sees them.
4. [ ] Kill the subprocess mid-run: supervisor respawns; session map
       reconstructed; a subsequent `set_power` reaches the new process;
       WS clients keep working.
5. [ ] Snapshot `readouts` carry real engine values; `ver` = `2.0.4.0`
       (not `ParameterDef.default`).
6. [ ] Session init while power off: engine session starts disabled.
7. [ ] `just dev` against the real engine works on WSL2 (manual check).

## Tracer bullet

`cargo test --features qemu -p ddp-daemon power_toggle_persists` — the
Slice 04 tracer bullet, now against the real engine.

**Mock policy.** Real engine. Stub remains only for non-`qemu` runs.

## References

- Epic: invariants (sample rate, sessions, power), engine protocol
- ADR-0002 (`docs/adr/0002-backend-agnostic-engine-qemu-default.md`)
- ADR-0010 (`docs/adr/0010-ak-direct-params-cmd-lifecycle.md`)
- `docs/ddp/03-binary-protocol.md` —
  SET_CONFIG validation behavior
