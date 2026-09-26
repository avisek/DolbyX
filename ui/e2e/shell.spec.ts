/**
 * Slice 13 (#116): the Shell in a real browser — fluid at every width
 * with no viewport unit, the visualizer filling its cell, the Off-look
 * as one rule, the Advanced header's bleed. Rendered-geometry truth
 * needs a browser (ADR-0011); jsdom sees only the var/class seam.
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

/** Viewport width → whether the visualizer and master controls share a row. */
const LAYOUTS = [
  { width: 390, sideBySide: false },
  { width: 700, sideBySide: false },
  { width: 1280, sideBySide: true },
]

/** Rendered edges of one element — a DOMRect won't cross the wire. */
const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const { top, right, bottom, left, width } = el.getBoundingClientRect()
    return { top, right, bottom, left, width }
  })

// Behavior 3: no horizontal overflow at any width; the visualizer's box
// is exactly its grid cell; the two-up region stacks or shares a row.
for (const { width, sideBySide } of LAYOUTS) {
  test(`at ${String(width)}px nothing overflows and the visualizer fills its cell`, async ({
    page,
  }) => {
    await openAt(page, width)

    const overflow = await pageOverflow(page)
    expect(overflow.scrollWidth).toBe(overflow.innerWidth)

    // The grid's resolved first track is the cell the visualizer sits in.
    const cellWidth = await page.locator('.app').evaluate((el) => {
      const [first] = getComputedStyle(el).gridTemplateColumns.split(' ')
      return parseFloat(first ?? '')
    })
    const vis = await box(page, '.visualizer')
    expect(vis.width).toBeCloseTo(cellWidth, 1)

    const master = await box(page, '.master-controls')
    if (sideBySide) {
      expect(master.top).toBeCloseTo(vis.top, 1)
      expect(master.left).toBeGreaterThanOrEqual(vis.right)
    } else {
      expect(master.top).toBeGreaterThanOrEqual(vis.bottom)
      expect(master.left).toBeCloseTo(vis.left, 1)
    }
  })
}

// Behavior 4: power off dims every region but the header to
// `--off-opacity`, and the dimmed controls still operate.
test('power off dims everything but the header, controls still flip', async ({
  page,
}) => {
  await openAt(page, 1280)
  const power = page.getByRole('switch', { name: 'Power' })
  await power.click()
  await expect(power).not.toBeChecked()

  const opacities = await page.evaluate(() => {
    // Numbers: the minified token reads `.45`, computed opacity `0.45`.
    const off = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--off-opacity',
      ),
    )
    const of = (selector: string) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`${selector} not rendered`)
      return parseFloat(getComputedStyle(el).opacity)
    }
    return {
      off,
      header: of('.app__header'),
      lan: of('.lan-access'),
      profiles: of('.profile-tabs'),
      presets: of('.eq-preset-picker'),
      visualizer: of('.visualizer'),
      master: of('.master-controls'),
    }
  })
  expect(opacities.off).toBeGreaterThan(0)
  expect(opacities.off).toBeLessThan(1)
  expect(opacities.header).toBe(1)
  for (const key of [
    'lan',
    'profiles',
    'presets',
    'visualizer',
    'master',
  ] as const) {
    expect(opacities[key]).toBe(opacities.off)
  }

  // Dimmed, not disabled: a master switch flips on its ack.
  const dialog = page.getByRole('switch', { name: 'Dialog Enhancer enable' })
  const before = await dialog.getAttribute('aria-checked')
  await dialog.click()
  await expect(dialog).toHaveAttribute(
    'aria-checked',
    before === 'true' ? 'false' : 'true',
  )
})

// Behavior 5: hovering the Advanced disclosure header tints its pseudo,
// whose hit box bleeds `--space-3` past the column edge on both sides.
test('the Advanced header tints on hover and bleeds into the gutter', async ({
  page,
}) => {
  await openAt(page, 1280)
  const header = page.getByRole('button', { name: 'Advanced' })
  const headerBackground = () => pseudoBackground(page, '.advanced__header')

  expect(await headerBackground()).toBe(TRANSPARENT)
  await header.hover()
  await expect.poll(headerBackground).not.toBe(TRANSPARENT)

  // Text flush with the column: the header's box is the column's
  // content box; hits land `--space-3` beyond it on each side, not past.
  const geometry = await bleedHits(page, '.advanced__header')
  const { left, right } = await box(page, '.advanced__header')
  expect(left).toBeCloseTo(geometry.columnLeft, 1)
  expect(right).toBeCloseTo(geometry.columnRight, 1)
  expect(geometry).toMatchObject({
    insideLeft: true,
    outsideLeft: false,
    insideRight: true,
    outsideRight: false,
  })
})
