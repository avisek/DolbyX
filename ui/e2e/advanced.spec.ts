/**
 * #85: the Advanced panel in a real browser — what jsdom can't see
 * (ADR-0011): folds leaving the tab order, keyboard commits, the
 * pointer lock, real drags, the daemon round trips. Real daemon, the
 * shipped parameter table, the default skin.
 */
import type { Page } from '@playwright/test'
import { expandAdvanced, expect, test } from './fixtures'

/** Opens the app and the panel; the category sections are the subject. */
async function openAdvanced(page: Page): Promise<void> {
  await page.goto('/')
  // By class: an open panel's readouts are `status` roles too.
  await expect(page.locator('.connection-badge')).toHaveText('Connected')
  await expandAdvanced(page)
}

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

  // From the preceding card's Slider (`dvlo`, #89) — one Tab reaches
  // the switch; the disabled reset marker between is skipped.
  await page
    .getByRole('slider', { name: 'Volume Leveler Output Target' })
    .focus()
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

// — Numeric input (#87 part 1, behavior 9) —

// The unit overlay is inert chrome: a click on `dhsb`'s `dB` lands in
// the field.
test('a click on the unit lands in its field', async ({ page }) => {
  await openAdvanced(page)
  const boost = page.getByRole('textbox', {
    name: 'Headphone Virtualizer Surround Boost',
  })
  const unit = boost.locator('..').locator('.adv-input__unit')
  await expect(unit).toHaveText('dB')
  await unit.click({ force: true })
  await expect(boost).toBeFocused()
})

// — Numeric input (#87 part 2, behavior 16) —

/** A client → daemon edit frame. */
interface EditFrame {
  readonly cmd: string
  readonly request_id: string
  readonly params?: Record<string, readonly number[]>
}

// The real-daemon check: an out-of-range value typed into Experimental
// `vol` (−130…30 dB) leaves the box as typed while the wire carries the
// clamped raw (30 dB = 480), every frame acks (no `INVALID_REQUEST`),
// and a cold reload's bootstrap snapshot resolves that raw.
test('typing out of range into vol sends the clamped raw, which a reload resolves', async ({
  page,
}) => {
  const sent: EditFrame[] = []
  const acked: string[] = []
  const errors: unknown[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const command = JSON.parse(String(frame.payload)) as EditFrame
      if (command.cmd === 'edit_profile') sent.push(command)
    })
    ws.on('framereceived', (frame) => {
      const event = JSON.parse(String(frame.payload)) as {
        type: string
        request_id?: string
      }
      if (event.type === 'ack' && event.request_id) acked.push(event.request_id)
      if (event.type === 'error') errors.push(event)
    })
  })
  await openAdvanced(page)
  const name = 'Endpoint Volume Volume'
  const vol = page.getByRole('textbox', { name })
  await expect(vol).toHaveValue('0') // the table default

  await vol.selectText()
  await vol.pressSequentially('999')
  await expect(vol).toHaveValue('999')
  await expect.poll(() => sent.at(-1)?.params).toEqual({ vol: [480] })
  await vol.press('Enter')
  await expect(vol).toHaveValue('30')
  await expect
    .poll(() => sent.every((frame) => acked.includes(frame.request_id)))
    .toBe(true)
  expect(errors).toEqual([])

  await page.reload()
  await expect(page.locator('.connection-badge')).toHaveText('Connected')
  await expect(page.getByRole('textbox', { name })).toHaveValue('30')
})

// — Pointer-lock scrub (#88, behavior 12) —

// The real lock: a press-drag on `dhsb` locks the pointer on the box
// (`document.pointerLockElement` is the `adv-input` wrapper) with the
// field focused; the release exits the lock leaving the field focused
// with its text selected, and the peer page's next snapshot carries the
// changed value. The step count stays unasserted: under a lock,
// CDP-synthesized mouse input carries cursor-warp artifacts in
// `movementY` (the engagement alone fires one), so only a real mouse
// can drive exact locked deltas — jsdom covers the arithmetic.
test('press-drag on dhsb locks the pointer on the box, scrubs, and restores focus + selection', async ({
  page,
  context,
}) => {
  await openAdvanced(page)
  const peer = await context.newPage()
  await openAdvanced(peer)
  const name = 'Headphone Virtualizer Surround Boost'
  const boost = page.getByRole('textbox', { name })
  const wrapper = boost.locator('..')
  await expect(boost).toHaveValue('3') // Music ships dhsb=48
  const lockedOn = () =>
    page.evaluate(() => document.pointerLockElement?.className ?? null)

  // `page.mouse` never scrolls: bring the box into the viewport first.
  await boost.scrollIntoViewIfNeeded()
  const rect = await boost.boundingBox()
  if (!rect) throw new Error('field not laid out')
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 3) // the third px engages
  await expect.poll(lockedOn).toMatch(/\badv-input\b/)
  await expect(wrapper).toHaveClass(/adv-input--scrubbing/)
  await expect(boost).toBeFocused()

  await page.mouse.move(x, y - 11)
  await expect(boost).not.toHaveValue('3')
  await page.mouse.up()

  await expect.poll(lockedOn).toBeNull()
  await expect(wrapper).not.toHaveClass(/adv-input--scrubbing/)
  await expect(boost).toBeFocused()
  const after = await boost.evaluate((el: HTMLInputElement) => ({
    value: el.value,
    selection: [el.selectionStart, el.selectionEnd],
  }))
  expect(after.selection).toEqual([0, after.value.length])
  await expect(peer.getByRole('textbox', { name })).toHaveValue(after.value)
})

// — Slider (#89, behavior 10) —

// A real press-drag from the thumb past the track's right end lands
// `max`: the slider reads 6 dB with focus held, `--norm` is 1, and the
// peer page's next snapshot carries the value. The thumb's box is read
// only to start the drag — where it sits is skin policy.
test("dragging dhsb's thumb to the track end lands max", async ({
  page,
  context,
}) => {
  await openAdvanced(page)
  const peer = await context.newPage()
  await openAdvanced(peer)
  const name = 'Headphone Virtualizer Surround Boost'
  const slider = page.getByRole('slider', { name })
  await expect(slider).toHaveAttribute('aria-valuenow', '3') // Music ships dhsb=48
  await slider.scrollIntoViewIfNeeded()
  const track = slider.locator('.adv-slider__track')
  const thumb = slider.locator('.adv-slider__thumb')
  const rect = await track.boundingBox()
  if (!rect) throw new Error('track not laid out')
  const thumbX = async () => {
    const box = await thumb.boundingBox()
    if (!box) throw new Error('thumb not laid out')
    return box.x + box.width / 2
  }
  const y = rect.y + rect.height / 2

  await page.mouse.move(await thumbX(), y)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width + 20, y, { steps: 8 })
  await page.mouse.up()

  await expect(slider).toHaveAttribute('aria-valuenow', '6')
  await expect(slider).toBeFocused()
  await expect(slider).toHaveAttribute('aria-valuetext', '6 dB')
  expect(
    await slider.evaluate((el) => el.style.getPropertyValue('--norm')),
  ).toBe('1')
  await expect(page.getByRole('textbox', { name })).toHaveValue('6')
  await expect(peer.getByRole('slider', { name })).toHaveAttribute(
    'aria-valuenow',
    '6',
  )
})

// — Band editing (#91, behavior 9) —

// The Band editor popover: opened on band 1 and on band 20 of `gebg`
// (Home / End, Enter), the editor is visible with its field focused;
// Escape closes it and hands focus back to the strip. A digit typed on
// the strip lands as the editor's whole text once (the strip consumes
// the keydown). Where the editor renders is skin policy.
test('the band editor of band 1 and of band 20 opens, and the strip keys drive it', async ({
  page,
}) => {
  await openAdvanced(page)
  const strip = page.getByRole('group', {
    name: 'Graphic Equalizer Band Gains',
  })
  await strip.scrollIntoViewIfNeeded()
  await strip.focus()

  for (const [key, slot] of [
    ['Home', 0],
    ['End', 19],
  ] as const) {
    await page.keyboard.press(key)
    await page.keyboard.press('Enter')
    const band = strip.locator('.adv-bands__band').nth(slot)
    const editor = band.locator('.adv-bands__editor')
    await expect(band).toHaveClass(/adv-bands__band--editing/)
    await expect(band.getByRole('textbox')).toBeFocused()
    await expect(editor).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(strip).toBeFocused()
    await expect(band).not.toHaveClass(/adv-bands__band--editing/)
  }

  await page.keyboard.press('Home')
  await page.keyboard.press('3')
  const first = strip.locator('.adv-bands__band').first().getByRole('textbox')
  await expect(first).toBeFocused()
  await expect(first).toHaveValue('3')
  await page.keyboard.press('Enter')
  await expect(strip).toBeFocused()
  await expect(first).toHaveValue('3')

  // The open editor keeps the Scrub: a press-drag on its box locks the
  // pointer and steps the band; the strip opens nothing else.
  await page.keyboard.press('Enter')
  await expect(first).toBeFocused()
  const box = await first.boundingBox()
  if (!box) throw new Error('editor not laid out')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 3)
  await expect
    .poll(() =>
      page.evaluate(() => document.pointerLockElement?.className ?? null),
    )
    .toMatch(/\badv-input\b/)
  await page.mouse.move(x, y - 11)
  await expect(first).not.toHaveValue('3')
  await page.mouse.up()
  await expect(first).toBeFocused()
  await expect(strip.locator('.adv-bands__band--editing')).toHaveCount(1)
})

// — Band editing: drag-to-paint (#91 part 2, behavior 15) —

// Geometry truth for the Paint: a fast 4-event drag — press on band 1,
// a move to mid-strip, a move to band 20, release — across `gebg` at a quarter
// of the strip's height leaves no band at its pre-drag value (Music
// ships a flat 0 dB): every band the pointer skipped is interpolated
// to the same height, the editor never opens, and the release's commit
// reaches the peer page's next snapshot.
test('a fast 4-event drag across gebg leaves no band at its pre-drag value', async ({
  page,
  context,
}) => {
  await openAdvanced(page)
  const peer = await context.newPage()
  await openAdvanced(peer)
  const name = 'Graphic Equalizer Band Gains'
  const strip = page.getByRole('group', { name })
  await strip.scrollIntoViewIfNeeded()
  const values = (group: typeof strip) =>
    group
      .locator('.adv-bands__bar')
      .evaluateAll((bars) =>
        bars.map((bar) =>
          (bar as HTMLElement).style.getPropertyValue('--value'),
        ),
      )
  const before = await values(strip)
  expect(before).toHaveLength(20)
  expect(new Set(before)).toEqual(new Set(['0']))

  const bands = strip.locator('.adv-bands__band')
  const [first, last] = await Promise.all([
    bands.first().boundingBox(),
    bands.last().boundingBox(),
  ])
  if (!first || !last) throw new Error('bands not laid out')
  const y = first.y + first.height / 4
  await page.mouse.move(first.x + first.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(first.x + (last.x - first.x) / 2, y)
  await page.mouse.move(last.x + last.width / 2, y)
  await page.mouse.up()

  const after = await values(strip)
  expect(after.some((value, band) => value === before[band])).toBe(false)
  expect(new Set(after).size).toBe(1) // one height, every band
  await expect(strip.locator('.adv-bands__band--editing')).toHaveCount(0)
  await expect
    .poll(() => values(peer.getByRole('group', { name })))
    .toEqual(after)
})

// — Divergence + Reset (#92, behavior 9) —

// The real round trip: flipping `dvle` off its Baseline enables the
// card's Reset marker (`disabled` while clean), and its click sends one
// scoped `reset_profile` — the daemon falls the 4-CC back and the
// reconcile lands it. How the marker looks at rest or on hover is skin
// policy.
test('a diverged reset marker enables, and its click lands reset_profile', async ({
  page,
}) => {
  const resets: unknown[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const command = JSON.parse(String(frame.payload)) as { cmd: string }
      if (command.cmd === 'reset_profile') resets.push(command)
    })
  })
  await openAdvanced(page)
  const enable = page.getByRole('switch', { name: 'Volume Leveler Enable' })
  const reset = page.getByRole('button', {
    name: 'Reset Volume Leveler Enable',
  })

  await expect(reset).toBeDisabled()
  await enable.click() // Music ships dvle=0 — now off its Baseline
  await expect(enable).toBeChecked()
  await expect(reset).toBeEnabled()

  await reset.click()
  await expect(enable).not.toBeChecked()
  await expect(reset).toBeDisabled()
  expect(resets).toMatchObject([{ cmd: 'reset_profile', only: ['dvle'] }])
})
