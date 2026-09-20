/**
 * #85: the Advanced panel's geometry — what jsdom can't see (ADR-0011).
 * Real browser, real daemon, the shipped parameter table.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** Opens the panel; the category sections are the subject. */
async function openAdvanced(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Connected')
  await page.getByRole('button', { name: 'Advanced' }).click()
}

// Behavior 5: the fold toggle IS the header's box — on every category,
// its bounding box equals the header's, so the whole header is the hit
// area, edge to edge.
test('every category toggle fills its header box', async ({ page }) => {
  await openAdvanced(page)
  const heads = page.locator('.adv-cat__head')
  await expect(heads).toHaveCount(15) // the shipped `[[category]]` rows

  const rects = await heads.evaluateAll((elements) =>
    elements.map((head) => {
      const toggle = head.querySelector('.adv-cat__toggle')
      if (!toggle) throw new Error('header without toggle')
      const box = (el: Element) => el.getBoundingClientRect().toJSON() as object
      return { head: box(head), toggle: box(toggle) }
    }),
  )
  for (const { head, toggle } of rects) expect(toggle).toEqual(head)
})

// Behavior 5: once folded, the body is `visibility: hidden` and Tab
// skips its content. The cards hold nothing focusable yet (readouts,
// disabled reset markers), so the test plants a button in the body —
// the fold must drop it from the tab order all the same.
test('a folded category hides its body and takes it out of the tab order', async ({
  page,
}) => {
  await openAdvanced(page)
  const section = page.getByRole('region', { name: 'Graphic Equalizer' })
  const toggle = section.getByRole('button', { name: /^Graphic Equalizer/ })
  const body = section.locator('.adv-cat__body')
  await body.evaluate((el) => {
    const planted = document.createElement('button')
    planted.textContent = 'planted'
    el.append(planted)
  })

  // Expanded: Tab from the toggle reaches the body (the disabled reset
  // is skipped).
  await toggle.focus()
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toHaveText('planted')

  await toggle.click()
  await expect(section).toHaveClass(/adv-cat--collapsed/)
  await expect(body).toHaveCSS('visibility', 'hidden')

  // Folded: Tab lands on the next category's toggle.
  await toggle.focus()
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toHaveClass(/adv-cat__toggle/)
  await expect(page.locator(':focus')).toHaveText(/^Dialog Enhancer/)
})

// Behavior 10: at 1280 px no label truncates — every `adv-card__label`
// fits its track (wrapping is fine, overflow is not) — and the shared
// tracks hold: within one category every control starts at the same x.
test('labels never overflow and controls align within a category', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openAdvanced(page)
  const labels = page.locator('.adv-card__label')
  await expect(labels).toHaveCount(64) // the shipped `[[param]]` rows

  const overflowing = await labels.evaluateAll((elements) =>
    elements
      .filter((label) => label.scrollWidth > label.clientWidth)
      .map((label) => label.textContent),
  )
  expect(overflowing).toEqual([])

  const controlXs = await page
    .locator('.adv-cat')
    .evaluateAll((sections) =>
      sections.map((section) =>
        [...section.querySelectorAll('.adv-card__control')].map(
          (control) => control.getBoundingClientRect().x,
        ),
      ),
    )
  expect(controlXs).toHaveLength(15)
  for (const xs of controlXs) {
    expect(xs.length).toBeGreaterThan(0)
    expect(new Set(xs).size).toBe(1)
  }
})
