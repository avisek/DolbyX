/**
 * Slice 09 (#17): the power toggle end-to-end — real browser, real
 * daemon, real engine. Selectors are the accessible roles the
 * components ship (`switch` = the power Toggle, `status` = ConnectionBadge).
 */
import { countStateFrames, expect, test } from './fixtures'

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
  await expect(power).toBeChecked()
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
  const stateFrames = countStateFrames(page)
  await page.goto('/')
  const power = page.getByRole('switch', { name: 'Power' })
  await expect(power).toBeChecked()
  // Connect traffic settles at exactly two `state` frames: the
  // snapshot-on-connect plus the get_state reconcile reply.
  await expect.poll(stateFrames).toBe(2)

  // Local-first: the originator's flip lands on its ack.
  await power.click()
  await expect(power).not.toBeChecked()

  // Down: SIGTERM flushes the flip to config.toml; the badge notices —
  // text and, for the skin, its `--connected` modifier (#117).
  await daemon.stop()
  const badge = page.getByRole('status')
  await expect(badge).toHaveText('Reconnecting…')
  await expect(badge).not.toHaveClass(/connection-badge--connected/)

  // Up on the same port over the same config dir: the WS reconnects
  // with backoff and the flip is still there.
  await daemon.start()
  await expect(badge).toHaveText('Connected')
  await expect(badge).toHaveClass(/connection-badge--connected/)
  // Reconciled, not merely reconnected: fresh `state` frames beyond the
  // pre-restart two carry the restarted daemon's truth to the page.
  await expect.poll(stateFrames).toBeGreaterThan(2)
  await expect(power).not.toBeChecked()

  // A cold reload paints from the restarted daemon's bootstrap.
  await page.reload()
  await expect(power).not.toBeChecked()
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
  const originatorStates = countStateFrames(page)
  await page.goto('/')
  const originatorPower = page.getByRole('switch', { name: 'Power' })
  await expect(page.getByRole('status')).toHaveText('Connected')
  // The originator's connect traffic settles at exactly two `state`
  // frames (snapshot-on-connect + get_state reconcile reply) — a
  // deterministic baseline nothing below may grow.
  await expect.poll(originatorStates).toBe(2)

  const peer = await context.newPage()
  await peer.goto('/')
  const peerPower = peer.getByRole('switch', { name: 'Power' })
  await expect(peerPower).toBeChecked()

  await originatorPower.click()

  // The peer hears the broadcast; the originator applied its own ack…
  await expect(peerPower).not.toBeChecked()
  await expect(originatorPower).not.toBeChecked()
  // …and got no snapshot pushed at it — not for the peer joining, not
  // for its own flip: nothing fights the originator's in-flight edits.
  expect(originatorStates()).toBe(2)
})
