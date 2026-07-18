/**
 * Slice 16 (#24) seam 3: the Classic skin's rendered geometry — real
 * browser, real daemon, real engine. Behavior 12 drives the CSS
 * contract's vars directly (rendered-geometry truth needs a browser,
 * ADR-0011); behavior 13 streams real audio through a synthetic
 * plugin and watches the bricks.
 */
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { SyntheticPlugin } from './plugin'

/** Rendered height of one element, 0-height elements included. */
const height = (locator: Locator) =>
  locator.evaluate((el) => el.getBoundingClientRect().height)

// Behavior 12: fill heights snap to row multiples — 0 dB → 12 rows,
// the −12 dB floor → an empty field — while the pip position stays
// continuous, riding the original's travel formula between row lines.
test('fills snap to whole rows, the floor is empty, the pip rides continuously', async ({
  page,
}) => {
  await page.goto('/')
  const columns = page.locator('.vis-column')
  await expect(columns).toHaveCount(20) // the defaults-carried custom grid

  const column = columns.first()
  const fill = column.locator('.vis-column__fill')
  const columnHeight = await height(column)
  const rowHeight = columnHeight / 48
  expect(rowHeight).toBeGreaterThan(0)

  // From mount the floor (−12 dB) renders an empty field — the
  // deliberate deviation from the original's always-lit bottom brick.
  expect(await height(fill)).toBe(0)

  // 0 dB → exactly 12 rows (the spec literal).
  const setExc = (dB: string) =>
    column.evaluate((el, value) => {
      el.style.setProperty('--exc', value)
    }, dB)
  await setExc('0')
  expect(Math.abs((await height(fill)) - 12 * rowHeight)).toBeLessThan(1)

  // Quantized down to whole rows: −3.25 dB and −4 dB both render the
  // 8-row fill.
  await setExc('-3.25')
  const quantized = await height(fill)
  expect(Math.abs(quantized - 8 * rowHeight)).toBeLessThan(1)
  await setExc('-4')
  expect(Math.abs((await height(fill)) - quantized)).toBeLessThan(0.01)

  // The pip is continuous (Classic's `--gain-step` is the wire's own
  // 1/16-dB quantum — an exact identity): at 2.5 dB it sits on the
  // original's travel — (gain + 12) / 48 · (field − row) + row / 2 —
  // mid-row, where a row-snapped position could not land.
  const pipBottom = () =>
    column.locator('.vis-column__pip').evaluate((el) => {
      const field = el.closest('.vis-column')?.getBoundingClientRect()
      return field ? field.bottom - el.getBoundingClientRect().bottom : NaN
    })
  await column.evaluate((el) => {
    el.style.setProperty('--gain', '2.5')
  })
  const travel = (dB: number) =>
    ((dB + 12) / 48) * (columnHeight - rowHeight) + rowHeight / 2
  expect(Math.abs((await pipBottom()) - travel(2.5))).toBeLessThan(1)

  // …and the ADR-0011 retune convention is real: a derived skin's
  // `--gain-step` override snaps the pip (round(down, 14.5, 12) → 12).
  await column.evaluate((el) => {
    el.style.setProperty('--gain-step', '12')
  })
  expect(Math.abs((await pipBottom()) - travel(0))).toBeLessThan(1)
})

// Behavior 13: a synthetic plugin tone through the real engine moves
// the bricks on screen; with silence — no client fade anywhere — the
// engine's own ballistics walk the display back to the empty floor.
test('a plugin tone lights the bricks; silence walks the display to the floor', async ({
  page,
  daemon,
}) => {
  test.slow() // two engine ballistic walks under qemu
  await page.goto('/')
  await expect(page.locator('.vis-column')).toHaveCount(20)

  const plugin = await SyntheticPlugin.connect(daemon.socketPath)
  await plugin.hello(48_000, 512)

  const FRAMES = 256
  let phase = 0
  /** One loud 750 Hz interleaved-stereo block, phase-continuous. */
  const toneBlock = () => {
    const pcm = new Int16Array(FRAMES * 2)
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const sample = Math.round(20_000 * Math.sin(phase))
      phase += (2 * Math.PI * 750) / 48_000
      pcm[frame * 2] = sample
      pcm[frame * 2 + 1] = sample
    }
    return pcm
  }

  const maxFillHeight = () =>
    page
      .locator('.vis-column__fill')
      .evaluateAll((fills) =>
        Math.max(...fills.map((el) => el.getBoundingClientRect().height)),
      )

  // Tone in: excitation climbs out of the floor and bricks light up.
  await expect
    .poll(
      async () => {
        for (let block = 0; block < 20; block += 1) {
          await plugin.process(toneBlock())
        }
        return maxFillHeight()
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)

  // Silence in: the display walks to the floor by itself.
  await expect
    .poll(
      async () => {
        for (let block = 0; block < 40; block += 1) {
          await plugin.process(new Int16Array(FRAMES * 2))
        }
        return maxFillHeight()
      },
      { timeout: 60_000 },
    )
    .toBe(0)

  plugin.goodbye()
})
