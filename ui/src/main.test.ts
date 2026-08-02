/**
 * A LAN page origin (issue #72): the bounce must follow the page
 * hostname — `localhost` would send a phone to itself.
 * @vitest-environment happy-dom
 * @vitest-environment-options {"url": "http://192.168.1.7:5173/"}
 */
import { expect, it, vi } from 'vitest'

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
