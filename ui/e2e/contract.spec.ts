/**
 * #138: the contract suite — what every registered skin owes the
 * skeleton, in a real browser, over every skin in turn (ADR-0011
 * switching addendum): no sideways overflow with every region open,
 * every control reachable by the pointer. Taste is never pinned. One
 * daemon per width; the skins loop inside as steps, switched over the
 * wire between them. A skin declaring `light dark` on `:root` repeats
 * the pass under the light scheme.
 *
 * The focus walk (1280 only — a focus mark is not width-sensitive)
 * judges the mark by pixel diff: a clipped screenshot of the stop
 * focused vs blurred must differ. A skin may mark focus with anything
 * — outline, border, box-shadow, colour, a tint on its Row, an opacity
 * reveal — so no property list can judge it; and an invisible control
 * with a ring changes no pixel, so visibility is subsumed. Hazard: the
 * walk assumes nothing under a clip moves on its own — Vis idle, no
 * feed, no plugin tone. Never run it under a live feed.
 */
import type { CDPSession, Page } from '@playwright/test'
import {
  collapseAdvanced,
  countStateFrames,
  declaresLightDark,
  expandAdvanced,
  expect,
  expectNoOverflow,
  expectReachable,
  flipLan,
  foldSettled,
  openAt,
  setSkin,
  skinList,
  test,
} from './fixtures'

/**
 * The overflow matrix — closed, panel open, LAN on, QR open (and
 * hit-testable at its centre), QR closed — then reachability with
 * everything open; ends where it started (closed, LAN off) so the next
 * skin, or the light pass, sees the same screen.
 */
async function contract(page: Page): Promise<void> {
  await expectNoOverflow(page)
  await expandAdvanced(page)
  await expectNoOverflow(page)
  await flipLan(page, true)
  await foldSettled(page)
  await expectNoOverflow(page)

  const figure = page.locator('.lan-access__qr')
  await page.getByRole('button', { name: 'Show QR code' }).click()
  await expect(figure).toBeFocused()
  await expectNoOverflow(page)
  // The open Popover escapes the tools' clip and stacks above the rows
  // below it: a hit at its centre lands inside the figure.
  const hit = await figure.evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect()
    const target = document.elementFromPoint(left + width / 2, top + height / 2)
    return target !== null && el.contains(target)
  })
  expect(hit).toBe(true)

  await page.keyboard.press('Escape')
  await expect(figure).toBeHidden()
  await expectNoOverflow(page)

  await expectReachable(page)

  await flipLan(page, false)
  await foldSettled(page)
  await collapseAdvanced(page)
}

// Behavior 1: matrix + reachability at every width, every skin, both
// schemes where the skin declares both.
for (const width of [390, 700, 1280]) {
  test(`at ${String(width)}px every skin keeps the page unwidened and every control reachable`, async ({
    page,
  }) => {
    await openAt(page, width)
    for (const skin of await skinList(page)) {
      await test.step(skin.id, async () => {
        await setSkin(page, skin.id)
        await contract(page)
        if (await declaresLightDark(page)) {
          await page.emulateMedia({ colorScheme: 'light' })
          try {
            await contract(page)
          } finally {
            await page.emulateMedia({ colorScheme: 'dark' })
          }
        }
      })
    }
  })
}

// — The focus walk —

/**
 * The walk's `<style>`: Chromium paints a caret and a select-all
 * highlight in a freshly tabbed-to field, which would pass a field with
 * no mark of its own — both off. Transitions and animations off too,
 * so each shot is the end state: a mark must hold at rest.
 */
const WALK_STYLE = `
  * { caret-color: transparent !important }
  ::selection { background-color: transparent !important; color: inherit !important }
  *, ::before, ::after { transition: none !important; animation: none !important }
`

/** Room around a stop for a ring, an offset ring, or a glow. */
const CLIP_MARGIN = 12

/** More than any screen has: the walk must leave the document before this. */
const MAX_STOPS = 300

/** A document rectangle — `Page.captureScreenshot`'s `clip`. */
interface Clip {
  x: number
  y: number
  width: number
  height: number
}

/** One tab stop: what holds focus, and the box its mark may paint in. */
interface Stop {
  readonly name: string
  readonly clip: Clip
}

/** A walked stop: its name, and whether its clip changed with focus. */
interface StopMark {
  readonly name: string
  readonly marked: boolean
}

/**
 * The focused element, scrolled into view; `null` once Tab has left
 * the document. Clip: its own box ∪ its `label`s' boxes (a hidden radio
 * paints through its pill, a tristate segment through its card),
 * inflated and clamped to the viewport. Name: its accessible name, else
 * its nearest named ancestor's (a category header's section; a radio's
 * group) plus, for a radio, its own label's text — the last of its
 * labels, as a tristate radio is labelled by its card first.
 */
const describeStop = (margin: number): Stop | null => {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return null
  // The element itself, never its label: Chromium moves the sequential
  // focus navigation starting point to whatever is scrolled into view.
  // Instant: a skin's smooth scrolling would shoot mid-scroll.
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' })
  const labels = el instanceof HTMLInputElement ? [...(el.labels ?? [])] : []
  const boxes = [el, ...labels].map((node) => node.getBoundingClientRect())
  const { clientWidth, clientHeight } = document.documentElement
  const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) - margin)
  const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - margin)
  const right = Math.min(
    clientWidth,
    Math.max(...boxes.map((b) => b.right)) + margin,
  )
  const bottom = Math.min(
    clientHeight,
    Math.max(...boxes.map((b) => b.bottom)) + margin,
  )
  const own = el.getAttribute('aria-label')
  const name =
    own ??
    [
      el.closest('[aria-label]')?.getAttribute('aria-label'),
      el instanceof HTMLInputElement
        ? labels.at(-1)?.textContent.trim()
        : undefined,
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(' ')
  // `Page.captureScreenshot` clips in document coordinates.
  const { scrollX, scrollY } = window
  return {
    name,
    clip: {
      x: left + scrollX,
      y: top + scrollY,
      width: right - left,
      height: bottom - top,
    },
  }
}

// The walk's wire is raw CDP: Playwright's wrappers cost 3–15× per
// call and the walk makes ~800; the frame capture (~35 ms) stays.

/** Presses Tab — a real key, so the stop matches `:focus-visible`. */
async function tab(cdp: CDPSession): Promise<void> {
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/** Runs `fn(arg)` in the page, awaiting a returned promise. */
async function run<A, T>(
  cdp: CDPSession,
  fn: (arg: A) => T,
  arg?: A,
): Promise<Awaited<T>> {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
    returnByValue: true,
    awaitPromise: true,
  })
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    )
  }
  return result.value as Awaited<T>
}

/** The clip's pixels as the encoder's bytes: same pixels ⇒ same string. */
async function capture(cdp: CDPSession, clip: Clip): Promise<string> {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: 1 },
  })
  return data
}

/**
 * Tabs from the top of a fresh document (focus starts before the first
 * control, nothing hovered — the pointer is parked) through every stop
 * until focus leaves, recording each stop's name and whether it paints
 * a mark: its clip focused vs blurred must differ. Tab resumes from a
 * blurred element (the sequential focus navigation starting point), so
 * the blurred shot needs no refocus.
 */
async function walk(page: Page): Promise<StopMark[]> {
  await page.reload()
  // By class: the open panel's readouts are `status` roles too.
  await expect(page.locator('.connection-badge')).toHaveText('Connected')
  // Open from the setup's pref — a click here would seat the starting
  // point on the header and skip the main screen.
  await expect(page.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await page.mouse.move(0, 0)
  await page.addStyleTag({ content: WALK_STYLE })
  const cdp = await page.context().newCDPSession(page)
  try {
    await run(cdp, () => document.fonts.ready)
    const stops: StopMark[] = []
    for (let i = 0; i < MAX_STOPS; i++) {
      await tab(cdp)
      const stop = await run(cdp, describeStop, CLIP_MARGIN)
      if (stop === null) return stops
      const focused = await capture(cdp, stop.clip)
      await run(cdp, () => {
        ;(document.activeElement as HTMLElement).blur()
      })
      const blurred = await capture(cdp, stop.clip)
      stops.push({ name: stop.name, marked: focused !== blurred })
    }
    throw new Error(
      `focus never left the document in ${String(MAX_STOPS)} Tabs`,
    )
  } finally {
    await cdp.detach()
  }
}

/**
 * Every Picker action enabled — a scratch profile, a captured preset,
 * one EQ slider nudge diverging the capture — LAN on for its tools, the
 * panel open (a pref the walk's reloads keep): the longest tab order
 * the screen has.
 */
async function enableEveryStop(page: Page): Promise<void> {
  const stateFrames = countStateFrames(page)
  await openAt(page, 1280)
  // Connect settles at two `state` frames; each add's `get_state`
  // reconcile is one more — the nudge must land after it, or the
  // reconcile's snapshot would overwrite the optimistic edit.
  await expect.poll(stateFrames).toBe(2)
  await page.getByRole('button', { name: 'Add profile' }).click()
  await expect(page.getByRole('radio', { name: 'Music 2' })).toBeChecked()
  await expect.poll(stateFrames).toBe(3)
  await page.getByRole('button', { name: 'Add EQ preset' }).click()
  await expect(page.getByRole('radio', { name: 'Preset 1' })).toBeChecked()
  await expect.poll(stateFrames).toBe(4)
  await page.locator('.eq-slider').first().focus()
  await page.keyboard.press('ArrowUp')
  await flipLan(page, true)
  await expandAdvanced(page)
}

/**
 * The Master control Rows' stops: the Reset marker (live: the scratch
 * profile clones Music, whose values sit off a custom's Baseline — the
 * parameter defaults — on every Master control), the switch, the box
 * and the Slider, which share a name.
 */
const masterStops = (control: string) => [
  `Reset ${control}`,
  `${control} enable`,
  `${control} amount`,
  `${control} amount`,
]

/**
 * One category's stops: the header (named by its section), then its
 * cards' in table order — `one` a single control, `numeric` the field
 * then its Slider, `reset` a live Reset marker (the category's when
 * unnamed). Which markers are live and where the tristates sit follow
 * from Music's values against the parameter defaults.
 */
const category = (
  label: string,
  cards: (names: {
    one: (name: string) => string
    numeric: (name: string) => string[]
    reset: (name?: string) => string
  }) => (string | string[])[],
): string[] => {
  const one = (name: string) => `${label} ${name}`
  return [
    label,
    ...cards({
      one,
      numeric: (name) => [one(name), one(name)],
      reset: (name) =>
        name === undefined ? `Reset ${label}` : `Reset ${one(name)}`,
    }).flat(),
  ]
}

/** The tab order the setup leaves, top to bottom; `skin` names the checked Skin pill. */
const expectedStops = (skin: string): string[] => [
  'Power',
  'Profile Music 2', // the checked pill: one tab stop for the group
  'Add profile',
  'Rename profile',
  'Delete profile',
  'Reset profile',
  'EQ Preset Preset 1',
  'Add EQ preset',
  'Rename EQ preset',
  'Delete EQ preset',
  'Reset EQ preset',
  '43 Hz', // the five default sliders over the shipped `gebf`
  '603 Hz',
  '2067 Hz',
  '5685 Hz',
  '18777 Hz',
  ...masterStops('Surround Virtualizer'),
  ...masterStops('Dialog Enhancer'),
  ...masterStops('Volume Leveller'),
  'LAN access',
  'LAN URL',
  'Copy URL',
  'Show QR code',
  `Skin ${skin}`,
  'Advanced',
  ...category('Volume Leveler', ({ one, numeric, reset }) => [
    reset(),
    reset('Amount'),
    numeric('Amount'),
    numeric('Input Target'),
    numeric('Output Target'),
    reset('Enable'),
    one('Enable'),
    numeric('Modeler Calibration'),
    one('Modeler Enable'),
  ]),
  ...category('Intelligent Equalizer', ({ one, numeric }) => [
    numeric('Band Count'),
    one('Band Frequencies'),
    one('Band Targets'),
    one('Enable'),
    numeric('Amount'),
  ]),
  ...category('Graphic Equalizer', ({ one, numeric, reset }) => [
    reset(),
    reset('Enable'),
    one('Enable'),
    numeric('Band Count'),
    one('Band Frequencies'),
    reset('Band Gains'), // the EQ slider nudge diverged the capture
    one('Band Gains'),
  ]),
  ...category('Dialog Enhancer', ({ one, numeric, reset }) => [
    reset(),
    reset('Enable'),
    one('Enable'),
    reset('Amount'),
    numeric('Amount'),
    numeric('Ducking'),
  ]),
  ...category('Volume Maximizer', ({ one, numeric, reset }) => [
    reset(),
    reset('Enable'),
    one('Enable Off'),
    numeric('Boost'),
  ]),
  ...category('Speaker Virtualizer', ({ one, numeric, reset }) => [
    reset(),
    one('Enable Off'),
    reset('Surround Boost'),
    numeric('Surround Boost'),
    numeric('Speaker Angle'),
    reset('Start Frequency'),
    numeric('Start Frequency'),
    one('Surround Compressor Enable Auto'),
  ]),
  ...category('Headphone Virtualizer', ({ one, numeric, reset }) => [
    reset(),
    reset('Enable'),
    one('Enable Auto'),
    reset('Surround Boost'),
    numeric('Surround Boost'),
    numeric('Reverberation Gain'),
  ]),
  ...category('Next Gen Surround', ({ one }) => [one('Enable Auto')]),
  ...category('Audio Regulator', ({ one, numeric }) => [
    numeric('Band Count'),
    one('Band Frequencies'),
    one('Band Isolates'),
    one('Band Low Thresholds'),
    one('Band High Thresholds'),
    numeric('Overdrive'),
    numeric('Timbre Preservation'),
  ]),
  ...category('Audio Optimizer', ({ one, numeric, reset }) => [
    reset(),
    numeric('Channel Count'),
    numeric('Band Count'),
    one('Band Frequencies'),
    one('Band Gains channel 2'),
    one('Band Gains channel 3'),
    reset('Enable'),
    one('Enable Auto'),
  ]),
  ...category('Peak Limiter', ({ one, numeric }) => [
    numeric('Boost'),
    numeric('Limiting and Protection Mode'),
    one('Test Mode Enable'),
  ]),
  ...category('Endpoint Volume', ({ numeric }) => [
    numeric('Endpoint'),
    numeric('Output Channel Format'),
    numeric('Pre-gain'),
    numeric('Post-gain'),
    numeric('Volume'),
  ]),
  ...category('Visualizer', ({ one, numeric }) => [
    one('Enable'),
    one('Native Band Count'), // read-only: the field alone, its Slider disabled
    one('Native Band Frequencies'),
    one('Native Band Gains'),
    one('Native Band Excitations'),
    numeric('Custom Band Count'),
    one('Custom Band Frequencies'),
    one('Custom Band Gains'),
    one('Custom Band Excitations'),
  ]),
  ...category('Build', ({ one }) => [
    one('Bundle Version'),
    one('Version'),
    one('Bundle ID'),
  ]),
  ...category('License', ({ one }) => [
    one('Manufacturer ID'),
    one('Authentication Status'),
    one('Data Pointer'),
  ]),
]

/**
 * The walk under the current scheme: the stops are the skeleton's, in
 * order (a stale selector or a lost starting point would drop a region
 * silently), and every one paints a mark.
 */
async function expectMarkedWalk(page: Page, skin: string): Promise<void> {
  const stops = await walk(page)
  expect(stops.map((stop) => stop.name)).toEqual(expectedStops(skin))
  expect(stops.filter((stop) => !stop.marked).map((stop) => stop.name)).toEqual(
    [],
  )
}

// Behavior 5: every tab stop — the whole main screen and the open panel
// — paints a focus mark under every skin, both schemes where the skin
// declares both, and the stops are the skeleton's, in order.
test('at 1280px every tab stop shows a focus mark under every skin', async ({
  page,
}) => {
  // ~165 stops × 2 frame captures per walk, one walk per skin and
  // scheme: seconds each, the suite's longest test by far.
  test.slow()
  await enableEveryStop(page)
  for (const skin of await skinList(page)) {
    await test.step(skin.id, async () => {
      await setSkin(page, skin.id)
      await expectMarkedWalk(page, skin.label)
      if (await declaresLightDark(page)) {
        await page.emulateMedia({ colorScheme: 'light' })
        try {
          await expectMarkedWalk(page, skin.label)
        } finally {
          await page.emulateMedia({ colorScheme: 'dark' })
        }
      }
    })
  }
})
