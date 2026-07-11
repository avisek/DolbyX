# DolbyX UI

Solid.js + TypeScript SPA, Vite-built, served by the daemon. The browser
always visits the daemon at `localhost:9876` — there are no `/api/*`
routes; all live state flows over one WebSocket
([ADR-0006](../docs/adr/0006-solid-ui-with-bootstrap-injection-no-api.md)).

## How it boots

The daemon reads one HTML file from disk and replaces `<!--BOOTSTRAP-->`
with a script defining `window.__BOOTSTRAP__` (full parameter table +
initial state snapshot). `main.tsx` reads it synchronously at module
init, so the first paint is fully populated; the WS connects in the
background and reconciles drift.

- **prod** — `dist/index.html`: `vite-plugin-singlefile` inlines all
  JS+CSS into one file (placeholder intact, build-enforced);
  `just build-release` places it beside the daemon binary.
- **dev** — `dev.html`: same placeholder, loads modules straight from
  Vite on `:5173`. `main.tsx` bounces direct `:5173` visits back to the
  daemon.

## Dev workflow

`just dev` (repo root) runs the daemon under `cargo watch` + `pnpm dev`,
concurrent with prefixed output. Rust edits restart the daemon; TS/CSS
hot-reload through the daemon's origin. Inside `ui/`: `pnpm dev` /
`build` / `test` / `lint` / `format`.

## Architecture

- `src/main.tsx` — bootstrap guard + mount
- `src/App.tsx` — root shell
- `src/store/` — `solid-js/store` state (no third-party state lib)
- `src/lib/` — bootstrap contract, parameter metadata, WS client, unit
  helpers (arriving with their slices)
- `src/styles/` — `theme.css` design tokens (skins swap variables, not
  code) + `base.css` resets; components carry their own BEM `.css` files

Conventions: strict TS (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); ESLint `strict-type-checked` +
`eslint-plugin-solid`; Prettier; Vitest + `@solidjs/testing-library` on
happy-dom. Params ride the wire as i16 1/16-dB — the UI converts to dB
for display only.
