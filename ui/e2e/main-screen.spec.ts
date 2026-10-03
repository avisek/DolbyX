/**
 * #94: the main screen as one product — real browser, real daemon, the
 * default skin. Screen-level invariants jsdom can't see (ADR-0011): no
 * sideways overflow with every region open, a visible focus indicator
 * on every tab stop, the connection badge's modifier following the
 * socket.
 */
import type { Page } from '@playwright/test'
import {
  expandAdvanced,
  expect,
  expectNoOverflow,
  flipLan,
  foldSettled,
  openAt,
  test,
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

/** The page-side slot holding every field's idle border colour. */
type RestWindow = Window & { __restBorder?: WeakMap<Element, string> }

/**
 * Records every field's border colour while nothing is focused, so the
 * walk can tell a focus line from the field's own idle border without
 * reading a skin token. Call with the pointer parked, before Tab 1.
 */
const recordRestBorders = (page: Page) =>
  page.evaluate(() => {
    const rest = new WeakMap<Element, string>()
    for (const el of document.querySelectorAll('input, textarea')) {
      rest.set(el, getComputedStyle(el).borderColor)
    }
    ;(window as RestWindow).__restBorder = rest
  })

/**
 * The focused element, named by its accessible name / text; `indicated`
 * when a ring the skin painted (an outline, never the browser's `auto`
 * fallback) sits on it, its `::before`, a descendant (a thumb), or its
 * next sibling (a hidden radio's pill), or its border differs from its
 * own idle border — the skin's focus mark on fields. `last` on the
 * Advanced header, the main screen's end.
 */
const describeFocus = (page: Page) =>
  page.evaluate(async (): Promise<Stop> => {
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
    const restBorder = (window as RestWindow).__restBorder?.get(el)
    const indicated =
      ring(el) ||
      ring(el, '::before') ||
      [...el.querySelectorAll('*')].some((child) => ring(child)) ||
      (sibling !== null && ring(sibling)) ||
      (restBorder !== undefined &&
        getComputedStyle(el).borderColor !== restBorder)
    // A hidden radio is named by its pill — its label.
    const label = el instanceof HTMLInputElement ? el.labels?.[0] : undefined
    return {
      name: el.getAttribute('aria-label') ?? (label ?? el).textContent.trim(),
      indicated,
      last: el.classList.contains('advanced__header'),
    }
  })

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
  await page.mouse.move(0, 0)
  await recordRestBorders(page)
  const stops: Stop[] = []
  for (let i = 0; i < 60 && !stops.at(-1)?.last; i++) {
    await page.keyboard.press('Tab')
    stops.push(await describeFocus(page))
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
