/**
 * Slice 17 (#25) part B, seam 3: the GEQ editor's rendered geometry
 * and the Classic skin's visibility + idle descent — real browser,
 * real daemon, real engine (jsdom sees only the var/class seam,
 * ADR-0011). Factory state: music profile, `gebg` all zero, no
 * sessions → the page mounts Vis idle and the editor renders resolved
 * state.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { SyntheticPlugin } from './plugin'

/** The padded dB → y mapping (ADR-0008) over a measured field. */
const yOf = (dB: number, height: number, pad: number) =>
  height - pad - ((dB + 12) * (height - 2 * pad)) / 48

/** Fractional indices of the default five sliders on the 20 grid. */
const SLIDER_INDICES = [0, 4.75, 9.5, 14.25, 19]

const box = (locator: Locator) =>
  locator.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })

// Behavior 10: two-pass curve with flat edge extensions at column
// centers; thumbs at fractional positions riding the padded track
// mapping — measured against the rendered field, not constants.
test('curve vertices at column centers, flat edges, thumbs at fractional x', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.visualizer')).toHaveClass(/visualizer--idle/)

  const field = await box(page.locator('.visualizer'))
  const pitch = field.width / 20

  // Both passes share one component-set points attribute.
  const points = await page
    .locator('.eq-curve__stroke')
    .evaluate((el) => el.getAttribute('points'))
  expect(points).toBeTruthy()
  await expect(page.locator('.eq-curve__glow')).toHaveAttribute(
    'points',
    points ?? '',
  )

  // 20 vertices + the two flat edge extensions; factory gebg is flat
  // zero, so every y is y(0 dB) under the thumbHeight/4 padding.
  const pad = (await box(page.locator('.eq-slider__thumb').first())).height / 4
  const flatY = yOf(0, field.height, pad)
  const parsed = (points ?? '').split(' ').map((pair) => {
    const [x = NaN, y = NaN] = pair.split(',').map(Number)
    return { x, y }
  })
  expect(parsed).toHaveLength(22)
  expect(parsed[0]?.x).toBe(0)
  expect(parsed.at(-1)?.x).toBeCloseTo(field.width, 0)
  for (const [vertex, point] of parsed.slice(1, 21).entries()) {
    expect(point.x).toBeCloseTo((vertex + 0.5) * pitch, 1)
  }
  for (const point of parsed) {
    expect(point.y).toBeCloseTo(flatY, 1)
  }

  // Five sliders at the fractional column centers, thumb centers on
  // the same mapping.
  const sliders = page.locator('.eq-slider')
  await expect(sliders).toHaveCount(5)
  for (const [i, index] of SLIDER_INDICES.entries()) {
    const slider = await box(sliders.nth(i))
    expect(slider.x - field.x).toBeCloseTo((index + 0.5) * pitch, 1)
    const thumb = await box(sliders.nth(i).locator('.eq-slider__thumb'))
    expect(thumb.y + thumb.height / 2 - field.y).toBeCloseTo(flatY, 1)
  }
})

// Behavior 10: editor hidden until hover/focus, shows in 250 ms,
// lingers 5 s after leave, then fades — all skin CSS, zero component
// timers.
test('editor hidden until hover or focus, lingers 5 s after leave', async ({
  page,
}) => {
  await page.goto('/')
  const opacity = () =>
    page.locator('.eq-sliders').evaluate((el) => getComputedStyle(el).opacity)

  expect(await opacity()).toBe('0')

  await page.hover('.visualizer')
  await expect.poll(opacity, { timeout: 2000 }).toBe('1')

  // Leave: the 5 s transition-delay lingers the editor fully visible…
  await page.mouse.move(0, 0)
  await page.waitForTimeout(4000)
  expect(await opacity()).toBe('1')
  // …then the 250 ms fade runs.
  await expect.poll(opacity, { timeout: 4000 }).toBe('0')

  // Keyboard path: focusing a hidden thumb reveals the same way —
  // hidden chrome stays focusable (ADR-0011).
  await page.locator('.eq-slider').first().focus()
  await expect.poll(opacity, { timeout: 2000 }).toBe('1')
})

/** Samples one fill's height as the idle descent runs. */
async function sampleDescent(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const root = document.querySelector('.visualizer')
    if (!root) return []
    // Wait for feed death (250 ms after the last frame).
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (root.classList.contains('visualizer--idle')) {
          clearInterval(timer)
          resolve()
        }
      }, 30)
    })
    const fills = [
      ...document.querySelectorAll<HTMLElement>('.vis-column__fill'),
    ]
    const heights = fills.map((el) => el.getBoundingClientRect().height)
    const target = fills[heights.indexOf(Math.max(...heights))]
    if (!target) return []
    const samples: number[] = []
    for (let i = 0; i < 24; i += 1) {
      samples.push(target.getBoundingClientRect().height)
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    return samples
  })
}

// Behavior 10: feed death walks the fills down brick-by-brick — the
// Classic descent transitions the data vars and round() re-quantizes
// per frame, so every sampled height is a whole-row multiple and the
// walk passes through intermediate rows instead of snapping.
test('idle descent walks the fills down brick-by-brick', async ({
  page,
  daemon,
}) => {
  test.slow() // an engine ballistic climb under qemu
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

  const rowHeight = (await box(page.locator('.vis-column').first())).height / 48

  // Tone in: climb well clear of the floor — the walk needs rows to
  // descend through. Frames flowing → never idle.
  await expect
    .poll(
      async () => {
        for (let block = 0; block < 20; block += 1) {
          await plugin.process(toneBlock())
        }
        return page
          .locator('.vis-column__fill')
          .evaluateAll((fills) =>
            Math.max(...fills.map((el) => el.getBoundingClientRect().height)),
          )
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(3 * rowHeight)
  await expect(page.locator('.visualizer')).not.toHaveClass(/visualizer--idle/)

  // Feed death: the plugin disconnects, its session dies, frames stop.
  plugin.goodbye()
  const samples = await sampleDescent(page)

  expect(samples[0] ?? 0).toBeGreaterThan(0)
  expect(samples.at(-1)).toBe(0)
  // Non-increasing, through at least one intermediate row — a walk,
  // not a snap…
  for (let i = 1; i < samples.length; i += 1) {
    expect(samples[i] ?? 0).toBeLessThanOrEqual((samples[i - 1] ?? 0) + 0.5)
  }
  const start = samples[0] ?? 0
  expect(samples.some((height) => height > 0 && height < start - 0.5)).toBe(
    true,
  )
  // …and every step lands on a whole-row height: brick-by-brick.
  for (const height of samples) {
    expect(
      Math.abs(height / rowHeight - Math.round(height / rowHeight)),
    ).toBeLessThan(0.15)
  }
})
