/**
 * #93: the Master controls' geometry — what jsdom can't see (ADR-0011).
 * Real browser, real daemon, the Classic skin.
 */
import { expect, test } from './fixtures'

// Behavior 9: the three controls of a row — switch, box, Slider — stand
// at one control height (`--control-h`), so the row reads as one line;
// the label text is the box's hit area, and a click on it focuses the
// box.
test('switch, box and slider share one height; the label click focuses the box', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.connection-badge')).toHaveText('Connected')
  const rows = page.locator('.master-control')
  await expect(rows).toHaveCount(3)

  const heights = await rows.evaluateAll((elements) =>
    elements.map((row) => {
      const height = (selector: string) => {
        const el = row.querySelector(selector)
        if (!el) throw new Error(`${selector} not rendered`)
        return el.getBoundingClientRect().height
      }
      return {
        switch: height('[role=switch]'),
        box: height('.adv-input__field'),
        slider: height('[role=slider]'),
      }
    }),
  )
  for (const row of heights) {
    expect(row.switch).toBeGreaterThan(0)
    expect(Math.abs(row.box - row.switch)).toBeLessThan(1)
    expect(Math.abs(row.slider - row.switch)).toBeLessThan(1)
  }

  const label = page.locator('.master-control__label', {
    hasText: 'Dialog Enhancer',
  })
  await label.click()
  await expect(
    page.getByRole('textbox', { name: 'Dialog Enhancer amount' }),
  ).toBeFocused()
})
