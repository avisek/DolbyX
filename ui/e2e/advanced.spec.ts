/**
 * #85: the Advanced panel's geometry — what jsdom can't see (ADR-0011).
 * Real browser, real daemon, the shipped parameter table.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/**
 * Opens the panel; the category sections are the subject. The open pref
 * is per origin, so a second page of the same context starts open —
 * only a collapsed panel gets the click.
 */
async function openAdvanced(page: Page): Promise<void> {
  await page.goto('/')
  // By class: an open panel's readouts are `status` roles too.
  await expect(page.locator('.connection-badge')).toHaveText('Connected')
  const header = page.getByRole('button', { name: 'Advanced' })
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

// Behavior 5: the fold toggle IS the header's box — on every category,
// its bounding box equals the header's, so the whole header is the hit
// area, edge to edge.
test('every category toggle fills its header box', async ({ page }) => {
  await openAdvanced(page)
  const heads = page.locator('.adv-cat__head')
  await expect(heads).toHaveCount(15) // the shipped `[[category]]` rows

  const rects = await heads.evaluateAll((elements) =>
    elements.map((head) => {
      const toggle = head.querySelector('.adv-cat__toggle')
      if (!toggle) throw new Error('header without toggle')
      const box = (el: Element) => el.getBoundingClientRect().toJSON() as object
      return { head: box(head), toggle: box(toggle) }
    }),
  )
  for (const { head, toggle } of rects) expect(toggle).toEqual(head)
})

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

// Behavior 10: at 1280 px no label truncates — every `adv-card__label`
// fits its track (wrapping is fine, overflow is not) — and the shared
// tracks hold: within one category every control starts at the same x.
test('labels never overflow and controls align within a category', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openAdvanced(page)
  const labels = page.locator('.adv-card__label')
  await expect(labels).toHaveCount(64) // the shipped `[[param]]` rows

  const overflowing = await labels.evaluateAll((elements) =>
    elements
      .filter((label) => label.scrollWidth > label.clientWidth)
      .map((label) => label.textContent),
  )
  expect(overflowing).toEqual([])

  const controlXs = await page
    .locator('.adv-cat')
    .evaluateAll((sections) =>
      sections.map((section) =>
        [...section.querySelectorAll('.adv-card__control')].map(
          (control) => control.getBoundingClientRect().x,
        ),
      ),
    )
  expect(controlXs).toHaveLength(15)
  for (const xs of controlXs) {
    expect(xs.length).toBeGreaterThan(0)
    expect(new Set(xs).size).toBe(1)
  }
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

// Every numeric box measures the same width whether or not it carries a
// unit — `dhsb` (dB) and `dvla` (unit-less) — and the unit overlay is
// inert chrome: `pointer-events: none`, a click on it lands in the field.
test('a unit-bearing and a unit-less box measure the same width; the unit is inert', async ({
  page,
}) => {
  await openAdvanced(page)
  const boost = page.getByRole('textbox', {
    name: 'Headphone Virtualizer Surround Boost',
  })
  const amount = page.getByRole('textbox', { name: 'Volume Leveler Amount' })
  const boxWidth = async (input: typeof boost) =>
    input.locator('..').evaluate((box) => box.getBoundingClientRect().width)
  expect(await boxWidth(boost)).toBeGreaterThan(0)
  expect(await boxWidth(amount)).toBe(await boxWidth(boost))

  const unit = boost.locator('..').locator('.adv-input__unit')
  await expect(unit).toHaveText('dB')
  await expect(unit).toHaveCSS('pointer-events', 'none')
  await unit.click({ force: true })
  await expect(boost).toBeFocused()
})

// Focus beats hover: with the card hovered, the focused field paints the
// focus line, not the hover line.
test('a focused numeric field outranks the card hover', async ({ page }) => {
  await openAdvanced(page)
  const boost = page.getByRole('textbox', {
    name: 'Headphone Virtualizer Surround Boost',
  })
  const card = boost.locator('xpath=ancestor::label[1]')
  await card.hover()
  const hovered = await boost.evaluate((el) => getComputedStyle(el).borderColor)
  await boost.focus()
  await expect(boost).toHaveCSS('border-color', 'rgb(0, 180, 255)')
  expect(hovered).not.toBe('rgb(0, 180, 255)')
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
// with its text selected under the scrub cursor, and the peer page's
// next snapshot carries the changed value. The step count stays
// unasserted: under a lock, CDP-synthesized mouse input carries
// cursor-warp artifacts in `movementY` (the engagement alone fires one),
// so only a real mouse can drive exact locked deltas — jsdom covers the
// arithmetic.
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
  await expect(boost).toHaveCSS('cursor', 'ns-resize')
  // Focused, the box reads as a text field; idle again, as a knob.
  await boost.focus()
  await expect(boost).toHaveCSS('cursor', 'text')
  await boost.blur()
  await expect(boost).toHaveCSS('cursor', 'ns-resize')
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
  await expect(boost).toHaveCSS('cursor', 'text')
  const after = await boost.evaluate((el: HTMLInputElement) => ({
    value: el.value,
    selection: [el.selectionStart, el.selectionEnd],
  }))
  expect(after.selection).toEqual([0, after.value.length])
  await expect(peer.getByRole('textbox', { name })).toHaveValue(after.value)
})

// — Slider (#89, behavior 10) —

// Geometry truth: the thumb's rendered centre sits where `--norm` says
// on the track — at the midpoint for Music's 3 dB of 0–6 — and a real
// press-drag from the thumb past the track's right end lands `max`:
// the slider reads 6 dB with focus held, `--norm` is 1, the thumb sits
// at the track's right edge, and the peer page's next snapshot carries
// the value.
test("dragging dhsb's thumb to the track end lands max; the thumb tracks --norm", async ({
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
  expect(Math.abs((await thumbX()) - (rect.x + rect.width / 2))).toBeLessThan(1)

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
  expect(Math.abs((await thumbX()) - (rect.x + rect.width))).toBeLessThan(1)
  await expect(page.getByRole('textbox', { name })).toHaveValue('6')
  await expect(peer.getByRole('slider', { name })).toHaveAttribute(
    'aria-valuenow',
    '6',
  )
})

// — Band editing (#91, behavior 9) —

// Geometry truth for the Band editor popover: opened on band 1 and on
// band 20 of `gebg` (Home / End, Enter), the editor renders above its
// band and inside the strip's box — `anchor-center` keeps the edge
// bands' editors from overflowing. A digit typed on the strip lands as
// the editor's whole text once (the strip consumes the keydown).
test('the band editor of band 1 and of band 20 opens above its band, inside the strip', async ({
  page,
}) => {
  await openAdvanced(page)
  const strip = page.getByRole('group', {
    name: 'Graphic Equalizer Band Gains',
  })
  await strip.scrollIntoViewIfNeeded()
  await strip.focus()
  const stripBox = await strip.boundingBox()
  if (!stripBox) throw new Error('strip not laid out')

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
    await expect(editor).toHaveCSS('opacity', '1')
    const [bandBox, editorBox] = await Promise.all([
      band.boundingBox(),
      editor.boundingBox(),
    ])
    if (!bandBox || !editorBox) throw new Error('band not laid out')
    expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(bandBox.y)
    expect(editorBox.x).toBeGreaterThanOrEqual(stripBox.x)
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(
      stripBox.x + stripBox.width,
    )
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

// The Classic morph: a diverged card's marker rests as the dot (glyph
// `::after` at opacity 0) and shows ↺ on card hover; a clean card's
// marker is invisible and not hit-testable — the slot stays. Then the
// real round trip: the click resets that one 4-CC on the daemon.
test('a diverged reset marker rests as a dot, morphs to ↺ on hover; a clean one is inert', async ({
  page,
}) => {
  await openAdvanced(page)
  const enable = page.getByRole('switch', { name: 'Volume Leveler Enable' })
  const reset = page.getByRole('button', {
    name: 'Reset Volume Leveler Enable',
  })
  const cleanReset = page.getByRole('button', {
    name: 'Reset Volume Leveler Amount',
  })
  const glyphOpacity = () =>
    reset.evaluate((el) => getComputedStyle(el, '::after').opacity)

  await expect(reset).toBeDisabled()
  await enable.click() // Music ships dvle=0 — now off its Baseline
  await expect(enable).toBeChecked()
  await expect(reset).toBeEnabled()

  // At rest (pointer parked on the panel header): the dot, no glyph.
  await page.getByRole('button', { name: 'Advanced' }).hover()
  await expect.poll(glyphOpacity, { timeout: 2000 }).toBe('0')
  await expect(reset).toHaveCSS('opacity', '1')

  // Card hover: the glyph.
  await page.locator('.adv-card', { has: enable }).hover()
  await expect.poll(glyphOpacity, { timeout: 2000 }).toBe('1')

  // Clean: invisible, and a pointer at its centre lands elsewhere.
  await expect(cleanReset).toBeDisabled()
  await expect(cleanReset).toHaveCSS('opacity', '0')
  await expect(cleanReset).toHaveCSS('pointer-events', 'none')
  const hit = await cleanReset.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const under = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    )
    return under === el
  })
  expect(hit).toBe(false)

  // The click: one scoped `reset_profile` — the daemon falls `dvle`
  // back to its Baseline and the reconcile lands it.
  await reset.click()
  await expect(enable).not.toBeChecked()
  await expect(reset).toBeDisabled()
})
