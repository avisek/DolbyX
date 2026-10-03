/**
 * #138: the contract suite — what every registered skin owes the
 * skeleton, in a real browser, over every skin in turn (ADR-0011
 * switching addendum): no sideways overflow with every region open,
 * every control reachable by the pointer. Taste is never pinned. One
 * daemon per width; the skins loop inside as steps, switched over the
 * wire between them. A skin declaring `light dark` on `:root` repeats
 * the pass under the light scheme. The focus walk is Part 2's.
 */
import type { Page } from '@playwright/test'
import {
  collapseAdvanced,
  declaresLightDark,
  expandAdvanced,
  expect,
  expectNoOverflow,
  expectReachable,
  flipLan,
  foldSettled,
  openAt,
  setSkin,
  skinList,
  test,
} from './fixtures'

/**
 * The overflow matrix — closed, panel open, LAN on, QR open (and
 * hit-testable at its centre), QR closed — then reachability with
 * everything open; ends where it started (closed, LAN off) so the next
 * skin, or the light pass, sees the same screen.
 */
async function contract(page: Page): Promise<void> {
  await expectNoOverflow(page)
  await expandAdvanced(page)
  await expectNoOverflow(page)
  await flipLan(page, true)
  await foldSettled(page)
  await expectNoOverflow(page)

  const figure = page.locator('.lan-access__qr')
  await page.getByRole('button', { name: 'Show QR code' }).click()
  await expect(figure).toBeFocused()
  await expectNoOverflow(page)
  // The open Popover escapes the tools' clip and stacks above the rows
  // below it: a hit at its centre lands inside the figure.
  const hit = await figure.evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect()
    const target = document.elementFromPoint(left + width / 2, top + height / 2)
    return target !== null && el.contains(target)
  })
  expect(hit).toBe(true)

  await page.keyboard.press('Escape')
  await expect(figure).toBeHidden()
  await expectNoOverflow(page)

  await expectReachable(page)

  await flipLan(page, false)
  await foldSettled(page)
  await collapseAdvanced(page)
}

// Behavior 1: matrix + reachability at every width, every skin, both
// schemes where the skin declares both.
for (const width of [390, 700, 1280]) {
  test(`at ${String(width)}px every skin keeps the page unwidened and every control reachable`, async ({
    page,
  }) => {
    await openAt(page, width)
    for (const skin of await skinList(page)) {
      await test.step(skin.id, async () => {
        await setSkin(page, skin.id)
        await contract(page)
        if (await declaresLightDark(page)) {
          await page.emulateMedia({ colorScheme: 'light' })
          await contract(page)
          await page.emulateMedia({ colorScheme: 'dark' })
        }
      })
    }
  })
}
