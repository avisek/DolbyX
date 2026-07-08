# Slice 21 — LV2 plugin + PipeWire filter-chain

**Goal.** `libdolbyx.lv2` loaded in a PipeWire `filter-chain` ferries
Linux playback through the daemon — feature parity with the Windows VST
path.

**Blocked by:** Slice 11.
**Mode:** HITL — the PipeWire smoke test needs a manual session on a Linux
desktop (or WSLg) with audio.

## What to build

- **`ddp-lv2-linux`** cdylib + `dolbyx.ttl` (stereo in/out, no control
  ports — all control via the Web UI), mirroring the VST shim's behavior:
  connect `/run/dolbyx/dolbyx.sock`, `Hello` at the host rate,
  float32 ↔ int16 at the boundary, dry pass-through + reconnect when the
  daemon is down, `Goodbye` on deactivate. The plugin-client core
  (connect / `Hello` / convert / dry-fallback / `Goodbye`) is shared with
  the VST shim (Slice 13): whichever slice lands second extracts it into
  a common crate rather than duplicating it.
- Example PipeWire `filter-chain` config, checked in and documented
  (smoke-only — Slice 22 packages it).

## Behaviors to test

1. [ ] Bundle validates (`lv2lint` / `lv2ls` sees it); TTL matches the
       binary's ports.
2. [ ] Synthetic LV2 host test: instantiate → activate → run ferries
       audio through the daemon; deactivate sends `Goodbye`.
3. [ ] Daemon down → dry pass-through, later reconnect (no xruns from
       blocking).
4. [ ] Manual: PipeWire `filter-chain` loads the example config; system
       audio flows; power toggle + profile switch audible.
5. [ ] qemu replay of the synthetic-host test.

## Tracer bullet

Synthetic host: run one block of a sine through the plugin against a live
daemon (Stub), assert the `Process`/`Processed` round-trip and sample
fidelity.

**Mock policy.** Synthetic host automated; real PipeWire manual. Stub for
fast tests, real engine for behavior 5.

## References

- Epic: plugin protocol
- Slice 13 — VST twin; mirrors this plugin-client core
- Slice 11 — AF_UNIX adapter (already CI-tested)
