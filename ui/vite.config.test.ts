/**
 * #136: the serve-mode asset plugin — `just dev` paints skin assets
 * exactly like the single-file build. Vite's dev CSS pipeline flattens a
 * skin's `@import`s itself and emits every non-SVG `url()` root-relative
 * (`/src/skins/…`), which 404s on the page origin — the daemon serves
 * two routes (ADR-0006). The plugin reads those files from disk into
 * data URIs in the emitted module; the build needs nothing (singlefile
 * forces `assetsInlineLimit`).
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedConfig } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { inlineDevAssets } from './vite.config'

const SVG = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0h1'/></svg>"
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

let root: string
const plugin = inlineDevAssets()

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dolbyx-dev-assets-'))
  mkdirSync(join(root, 'src/skins/r/icons'), { recursive: true })
  writeFileSync(join(root, 'src/skins/r/icons/x.svg'), SVG)
  writeFileSync(join(root, 'src/skins/r/x.png'), PNG)
  plugin.configResolved({ root } as ResolvedConfig)
})

afterAll(() => {
  rmSync(root, { recursive: true })
})

/** What `vite:css` emits for a `?inline` entry in dev: a JS module whose
 * default export is the flattened sheet as a JSON string. */
const module = (css: string) => `export default ${JSON.stringify(css)}`
const ENTRY = '/abs/ui/src/skins/r/index.css?inline'

// Behaviour 6 (#136): a root-relative `url()` becomes a data URI read
// from disk — SVG percent-encoded, the rest base64 — the quote style
// kept, so dev paints what the build inlines.
it('rewrites root-relative url() to data URIs read from the root', () => {
  const out = plugin.transform(
    module(
      `a{background:url(/src/skins/r/icons/x.svg)} b{background:url("/src/skins/r/x.png")} c{background:url('/src/skins/r/x.png')}`,
    ),
    ENTRY,
  )
  const svg = `data:image/svg+xml,${encodeURIComponent(SVG).replaceAll("'", '%27')}`
  const png = `data:image/png;base64,${PNG.toString('base64')}`
  expect(out).toBe(
    module(
      `a{background:url(${svg})} b{background:url("${png}")} c{background:url('${png}')}`,
    ),
  )
})

// …while `data:` and absolute URLs, and a path no file answers, pass
// untouched — as does any module that is not a stylesheet.
it('leaves data:, http(s) and unresolvable urls, and non-css modules alone', () => {
  const css = module(
    `a{background:url(data:image/png;base64,AA==)} b{background:url(https://e.com/a.png)} c{background:url(/src/skins/r/missing.png)}`,
  )
  expect(plugin.transform(css, ENTRY)).toBe(css)
  expect(
    plugin.transform('const a = "url(/src/skins/r/x.png)"', '/abs/ui/src/a.ts'),
  ).toBeUndefined()
})

// Behaviour 6 (#136): serve-only — the build's singlefile inlining is
// the one prod story; the hook is absent in build mode.
it('applies in serve mode only', () => {
  expect(plugin.apply).toBe('serve')
  expect(plugin.enforce).toBe('post')
})
