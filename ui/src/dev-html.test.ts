import { expect, it } from 'vitest'
// ?raw: Vite inlines the file — no node:fs under the browser tsconfig.
import html from '../dev.html?raw'

// The dev shell must load from a phone (issue #72): a page served at
// http://<ip>:9876 pulls modules from http://<ip>:5173, so URLs derive
// from the page hostname — never a hardcoded host.
it('derives Vite URLs from the page hostname, no hardcoded host', () => {
  expect(html).toContain('location.hostname')
  expect(html).not.toMatch(/localhost|127\.0\.0\.1/)
})

it('keeps the placeholder the daemon replaces at request time', () => {
  expect(html).toContain('<!--BOOTSTRAP-->')
})
