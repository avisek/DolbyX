/**
 * #94: the main screen as one product — real browser, real daemon, the
 * Classic skin. Screen-level invariants jsdom can't see (ADR-0011): no
 * sideways overflow with every region open, a visible focus indicator
 * on every tab stop, the connection badge's modifier following the
 * socket, and two screenshot baselines for eyeballing.
 */
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  expandAdvanced,
  expect,
  expectNoOverflow,
  flipLan,
  foldSettled,
  openAt,
  test,
  tokenColor,
} from './fixtures'

// Behavior 2: with the panel open and LAN on, nothing widens the page at
// any width — QR Popover closed, open, and closed again.
for (const width of [390, 700, 1280]) {
  test(`at ${String(width)}px nothing overflows with the panel open, LAN on, QR open and closed`, async ({
    page,
  }) => {
    await openAt(page, width)
    await expandAdvanced(page)
    await flipLan(page, true)
    await foldSettled(page)
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
 * The focused element, named by its accessible name / text; `indicated`
 * when a ring the skin painted (an outline, never the browser's `auto`
 * fallback) sits on it, its `::before`, a descendant (a thumb), or its
 * next sibling (a hidden radio's pill), or its border is the accent
 * line — the skin's focus mark on fields. `last` on the Advanced
 * header, the main screen's end.
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

/**
 * The Master control Rows' stops in DOM order: the Reset marker only
 * while the pair diverges (`disabled` when clean — the walk diverges
 * Dialog Enhancer first), then the switch, the box and the Slider,
 * which share a name.
 */
const masterStops = (control: string, diverged = false) => [
  ...(diverged ? [`Reset ${control}`] : []),
  `${control} enable`,
  `${control} amount`,
  `${control} amount`,
]

// Behavior 3: Tab through the whole main screen — power, the LAN Access
// Row, both Pickers with an enabled Reset, the EQ sliders, the Master
// control Rows with an enabled Reset marker, the Advanced header — and
// every stop shows a focus indicator.
test('every tab stop on the main screen shows a focus indicator', async ({
  page,
}) => {
  await openAt(page, 1280)
  await flipLan(page, true)
  // One step up on Dialog Enhancer's box: its Row's marker and the
  // profile's Reset come alive, so the walk reaches both.
  await page.getByRole('textbox', { name: 'Dialog Enhancer amount' }).focus()
  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('button', { name: 'Reset Dialog Enhancer' }),
  ).toBeEnabled()
  // A fresh document over the same daemon: LAN and the edit persist,
  // focus starts from the top, nothing hovered — the indicator seen is
  // focus's alone.
  await openAt(page, 1280)
  const accent = await tokenColor(page, '--color-accent')
  await page.mouse.move(0, 0)
  const stops: Stop[] = []
  for (let i = 0; i < 60 && !stops.at(-1)?.last; i++) {
    await page.keyboard.press('Tab')
    stops.push(await describeFocus(page, accent))
  }

  // The walk covered the screen in DOM order — a stale selector would
  // drop a whole region silently. The EQ sliders are the five default
  // ones over the shipped `gebf` (defaults.toml); the Pickers' other
  // actions are disabled on a Factory item and never stop the walk.
  expect(stops.map((stop) => stop.name)).toEqual([
    'Power',
    'LAN access',
    'LAN URL',
    'Copy URL',
    'Show QR code',
    'Music', // the checked pill: one tab stop for the group
    'Add profile',
    'Reset profile',
    'None',
    'Add EQ preset',
    '43 Hz',
    '603 Hz',
    '2067 Hz',
    '5685 Hz',
    '18777 Hz',
    ...masterStops('Surround Virtualizer'),
    ...masterStops('Dialog Enhancer', true),
    ...masterStops('Volume Leveller'),
    'Advanced',
  ])
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

// Screenshot baselines for eyeballing — never compared: a visual drift
// shows up as a binary diff in review, not as a red test. Every run
// writes them beside its results; `REFRESH_BASELINES=1` writes the
// checked-in ones (`e2e/baselines/`). LAN on so the tools are in frame —
// the URL masked, its host and port being this machine's and this
// run's; the Advanced panel stays collapsed (the main screen ends above
// it).
for (const width of [390, 1280]) {
  test(`screenshot baseline at ${String(width)}px`, async ({ page }, info) => {
    await openAt(page, width)
    await flipLan(page, true)
    await foldSettled(page)
    await page.mouse.move(0, 0)
    const file = `main-screen-${String(width)}.png`
    const shot = await page.screenshot({
      path: process.env.REFRESH_BASELINES
        ? join(import.meta.dirname, 'baselines', file)
        : info.outputPath(file),
      mask: [page.getByRole('textbox', { name: 'LAN URL' })],
      maskColor: await tokenColor(page, '--color-bg'),
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    })
    expect(shot.length).toBeGreaterThan(0)
  })
}
