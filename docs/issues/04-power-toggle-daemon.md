# Slice 04 — Power toggle over the wire (tracer bullet, part 1)

**Goal.** The daemon serves `GET /` with an injected bootstrap and `/ws`;
a WS client can `set_power`, the `StubBackend` records `set_enabled`, and
the change survives a daemon restart. Demoable with `websocat` — no UI yet
(Slice 05 adds it).

**Blocked by:** Slice 03.
**Mode:** AFK.

This is the tracer bullet's daemon half: the smallest path through WS →
state → engine → persistence. Every later slice extends one axis.

## What to build

**Modules introduced** (interfaces in the epic's deep-modules table):

- `Engine` trait + `VisFrame` + `SessionId` in `ddp-engine`, plus
  `StubBackend` — records calls, fabricates replies; the one sanctioned
  test seam.
- `State` (`ddp-state`) — just `power` + `selected_profile = "music"` for
  now; `apply(Command) → Result<StateDiff, ValidationError>` shape from
  day one.
- `Persistence` (`ddp-persistence`) — root keys only (`power`,
  `selected_profile`), written to `config.toml` **only when diverging from
  factory** (fresh install: empty file — 0 bytes; the file is created
  empty on first run because the watcher and hand-editing need it to
  exist). Loads `parameters.toml` + `defaults.toml` at startup (a minimal
  hand-written `defaults.toml` with `power = true`,
  `selected_profile = "music"` suffices until Slice 10). 500 ms debounce
  shared across all on-disk fields; pending writes flushed on graceful
  shutdown (SIGTERM / Windows console close handler). Config path:
  platform data dir (`/var/lib/dolbyx/config.toml`,
  `%PROGRAMDATA%\DolbyX\config.toml`) with a `--config-dir` override for
  tests/dev.
- `HttpServer` (axum/hyper) — exactly two routes: `GET /` and `GET /ws`.
  `GET /` reads the HTML file from disk (`$(daemon-dir)/index.html`, or
  the `--ui <path>` flag → `ui/dev.html` in dev) and string-replaces
  `<!--BOOTSTRAP-->` with a `<script>` defining `window.__BOOTSTRAP__ =
  { params, state }` — re-serialized on every request. Missing/unreadable
  HTML, malformed `parameters.toml`/`defaults.toml` → **refuse to start**.
  Port from `--port` (default 9876), not config.
- `WsServer` + `WsCommands` — serde-typed commands `get_state` +
  `set_power`; every command answered by exactly one `ack`/`error`
  echoing `request_id`; full snapshot on connect and on `get_state`;
  **originator-aware broadcast** (internal `ConnId`, excluded from the
  `state` fan-out — see epic wire-protocol section); `INVALID_REQUEST` for
  malformed JSON / unknown cmd.
- `EngineSupervisor` — just enough to own the `Engine` instance and a
  creation-ordered session table; `set_power` fans `set_enabled` to all
  live sessions; **zero sessions → no engine call** (state-only).
- `tracing` setup (epic: Logging) — stdout human-readable, errors
  duplicated to stderr, `RUST_LOG` filter. (Rotating file target can wait
  for Slice 22.)

Snapshot shape: user-state + `readouts` map — with zero sessions the 8
ReadOnly-Static values come from `ParameterDef.default` (real values:
Slice 08).

## Behaviors to test (red → green order)

1. [ ] Daemon binds `:9876`; `GET /` returns HTML carrying valid
       `window.__BOOTSTRAP__` JSON (params: 64 defs, state).
2. [ ] WS `/ws` connects; first frame is a `state` event matching current
       `State`.
3. [ ] `set_power { on: false }` flips `State.power`; daemon replies `ack`
       echoing `request_id`.
4. [ ] With one session created via `EngineSupervisor`, `set_power`
       records `set_enabled(session, false)` on `StubBackend` exactly
       once; with zero sessions, no engine call at all.
5. [ ] Two concurrent WS clients; one issues `set_power`; only the *other*
       receives the broadcast `state` (originator excluded — its `ack`
       confirms).
6. [ ] `power` change debounces 500 ms then writes `config.toml`; factory
       values are omitted (overlay semantics).
7. [ ] Daemon restart reloads `power` from `config.toml`.
8. [ ] Graceful shutdown flushes a pending (not-yet-debounced) write.
9. [ ] Malformed JSON returns `{ type: "error", code: "INVALID_REQUEST" }`
       without crashing the connection.
10. [ ] With zero sessions, snapshot `readouts` carry
        `ParameterDef.default` values.
11. [ ] Missing UI HTML / malformed TOML → process exits nonzero with a
        clear error (refuse-to-start policy).
12. [ ] Refactor pass — extract duplication revealed by 1–11 without
        breaking green (never refactor while RED).

## Tracer bullet

Integration test: start daemon with `StubBackend`, create one session via
`EngineSupervisor`, connect via WS, send
`{ "cmd": "set_power", "on": false }`, assert `StubBackend` recorded
`set_enabled(session, false)` exactly once. Real axum test client, real
`tokio-tungstenite` on a bound port — no mocking past the `Engine` trait.

**Mock policy.** `StubBackend` only. HTTP + WS real; persistence against a
real tempdir.

## References

- Epic: wire protocol, data model, deep modules, invariants
- ADR-0005 (`docs/adr/0005-wire-protocol-i16-name-based-originator-aware.md`) — originator-aware broadcast
- ADR-0006 (`docs/adr/0006-solid-ui-with-bootstrap-injection-no-api.md`) — bootstrap injection
- ADR-0007 (`docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`) — overlay semantics
