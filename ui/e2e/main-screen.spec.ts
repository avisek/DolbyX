/**
 * #94: the main screen as one product — real browser, real daemon, the
 * Classic skin. Screen-level invariants jsdom can't see (ADR-0011): no
 * sideways overflow with every region open, a visible focus indicator
 * on every tab stop, the connection badge's modifier following the
 * socket, and two screenshot baselines for eyeballing.
 */
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openAt, pageOverflow, test, tokenColor } from './fixtures'

/** Flips LAN on via the Row's text — the label forwards to the switch. */
async function flipLanOn(page: Page): Promise<void> {
  await page.getByText('LAN Access').click()
  await expect(page.getByRole('switch', { name: 'LAN access' })).toBeChecked()
  // The tools fold in; geometry is read once the fold has landed.
  await expect
    .poll(() =>
      page
        .locator('.lan-access__tools')
        .evaluate((el) => el.getAnimations().length),
    )
    .toBe(0)
}

/** Expands the Advanced panel (a per-origin pref: only a collapsed one gets the click). */
async function expandAdvanced(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: 'Advanced' })
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

const expectNoOverflow = async (page: Page) => {
  const { scrollWidth, innerWidth } = await pageOverflow(page)
  expect(scrollWidth).toBe(innerWidth)
}

// Behavior 2: with the panel open and LAN on, nothing widens the page at
// any width — QR Popover closed, open, and closed again.
for (const width of [390, 700, 1280]) {
  test(`at ${String(width)}px nothing overflows with the panel open, LAN on, QR open and closed`, async ({
    page,
  }) => {
    await openAt(page, width)
    await expandAdvanced(page)
    await flipLanOn(page)
    await expectNoOverflow(page)

    const figure = page.locator('.lan-access__qr')
    await page.getByRole('button', { name: 'Show QR code' }).click()
    await expect(figure).toBeFocused()
    await expectNoOverflow(page)

    await page.keyboard.press('Escape')
    await expect(figure).toBeHidden()
    await expectNoOverflow(page)
  })
}

/** One tab stop of the walk: what holds focus, and whether it shows it. */
interface Stop {
  readonly name: string
  readonly indicated: boolean
  readonly last: boolean
}

/**
 * The focused element, named by its accessible name / text / class;
 * `indicated` when a ring the skin painted (an outline, never the
 * browser's `auto` fallback) sits on it, its `::before`, a descendant
 * (a thumb), or its next sibling (a hidden radio's pill), or its border
 * is the accent line — the skin's focus mark on fields. `last` on the
 * Advanced header, the main screen's end.
 */
const describeFocus = (page: Page, accent: string) =>
  page.evaluate(async (accentColor): Promise<Stop> => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement)) throw new Error('nothing focused')
    // A field's focus line transitions in: read it once it has landed.
    await Promise.all(
      el.getAnimations({ subtree: true }).map((a) => a.finished),
    )
    const ring = (target: Element, pseudo?: string) => {
      const { outlineStyle, outlineWidth } = getComputedStyle(target, pseudo)
      return (
        outlineStyle !== 'none' &&
        outlineStyle !== 'auto' &&
        parseFloat(outlineWidth) > 0
      )
    }
    const sibling = el.nextElementSibling
    const indicated =
      ring(el) ||
      ring(el, '::before') ||
      [...el.querySelectorAll('*')].some((child) => ring(child)) ||
      (sibling !== null && ring(sibling)) ||
      getComputedStyle(el).borderColor === accentColor
    // A hidden radio is named by its pill — its label.
    const label = el instanceof HTMLInputElement ? el.labels?.[0] : undefined
    return {
      name: el.getAttribute('aria-label') ?? (label ?? el).textContent.trim(),
      indicated,
      last: el.classList.contains('advanced__header'),
    }
  }, accent)

// Behavior 3: Tab through the whole main screen — power, LAN row, both
// Pickers, the EQ sliders, the Master control Rows, the Advanced
// header — and every stop shows a focus indicator.
test('every tab stop on the main screen shows a focus indicator', async ({
  page,
}) => {
  await openAt(page, 1280)
  await flipLanOn(page)
  // A fresh document over the same daemon: LAN stays on (its tools in
  // the tab order), and focus starts from the top, nothing hovered — the
  // indicator seen is focus's alone.
  await openAt(page, 1280)
  const accent = await tokenColor(page, '--color-accent')
  await page.mouse.move(0, 0)
  const stops: Stop[] = []
  for (let i = 0; i < 60 && !stops.at(-1)?.last; i++) {
    await page.keyboard.press('Tab')
    stops.push(await describeFocus(page, accent))
  }
  expect(stops.at(-1)?.last).toBe(true)

  // The walk covered the screen: each region's stops are there, in
  // order — a stale selector would drop a whole region silently.
  const names = stops.map((stop) => stop.name)
  expect(names).toEqual([
    'Power',
    'LAN access',
    'LAN URL',
    'Copy URL',
    'Show QR code',
    'Music', // the checked profile pill: one tab stop for the group
    'Add profile', // Rename / Delete / Reset: disabled on a clean Factory item
    'None',
    'Add EQ preset',
    ...names.filter((name) => name.endsWith(' Hz')), // the EQ sliders, N of them
    ...['Surround Virtualizer', 'Dialog Enhancer', 'Volume Leveller'].flatMap(
      (control) => [
        `${control} enable`,
        `${control} amount`, // the box
        `${control} amount`, // the Slider
      ],
    ),
    'Advanced',
  ])
  expect(names.filter((name) => name.endsWith(' Hz')).length).toBeGreaterThan(1)
  expect(
    stops.filter((stop) => !stop.indicated).map((stop) => stop.name),
  ).toEqual([])
})

// Behavior 5: the badge carries `--connected` while the socket is up and
// drops it the moment the daemon closes it.
test('the connection badge drops --connected when the daemon closes the socket', async ({
  page,
  daemon,
}) => {
  await openAt(page, 1280)
  const badge = page.getByRole('status')
  await expect(badge).toHaveClass(/connection-badge--connected/)

  await daemon.stop()
  await expect(badge).toHaveText('Reconnecting…')
  await expect(badge).not.toHaveClass(/connection-badge--connected/)
})

// Screenshot baselines for eyeballing — written on every run, checked
// in, never compared: a visual drift shows up as a binary diff in
// review, not as a red test. LAN on so the tools are in frame — the URL
// masked, its host and port being this machine's and this run's; the
// Advanced panel stays collapsed (the main screen ends above it).
for (const width of [390, 1280]) {
  test(`screenshot baseline at ${String(width)}px`, async ({ page }) => {
    await openAt(page, width)
    await flipLanOn(page)
    await page.mouse.move(0, 0)
    await page.screenshot({
      mask: [page.getByRole('textbox', { name: 'LAN URL' })],
      maskColor: await tokenColor(page, '--color-bg'),
      path: join(
        import.meta.dirname,
        'baselines',
        `main-screen-${String(width)}.png`,
      ),
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    })
  })
}
