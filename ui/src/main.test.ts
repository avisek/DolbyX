import { expect, it, vi } from 'vitest'

it('redirects a direct :5173 visit to the daemon and halts', async () => {
  // No daemon-injected window.__BOOTSTRAP__ in this environment — exactly
  // what a dev visiting :5173 directly gets.
  const replace = vi
    .spyOn(location, 'replace')
    .mockImplementation(() => undefined)

  await expect(import('./main')).rejects.toThrow('Bootstrap missing')
  expect(replace).toHaveBeenCalledWith(
    'http://localhost:9876' + location.pathname,
  )
})
