# Slice 11 — `AudioServer` + plugin protocol (both adapters)

**Goal.** The daemon accepts plugin connections on the platform socket
(Windows named pipe + Unix socket), a synthetic plugin client can
`Hello` / `Process` / `Goodbye`, and audio round-trips through the shared
engine subprocess with correct multiplexing. No real plugin yet (VST:
Slice 13; LV2: Slice 21).

**Blocked by:** Slice 08.
**Mode:** AFK — synthetic clients keep this CI-testable on both platforms
(Linux runner: AF_UNIX + qemu engine; Windows runner: named pipe + Stub).

## What to build

- **`AudioServer`** (`ddp-daemon/src/audio_server.rs`):
  `accept_loop(supervisor) → !` speaking the epic's *Plugin ↔ daemon*
  protocol (`Hello {sample_rate, max_frames}` → `HelloAck {session_id}`,
  `Process {frames, pcm}` → `Processed {pcm}`, `Goodbye` either way).
  Protocol handling is transport-agnostic over any duplex byte stream.
- **Two adapters** (`platform/windows.rs`, `platform/unix.rs`): Windows
  named pipe `\\.\pipe\DolbyX`
  (`tokio::net::windows::named_pipe`), Unix `/run/dolbyx/dolbyx.sock`
  (fall back to a `--socket-path` override for dev/tests; the systemd
  `RuntimeDirectory`/ACL story is Slice 22). A real seam — both adapters
  must be tested.
- **Session lifecycle**: `Hello` → `EngineSupervisor::create_session(rate)`
  (host-side validation from Slice 08 applies — a bad rate rejects the
  plugin cleanly); disconnect or `Goodbye` → destroy. The daemon never
  creates sessions on its own.
- **Multiplexing**: each plugin's audio stays on its own session id over
  the one shared engine subprocess; audio is int16 stereo end-to-end here.
- **Main-session dynamics** (epic invariant): oldest live session is
  main; when it dies, next-oldest takes over → supervisor re-reads the 8
  `readouts` from the new main (rate-derived `vnnb`/`vnbf` may differ) and
  broadcasts a fresh snapshot.
- **Power fan-out**: `set_power` reaches every live plugin session; a
  session created while power is off starts disabled (both already in the
  supervisor — now observable through real connections).

## Behaviors to test

1. [ ] Linux daemon binds the Unix socket; Windows daemon binds the named
       pipe (per-platform CI).
2. [ ] `Hello {48000, 512}` acked with a fresh session id; the engine
       session was created at 48000 (SET_CONFIG at the plugin's rate — no
       44.1 fallback, pitch preserved).
3. [ ] `Process` frames round-trip; with power on, processed PCM ≠ input;
       with power off (bypass), `OUT == IN`.
4. [ ] Two synthetic plugins multiplex — distinct sessions, no crosstalk
       (distinct test tones stay distinct).
5. [ ] `Goodbye` (and abrupt disconnect) destroys the session.
6. [ ] Main-session handover: kill the oldest client → next becomes main,
       `readouts` re-read + snapshot broadcast.
7. [ ] Toggling power fans `set_enabled` to all live sessions; a session
       created while power is off starts disabled.
8. [ ] Invalid `Hello` rate → clean protocol error, connection closed,
       daemon healthy.
9. [ ] qemu replay: 2–5 green under `--features qemu`.

## Tracer bullet

Loopback integration test: start daemon, connect a synthetic plugin over
the platform socket, push silence frames, assert `Processed` returns the
expected PCM (Stub: Slice 04's marker contract; real engine: within
transient bounds).

**Mock policy.** Real socket both platforms. Stub engine for Windows CI
and fast tests; real engine behind `--features qemu` on Linux.

## References

- Epic: plugin protocol table, invariants (sessions, main session, rate)
- ADR-0002 (`docs/adr/0002-backend-agnostic-engine-qemu-default.md`)
