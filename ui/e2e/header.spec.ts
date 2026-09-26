/**
 * Slice 14 (#117): the header in a real browser — the power label's
 * stretched `::before` is the whole header's hit and hover surface,
 * bleeding `--space-3` into the gutter. Rendered-geometry truth needs a
 * browser (ADR-0011); jsdom sees only the label → input forward.
 */
import type { Page } from '@playwright/test'
import {
  bleedHits,
  expect,
  openAt,
  pageOverflow,
  pseudoBackground,
  test,
  TRANSPARENT,
} from './fixtures'

const power = (page: Page) => page.getByRole('switch', { name: 'Power' })

/** The power row's `::before` — the hit + hover surface. */
const rowPseudoBackground = (page: Page) => pseudoBackground(page, '.power')

/** A token's colour as the browser resolves it (a `color-mix` won't compare as text). */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement('div')
    probe.style.background = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, token)

/** Centre of the wordmark — the pointer's target; the label's pseudo is what receives it. */
async function titleCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByRole('heading', { name: 'DolbyX' }).boundingBox()
  if (!box) throw new Error('title not rendered')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Behavior 2: a click on the wordmark lands on the label's pseudo and
// forwards to the switch — power flips on the real daemon, then back.
test('clicking the wordmark flips power, and again restores it', async ({
  page,
}) => {
  await openAt(page, 1280)
  await expect(power(page)).toBeChecked()

  const { x, y } = await titleCentre(page)
  await page.mouse.click(x, y)
  await expect(power(page)).not.toBeChecked()

  await page.mouse.click(x, y)
  await expect(power(page)).toBeChecked()
})

// Behavior 3: hovering the title paints the row's pseudo with the hover
// fill; Tab to the switch swaps it for the focus tint and rings the
// switch — focus outranks hover.
test('hovering the title tints the power row; Tab carries the focus tint and rings the switch', async ({
  page,
}) => {
  await openAt(page, 1280)
  expect(await rowPseudoBackground(page)).toBe(TRANSPARENT)

  const { x, y } = await titleCentre(page)
  await page.mouse.move(x, y)
  await expect
    .poll(() => rowPseudoBackground(page))
    .toBe(await tokenColor(page, '--hover-bg'))

  // The switch is the document's first tab stop.
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await expect(power(page)).toBeFocused()
  await expect
    .poll(() => rowPseudoBackground(page))
    .toBe(await tokenColor(page, '--focus-tint'))
  const outline = await power(page).evaluate((el) => {
    const { outlineStyle, outlineWidth } = getComputedStyle(el)
    return { style: outlineStyle, width: parseFloat(outlineWidth) }
  })
  expect(outline.style).not.toBe('none')
  expect(outline.width).toBeGreaterThan(0)
})

// Behavior 4: the header's hit surface reaches `--space-3` past the
// column edge on both sides — not further — and, hovered, never widens
// the page, narrow or wide.
for (const width of [390, 1280]) {
  test(`at ${String(width)}px the power row's surface bleeds into the gutter without overflow`, async ({
    page,
  }) => {
    await openAt(page, width)

    expect(await bleedHits(page, '.power', '.app__header')).toMatchObject({
      insideLeft: true,
      outsideLeft: false,
      insideRight: true,
      outsideRight: false,
    })

    const { x, y } = await titleCentre(page)
    await page.mouse.move(x, y)
    await expect.poll(() => rowPseudoBackground(page)).not.toBe(TRANSPARENT)
    const overflow = await pageOverflow(page)
    expect(overflow.scrollWidth).toBe(overflow.innerWidth)
  })
}
