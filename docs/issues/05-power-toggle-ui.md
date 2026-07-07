# Slice 05 — Power toggle in the browser (tracer bullet, part 2)

**Goal.** Opening `http://localhost:9876` shows a Power toggle that
reflects and flips daemon state, with a connection badge and an
auto-reconnecting WebSocket. Completes the tracer bullet through the UI
layer.

**Blocked by:** Slices 02, 04.
**Mode:** AFK.

## What to build

- **Store hydration** (`store/state.ts`): read `window.__BOOTSTRAP__`
  synchronously at module init, hydrate the Solid store, paint fully
  populated on the first frame — no pre-paint network round-trip. The WS
  then connects in the background; its `state` event reconciles any drift
  between HTML render time and connect time.
- **WS client** (`store/ws.ts` + `lib/ws.ts`): typed command/event layer;
  client-generated `request_id`, promise-style await of the matching
  `ack`/`error`; on any `error`, re-issue `get_state` to reconcile;
  auto-reconnect with backoff after socket drop or daemon restart, then
  `get_state` + reconcile.
- **`PowerToggle.tsx`**: renders `state.power`, sends `set_power` on
  click. Local-first: the originator applies its own change on `ack` (the
  broadcast goes to *other* clients — epic: originator-aware broadcast).
- **`ConnectionBadge.tsx`**: connected / reconnecting states driven by the
  WS client.
- Theming: first real use of `theme.css` variables (dark navy bg, cyan
  accent) — keep it minimal; full DDP look lands with the visualizer
  slices.

## Behaviors to test

1. [ ] Store hydrates from a fixture `__BOOTSTRAP__`; PowerToggle renders
       the initial power state on first paint (no WS needed).
2. [ ] Click sends `set_power` with a fresh `request_id`; `ack` resolves
       the pending promise and applies the flip.
3. [ ] An incoming `state` event (other-client change) updates the toggle.
4. [ ] An `error` event triggers a `get_state` reconcile.
5. [ ] Socket drop → badge shows reconnecting; reconnect → `get_state`
       issued, badge shows connected, state reconciled.
6. [ ] Manual demo: `just dev`, flip toggle in two tabs — each tab's
       change appears in the other; daemon restart → both tabs recover.

## Tracer bullet

Vitest + `@solidjs/testing-library` with a mocked WebSocket: render App
with fixture bootstrap, click PowerToggle, assert the mock WS saw
`set_power` and the UI settled after a fabricated `ack`.

**Mock policy.** Mocked WebSocket in unit tests (per
ADR-0006 (`docs/adr/0006-solid-ui-with-bootstrap-injection-no-api.md`));
manual demo against the real daemon. Real-browser E2E lands in Slice 09.

## References

- Epic: wire protocol (ack/error, originator rule), dev workflow
- Slice 04 — the daemon contract this consumes
