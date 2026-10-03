/**
 * Slice 15 (#118): the LAN Access Row in a real browser — the fold
 * landing the tools in and out of the tab order. jsdom sees only the
 * modifier / focus seam (ADR-0011). Real daemon: flipping LAN on binds
 * the LAN listener for real (ADR-0012). Overflow off / on and the QR
 * Popover's hit test live in contract.spec, looped over every skin.
 */
import type { Page } from '@playwright/test'
import { expect, flipLan, foldSettled, openAt, test } from './fixtures'

const lanSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'LAN access' })

// Behavior 6: flipping LAN on reveals the tools; off, the fold lands
// them hidden and out of the tab order — Tab from the switch skips the
// LAN URL. The fold's motion is skin policy; where it lands is not.
test('flipping LAN reveals the tools; off lands them hidden and out of the tab order', async ({
  page,
}) => {
  await openAt(page, 1280)
  const tools = page.locator('.lan-access__tools')
  // By class: a hidden field has no role to query.
  const url = page.locator('.lan-access__url')
  await expect(lanSwitch(page)).not.toBeChecked()
  await expect(tools).toBeHidden()

  await flipLan(page, true)
  await foldSettled(page)
  await expect(tools).toBeVisible()
  await expect(url).toBeVisible()

  await flipLan(page, false)
  await foldSettled(page)
  await expect(tools).toBeHidden()
  await lanSwitch(page).focus()
  await page.keyboard.press('Tab')
  await expect(url).not.toBeFocused()
  await expect(page.locator('.lan-access :focus')).toHaveCount(0)
})
