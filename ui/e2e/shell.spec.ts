/**
 * Slice 13 (#116): the Shell in a real browser — the Off-look leaves
 * every control operable. How the dimming looks is skin policy
 * (ADR-0011, switching addendum); that the dimmed controls still flip
 * on the real daemon is the behaviour.
 */
import { expect, openAt, test } from './fixtures'

// Behavior 4 (+ #94 behavior 4): power off, the controls still operate
// — a Master switch flips, a Picker pick lands.
test('power off: controls still flip', async ({ page }) => {
  await openAt(page, 1280)
  const power = page.getByRole('switch', { name: 'Power' })
  await power.click()
  await expect(power).not.toBeChecked()

  // Dimmed, not disabled: a master switch flips on its ack.
  const dialog = page.getByRole('switch', { name: 'Dialog Enhancer enable' })
  const before = await dialog.isChecked()
  await dialog.click()
  await expect(dialog).toBeChecked({ checked: !before })
  // …and a Picker pick lands on its ack (the pill is the radio's
  // click surface; the radio itself is hidden behind it).
  await page
    .getByRole('radiogroup', { name: 'EQ Preset' })
    .getByText('Rich', { exact: true })
    .click()
  await expect(page.getByRole('radio', { name: 'Rich' })).toBeChecked()
})
