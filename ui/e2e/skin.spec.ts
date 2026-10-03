/**
 * #138: skin switching in a real browser — the default skin, the real
 * daemon (ADR-0013). A pill pick lands on its ack and reaches a peer
 * page over the daemon's fan-out; a `config.toml` naming a skin the
 * registry doesn't ship paints the default with no pill checked; a
 * reload paints the chosen skin straight from Bootstrap, nothing
 * fetched. Note: Classic is Remastered's verbatim copy until #139, so
 * the two texts are byte-identical today — the swap is pinned through
 * the pill and the peer's text matching the originator's.
 */
import { writeFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import {
  expect,
  openAt,
  skinRadio,
  skinRadios,
  skinText,
  test,
} from './fixtures'

const classicPill = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Skin' }).getByText('Classic')
const classicRadio = (page: Page) => skinRadio(page, 'classic')

// Behavior 2: a pick is ack-then-apply at the originator and a `state`
// broadcast at the peer — both pages end up checked and painted alike.
test('a pill pick lands on its ack and a second page follows', async ({
  page,
  context,
}) => {
  await openAt(page, 1280)
  const peer = await context.newPage()
  await peer.goto('/')
  await expect(peer.getByRole('status')).toHaveText('Connected')
  await expect(classicRadio(peer)).not.toBeChecked()

  await classicPill(page).click()
  await expect(classicRadio(page)).toBeChecked()
  await expect(classicRadio(peer)).toBeChecked()
  const painted = await skinText(page)
  expect(painted).not.toBe('')
  expect(await skinText(peer)).toBe(painted)
})

// Behavior 2: the daemon stores the id unchecked; the registry judges
// it — unknown paints the default, and no pill claims to be it.
test('a config.toml skin the registry does not ship paints the default with no pill checked', async ({
  page,
  daemon,
}) => {
  await openAt(page, 1280)
  const fallback = await skinText(page)

  await daemon.stop()
  await writeFile(daemon.configPath, 'skin = "nope"\n')
  await daemon.start()
  await openAt(page, 1280)

  const bootstrap = await page.evaluate(() => window.__BOOTSTRAP__)
  expect(bootstrap?.state.skin).toBe('nope')
  expect(await skinText(page)).toBe(fallback)
  await expect(skinRadios(page).and(page.locator(':checked'))).toHaveCount(0)
})

// Behavior 2: the chosen skin's text is already in the document — the
// first paint reads the id from Bootstrap; no stylesheet, script or
// data request follows (favicon aside — browser chrome), only the WS.
test('a reload paints the chosen skin from Bootstrap with no extra request', async ({
  page,
}) => {
  await openAt(page, 1280)
  await classicPill(page).click()
  await expect(classicRadio(page)).toBeChecked()
  const classic = await skinText(page)

  const subresources: string[] = []
  page.on('request', (request) => {
    if (
      request.resourceType() !== 'document' &&
      !request.url().endsWith('/favicon.ico')
    ) {
      subresources.push(request.url())
    }
  })
  let sockets = 0
  page.on('websocket', () => {
    sockets += 1
  })

  await page.reload()
  const bootstrap = await page.evaluate(() => window.__BOOTSTRAP__)
  expect(bootstrap?.state.skin).toBe('classic')
  expect(await skinText(page)).toBe(classic)
  await expect(classicRadio(page)).toBeChecked()
  await expect(page.getByRole('status')).toHaveText('Connected')
  expect(subresources).toEqual([])
  expect(sockets).toBe(1)
})
