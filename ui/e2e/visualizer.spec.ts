/**
 * Slice 16 (#24) seam 3: real audio through the real engine reaches
 * the visualizer's published data (ADR-0011): a synthetic plugin's tone
 * lifts `--exc` off the floor; silence lets the engine's own ballistics
 * walk it back. How a skin paints the columns is its own business.
 */
import { expect, test } from './fixtures'
import { SyntheticPlugin } from './plugin'

/** The wire floor the columns mount at, in dB. */
const FLOOR_DB = -12

// Behavior 13: a plugin tone through the engine raises the columns'
// `--exc` above the floor; with silence — no client fade anywhere —
// the engine walks every column back to −12 dB.
test('a plugin tone raises --exc above the floor; silence returns it', async ({
  page,
  daemon,
}) => {
  test.slow() // two engine ballistic walks under qemu
  await page.goto('/')
  const columns = page.locator('.vis-column')
  await expect(columns).toHaveCount(20) // the defaults-carried custom grid

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

  /** The loudest column's published excitation, in dB. */
  const maxExc = () =>
    columns.evaluateAll((els) =>
      Math.max(
        ...els.map((el) =>
          parseFloat((el as HTMLElement).style.getPropertyValue('--exc')),
        ),
      ),
    )
  expect(await maxExc()).toBe(FLOOR_DB)

  // Tone in: excitation climbs out of the floor.
  await expect
    .poll(
      async () => {
        for (let block = 0; block < 20; block += 1) {
          await plugin.process(toneBlock())
        }
        return maxExc()
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(FLOOR_DB)

  // Silence in: the display walks to the floor by itself.
  await expect
    .poll(
      async () => {
        for (let block = 0; block < 40; block += 1) {
          await plugin.process(new Int16Array(FRAMES * 2))
        }
        return maxExc()
      },
      { timeout: 60_000 },
    )
    .toBe(FLOOR_DB)

  plugin.goodbye()
})
