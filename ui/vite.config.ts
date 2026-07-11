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

// Backend-integration mode: the browser always visits the daemon at
// :9876; Vite serves modules + HMR straight from :5173 — no proxies
// (no /api exists and /ws is same-origin with the page).
export default defineConfig({
  plugins: [solid(), viteSingleFile(), assertBootstrapPlaceholder()],
  server: {
    strictPort: true, // dev.html + origin hardcode :5173 — never drift
    cors: true,
    origin: 'http://localhost:5173',
    hmr: { host: 'localhost', port: 5173, protocol: 'ws' },
  },
})
