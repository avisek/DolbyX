# Solid.js UI with bootstrap injection, no `/api/*` routes

The Web UI is Solid.js + TypeScript, Vite-built, served from disk beside
the daemon binary — nothing embedded; a missing file refuses startup. At
request time the daemon replaces the HTML's `<!--BOOTSTRAP-->`
placeholder with parameter metadata + the initial state snapshot as a
single `window.__BOOTSTRAP__` global; the UI reads it synchronously at
module init, so the first paint is fully populated with no pre-paint
network round-trip. There are deliberately **no `/api/*` routes** in dev
or prod: all subsequent state flows over one WebSocket per UI tab — a
single channel, no REST/WS impedance mismatch. Solid's fine-grained
reactivity fits the high-frequency updates (visualizer levels, GEQ thumb
drag) without VDOM diff overhead, at ~7 KB runtime vs React's ~45 KB.
