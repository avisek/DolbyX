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

- `src/main.tsx` — bootstrap guard + mount + background WS connect
- `src/App.tsx` — root shell
- `src/store/state.ts` — `solid-js/store` snapshot, hydrated from the
  bootstrap at module init (no third-party state lib)
- `src/store/ws.ts` — WS ↔ store glue: connection signal + the command
  actions components call (local-first: the originator applies its own
  change on `ack`; the `state` broadcast goes to other tabs)
- `src/lib/ws.ts` — typed wire vocabulary + `WsClient`: fresh
  `request_id` per command settled promise-style, `get_state` reconcile
  on every open and on any `error` (except a failed reconcile itself —
  no loop), auto-reconnect with backoff
- `src/lib/` also: bootstrap contract, parameter metadata, unit helpers
  (arriving with their slices)
- `src/components/` — `PowerToggle`, `ConnectionBadge`, … one `.tsx`
  per component; no CSS (see Skin authoring)
- `src/skins/classic/` — the Classic skin: tokens, resets, one BEM
  stylesheet per component, and `index.css` — the only stylesheet the
  app imports
- `src/test/` — shared fixtures + the mocked `WebSocket` (the sanctioned
  UI test seam); `e2e/` — Playwright against the real daemon + engine

Conventions: strict TS (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); ESLint `strict-type-checked` +
`eslint-plugin-solid`; Prettier; Vitest + `@solidjs/testing-library` on
happy-dom. Params ride the wire as i16 1/16-dB — the UI converts to dB
for display only.

## Skin authoring

A **Skin** is CSS only ([ADR-0011](../docs/adr/0011-css-skin-contract.md)).
Components render a fixed **skeleton** — semantic elements, state as BEM
modifiers, data as CSS custom properties — and import no CSS; the skin
paints it. v2.0 ships one skin, **Classic**, and no switcher.

**Tree** — `src/skins/classic/`:

- `index.css` — the skin entry point; `main.tsx` imports only this
- `theme.css` — tokens; `base.css` — resets + typography
- `<Component>.css` — one BEM file per component; `index.css` orders them

**Add a component's stylesheet**: create `src/skins/classic/<Name>.css`,
`@import` it from `index.css`. Never import CSS from `.tsx` — ESLint
rejects it everywhere but `main.tsx` (`src/skin.test.ts` pins the rule).

**Tokens** (`theme.css`) — names are the contract, values are Classic's;
components never read them. Existing components still carry literals
until the Classic sweep (#94); new stylesheets use tokens:

| Token                                                                                             | Meaning                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `--color-bg` `--color-surface` `--color-accent` `--color-text` `--color-text-muted` `--font-sans` | palette + type                                    |
| `--space-1…6`                                                                                     | spacing scale, 0.25–2 rem                         |
| `--control-h`                                                                                     | one height for input / toggle / tristate / slider |
| `--radius-1` `--radius-2`                                                                         | controls / cards                                  |
| `--hue-settable` `--hue-experimental` `--hue-readonly`                                            | 4-CC color by settability bucket                  |
| `--fold-ms` `--fold-ease`                                                                         | fold / disclosure motion                          |
| `--focus-ring`                                                                                    | the focus outline                                 |

**Rules** (ADR-0011 + addendum):

- Layout is the skin's: nested `subgrid`, multicol masonry, anchor
  positioning, `transform`, `z-index`, `@property`. Never
  `display: contents` — folds animate and regions stay in the a11y tree.
- Collapsed content is state: animate the body's track, then a
  _delayed_ `visibility` takes it out of tab order. Hover/focus-revealed
  chrome hides with `opacity` only — it must stay focusable.
- Hover rules sit under focus weight: wrap the hover selector in
  `:where()`; a focused control always wins.
- Read modifiers (`--exp --ro --preset --diverged --collapsed …`) and
  continuous vars in real units (`--value`, `--norm`, `--count`);
  quantize with `round(…, step)`, step a numeric token. No badge
  elements: color-code the 4-CC or synthesize text via `::before` /
  `::after`.
- The reset marker is one real `button`, `disabled` when clean: paint a
  dot at rest, morph to ↺ on hover / `:focus-visible`.
- Chromium is the target: subgrid, `:has`, anchor positioning,
  `@property`, `overflow: clip` are fair game.
