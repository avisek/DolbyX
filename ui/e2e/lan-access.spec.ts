/**
 * Slice 15 (#118): the LAN Access Row in a real browser — the fold the
 * tools animate through, the narrow reflow (switch on line 1, tools on
 * line 2), no sideways overflow off or on, and the QR Popover escaping
 * the tools' clip. Rendered-geometry truth needs a browser (ADR-0011);
 * jsdom sees only the modifier / focus seam. Real daemon: flipping LAN
 * on binds the LAN listener for real (ADR-0012).
 */
import type { Page } from '@playwright/test'
import {
  box,
  expect,
  expectNoOverflow,
  flipLan,
  foldSettled,
  openAt,
  sameLine,
  test,
} from './fixtures'

/** The page-side fold sampler's slot (armFoldSampler / foldSamples). */
type FoldWindow = Window & { __fold?: Promise<number[]> }

const lanSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'LAN access' })

/**
 * Arms a page-side sampler: once `--on` flips, it records the tools'
 * width every frame for longer than the fold, then resolves. Armed
 * before the click, read after it — the flip lands on a WS ack, so
 * the sample must not depend on the test's round-trip timing.
 */
async function armFoldSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const row = document.querySelector('.lan-access')
    const tools = document.querySelector('.lan-access__tools')
    if (!row || !tools) throw new Error('LAN row not rendered')
    // The built stylesheet may read `.24s` where the token says `240ms`.
    const fold = getComputedStyle(document.documentElement)
      .getPropertyValue('--fold-ms')
      .trim()
    const foldMs = fold.endsWith('ms')
      ? parseFloat(fold)
      : parseFloat(fold) * 1000
    ;(window as FoldWindow).__fold = new Promise<number[]>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect()
        const samples: number[] = []
        const start = performance.now()
        const tick = () => {
          samples.push(tools.getBoundingClientRect().width)
          if (performance.now() - start < foldMs * 2)
            requestAnimationFrame(tick)
          else resolve(samples)
        }
        tick()
      })
      observer.observe(row, { attributes: true, attributeFilter: ['class'] })
    })
  })
}

const foldSamples = (page: Page) =>
  page.evaluate(() => (window as FoldWindow).__fold)

const toolsVisibility = (page: Page) =>
  page
    .locator('.lan-access__tools')
    .evaluate((el) => getComputedStyle(el).visibility)

// Behavior 6: flipping LAN via the Row animates the tools in and out —
// widths differ mid-transition — and, once off, the fold lands them
// out of the tab order (`visibility: hidden`).
test('flipping LAN folds the tools out and in; off lands them hidden', async ({
  page,
}) => {
  await openAt(page, 1280)
  await expect(lanSwitch(page)).not.toBeChecked()
  expect(await toolsVisibility(page)).toBe('hidden')
  expect((await box(page, '.lan-access__tools')).width).toBe(0)

  await armFoldSampler(page)
  await flipLan(page, true)
  const unfold = (await foldSamples(page)) ?? []
  const open = unfold.at(-1) ?? 0
  expect(open).toBeGreaterThan(0)
  // Mid-transition: at least one sample strictly between folded and open.
  expect(unfold.some((w) => w > 0 && w < open)).toBe(true)
  expect(await toolsVisibility(page)).toBe('visible')

  await armFoldSampler(page)
  await flipLan(page, false)
  const fold = (await foldSamples(page)) ?? []
  expect(fold.some((w) => w > 0 && w < open)).toBe(true)
  expect(fold.at(-1)).toBe(0)
  await expect.poll(() => toolsVisibility(page)).toBe('hidden')
})

// Behavior 6, 390: the switch shares line 1 with the text; the tools
// sit right-aligned on line 2.
test('at 390px the switch stays on the text line and the tools drop to a right-aligned second line', async ({
  page,
}) => {
  await openAt(page, 390)
  await flipLan(page, true)
  await foldSettled(page)

  const text = await box(page, '.lan-access__text')
  const toggle = await box(page, '#lan')
  const tools = await box(page, '.lan-access__tools')
  const rowEdge = await page.locator('.lan-access').evaluate((el) => {
    const { right } = el.getBoundingClientRect()
    return right - parseFloat(getComputedStyle(el).paddingRight)
  })

  expect(sameLine(toggle, text)).toBe(true)
  expect(toggle.left).toBeGreaterThan(text.right)
  // Line 2, flush right.
  expect(tools.top).toBeGreaterThanOrEqual(toggle.bottom)
  expect(tools.right).toBeCloseTo(rowEdge, 1)
})

// Behavior 6: nothing overflows sideways with LAN off or on, narrow or
// wide — the folded tools and the closed popover add no scroll width.
for (const width of [390, 1280]) {
  test(`at ${String(width)}px the Row never widens the page, LAN off or on`, async ({
    page,
  }) => {
    await openAt(page, width)
    await expectNoOverflow(page)

    await flipLan(page, true)
    await foldSettled(page)
    await expectNoOverflow(page)
  })
}

// The Row lifts on hover (`.lan-access:where(:hover)` — the pseudo-class
// alone inside `:where()`, or the base rule's own layer outranks it).
test('hovering the Row tints its surface', async ({ page }) => {
  await openAt(page, 1280)
  const layer = () =>
    page
      .locator('.lan-access')
      .evaluate((el) => getComputedStyle(el).backgroundImage)
  const rest = await layer()
  await page.getByText('LAN Access').hover()
  await expect.poll(layer).not.toBe(rest)
})

// Behavior 6: the open Popover escapes the tools' clip and stacks
// above the rows below — a hit at its centre lands inside the figure.
test('the open QR popover is hit-testable at its centre', async ({ page }) => {
  await openAt(page, 1280)
  await flipLan(page, true)

  await page.getByRole('button', { name: 'Show QR code' }).click()
  const figure = page.locator('.lan-access__qr')
  await expect(figure).toBeVisible()
  await expect(figure).toBeFocused()

  const hit = await figure.evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect()
    const target = document.elementFromPoint(left + width / 2, top + height / 2)
    return target !== null && el.contains(target)
  })
  expect(hit).toBe(true)
})
