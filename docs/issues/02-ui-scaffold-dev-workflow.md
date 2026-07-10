# Slice 02 — UI scaffold + dev workflow

**Goal.** `ui/` is a working Solid + Vite + TypeScript project with lint,
test, and production build green, and `just dev` runs daemon + UI together
with hot reload through the daemon's origin.

**Blocked by:** Slice 01.
**Mode:** AFK.
**Type:** scaffolding — no user-visible behavior yet (Slice 05 puts the
first control on screen).

## What to build

Stack (ADR-0006 — `docs/adr/0006-solid-ui-with-bootstrap-injection-no-api.md`):

- **Solid.js + TypeScript** (`solid-js`, `solid-js/web`), `strict: true`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Solid's
  fine-grained reactivity fits the UI (visualizer frames, GEQ drags — no
  VDOM diff overhead; ~7 KB runtime).
- **Vite** with `vite-plugin-solid` and `vite-plugin-singlefile` (prod
  build inlines all CSS+JS into one `index.html`).
- **Plain CSS with BEM** — no utility framework. `styles/theme.css` holds
  CSS custom properties (DDP-styled defaults: dark navy background, Dolby
  cyan accent); `styles/base.css` resets + typography. Future skins swap
  variables, not code.
- **`solid-js/store`** for state — no third-party state lib.
- **Vitest** + `@solidjs/testing-library` (mocked WebSocket) for unit
  tests; Playwright arrives in Slice 09.
- **ESLint** `@typescript-eslint/strict-type-checked` +
  `eslint-plugin-solid`; **Prettier**.

**Bootstrap contract (consumed here, produced in Slice 04).** The daemon
templates the served HTML, replacing a `<!--BOOTSTRAP-->` placeholder with
a `<script>` defining:

```ts
window.__BOOTSTRAP__: {
  params: ParameterDef[],   // full metadata table — no /api/parameters
  state: StateSnapshot,     // mirrors the WS "state" event
}
```

`params` is delivered once per page load, never re-broadcast (the table
can't change within a daemon lifetime). The UI reads it synchronously at
module init and paints fully populated on the first frame; the WS connects
in the background and its `state` event reconciles drift. There is
intentionally **no `/api/*` endpoint** in dev or prod.

**Two HTML shells, one code path.** `GET /` reads one file from disk and
string-replaces the placeholder — dev and prod differ only in which file:
prod = `$(daemon-dir)/index.html` (Vite singlefile build, placed beside
the binary by `just build-release`); dev = `--ui ui/dev.html`:

```html
<!-- ui/dev.html -->
<!DOCTYPE html>
<html>
  <head>
    <title>DolbyX</title>
    <!--BOOTSTRAP-->
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="http://localhost:5173/@vite/client"></script>
    <script type="module" src="http://localhost:5173/src/main.tsx"></script>
  </body>
</html>
```

`ui/index.html` (prod source) keeps the `<!--BOOTSTRAP-->` placeholder
through the Vite build. Nothing is ever embedded in the daemon binary.

`vite.config.ts` — backend-integration mode so HMR works through the
daemon's `:9876` origin (HMR client connects straight to :5173; no proxies
— no `/api` exists and `/ws` is same-origin with the page):

```ts
server: {
  cors: true,
  origin: 'http://localhost:5173',
  hmr: { host: 'localhost', port: 5173, protocol: 'ws' },
}
```

`main.tsx` guard for devs who visit :5173 directly:

```ts
if (!window.__BOOTSTRAP__) {
  location.replace('http://localhost:9876' + location.pathname)
  throw new Error('Bootstrap missing — redirecting to daemon')
}
```

**`just dev`**: daemon under `cargo watch -x 'run -p ddp-daemon -- --ui
ui/dev.html'` + `pnpm -C ui dev`, concurrent, prefixed/colored output.
Rust edits restart the daemon; TS/CSS hot-reload. (The daemon side may be
a placeholder binary until Slice 04 — the recipe and Vite config must be
correct now.)

**`just build-release`**: `pnpm -C ui build` (singlefile) → `cargo build
--release` → copy `ui/dist/index.html` beside the binary.

**CI**: extend the Slice 01 workflow with `pnpm run lint` + `pnpm run
test` + `pnpm -C ui build`.

Directory shape: see the epic's crate map (UI source shape). Create
`main.tsx`, `App.tsx`, `store/`, `styles/`, `lib/` with minimal compiling
placeholders; component files arrive with their slices. Add a short
`ui/README.md` (component architecture + dev workflow).

## Acceptance criteria

- [ ] `pnpm -C ui build` produces a singlefile `dist/index.html` with the
      `<!--BOOTSTRAP-->` placeholder intact
- [ ] `pnpm run lint` / `pnpm run test` green (one trivial Vitest spec)
- [ ] `just dev` starts both processes; a TS edit triggers a Vite HMR
      update (log-level check — in-browser verification lands with
      Slice 04's real daemon)
- [ ] `main.tsx` :5173 guard redirects to :9876
- [ ] CI runs UI lint + test + build on both platforms
- [ ] `ui/README.md` written

## References

- Epic: dev workflow, code-quality standards
- ADR-0006 (`docs/adr/0006-solid-ui-with-bootstrap-injection-no-api.md`)
