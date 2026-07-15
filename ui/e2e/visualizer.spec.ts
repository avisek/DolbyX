/**
 * Slice 16 (#24) behavior 9: real browser, real daemon, real engine —
 * a synthetic plugin (`e2e/plugin.ts`) pushes a tone through
 * `libdseffect.so` and the spectrum bricks move on screen; when the
 * audio stops, the client freezes and fades to the floor on its own.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { SyntheticPlugin } from './plugin'

const SAMPLE_RATE = 48_000
const FRAMES = 480 // 10 ms blocks

/**
 * One interleaved-stereo block of the streamed signal: a 110 Hz
 * sawtooth — harmonics light bands across the whole grid — whose level
 * alternates every 50 blocks (~0.5 s), so the field visibly moves.
 */
function signalBlock(block: number): Int16Array {
  const pcm = new Int16Array(FRAMES * 2)
  const amplitude = Math.floor(block / 50) % 2 === 0 ? 24_000 : 3_000
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const t = (block * FRAMES + frame) / SAMPLE_RATE
    const saw = 2 * ((t * 110) % 1) - 1
    const sample = Math.round(saw * amplitude)
    pcm[frame * 2] = sample
    pcm[frame * 2 + 1] = sample
  }
  return pcm
}

/** How many bricks are lit — the floor rests at exactly one per column. */
const litCount = (page: Page) => page.locator('.visualizer__brick--lit').count()

/** The lit field's exact shape — each brick's (x, y) — for change detection. */
const litSignature = (page: Page) =>
  page
    .locator('.visualizer')
    .evaluate((svg) =>
      [...svg.querySelectorAll('.visualizer__brick--lit')]
        .map(
          (brick) =>
            `${String(brick.getAttribute('x'))},${String(brick.getAttribute('y'))}`,
        )
        .join(';'),
    )

test('bricks move while a plugin pushes a tone through the real engine, then fade to the floor', async ({
  page,
  daemon,
}) => {
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Visualizer' })).toBeVisible()
  // At rest the spectrum sits at the floor — one brick per column.
  await expect.poll(() => litCount(page)).toBe(20)

  const plugin = await SyntheticPlugin.connect(daemon.socketPath)
  await plugin.hello(SAMPLE_RATE, FRAMES)
  const stop = { requested: false }
  const stream = (async () => {
    for (let block = 0; !stop.requested; block += 1) {
      await plugin.process(signalBlock(block))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })()

  try {
    // The bars rise off the floor…
    await expect
      .poll(() => litCount(page), { timeout: 20_000 })
      .toBeGreaterThan(30)
    // …and keep moving while the tone plays.
    const before = await litSignature(page)
    await expect
      .poll(() => litSignature(page), { timeout: 20_000 })
      .not.toBe(before)
  } finally {
    stop.requested = true
    await stream
    plugin.end()
  }

  // No more events: the client freezes, then fades back to the floor —
  // no suspend protocol, nothing daemon-side.
  await expect.poll(() => litCount(page), { timeout: 10_000 }).toBe(20)
})
