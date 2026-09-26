/**
 * #93: the Master controls in a real browser — what jsdom can't see
 * (ADR-0011): one control height across the Row, the subgrid's shared
 * box column, the narrow reflow, hover under focus weight. Real
 * daemon, the Classic skin.
 */
import type { Page } from '@playwright/test'
import { box, expect, openAt, pageOverflow, test, tokenColor } from './fixtures'

/** A token's length in px as the root resolves it (rem tokens). */
const tokenPx = (page: Page, token: string) =>
  page.evaluate((name) => {
    const root = getComputedStyle(document.documentElement)
    return parseFloat(root.getPropertyValue(name)) * parseFloat(root.fontSize)
  }, token)

const rowBackground = (page: Page, row: string) =>
  page.locator(row).evaluate((el) => getComputedStyle(el).backgroundColor)

const DIALOG = '.master-control:has(#master-deon)'

// Behavior 8, 1280: switch, box and Slider stand at one control height;
// the three boxes share a left edge (the subgrid's box track); the card
// shares a row with the visualizer.
test('at 1280px the row is one line, boxes align across rows, the card sits beside the visualizer', async ({
  page,
}) => {
  await openAt(page, 1280)
  const rows = page.locator('.master-control')
  await expect(rows).toHaveCount(3)

  const geometry = await rows.evaluateAll((elements) =>
    elements.map((row) => {
      const rect = (selector: string) => {
        const el = row.querySelector(selector)
        if (!el) throw new Error(`${selector} not rendered`)
        return el.getBoundingClientRect()
      }
      return {
        switch: rect('[role=switch]').height,
        box: rect('.adv-input__field').height,
        slider: rect('[role=slider]').height,
        boxLeft: rect('.adv-input').left,
      }
    }),
  )
  for (const row of geometry) {
    expect(row.switch).toBeGreaterThan(0)
    expect(Math.abs(row.box - row.switch)).toBeLessThan(1)
    expect(Math.abs(row.slider - row.switch)).toBeLessThan(1)
  }
  const [first, ...rest] = geometry
  for (const row of rest)
    expect(row.boxLeft).toBeCloseTo(first?.boxLeft ?? NaN, 1)

  const card = await box(page, '.master-controls')
  const vis = await box(page, '.visualizer')
  expect(card.top).toBeCloseTo(vis.top, 1)
  expect(card.left).toBeGreaterThanOrEqual(vis.right)
})

// Behavior 9, 390: the box + Slider line drops under the title line and
// the Slider reaches the Row's content edge; `--space-2` separates
// marker and switch; nothing overflows sideways.
test('at 390px the amount line drops under the title and the Slider reaches the edge', async ({
  page,
}) => {
  await openAt(page, 390)

  const title = await box(page, `${DIALOG} .master-control__label`)
  const field = await box(page, `${DIALOG} .adv-input`)
  const slider = await box(page, `${DIALOG} [role=slider]`)
  expect(field.top).toBeGreaterThanOrEqual(title.bottom)
  expect(slider.top).toBeGreaterThanOrEqual(title.bottom)

  // The prototype's Row keeps its inline padding: the Slider fills the
  // Row's content box to its edge.
  const rowEdge = await page.locator(DIALOG).evaluate((el) => {
    const { right } = el.getBoundingClientRect()
    return right - parseFloat(getComputedStyle(el).paddingRight)
  })
  expect(Math.abs(slider.right - rowEdge)).toBeLessThanOrEqual(1)

  const marker = await box(page, `${DIALOG} .master-control__reset`)
  const toggle = await box(page, `${DIALOG} [role=switch]`)
  expect(toggle.left - marker.right).toBeCloseTo(
    await tokenPx(page, '--space-2'),
    1,
  )

  const overflow = await pageOverflow(page)
  expect(overflow.scrollWidth).toBe(overflow.innerWidth)
})

// Behavior 10: hovering a Row paints the hover fill and lifts its
// thumb, like a panel card; Tab into its box swaps the fill for the
// focus tint and rings the box — focus outranks hover, the hover tint
// never stacks on top.
test('hovering a row tints it; focus in its box carries the focus tint and a ring', async ({
  page,
}) => {
  await openAt(page, 1280)
  const at = await box(page, `${DIALOG} .master-control__label`)
  await page.mouse.move(at.left + 4, at.top + at.height / 2)
  await expect
    .poll(() => rowBackground(page, DIALOG))
    .toBe(await tokenColor(page, '--hover-bg'))
  await expect(page.locator(`${DIALOG} .adv-slider__thumb`)).toHaveCSS(
    'scale',
    '1.2',
  )

  // Keep the pointer on the row: focus must win the contest, not
  // merely replace a departed hover.
  await page.getByRole('switch', { name: 'Dialog Enhancer enable' }).focus()
  await page.keyboard.press('Tab')
  const field = page.getByRole('textbox', { name: 'Dialog Enhancer amount' })
  await expect(field).toBeFocused()
  await expect
    .poll(() => rowBackground(page, DIALOG))
    .toBe(await tokenColor(page, '--focus-tint'))
  await expect(field).toHaveCSS(
    'border-color',
    await tokenColor(page, '--color-accent'),
  )
})
