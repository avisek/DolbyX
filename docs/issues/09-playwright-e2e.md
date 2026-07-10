# Slice 09 — Playwright E2E harness

**Goal.** Playwright drives a real browser against the real daemon +
`QemuBackend` + `libdseffect.so`; the first spec covers the power toggle
end-to-end. Later slices add specs where meaningful.

**Blocked by:** Slices 05, 08.
**Mode:** AFK.

## What to build

- Playwright config in `ui/` targeting the daemon origin
  (`localhost:9876`), with a fixture that builds the UI (singlefile),
  starts the daemon with `QemuBackend` on a temp config dir, and tears
  down cleanly.
- First spec: page loads fully populated on first paint (bootstrap — no
  fetch waterfall), toggle power, assert persistence across a daemon
  restart, assert a second page reflects the change (broadcast).
- CI wiring: E2E job on Linux (qemu provisioned in Slice 06's CI work),
  gated to run after unit/integration jobs.
- `Justfile`: `just e2e`.

Why real everything (epic test policy): mocking the daemon's WS would
duplicate daemon logic in fixtures and drift; mocking the engine would
skip the binary protocol, AK binding, and lifecycle — where the
integration risk lives.

## Behaviors to test

1. [ ] First paint is fully populated (no loading flash), straight from
       bootstrap.
2. [ ] Power toggle round-trips: click → engine → restart daemon → state
       survives → UI reconnects and reconciles (ConnectionBadge cycles
       reconnecting → connected).
3. [ ] Two pages: change in one appears in the other (originator
       suppression means the *originator* updates from its `ack`, the
       other from broadcast).
4. [ ] `just e2e` green locally and in CI.

## Tracer bullet

Spec: open page → `power` toggle reflects bootstrap state → click →
restart daemon fixture → reload → still toggled.

**Mock policy.** Nothing mocked, by definition of this slice.

## References

- Epic: code-quality standards (test policy)
- Slices 05, 08 — the stack under test
