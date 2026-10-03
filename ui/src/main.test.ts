/**
 * The app entry under happy-dom: the LAN-origin bounce (issue #72) and
 * the first paint of the Bootstrap skin (#136).
 * @vitest-environment happy-dom
 * @vitest-environment-options {"url": "http://192.168.1.7:5173/"}
 */
import { expect, it, vi } from 'vitest'
import { findSkin } from './skins'
import { fixtureBootstrap } from './test/fixture'
import { MockWebSocket } from './test/mock-ws'

// A LAN page origin: the bounce must follow the page hostname —
// `localhost` would send a phone to itself.
it('redirects a direct :5173 visit to the same-host daemon and halts', async () => {
  // No daemon-injected window.__BOOTSTRAP__ in this environment — exactly
  // what a dev visiting :5173 directly gets.
  const replace = vi
    .spyOn(location, 'replace')
    .mockImplementation(() => undefined)

  await expect(import('./main')).rejects.toThrow('Bootstrap missing')
  expect(replace).toHaveBeenCalledWith(
    'http://192.168.1.7:9876' + location.pathname,
  )
})

// Behavior 2 (#136): the first paint reads `skin` from Bootstrap — the
// `<style id="skin">` holds that skin's text before the app renders, no
// flash, no second request (ADR-0013).
it('paints the Bootstrap skin into <style id="skin"> before rendering', async () => {
  window.__BOOTSTRAP__ = fixtureBootstrap({ skin: 'classic' })
  vi.stubGlobal('WebSocket', MockWebSocket)
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  vi.resetModules()

  await import('./main')

  expect(document.head.querySelector('style#skin')?.textContent).toBe(
    findSkin('classic').css,
  )
  expect(root.querySelector('.app')).not.toBeNull()
})
