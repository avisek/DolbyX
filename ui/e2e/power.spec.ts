/**
 * Slice 09 (#17): the power toggle end-to-end — real browser, real
 * daemon, real engine. Selectors are the accessible roles the
 * components ship (`switch` = PowerToggle, `status` = ConnectionBadge).
 */
import { expect, test } from './fixtures'

/** Behavior 1: the first paint is fully populated from the bootstrap. */
test('first paint is fully populated straight from the bootstrap', async ({
  page,
}) => {
  // Any subresource fetch would reintroduce the waterfall ADR-0006 bans
  // (favicon aside — browser chrome, not the app's doing).
  const subresources: string[] = []
  page.on('request', (request) => {
    if (
      request.resourceType() !== 'document' &&
      !request.url().endsWith('/favicon.ico')
    ) {
      subresources.push(request.url())
    }
  })

  await page.goto('/')

  // Power is on out of the box (defaults.toml), and the daemon injected
  // that truth into the document itself.
  const power = page.getByRole('switch', { name: 'Power' })
  await expect(power).toHaveAttribute('aria-checked', 'true')
  const bootstrap = await page.evaluate(() => window.__BOOTSTRAP__)
  expect(bootstrap?.state.power).toBe(true)

  // The singlefile document needed nothing else — no script, style, or
  // data fetch — so the first paint cannot have waited on a request.
  expect(subresources).toEqual([])
  await expect(page.getByRole('status')).toHaveText('Connected')
})

/**
 * Behavior 2 + the tracer bullet: click → engine → daemon restart →
 * state survives → the page reconnects and reconciles.
 */
test('a power flip survives a daemon restart and the page reconnects', async ({
  page,
  daemon,
}) => {
  await page.goto('/')
  const power = page.getByRole('switch', { name: 'Power' })
  await expect(power).toHaveAttribute('aria-checked', 'true')

  // Local-first: the originator's flip lands on its ack.
  await power.click()
  await expect(power).toHaveAttribute('aria-checked', 'false')

  // Down: SIGTERM flushes the flip to config.toml; the badge notices.
  await daemon.stop()
  const badge = page.getByRole('status')
  await expect(badge).toHaveText('Reconnecting…')

  // Up on the same port over the same config dir: the WS reconnects
  // with backoff, get_state reconciles, and the flip is still there.
  await daemon.start()
  await expect(badge).toHaveText('Connected')
  await expect(power).toHaveAttribute('aria-checked', 'false')

  // A cold reload paints from the restarted daemon's bootstrap.
  await page.reload()
  await expect(power).toHaveAttribute('aria-checked', 'false')
})

/**
 * Behavior 3: a flip in one page reaches another — the peer from the
 * `state` broadcast, the originator only from its `ack` (originator
 * suppression, ADR-0005).
 */
test('a flip in one page reaches the other, with no snapshot pushed at the originator', async ({
  page,
  context,
}) => {
  // Collect every `state` event the originator's WS receives.
  const originatorStates: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      const payload = String(frame.payload)
      if ((JSON.parse(payload) as { type: string }).type === 'state') {
        originatorStates.push(payload)
      }
    })
  })
  await page.goto('/')
  const originatorPower = page.getByRole('switch', { name: 'Power' })
  await expect(page.getByRole('status')).toHaveText('Connected')

  const peer = await context.newPage()
  await peer.goto('/')
  const peerPower = peer.getByRole('switch', { name: 'Power' })
  await expect(peerPower).toHaveAttribute('aria-checked', 'true')

  // Baseline after both settle: connect snapshot + get_state reconcile
  // (> 0 proves the tap sees frames — the final count can't pass vacuously).
  const statesBefore = originatorStates.length
  expect(statesBefore).toBeGreaterThan(0)
  await originatorPower.click()

  // The peer hears the broadcast; the originator applied its own ack…
  await expect(peerPower).toHaveAttribute('aria-checked', 'false')
  await expect(originatorPower).toHaveAttribute('aria-checked', 'false')
  // …without a round-trip snapshot fighting its in-flight edit.
  expect(originatorStates.length).toBe(statesBefore)
})
