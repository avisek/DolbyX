/**
 * #85: the Advanced panel's geometry — what jsdom can't see (ADR-0011).
 * Real browser, real daemon, the shipped parameter table.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/**
 * Opens the panel; the category sections are the subject. The open pref
 * is per origin, so a second page of the same context starts open —
 * only a collapsed panel gets the click.
 */
async function openAdvanced(page: Page): Promise<void> {
  await page.goto('/')
  // By class: an open panel's readouts are `status` roles too.
  await expect(page.locator('.connection-badge')).toHaveText('Connected')
  const header = page.getByRole('button', { name: 'Advanced' })
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
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
// skips its content — the first card's switch (`geon`, #86) included.
test('a folded category hides its body and takes it out of the tab order', async ({
  page,
}) => {
  await openAdvanced(page)
  const section = page.getByRole('region', { name: 'Graphic Equalizer' })
  const toggle = section.getByRole('button', { name: /^Graphic Equalizer/ })
  const body = section.locator('.adv-cat__body')

  // Expanded: Tab from the toggle reaches the first card's switch (the
  // disabled reset markers are skipped).
  await toggle.focus()
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toHaveAttribute(
    'aria-label',
    'Graphic Equalizer Enable',
  )

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

// — Discrete controls (#86, behavior 9) —

// A keyboard flip on a switch is a real `edit_profile`: Space on the
// focused switch commits, the daemon acks the originator (which flips
// on the ack) and broadcasts — the peer page's next `state` snapshot
// carries the new value.
test('Tab + Space on a switch commits, and the next snapshot carries it', async ({
  page,
  context,
}) => {
  await openAdvanced(page)
  const peer = await context.newPage()
  await openAdvanced(peer)
  const name = 'Volume Leveler Enable'
  const enable = page.getByRole('switch', { name })
  const peerEnable = peer.getByRole('switch', { name })
  await expect(enable).not.toBeChecked() // Music ships dvle=0
  await expect(peerEnable).not.toBeChecked()

  const toggle = page.getByRole('button', { name: /^Volume Leveler/ })
  await toggle.focus()
  await page.keyboard.press('Tab')
  await expect(enable).toBeFocused()
  await page.keyboard.press('Space')

  await expect(enable).toBeChecked()
  await expect(peerEnable).toBeChecked()
  await expect(enable).toBeFocused()
})

// Arrow keys move within a tristate's radio group — one Tab stop — and
// each move is a commit: the checked segment follows, the peer's next
// snapshot carries the value, and Tab leaves the group as a whole.
test('Arrow keys on a tristate move the selection and commit', async ({
  page,
  context,
}) => {
  await openAdvanced(page)
  const peer = await context.newPage()
  await openAdvanced(peer)
  const name = 'Speaker Virtualizer Enable'
  const group = page.getByRole('radiogroup', { name })
  const radios = group.getByRole('radio')
  const peerRadios = peer.getByRole('radiogroup', { name }).getByRole('radio')
  await expect(radios.nth(0)).toBeChecked() // Music resolves vspe=0

  await radios.nth(0).focus()
  await page.keyboard.press('ArrowRight')
  await expect(radios.nth(1)).toBeChecked()
  await expect(peerRadios.nth(1)).toBeChecked()
  await page.keyboard.press('ArrowRight')
  await expect(radios.nth(2)).toBeChecked()
  await expect(peerRadios.nth(2)).toBeChecked()
  await expect(radios.nth(2)).toBeFocused()

  // One Tab stop: Tab leaves the group for the next card's control.
  await page.keyboard.press('Tab')
  await expect(group.locator(':focus')).toHaveCount(0)
})
