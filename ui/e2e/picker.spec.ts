/**
 * #119 part 2: the Picker in a real browser — what jsdom can't see
 * (ADR-0011): the rename field sized to its text, the pills keeping
 * keyboard focus across a real profile switch, the narrow reflow, the
 * ghost actions' focus ring and hover lift. Real daemon, the Classic
 * skin.
 */
import type { Page } from '@playwright/test'
import {
  background,
  box,
  countStateFrames,
  expect,
  openAt,
  expectNoOverflow,
  sameLine,
  test,
  TRANSPARENT,
} from './fixtures'

const PROFILE = '.picker--profile'
/** The checked pill: the radio's label, painted through `:checked`. */
const CHECKED_PILL = `${PROFILE} .picker__radio:checked + .picker__option`

const profileRadio = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true })

/** Add clones the selected Music as `Music 2` and auto-selects it. */
async function addScratchProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add profile' }).click()
  await expect(profileRadio(page, 'Music 2')).toBeChecked()
}

async function deleteScratchProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Delete profile' }).click()
  await expect(profileRadio(page, 'Music 2')).toHaveCount(0)
  await expect(profileRadio(page, 'Music')).toBeChecked()
}

// Behavior 7: the rename field takes the pill's place at the pill's
// width (content-sized, the pill's own padding), grows as typed, and
// Esc hands the pill back at its old width.
test('the rename field starts at the pill width, grows as typed, and Esc restores', async ({
  page,
}) => {
  await openAt(page, 1280)
  await addScratchProfile(page)

  const pillBefore = await box(page, CHECKED_PILL)
  await page.getByRole('button', { name: 'Rename profile' }).click()
  const field = page.getByRole('textbox', { name: 'Profile name' })
  await expect(field).toHaveValue('Music 2')
  await expect(field).toBeFocused()

  const fieldAtStart = await box(page, `${PROFILE} .picker__field`)
  expect(Math.abs(fieldAtStart.width - pillBefore.width)).toBeLessThanOrEqual(1)

  await field.fill('Music 2, a much longer name')
  const fieldTyped = await box(page, `${PROFILE} .picker__field`)
  expect(fieldTyped.width).toBeGreaterThan(fieldAtStart.width)

  await field.press('Escape')
  await expect(field).toHaveCount(0)
  await expect(profileRadio(page, 'Music 2')).toBeChecked()
  const pillAfter = await box(page, CHECKED_PILL)
  expect(Math.abs(pillAfter.width - pillBefore.width)).toBeLessThanOrEqual(1)

  await deleteScratchProfile(page)
})

const pillColor = (page: Page, id: string) =>
  page
    .locator(`${PROFILE} label[for="${id}"]`)
    .evaluate((el) => getComputedStyle(el).color)

// Behavior 9's pill half: an unchecked pill lifts its text on hover
// (`.picker__option:where(:hover)` — the pseudo-class alone inside
// `:where()`, or the base rule outranks it and nothing paints); the
// checked pill keeps its accent fill.
test('hovering an unchecked pill lifts its text; the checked pill stays filled', async ({
  page,
}) => {
  await openAt(page, 1280)
  const game = 'picker-profile-game'
  const rest = await pillColor(page, game)
  await page.locator(`${PROFILE} label[for="${game}"]`).hover()
  await expect.poll(() => pillColor(page, game)).not.toBe(rest)

  const checked = await pillColor(page, 'picker-profile-music')
  await page.locator(`${PROFILE} label[for="picker-profile-music"]`).hover()
  await page.waitForTimeout(200)
  expect(await pillColor(page, 'picker-profile-music')).toBe(checked)
})

/** One Picker's boxes: label, options, actions. */
const pickerBoxes = (page: Page, picker: string) =>
  Promise.all([
    box(page, `${picker} .picker__label`),
    box(page, `${picker} .picker__options`),
    box(page, `${picker} .picker__actions`),
  ])

// Behavior 8, 390: label and actions share line 1, the pills sit
// below; nothing overflows sideways.
test('at 390px each Picker puts label + actions on line 1 and the pills below', async ({
  page,
}) => {
  await openAt(page, 390)
  for (const picker of [PROFILE, '.picker--eq']) {
    const [label, options, actions] = await pickerBoxes(page, picker)
    expect(sameLine(label, actions)).toBe(true)
    expect(actions.left).toBeGreaterThan(label.right)
    expect(options.top).toBeGreaterThanOrEqual(
      Math.max(label.bottom, actions.bottom),
    )
  }
  await expectNoOverflow(page)
})

// Behavior 8, 1280: label, pills and actions on one line, in DOM order.
test('at 1280px each Picker is one line: label, pills, actions', async ({
  page,
}) => {
  await openAt(page, 1280)
  for (const picker of [PROFILE, '.picker--eq']) {
    const [label, options, actions] = await pickerBoxes(page, picker)
    expect(sameLine(label, options)).toBe(true)
    expect(sameLine(options, actions)).toBe(true)
    expect(options.left).toBeGreaterThan(label.right)
    expect(actions.left).toBeGreaterThanOrEqual(options.right)
  }
  await expectNoOverflow(page)
})

const ACTIONS = ['Add', 'Rename', 'Delete', 'Reset'].flatMap((verb) => [
  `${verb} profile`,
  `${verb} EQ preset`,
])

const action = (name: string) => `.picker__action[aria-label="${name}"]`

// Behavior 9: every action rings when tabbed to (the skin's
// `:focus-visible` rule) and lifts its background on hover. A custom
// profile and a captured preset enable what a Factory item disables;
// one EQ slider nudge diverges the capture so its Reset is live too.
test('tabbing to an action shows a focus ring; hovering an enabled one lifts its background', async ({
  page,
}) => {
  const stateFrames = countStateFrames(page)
  await openAt(page, 1280)
  // Connect settles at two `state` frames; each add's `get_state`
  // reconcile is one more — the nudge must land after it, or the
  // reconcile's snapshot would overwrite the optimistic edit.
  await expect.poll(stateFrames).toBe(2)
  await addScratchProfile(page)
  await expect.poll(stateFrames).toBe(3)
  await page.getByRole('button', { name: 'Add EQ preset' }).click()
  await expect(page.getByRole('radio', { name: 'Preset 1' })).toBeChecked()
  await expect.poll(stateFrames).toBe(4)
  await page.locator('.eq-slider').first().focus()
  await page.keyboard.press('ArrowUp')

  for (const name of ACTIONS) {
    const button = page.getByRole('button', { name })
    await expect(button).toBeEnabled()

    // Keyboard focus: leave and come back with Tab so `:focus-visible`
    // holds — a programmatic focus alone would not prove the ring.
    await button.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(button).toBeFocused()
    const ring = await button.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        visible: el.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
      }
    })
    expect(ring.visible).toBe(true)
    expect(ring.outlineStyle).not.toBe('none')
    expect(ring.outlineWidth).toBeGreaterThan(0)

    await page.mouse.move(0, 0)
    await expect.poll(() => background(page, action(name))).toBe(TRANSPARENT)
    await button.hover()
    await expect
      .poll(() => background(page, action(name)))
      .not.toBe(TRANSPARENT)
  }
})

/** The profile Picker's radio holding focus — one while focus stays in the group. */
const focusedProfileRadio = (page: Page) =>
  page.locator(`${PROFILE} .picker__radio:focus`)

// Behavior 6: Arrow keys move the check natively; the click Chromium
// dispatches asks the daemon (`set_profile`), the ack flips the pill,
// and — positional keying — the focused radio survives the rebuilt
// snapshot: ArrowRight lands on Game, ArrowLeft brings Music back.
test('ArrowRight on the checked profile radio switches the profile and keeps focus in the group; ArrowLeft restores', async ({
  page,
}) => {
  await openAt(page, 1280)
  const music = profileRadio(page, 'Music')
  const game = profileRadio(page, 'Game')
  await expect(music).toBeChecked()
  await music.focus()

  await page.keyboard.press('ArrowRight')
  await expect(game).toBeChecked()
  await expect(music).not.toBeChecked()
  await expect(focusedProfileRadio(page)).toHaveCount(1)

  await page.keyboard.press('ArrowLeft')
  await expect(music).toBeChecked()
  await expect(game).not.toBeChecked()
  await expect(focusedProfileRadio(page)).toHaveCount(1)
})
