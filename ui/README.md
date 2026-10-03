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
- `src/skins/` — the Skin registry (`index.ts`) + one directory per
  skin (`remastered/`, `classic/`), each a `index.css` entry point
  importing its sheets; `store/skin.ts` paints the chosen one
- `src/test/` — shared fixtures + the mocked `WebSocket` (the sanctioned
  UI test seam); `e2e/` — Playwright against the real daemon + engine

Conventions: strict TS (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); ESLint `strict-type-checked` +
`eslint-plugin-solid`; Prettier; Vitest + `@solidjs/testing-library` on
happy-dom. Params ride the wire as i16 1/16-dB — the UI converts to dB
for display only.

## Skin authoring

A **Skin** is CSS only ([ADR-0011](../docs/adr/0011-css-skin-contract.md)):
components render a fixed **skeleton** — semantic elements, state as BEM
modifiers, data as CSS custom properties — and import no CSS; the skin
paints it. A skin is **a directory + a registry row**: `src/skins/<id>/`
holding `index.css` (the entry point, `@import`ing every sheet in the
directory) and `src/skins/index.ts` listing `{ id, label, css }`, pill
order, first = default. Shipped: `remastered/` (default), `classic/`.

**Add a skin**

1. Copy a directory: `cp -r src/skins/remastered src/skins/<id>`.
2. Register it: `import <id> from './<id>/index.css?inline'` + a row in
   `skins`. Only this module may import CSS — ESLint rejects it
   everywhere else, `?inline` included.
3. Declare `color-scheme` on `:root` (`dark`, or `light dark` with
   `light-dark()` values). Mandatory, not stylistic: the build lowers
   `light-dark()` only where the sheet declares a scheme.

**Add a sheet**: create `src/skins/<id>/<Name>.css`, `@import` it from
that skin's `index.css` — every sheet in the directory must be reachable
from it.

**Switching** ([ADR-0013](../docs/adr/0013-skin-choice-daemon-root-scalar-bundled-skins.md)):
`skin` is a daemon root scalar carried in every snapshot. Every
registered entry point is bundled into `index.html` as text; one
`<style id="skin">` holds the active skin's, painted from Bootstrap
before the first render and swapped live when the id changes (transitions
suppressed for the swap). An id the registry doesn't ship paints the
default. The daemon never validates the id.

**Custom properties are private.** A skin's palette, spacing scale, icon
masks and step values are its own — nothing outside the skin reads one;
no shared token table exists. Only the skeleton is contract: classes,
modifiers, and the published data vars (`--value`, `--norm`, `--count`,
`--bands`, `--exc`, `--gain`, …).

**Assets** live in the skin's directory, referenced by relative `url()`
(`url('./icons/plus.svg')`, `url('./Inter.woff2')`); the build inlines
them as data URIs, so a skin never adds a route; in dev a serve-only
plugin (`vite.config.ts`, tested by `vite.config.test.ts`) does the same.
Budget: ≤ 2 font weights per skin (~30 KB each inlined, Latin subset —
subset manually, e.g. `pyftsubset --unicodes=U+0000-00FF --flavor=woff2`).

**Rules** (ADR-0011 + addenda):

- Layout is the skin's: nested `subgrid`, multicol masonry, anchor
  positioning, `transform`, `z-index`, `@property`. Never
  `display: contents` — folds animate and regions stay in the a11y tree.
- Collapsed content is state: animate the body's track, then a
  _delayed_ `visibility` takes it out of tab order. Hover/focus-revealed
  chrome hides with `opacity` only — it must stay focusable.
- Hover rules sit under focus weight: wrap the hover pseudo-class alone
  in `:where()` (`.row:where(:hover)`); a focused control always wins.
- Read modifiers (`--exp --ro --preset --diverged --collapsed …`) and
  continuous vars in real units; quantize with `round(…, step)`, step a
  numeric custom property. No badge elements: colour-code the 4-CC or
  synthesize text via `::before` / `::after`.
- The reset marker is one real `button`, `disabled` when clean: paint a
  dot at rest, morph to ↺ on hover / `:focus-visible`.
- **Shell**: fluid without viewport units — no `vw`/`vh`/`svh`/`dvh`;
  `100%` height chains; wrapping and container queries reflow regions
  (thresholds are rem literals — size queries can't read custom
  properties). The **Off-look** dims everything but the header by
  `opacity`, never `filter`.
- **Icons**: buttons render empty, named by `aria-label`; paint an Icon
  mask in `currentColor` from a skin-private property or an asset file:

  ```css
  .my-button::before {
    content: '';
    inline-size: var(--icon-size);
    block-size: var(--icon-size);
    background-color: currentColor;
    mask-image: var(--icon-copy);
    mask-size: contain;
  }
  ```

- Chromium is the target: subgrid, `:has`, anchor positioning,
  `@property`, `overflow: clip` are fair game.

**What tests check** — behaviour and reachability, never taste:

- Unit audits (`src/skin.test.ts`, `src/skins/audit.test.ts`): no CSS
  import outside the registry; skin directories ↔ registry 1:1; every
  sheet reachable from its skin's `index.css`; `color-scheme` on
  `:root`; no viewport unit; the registry's default = `defaults.toml`'s.
- Contract (`e2e/contract.spec.ts`), looped over every registered skin
  at 390 / 700 / 1280 and again under the light scheme where the skin
  declares `light dark`: no sideways overflow with every region open,
  every control hit-testable at its centre (or its label's).
- Switching (`e2e/skin.spec.ts`): a pick reaches a peer page, an unknown
  `config.toml` id paints the default with no pill checked, a reload
  paints from Bootstrap with no extra request.
- `e2e/main-screen.spec.ts`: a visible focus indicator on every tab stop
  (interim, until #138 Part 2), the badge's `--connected` following the
  socket.

Never checked: a skin's custom properties, literal colours or lengths,
timings, screenshots, hover tints, thumb scale, reveal timing, popover
placement — all skin policy.
