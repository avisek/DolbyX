# Skin loading — inlining, bytes, colour scheme, live `<style>` swap

Research for [#128](https://github.com/avisek/DolbyX/issues/128) (map [#127](https://github.com/avisek/DolbyX/issues/127)). Stack: Vite 8.1.4, `vite-plugin-singlefile` 2.3.3, Playwright 1.61. Empirical probes ran on this branch (`?inline` CSS + `@font-face` with a 21.5 KB `.woff2`), reverted after measuring.

## 1. `?inline` CSS + `@font-face` in the single-file build

**Verdict: works as planned, no config change needed.** Font lands as a base64 data URI inside the JS string; nothing emitted beside `dist/index.html`.

- `?inline` → processed CSS returned as module default string, not injected, never emitted as `.css` asset ([Vite features](https://vite.dev/guide/features#disabling-css-injection-into-the-page); [css.ts](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugins/css.ts) `inlineRE`, build path `else if (inlined) … export default JSON.stringify(content)`).
- `url()` IS rewritten for `?inline` — only `?raw|?url|?worker` skip the CSS plugin ([constants.ts `SPECIAL_QUERY_RE`](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/constants.ts)). Asset placeholder `__VITE_ASSET__…` inside the JS string is resolved in `renderChunk` ([asset.ts](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugins/asset.ts)).
- Threshold: Vite default `assetsInlineLimit` = 4096 B ([docs](https://vite.dev/config/build-options#build-assetsinlinelimit)); singlefile overrides it to `() => true` → every asset inlined regardless of size ([src/index.ts](https://github.com/richardtallent/vite-plugin-singlefile/blob/main/src/index.ts) `_useRecommendedBuildConfig`). Also forces `cssCodeSplit=false`, `base="./"`, `assetsDir=""`, `codeSplitting=false` (Vite ≥ 8). Plugin itself inlines only JS + CSS; other assets are left as files with `NOTE: asset not inlined` — moot since Vite data-URIs them first. Exceptions Vite never inlines: `public/`, `.html`, `svg#fragment`, `?no-inline`, Git LFS placeholders.
- **Measured** (`pnpm build`): `dist/` = `index.html` only. `@font-face{…src:url(data:font/woff2;base64,…)}` found inside the `<script>`, not the `<style>`. Same source without singlefile → `assets/probe-*.woff2` 21.5 KB emitted + `url(/assets/probe-*.woff2)` in the JS string (confirms the override is what inlines it).
- `?inline` CSS is minified in build (lightningcss) → see §3 gotcha.

### `vite dev`

- Dev never inlines (except `.svg` and `?inline` assets): `url()` → root-relative `/src/skins/<skin>/font.woff2` ([asset.ts `fileToDevUrl`](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugins/asset.ts); [assets guide](https://vite.dev/guide/assets)). **Measured**: `curl :5173/src/…/probe.css?inline` → `export default "@font-face {… url('/src/skins/research/probe.woff2') …"`.
- Gotcha (already flagged in `ui/vite.config.ts`): dev page origin is the daemon `:9876`, modules come from `:5173`; a root-relative URL hits the daemon → 404 → font silently missing in `just dev`. Options: accept (fonts cosmetic, `font-display: swap` falls back to system stack); or in `import.meta.env.DEV` rewrite `url(/src/` → `url(http://${location.hostname}:5173/src/` before injecting. E2E is unaffected — `e2e/global-setup.ts` runs `pnpm build` and daemons serve `dist/index.html`.

## 2. Byte cost

| | bytes |
|---|---|
| probe `.woff2` (Google Sans 400, Latin subset) | 21 528 |
| base64 in HTML | 28 704 (+33 %, [MDN](https://developer.mozilla.org/en-US/docs/Glossary/Base64#encoded_size_increase)) |
| base64 gzip -9 | 21 715 |
| raw gzip -9 | 21 563 (no gain — WOFF2 is already Brotli, [WOFF2 §5](https://www.w3.org/TR/WOFF2/#table_format)) |
| `dist/index.html` before / after | 114 068 / 143 021 raw; 35 472 / 59 124 gzip |

- Rule of thumb: one Latin-subset static weight ≈ 20–25 KB woff2 → ≈ 27–33 KB inlined. Google Fonts Inter 400 latin slice = 23 664 B (live measurement, v20).
- Gzip over the wire recovers the base64 overhead (28.7 → 21.7 KB) but not the font itself. `serve_index` uncompressed costs ≈ +7 KB per weight vs gzip; the whole page is 114 KB raw / 35 KB gzip today → gzip would save ~3×, independent of fonts. LAN-only, single request per page load → not worth adding compression for skins alone; revisit if the page passes ~0.5 MB.
- Budget suggestion: ≤ 2 weights per skin (~60 KB inlined), subset to Latin.

## 3. `light-dark()`, `color-scheme`, Playwright

- `color-scheme`: Chrome 81, Firefox 96, Safari 13 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/css/properties/color-scheme.json), [Chrome Status](https://chromestatus.com/feature/6070987093180416)). `light-dark()`: Chrome 123, Firefox 120, Safari 17.5 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/css/types/color.json), [Chrome Status](https://chromestatus.com/feature/4909742688567296)). `light-dark()` needs `color-scheme: light dark` (or `light`/`dark`) on the element or an ancestor ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark#description)).
- **Build gotcha (measured)**: Vite 8 `build.cssMinify` defaults to lightningcss, `build.target` to `baseline-widely-available` (Chrome 111+). lightningcss lowers `light-dark(#111,#eee)` → `var(--lightningcss-light,#111)var(--lightningcss-dark,#eee)` and, where the sheet declares `color-scheme`, emits `--lightningcss-light:initial;--lightningcss-dark: ;` + `@media (prefers-color-scheme:dark)` flip. Works on Chrome 111–122 too — **but only if the same skin sheet declares `color-scheme`** (without it the lowered value is invalid → property unset). With `build.cssTarget: 'chrome123'` `light-dark()` is kept verbatim. Either: keep default and make "every skin declares `color-scheme` on `:root`" a rule (Classic: `dark`), or pin `cssTarget`. Tests must never grep for `light-dark(` in built output.
- Playwright: `page.emulateMedia({ colorScheme: 'dark' | 'light' | 'no-preference' | null })` per test ([page.emulateMedia](https://playwright.dev/docs/api/class-page#page-emulate-media)); `test.use({ colorScheme: 'dark' })` per file / describe; `projects[].use.colorScheme` per project; default `'light'` ([testOptions.colorScheme](https://playwright.dev/docs/api/class-testoptions#test-options-color-scheme), [emulation guide](https://playwright.dev/docs/emulation#color-scheme-and-media)). Current `ui/playwright.config.ts` has one project (`Desktop Chrome`) → tests run light unless emulated.

## 4. Replacing `<style>` text live

- **FOUC: none** if swap is one synchronous assignment (`style.textContent = css`). Rendering happens once per task after microtasks ([HTML event loop](https://html.spec.whatwg.org/multipage/webappapis.html#event-loop-processing-model)); don't remove + append across tasks.
- **Transitions fire (measured)**: a wholesale swap is one style change event; every property whose value differs and has a `transition` in the *after-change* style animates old → new ([CSS Transitions §3](https://www.w3.org/TR/css-transitions-1/#starting)). Probe: `color` and a registered `--x` both mid-transition 1 s after swap. Free cross-fade on colours, but geometry/`order`/layout transitions would animate too. Suppress with `el.style.transition='none'` (or a root class) during the swap, force a sync recalc (`getComputedStyle(...)` read), then clear — measured: new value applied instantly.
- **`@property` (measured, Chrome)**: redeclaring in the new sheet re-registers cleanly — changed `initial-value` 1 → 5 reflected, changed `syntax` `<number>` → `<length>` reflected, removing the rule unregisters (value empty). Spec: last valid `@property` in document order wins, re-determined from active sheets ([Properties & Values API](https://drafts.css-houdini.org/css-properties-values-api/#determining-registration)). Never use `CSS.registerProperty()` — it beats all `@property` rules and throws on re-register. Changing a registration can start/interrupt a transition (spec note) — covered by the suppression above.
- Classic already has 4 `@property` rules (`NumberInput.css`, `Visualizer.css`) — fine to duplicate into Remastered.

## Decisions this unlocks

1. Loading model stands: `?inline` per skin, one `<style>`, text swap. No `assetsInlineLimit` change.
2. Rule for skin authors: declare `color-scheme` on `:root` (lightningcss lowering); font budget ≈ 2 Latin-subset weights.
3. Skin switch: wrap in transition suppression unless the cross-fade is wanted.
4. Dev-mode fonts: either accept fallback or rewrite `url(/src/` in DEV.
5. Contract e2e colour-scheme loop: `test.use({ colorScheme })` or a second project; no app code needed.
