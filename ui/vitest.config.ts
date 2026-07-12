import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  // hot: false — no solid-refresh injection in tests; its virtual module
  // (`/@solid-refresh`) doesn't resolve under Vitest on Windows.
  plugins: [solid({ hot: false })],
  // Solid ships separate dev/browser builds — tests need the dev one.
  resolve: { conditions: ['development', 'browser'] },
  // Unit tests only — e2e/*.spec.ts belongs to Playwright (`just e2e`).
  test: { environment: 'happy-dom', include: ['src/**/*.test.{ts,tsx}'] },
})
