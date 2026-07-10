# Slice 06 — `ddp-engine-arm`: protocol + session lifecycle + process

**Goal.** A cross-compiled ARMv7 binary loads `libdseffect.so`, speaks the
daemon↔engine binary protocol over stdin/stdout, and creates / enables /
processes / destroys sessions — verified by a standalone Rust harness
driving the subprocess under `qemu-arm-static`. No daemon involvement yet.

**Blocked by:** Slice 01.
**Mode:** HITL — the first qemu green needs manual investigation of any
session-init delta; the engine doesn't emit explicit errors for many
things, so silent failures look like clean exits.

## What to build

- **`protocol.rs`** — the length-prefixed framing from the epic's
  *Daemon ↔ engine subprocess* table, shared between `ddp-engine` and
  `ddp-engine-arm` (single definition; `ddp-engine-arm/src/protocol.rs`
  mirrors or depends on it). This slice implements ops 0x01–0x03 + 0x30;
  0x10/0x11 land in Slice 07.
- **`ddp-engine-arm`** (`target = armv7-unknown-linux-gnueabihf`):
  `main.rs` dlopens `libdseffect.so` (resolved from its own directory),
  reads framed commands from stdin, writes framed replies to stdout;
  `session.rs` maps `session_id → effect_handle_t` — one shared process
  multiplexes all sessions. Android/libc stubs: link the ones already
  proven under `tools/ddp_probe/` (relocated there in Slice 01).
- **Session lifecycle (cmd protocol — lifecycle stays on cmd, params
  don't;** ADR-0010 (`docs/adr/0010-ak-direct-params-cmd-lifecycle.md`)):
  - `CreateSession(rate)`: create handle → `EFFECT_CMD_INIT` → one
    `EFFECT_CMD_SET_CONFIG` at the requested rate, pinning **stereo +
    PCM16 + WRITE output mode**. The engine validates, rebuilds its
    `Ds1ap` at the rate, re-applies cached AK params
    (`docs/ddp/03-binary-protocol.md#effect_cmd_set_config-effect-command-1`).
    No DEFINE_PARAMS / DEFINE_SETTINGS handshake — ever.
  - `SetEnabled`: `EFFECT_CMD_ENABLE` / `EFFECT_CMD_DISABLE`.
  - `DestroySession`: release the handle.
- **`Process` (0x30)**: wraps `libdseffect.so`'s `process()`. WRITE mode
  means the engine **overwrites** the output buffer — no per-block
  `memset` (v1 used ACCUMULATE and had to). Disable is engine-owned: on
  DISABLE the engine crossfades wet→dry (≈125 ms; blocks still return
  `0`), then bypassed blocks return `-ENODATA` and — in WRITE mode —
  deposit the dry input straight into the output (`OUT == IN`, verified by
  `setconfig_probe` Sc9; same for a never-enabled session). So treat
  enabled, crossfading, and bypassed blocks identically: call `process()`,
  ship the output — no memset, no input→output copy. (This slice replies
  with audio only; the 160-byte vis tail is appended in Slice 07 — leave
  the reply layout ready for it.)
- **Standalone harness** (`ddp-engine/tests/qemu_smoke.rs` or a dedicated
  ARM-harness test, feature-gated `qemu`): spawns
  `qemu-arm-static <ddp-engine-arm>` directly, drives frames over
  stdin/stdout.
- **CI**: provision `qemu-user-static` via apt; build the ARM crate; run
  the harness; and wire the **`tools/ddp_probe` regression harness** into
  CI so the documented engine behaviors stay verified (cmd 3 ≡ `ak_set`
  via `akctl_probe`, `SET_CONFIG` rate-swap via `setconfig_probe`,
  cache-raw vs registry-clamped, the 7560 / 5512-sample crossfades).
- **Justfile**: recipe(s) for the ARM build (cross target install +
  build + harness run).

## Behaviors to test

1. [ ] `ddp-engine-arm` cross-compiles for
       `armv7-unknown-linux-gnueabihf`; CI builds it.
2. [ ] `CreateSession(48000)` → session id; INIT + SET_CONFIG issued;
       status 0.
3. [ ] Two sessions coexist; ids independent; destroy one, other still
       processes.
4. [ ] Enabled session: `Process` on a test tone returns processed PCM ≠
       input (effect active).
5. [ ] Never-enabled session: `Process` returns `OUT == IN` (dry deposit,
       WRITE mode).
6. [ ] Disable mid-stream: output crossfades then goes dry; no error
       surfaced to the caller (`-ENODATA` handled as bypass, per
       `setconfig_probe` Sc9).
7. [ ] Malformed frame (bad opcode / short payload) → error status reply,
       process stays alive.
8. [ ] Probe regression harness green in CI under `qemu-user-static`.

## Tracer bullet

Harness test: spawn the subprocess, `CreateSession(44100)` →
`SetEnabled(true)` → `Process` one block of a sine, assert status 0 and
output differs from input.

**Mock policy.** Nothing mocked — real `libdseffect.so` under qemu. This
slice *is* the boundary being made real.

## References

- Epic: engine binary protocol table, invariants (SET_CONFIG rules)
- ADR-0010 (`docs/adr/0010-ak-direct-params-cmd-lifecycle.md`)
- `docs/ddp/03-binary-protocol.md` —
  SET_CONFIG, effect commands, practical reminders
- `tools/ddp_probe/README.md` — probe
  harness targets; `setconfig_probe` Sc9
- v1 ARM-side code via `git show v1:arm/…` if a pattern is needed
