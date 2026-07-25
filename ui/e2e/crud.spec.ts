/**
 * Slice 18 part C (#26), behavior 6: full CRUD journeys — real
 * browser, real daemon, real engine. Disabled states derive from the
 * live `overridden` and the factory/None matrix; affordances disable,
 * never hide.
 */
import { expect, test } from './fixtures'

test('profile journey: clone Music → rename → edit → reset → delete', async ({
  page,
}) => {
  await page.goto('/')
  const add = page.getByRole('button', { name: 'Add profile' })
  const rename = page.getByRole('button', { name: 'Rename profile' })
  const remove = page.getByRole('button', { name: 'Delete profile' })
  const reset = page.getByRole('button', { name: 'Reset profile' })

  // Factory Music selected, nothing diverging: only Add is live.
  const music = page.getByRole('tab', { name: 'Music' })
  await expect(music).toHaveAttribute('aria-selected', 'true')
  await expect(add).toBeEnabled()
  await expect(rename).toBeDisabled()
  await expect(remove).toBeDisabled()
  await expect(reset).toBeDisabled()

  // The tracer bullet: Add clones Music's resolved content as
  // `Music 2`, and the ack's minted id auto-selects the clone.
  await add.click()
  const clone = page.getByRole('tab', { name: 'Music 2' })
  await expect(clone).toHaveAttribute('aria-selected', 'true')
  await expect(rename).toBeEnabled()
  await expect(remove).toBeEnabled()
  // A Music clone diverges from the custom baseline (dvla 4 vs 7, …),
  // so the reconciled `overridden` enables Reset.
  await expect(reset).toBeEnabled()

  // Inline rename: Enter commits `edit_profile { id, name }`.
  await rename.click()
  const field = page.getByRole('textbox', { name: 'Profile name' })
  await expect(field).toHaveValue('Music 2')
  await field.fill('Late Night')
  await field.press('Enter')
  const renamed = page.getByRole('tab', { name: 'Late Night' })
  await expect(renamed).toHaveAttribute('aria-selected', 'true')

  // Edit: flip Dialog Enhancer off (Music ships it on).
  const dialog = page.getByRole('switch', { name: 'Dialog Enhancer enable' })
  await expect(dialog).toHaveAttribute('aria-checked', 'true')
  await dialog.click()
  await expect(dialog).toHaveAttribute('aria-checked', 'false')

  // Whole-item reset: the custom falls to the shared layers — never
  // its Music birth clone — so dvla lands the table default 7, not
  // Music's 4. The name survives; nothing is left to clear.
  const leveller = page.getByRole('slider', { name: 'Volume Leveller amount' })
  await expect(leveller).toHaveValue('4')
  await reset.click()
  await expect(leveller).toHaveValue('7')
  await expect(renamed).toHaveAttribute('aria-selected', 'true')
  await expect(reset).toBeDisabled()

  // A pure edit re-enables Reset live — the originator's own union,
  // no snapshot round-trip involved (behavior 2's "flipping live as
  // edits land").
  await dialog.click()
  await expect(dialog).toHaveAttribute('aria-checked', 'true')
  await expect(reset).toBeEnabled()

  // Delete: the tab goes; the selection falls to the Fallback profile.
  await remove.click()
  await expect(renamed).toHaveCount(0)
  await expect(music).toHaveAttribute('aria-selected', 'true')
  await expect(rename).toBeDisabled()
})

test('EQ preset journey: capture from None → rename → delete, matrix tracking the selection', async ({
  page,
}) => {
  await page.goto('/')
  const add = page.getByRole('button', { name: 'Add EQ preset' })
  const rename = page.getByRole('button', { name: 'Rename EQ preset' })
  const remove = page.getByRole('button', { name: 'Delete EQ preset' })
  const reset = page.getByRole('button', { name: 'Reset EQ preset' })
  const none = page.getByRole('radio', { name: 'None' })

  // None selected out of the box: Rename/Delete disabled, and the
  // None row's scoped reset has nothing to clear.
  await expect(none).toHaveAttribute('aria-checked', 'true')
  await expect(rename).toBeDisabled()
  await expect(remove).toBeDisabled()
  await expect(reset).toBeDisabled()

  // A factory selection keeps Rename/Delete disabled — the matrix
  // follows the picker's selection live.
  const rich = page.getByRole('radio', { name: 'Rich' })
  await rich.click()
  await expect(rich).toHaveAttribute('aria-checked', 'true')
  await expect(rename).toBeDisabled()
  await expect(remove).toBeDisabled()

  // Back on None, Add captures Music's own resolved 9 as `Preset 1`;
  // the minted id auto-selects it for this profile.
  await none.click()
  await expect(none).toHaveAttribute('aria-checked', 'true')
  await add.click()
  const captured = page.getByRole('radio', { name: 'Preset 1' })
  await expect(captured).toHaveAttribute('aria-checked', 'true')
  await expect(rename).toBeEnabled()
  await expect(remove).toBeEnabled()
  // Music's own 9 equal the preset custom baseline exactly, so the
  // write law stored nothing — nothing to reset on the fresh capture.
  await expect(reset).toBeDisabled()

  // Inline rename on the captured preset.
  await rename.click()
  const field = page.getByRole('textbox', { name: 'EQ preset name' })
  await expect(field).toHaveValue('Preset 1')
  await field.fill('Warm')
  await field.press('Enter')
  const renamed = page.getByRole('radio', { name: 'Warm' })
  await expect(renamed).toHaveAttribute('aria-checked', 'true')

  // Delete falls this profile to explicit None, never a peer preset.
  await remove.click()
  await expect(renamed).toHaveCount(0)
  await expect(none).toHaveAttribute('aria-checked', 'true')
})
