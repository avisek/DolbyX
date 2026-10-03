/**
 * Slice 15 (#118): the LAN Access Row in a real browser — the fold
 * landing the tools in and out of the tab order, no sideways overflow
 * off or on, and the QR Popover reachable at its centre. jsdom sees
 * only the modifier / focus seam (ADR-0011). Real daemon: flipping LAN
 * on binds the LAN listener for real (ADR-0012).
 */
import type { Page } from '@playwright/test'
import {
  expect,
  expectNoOverflow,
  flipLan,
  foldSettled,
  openAt,
  test,
} from './fixtures'

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

// Behavior 6: nothing overflows sideways with LAN off or on, narrow or
// wide — the folded tools and the closed popover add no scroll width.
for (const width of [390, 1280]) {
  test(`at ${String(width)}px the Row never widens the page, LAN off or on`, async ({
    page,
  }) => {
    await openAt(page, width)
    await expectNoOverflow(page)

    await flipLan(page, true)
    await foldSettled(page)
    await expectNoOverflow(page)
  })
}

// Behavior 6: the open Popover escapes the tools' clip and stacks
// above the rows below — a hit at its centre lands inside the figure.
test('the open QR popover is hit-testable at its centre', async ({ page }) => {
  await openAt(page, 1280)
  await flipLan(page, true)

  await page.getByRole('button', { name: 'Show QR code' }).click()
  const figure = page.locator('.lan-access__qr')
  await expect(figure).toBeVisible()
  await expect(figure).toBeFocused()

  const hit = await figure.evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect()
    const target = document.elementFromPoint(left + width / 2, top + height / 2)
    return target !== null && el.contains(target)
  })
  expect(hit).toBe(true)
})
