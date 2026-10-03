/**
 * #119 part 2: the Picker in a real browser — what jsdom can't see
 * (ADR-0011): the pills keeping keyboard focus across a real profile
 * switch. Real daemon, the default skin. The actions' focus marks are
 * the contract walk's (contract.spec), looped over every skin.
 */
import type { Page } from '@playwright/test'
import { expect, openAt, test } from './fixtures'

const PROFILE = '.picker--profile'

const profileRadio = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true })

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
