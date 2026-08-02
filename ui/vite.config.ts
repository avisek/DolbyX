import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type PluginOption } from 'vite'
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

// Backend-integration mode: the browser visits the daemon (:9876); Vite
// serves modules + HMR from :5173 on the same host — no proxies (no
// /api exists and /ws is same-origin with the page). No `origin`, no
// `hmr.host`: both would pin `localhost` and break `just dev-lan` —
// dev.html derives module URLs from the page hostname, and the HMR
// client falls back to its own module URL's host (issue #72). The day
// the first static asset appears this stops sufficing: Vite renders
// asset URLs root-relative, the page origin is the daemon, and the
// daemon serves exactly two routes — whoever adds that asset owns the
// dev-origin story.
export default defineConfig({
  plugins: [solid(), viteSingleFile(), assertBootstrapPlaceholder()],
  server: {
    strictPort: true, // dev.html hardcodes :5173 — never drift
    cors: true,
  },
})
