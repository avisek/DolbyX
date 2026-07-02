# Solid.js UI with bootstrap injection, no `/api/*` routes

The Web UI uses Solid.js + TypeScript built by Vite. Parameter metadata,
the initial state snapshot, and immutable engine info (backend) are
injected into `index.html` at request time as a single
`window.__BOOTSTRAP__` global. The UI reads it synchronously at module
init so the page paints fully populated on the first frame with no
pre-paint network round-trip. There are intentionally **no `/api/*`
routes** in dev or prod — all subsequent state flows through one
WebSocket connection per UI tab. Solid's fine-grained reactivity matches
the high-frequency reactive updates (visualizer levels, GEQ thumb drag)
without VDOM diff overhead, at ~7 KB runtime vs React's ~45 KB. State is
single-channel, so there is no REST/WS impedance mismatch to manage.
