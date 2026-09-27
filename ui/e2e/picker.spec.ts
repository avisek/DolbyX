/**
 * #119 part 2: the Picker in a real browser — what jsdom can't see
 * (ADR-0011): the rename field sized to its text, the pills keeping
 * keyboard focus across a real profile switch, the narrow reflow, the
 * ghost actions' focus ring and hover lift. Real daemon, the Classic
 * skin.
 */
import type { Page } from '@playwright/test'
import {
  box,
  expect,
  openAt,
  pageOverflow,
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

/** Both Pickers' boxes: label, options, actions. */
const pickerBoxes = (page: Page, picker: string) =>
  Promise.all([
    box(page, `${picker} .picker__label`),
    box(page, `${picker} .picker__options`),
    box(page, `${picker} .picker__actions`),
  ])

/** Whether two boxes share a line — their vertical extents overlap. */
const sameLine = (a: { top: number; bottom: number }, b: typeof a) =>
  a.top < b.bottom && b.top < a.bottom

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
  const overflow = await pageOverflow(page)
  expect(overflow.scrollWidth).toBe(overflow.innerWidth)
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
  const overflow = await pageOverflow(page)
  expect(overflow.scrollWidth).toBe(overflow.innerWidth)
})

const ACTIONS = ['Add', 'Rename', 'Delete', 'Reset'].flatMap((verb) => [
  `${verb} profile`,
  `${verb} EQ preset`,
])

const buttonBackground = (page: Page, name: string) =>
  page
    .getByRole('button', { name })
    .evaluate((el) => getComputedStyle(el).backgroundColor)

// Behavior 9: every enabled action rings when tabbed to (the skin's
// `:focus-visible` rule) and lifts its background on hover. A custom
// profile and a captured preset enable what a Factory item disables;
// the fresh capture's Reset stays disabled — nothing to clear — and a
// disabled button is never a tab stop.
test('tabbing to an action shows a focus ring; hovering an enabled one lifts its background', async ({
  page,
}) => {
  await openAt(page, 1280)
  await addScratchProfile(page)
  await page.getByRole('button', { name: 'Add EQ preset' }).click()
  await expect(page.getByRole('radio', { name: 'Preset 1' })).toBeChecked()

  for (const name of ACTIONS) {
    const button = page.getByRole('button', { name })
    if (name === 'Reset EQ preset') {
      await expect(button).toBeDisabled()
      continue
    }
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
        style: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
      }
    })
    expect(ring.visible).toBe(true)
    expect(ring.style).not.toBe('none')
    expect(ring.width).toBeGreaterThan(0)

    await page.mouse.move(0, 0)
    await expect.poll(() => buttonBackground(page, name)).toBe(TRANSPARENT)
    await button.hover()
    await expect.poll(() => buttonBackground(page, name)).not.toBe(TRANSPARENT)
  }
})

/** Whether the focused element is one of the profile Picker's radios. */
const focusInProfileGroup = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement
    return (
      active instanceof HTMLInputElement &&
      active.classList.contains('picker__radio') &&
      active.closest('.picker--profile') !== null
    )
  })

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
  expect(await focusInProfileGroup(page)).toBe(true)

  await page.keyboard.press('ArrowLeft')
  await expect(music).toBeChecked()
  await expect(game).not.toBeChecked()
  expect(await focusInProfileGroup(page)).toBe(true)
})
