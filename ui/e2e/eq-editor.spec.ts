/**
 * Slice 17 (#25) parts B + C, seam 3: the GEQ editor's rendered
 * geometry, Vis idle following feed death, and the drag replay through
 * the real daemon + engine (jsdom sees only the var/class seam,
 * ADR-0011). Factory state: music profile, `gebg` all zero, no sessions
 * → the page mounts Vis idle and the editor renders resolved state.
 */
import type { Locator } from '@playwright/test'
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

  // Five thumbs centred on the fractional column centers, on the same
  // mapping. The thumb, not the slider box: a skin may widen the box
  // around its x (Remastered tiles the field for nearest-slider hover).
  const sliders = page.locator('.eq-slider')
  await expect(sliders).toHaveCount(5)
  for (const [i, index] of SLIDER_INDICES.entries()) {
    const thumb = await box(sliders.nth(i).locator('.eq-slider__thumb'))
    expect(thumb.x + thumb.width / 2 - field.x).toBeCloseTo(
      (index + 0.5) * pitch,
      1,
    )
    expect(thumb.y + thumb.height / 2 - field.y).toBeCloseTo(flatY, 1)
  }
})

// Behavior 10: feed death raises `visualizer--idle` — the seam a skin's
// descent (brick walk, continuous fade, …) hangs off. Frames flowing
// clear it; the plugin's goodbye kills its session and, 250 ms after the
// last frame, the component raises it again.
test('feed death raises visualizer--idle', async ({ page, daemon }) => {
  await page.goto('/')
  const visualizer = page.locator('.visualizer')
  await expect(visualizer).toHaveClass(/visualizer--idle/)

  const plugin = await SyntheticPlugin.connect(daemon.socketPath)
  await plugin.hello(48_000, 512)
  const silence = new Int16Array(512 * 2)
  await expect
    .poll(
      async () => {
        for (let block = 0; block < 20; block += 1) {
          await plugin.process(silence)
        }
        return visualizer.evaluate((el) =>
          el.classList.contains('visualizer--idle'),
        )
      },
      { timeout: 30_000 },
    )
    .toBe(false)

  plugin.goodbye()
  await expect(visualizer).toHaveClass(/visualizer--idle/)
})

/** One sent live-edit frame, as captured off the page's WS. */
interface EditFrame {
  readonly cmd: string
  readonly params: {
    readonly gebg?: readonly number[]
    readonly geon?: readonly number[]
  }
}

// Behavior 16 (part C): a drag trace through the real daemon + engine.
// Factory music: no preset (writes route to `edit_profile`), ieon 0 —
// once the auto-flipped `geon` lands, the composed `vcbg` the engine
// emits *is* the clamped GEQ registry on the mirrored grid, so the
// `vis`-fed curve following the emitted batch pins `get_params("gebg")`
// end to end: daemon validation, `Profile::splice`, the engine's
// AK-direct write + commit, the per-block registry read.
test('a drag lands in the engine: the vis-fed curve follows the emitted batch', async ({
  page,
  daemon,
}) => {
  test.slow() // real engine blocks under qemu
  const sent: EditFrame[] = []
  const errors: unknown[] = []
  let latestVcbg: readonly number[] | undefined
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const command = JSON.parse(String(frame.payload)) as EditFrame
      if (command.cmd.startsWith('edit_')) sent.push(command)
    })
    ws.on('framereceived', (frame) => {
      const event = JSON.parse(String(frame.payload)) as {
        type: string
        params?: { vcbg?: readonly number[] }
      }
      if (event.type === 'vis') latestVcbg = event.params?.vcbg
      if (event.type === 'error') errors.push(event)
    })
  })
  await page.goto('/')

  // Real audio: silence keeps the feed alive — the editor rides `vcbg`.
  const plugin = await SyntheticPlugin.connect(daemon.socketPath)
  await plugin.hello(48_000, 512)
  const pump = { stopped: false }
  const pumped = (async () => {
    const silence = new Int16Array(512 * 2)
    while (!pump.stopped) await plugin.process(silence)
  })()
  try {
    await expect.poll(() => latestVcbg, { timeout: 30_000 }).toBeTruthy()

    // The drag: a slow flat sweep across the whole field, then a held
    // hand — every Slider snap paints its brush window at one level,
    // the waits let the vis-fed reference keep up (the rebase math
    // converges on the finger), and a flat curve is the one shape the
    // engine's composed response reports verbatim, so the follow
    // assertion stays tight.
    const field = await box(page.locator('.visualizer'))
    const y = field.y + field.height * 0.5
    await page.mouse.move(field.x + field.width * 0.05, y)
    await page.mouse.down()
    await expect(page.locator('.visualizer')).toHaveClass(/visualizer--eq-drag/)
    await expect(page.locator('.eq-slider--active')).toHaveCount(1)
    for (const frac of [0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      await page.mouse.move(field.x + field.width * frac, y, { steps: 4 })
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(500) // the held hand
    await page.mouse.up()
    await expect(page.locator('.eq-slider--active')).toHaveCount(0)

    // Release isn't quiescence: the vis-fed rebase can leave
    // out-of-window brush cells, so the tick loop keeps decay-writing
    // briefly after the pointer lifts. Wait for a 600 ms window with
    // no new writes — the settled batch is what every pin below
    // compares against (CI caught the race as a ±1 band).
    let seen = -1
    await expect
      .poll(
        () => {
          const grew = sent.length !== seen
          seen = sent.length
          return grew
        },
        { intervals: [600], timeout: 15_000 },
      )
      .toBe(false)

    // The daemon accepted every write; the engine rejected none.
    expect(errors).toEqual([])
    const batches = sent.filter((frame) => frame.params.gebg)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.every((frame) => frame.cmd === 'edit_profile')).toBe(true)
    // The first gains batch flipped the bypassed filterbank, once.
    expect(batches[0]?.params.geon).toEqual([1])
    expect(
      batches.slice(1).every((frame) => frame.params.geon === undefined),
    ).toBe(true)

    // The daemon's own truth carries the settled batch verbatim — a
    // fresh connection's snapshot pins validation + `Profile::splice`
    // exactness (the engine feeds from exactly this). Polled to 0
    // deviation: the probe's snapshot can still race the last frame
    // in flight on the drag connection.
    const final = batches.at(-1)?.params.gebg ?? []
    const probeGebg = () =>
      page.evaluate(async () => {
        interface Snapshot {
          readonly profiles: readonly {
            readonly id: string
            readonly params: Readonly<Record<string, readonly number[]>>
          }[]
        }
        const probe = new WebSocket(`ws://${location.host}/ws`)
        const snapshot = await new Promise<Snapshot>((resolve, reject) => {
          // The daemon pushes a full snapshot on connect (ADR-0005).
          probe.onmessage = (event) => {
            const parsed = JSON.parse(String(event.data)) as {
              type: string
              snapshot?: Snapshot
            }
            if (parsed.type === 'state' && parsed.snapshot) {
              resolve(parsed.snapshot)
            }
          }
          probe.onerror = () => {
            reject(new Error('probe socket failed'))
          }
        })
        probe.close()
        const music = snapshot.profiles.find(
          (profile) => profile.id === 'music',
        )
        return music?.params['gebg']?.slice(0, 20)
      })
    await expect
      .poll(
        async () => {
          const daemonGebg = await probeGebg()
          if (!daemonGebg || daemonGebg.length !== final.length) {
            return Number.POSITIVE_INFINITY
          }
          return Math.max(
            ...final.map((gain, band) =>
              Math.abs(gain - (daemonGebg[band] ?? Number.POSITIVE_INFINITY)),
            ),
          )
        },
        { timeout: 10_000 },
      )
      .toBe(0)

    // Within a block the vis feed reports the engine applying it: the
    // composed response — not a registry echo, so transition slopes
    // spill between neighbouring bands (3 dB grants that); the settled
    // write reads back through band 19's composed response within one
    // raw step (the hold never swings — #105), and the once-bypassed
    // filterbank is audibly engaged.
    await expect
      .poll(
        () => {
          const vis = latestVcbg
          if (!vis) return 'no vis frame'
          const spill = Math.max(
            ...final.map((gain, band) => Math.abs(gain - (vis[band] ?? 0))),
          )
          const top = vis[19] ?? 0
          const held = Math.abs(top - (final[19] ?? 0))
          if (spill > 48) return `spill ${String(spill)}`
          if (held > 1) return `held band off by ${String(held)}`
          if (top < 128) return `filterbank bypassed: ${String(top)}`
          return 'landed'
        },
        { timeout: 30_000 },
      )
      .toBe('landed')
  } finally {
    pump.stopped = true
    await pumped.catch(() => undefined)
    plugin.goodbye()
  }
})
