import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  // Solid ships separate dev/browser builds — tests need the dev one.
  resolve: { conditions: ['development', 'browser'] },
  test: { environment: 'happy-dom' },
})
