# Slice 13 — VST2 plugin + EqualizerAPO (daily-driver milestone)

**Goal.** `DolbyX.dll` loaded in EqualizerAPO ferries system playback
through the daemon's engine: music audibly gets the DDP treatment, the
profile switch is audible, and the UI opens from the plugin. **This is the
milestone where DolbyX v2 replaces v1 as the daily driver.**

**Blocked by:** Slices 11, 12.
**Mode:** HITL — end-to-end smoke requires manual install into
EqualizerAPO on the dev machine.

## What to build

- **`ddp-vst-windows`** cdylib: a thin VST2 shim (no DSP, no state — all
  control lives in the Web UI):
  - On resume/init: connect `\\.\pipe\DolbyX`, send
    `Hello {sample_rate, max_frames}` from the host's processing setup,
    keep the `session_id`.
  - `processReplacing`: convert host float32 → int16 stereo **once at the
    host boundary**, send `Process`, write `Processed` back as float32.
    Degrade gracefully when the daemon is down (pass-through dry +
    periodic reconnect) — audio must never stop.
  - `effEditOpen`: `ShellExecuteW` → `http://localhost:9876` (the plugin
    has no editor of its own).
  - Disconnect / suspend → `Goodbye`.
- Rate changes from the host = `Goodbye` + fresh `Hello` (sessions are
  rate-immutable — epic invariant).
- Build as a Windows cross/native target; artifact name `DolbyX.dll`.
- Short install doc: EqualizerAPO config line + where to drop the DLL
  (feeds Slice 22's packaging).

## Behaviors to test

1. [ ] Protocol unit tests: float32↔int16 conversion (round-trip,
       clipping saturates, no DC offset), framing against a fake pipe.
2. [ ] Synthetic VST host test (Rust harness calling the exported VST
       entry): resume → Hello sent; process → audio round-trips; suspend
       → Goodbye.
3. [ ] Daemon down: plugin passes audio through dry, reconnects when the
       daemon returns (no host stall, no glitch loop).
4. [ ] Manual: EqualizerAPO loads the DLL; system audio flows; power
       toggle audibly enables/disables (crossfade, not a click); profile
       switch (Music ↔ Movie) audibly changes character.
5. [ ] `effEditOpen` opens the UI in the default browser.
6. [ ] Two hosts / two plugin instances (e.g. EqualizerAPO + a DAW):
       independent sessions, no crosstalk.

## Tracer bullet

Harness test: load the cdylib's VST entry, drive
resume → processReplacing with a sine → assert output ≠ input while the
daemon (Stub or real engine) is up, and output == input (dry) when it's
down.

**Mock policy.** Synthetic host for automated tests; real EqualizerAPO for
the manual smoke. Real daemon + real engine for the audible checks.

## References

- Epic: plugin protocol, architecture diagram (VST shim)
- v1 VST via `git show v1:windows/vst/…` — proven VST2 ABI details
- Slice 11 — the daemon side this connects to
