/**
 * #119 part 2: the Picker in a real browser — what jsdom can't see
 * (ADR-0011): the pills keeping keyboard focus across a real profile
 * switch, the ghost actions' focus ring. Real daemon, the default skin.
 */
import type { Page } from '@playwright/test'
import { countStateFrames, expect, openAt, test } from './fixtures'

const PROFILE = '.picker--profile'

const profileRadio = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true })

/** Add clones the selected Music as `Music 2` and auto-selects it. */
async function addScratchProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add profile' }).click()
  await expect(profileRadio(page, 'Music 2')).toBeChecked()
}

const ACTIONS = ['Add', 'Rename', 'Delete', 'Reset'].flatMap((verb) => [
  `${verb} profile`,
  `${verb} EQ preset`,
])

// Behavior 9: every action rings when tabbed to (the skin's
// `:focus-visible` rule). A custom profile and a captured preset enable
// what a Factory item disables; one EQ slider nudge diverges the
// capture so its Reset is live too.
test('tabbing to an action shows a focus ring', async ({ page }) => {
  const stateFrames = countStateFrames(page)
  await openAt(page, 1280)
  // Connect settles at two `state` frames; each add's `get_state`
  // reconcile is one more — the nudge must land after it, or the
  // reconcile's snapshot would overwrite the optimistic edit.
  await expect.poll(stateFrames).toBe(2)
  await addScratchProfile(page)
  await expect.poll(stateFrames).toBe(3)
  await page.getByRole('button', { name: 'Add EQ preset' }).click()
  await expect(page.getByRole('radio', { name: 'Preset 1' })).toBeChecked()
  await expect.poll(stateFrames).toBe(4)
  await page.locator('.eq-slider').first().focus()
  await page.keyboard.press('ArrowUp')

  for (const name of ACTIONS) {
    const button = page.getByRole('button', { name })
    await expect(button).toBeEnabled()

    // Keyboard focus: leave and come back with Tab so `:focus-visible`
    // holds — a programmatic focus alone would not prove the ring.
    await button.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(button).toBeFocused()
    const ring = await button.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        visible: el.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
      }
    })
    expect(ring.visible).toBe(true)
    expect(ring.outlineStyle).not.toBe('none')
    expect(ring.outlineWidth).toBeGreaterThan(0)
  }
})

/** The profile Picker's radio holding focus — one while focus stays in the group. */
const focusedProfileRadio = (page: Page) =>
  page.locator(`${PROFILE} .picker__radio:focus`)

// Behavior 6: Arrow keys move the check natively; the click Chromium
// dispatches asks the daemon (`set_profile`), the ack flips the pill,
// and — positional keying — the focused radio survives the rebuilt
// snapshot: ArrowRight lands on Game, ArrowLeft brings Music back.
test('ArrowRight on the checked profile radio switches the profile and keeps focus in the group; ArrowLeft restores', async ({
  page,
}) => {
  await openAt(page, 1280)
  const music = profileRadio(page, 'Music')
  const game = profileRadio(page, 'Game')
  await expect(music).toBeChecked()
  await music.focus()

  await page.keyboard.press('ArrowRight')
  await expect(game).toBeChecked()
  await expect(music).not.toBeChecked()
  await expect(focusedProfileRadio(page)).toHaveCount(1)

  await page.keyboard.press('ArrowLeft')
  await expect(music).toBeChecked()
  await expect(game).not.toBeChecked()
  await expect(focusedProfileRadio(page)).toHaveCount(1)
})
