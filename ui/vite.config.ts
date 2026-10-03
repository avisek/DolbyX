import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  defineConfig,
  type Plugin,
  type PluginOption,
  type ResolvedConfig,
} from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import solid from 'vite-plugin-solid'

// The daemon string-replaces <!--BOOTSTRAP--> in the served HTML at
// request time (ADR-0006) — fail the build if the placeholder ever gets
// stripped from the singlefile output.
function assertBootstrapPlaceholder(): PluginOption {
  return {
    name: 'dolbyx:assert-bootstrap-placeholder',
    apply: 'build',
    closeBundle() {
      const html = readFileSync(
        join(import.meta.dirname, 'dist/index.html'),
        'utf8',
      )
      if (!html.includes('<!--BOOTSTRAP-->')) {
        throw new Error('dist/index.html lost the <!--BOOTSTRAP--> placeholder')
      }
    },
  }
}

const MIME: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** `file` as a data URI — SVG percent-encoded (quote-safe), the rest base64. */
function dataUri(file: string): string {
  const ext = extname(file).slice(1)
  const mime = MIME[ext] ?? 'application/octet-stream'
  if (ext === 'svg') {
    const text = encodeURIComponent(readFileSync(file, 'utf8'))
    return `data:${mime},${text.replaceAll("'", '%27')}`
  }
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`
}

// Skin assets are relative `url()`s in the skin's directory; the build
// inlines them as data URIs (singlefile forces `assetsInlineLimit`), so
// the daemon serves exactly two routes (ADR-0006, ADR-0013). Dev would
// diverge: the page origin is the daemon (:9876), modules come from
// Vite (:5173), and `vite:css` — which flattens a skin's `@import`s
// itself, so no other hook sees the sheets — emits every non-SVG
// `url()` root-relative, a 404 on the daemon. This serve-only hook
// runs after it and reads those files from disk into the emitted
// module, so `just dev` paints what `pnpm build` ships.
export function inlineDevAssets() {
  let root = ''
  return {
    name: 'dolbyx:inline-dev-assets',
    apply: 'serve',
    enforce: 'post',
    configResolved: (config: ResolvedConfig): void => {
      root = config.root
    },
    transform: (code: string, id: string): string | undefined => {
      if (!/\.css(?:$|\?)/.test(id)) return undefined
      return code.replace(
        /url\((\\?["']?)(\/[^"'()\\]+)\1\)/g,
        (match, quote: string, path: string) => {
          const file = join(root, path)
          if (!existsSync(file)) return match
          return `url(${quote}${dataUri(file)}${quote})`
        },
      )
    },
  } satisfies Plugin
}

// Backend-integration mode: the browser visits the daemon (:9876); Vite
// serves modules + HMR from :5173 on the same host — no proxies (no
// /api exists and /ws is same-origin with the page). No `origin`, no
// `hmr.host`: both would pin `localhost` and break `just dev-lan` —
// dev.html derives module URLs from the page hostname, and the HMR
// client falls back to its own module URL's host (issue #72).
export default defineConfig({
  plugins: [
    solid(),
    viteSingleFile(),
    assertBootstrapPlaceholder(),
    inlineDevAssets(),
  ],
  server: {
    strictPort: true, // dev.html hardcodes :5173 — never drift
    cors: true,
  },
})
