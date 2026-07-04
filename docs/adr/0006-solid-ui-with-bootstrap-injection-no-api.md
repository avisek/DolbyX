# Solid.js UI with bootstrap injection, no `/api/*` routes

The Web UI uses Solid.js + TypeScript built by Vite. The daemon serves
the UI HTML from disk beside the binary — nothing is embedded in the
daemon (dev: a flag points at the checked-in `ui/dev.html`; a missing
file refuses startup). At request time it string-replaces the file's
`<!--BOOTSTRAP-->` placeholder to inject parameter metadata and
the initial state snapshot as a single `window.__BOOTSTRAP__` global.
The UI reads it synchronously at module init so the page paints fully
populated on the first frame with no pre-paint network round-trip.
There are intentionally **no `/api/*` routes** in dev or prod — all
subsequent state flows through one WebSocket connection per UI tab.
Solid's fine-grained reactivity matches the high-frequency reactive
updates (visualizer levels, GEQ thumb drag) without VDOM diff overhead,
at ~7 KB runtime vs React's ~45 KB. State is single-channel, so there
is no REST/WS impedance mismatch to manage.
