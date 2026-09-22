import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket, type SentCommand } from '../test/mock-ws'
import {
  fixtureBootstrap,
  fixtureRamp,
  fixtureState,
  fixtureStateWithParams,
  fixtureVis,
} from '../test/fixture'

// The store and the parameter table both read window.__BOOTSTRAP__ at
// module init (ADR-0006) — install the fixture before the dynamic
// imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

/** The one entry slice the component reads — no cast gymnastics. */
interface SizedEntry {
  readonly target: Element
  readonly contentRect: { readonly width: number; readonly height: number }
}

/**
 * Captured ResizeObserver — the editor's pixel-geometry source. Tests
 * fire sized entries by hand: happy-dom has no layout, so the entry's
 * `contentRect` is the only size the component ever sees (thumb
 * `offsetHeight` reads 0 ⇒ pad 0 — the worked literals below map the
 * bare field).
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  static reset(): void {
    FakeResizeObserver.instances = []
  }

  static latest(): FakeResizeObserver {
    const observer = FakeResizeObserver.instances.at(-1)
    if (!observer) throw new Error('no ResizeObserver constructed yet')
    return observer
  }

  readonly observed: Element[] = []

  constructor(
    readonly callback: (
      entries: SizedEntry[],
      observer: ResizeObserver,
    ) => void,
  ) {
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(): void {}
  disconnect(): void {}

  /** Fires one sized entry per observed element. */
  fire(size: { width: number; height: number }): void {
    const entries = this.observed.map((target) => ({
      target,
      contentRect: size,
    }))
    this.callback(entries, this)
  }
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

const { default: Visualizer } = await import('./Visualizer')
const { applySnapshot, state } = await import('../store/state')
const { resetVis, visFrame } = await import('../store/vis')
const { startWs, stopWs } = await import('../store/ws')

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  })
  MockWebSocket.reset()
  FakeResizeObserver.reset()
  localStorage.clear()
  applySnapshot(fixtureState())
  resetVis()
})

afterEach(() => {
  stopWs()
  cleanup()
  vi.useRealTimers()
})

/** Renders the visualizer (editor inside) and connects the mock WS. */
function renderConnected(): MockWebSocket {
  render(() => <Visualizer />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

/** Sizes the field: the worked literals below assume 400 × 192. */
function sizeField(width = 400, height = 192): void {
  FakeResizeObserver.latest().fire({ width, height })
}

const sliders = () => [...document.querySelectorAll<HTMLElement>('.eq-slider')]
const thumbTops = () =>
  sliders().map(
    (slider) =>
      slider.querySelector<HTMLElement>('.eq-slider__thumb')?.style.top,
  )
const curvePoints = () =>
  document.querySelector('.eq-curve__stroke')?.getAttribute('points')

// Behavior 8 (#25), fresh feed: curve points, thumb Ys, and per-slider
// `--gain` all ride the latest `vis` frame's `vcbg` — the composed
// curve. Worked literals on a 400 × 192 field, pad 0 (no thumb
// height in happy-dom): y(dB) = 192 − 4 · (dB + 12); a raw ramp of
// 8/band is 0.5 dB/band, so vertex b sits at (20b + 10, 144 − 2b);
// the curve extends flat to both field edges; the default five
// sliders ride fractional indices {0, 4.75, 9.5, 14.25, 19} with
// linearly interpolated Ys.
it('rides vcbg while fresh: curve vertices, flat edges, fractional thumbs', () => {
  const socket = renderConnected()
  sizeField()
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbg: fixtureRamp(8) }),
  })
  vi.advanceTimersToNextFrame()

  // The ADR-0008 tree: both editor blocks inside the visualizer root,
  // two polylines sharing one component-set points attribute.
  const root = document.querySelector('.visualizer')
  expect(root?.querySelector('.eq-sliders')).toBeTruthy()
  const glow = root?.querySelector('.eq-curve .eq-curve__glow')
  expect(curvePoints()).toBeTruthy()
  expect(glow?.getAttribute('points')).toBe(curvePoints())

  const vertices = Array.from(
    { length: 20 },
    (_slot, band) => `${String(20 * band + 10)},${String(144 - 2 * band)}`,
  ).join(' ')
  expect(curvePoints()).toBe(`0,144 ${vertices} 400,106`)

  expect(sliders()).toHaveLength(5)
  expect(sliders().map((slider) => slider.style.left)).toEqual([
    '10px',
    '105px',
    '200px',
    '295px',
    '390px',
  ])
  expect(thumbTops()).toEqual(['144px', '134.5px', '125px', '115.5px', '106px'])
  expect(
    sliders().map((slider) => slider.style.getPropertyValue('--gain')),
  ).toEqual(['0', '2.375', '4.75', '7.125', '9.5'])
  expect(
    sliders().map((slider) => slider.getAttribute('aria-valuenow')),
  ).toEqual(['0', '2.375', '4.75', '7.125', '9.5'])
  expect(sliders().map((slider) => slider.getAttribute('aria-label'))).toEqual([
    '43 Hz',
    '603 Hz',
    '2067 Hz',
    '5685 Hz',
    '18777 Hz',
  ])
})

// Behavior 8 (#25), `ven = 0`: a bypassed DSP freezes the vis slots,
// so frozen frames can't follow edits — the editor renders the
// resolved active `gebg` (÷ 16) instead, frames still flowing. A raw
// ramp of 16/band is 1 dB/band: y(idx) = 192 − 4 · (idx + 12).
it('renders the resolved gebg under ven = 0, and vcbg again once ven returns', () => {
  const socket = renderConnected()
  sizeField()
  applySnapshot(fixtureStateWithParams({ ven: [0], gebg: fixtureRamp(16) }))
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbg: fixtureRamp(8) }),
  })
  vi.advanceTimersToNextFrame()

  expect(thumbTops()).toEqual(['144px', '125px', '106px', '87px', '68px'])
  expect(curvePoints()?.startsWith('0,144 10,144 30,140 50,136')).toBe(true)

  // ven back on: the very same frame data speaks again.
  applySnapshot(fixtureStateWithParams({ gebg: fixtureRamp(16) })) // ven = 1
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbg: fixtureRamp(8) }),
  })
  vi.advanceTimersToNextFrame()
  expect(thumbTops()).toEqual(['144px', '134.5px', '125px', '115.5px', '106px'])
})

// Behavior 8 (#25), Vis idle: from mount — and again 250 ms after the
// last frame — the editor renders the resolved active `gebg`, which a
// selected preset shadows entirely (ADR-0003). Flat +6 dB → every
// thumb and vertex at y = 192 − 4 · 18 = 120.
it('renders the resolved gebg under Vis idle — the selected preset shadowing', () => {
  const seeded = fixtureState()
  applySnapshot({
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === 'music'
        ? { ...profile, selected_eq_preset: 'rich' }
        : profile,
    ),
    eq_presets: seeded.eq_presets.map((preset) =>
      preset.id === 'rich'
        ? {
            ...preset,
            params: {
              ...preset.params,
              gebg: Array.from({ length: 20 }, () => 96),
            },
          }
        : preset,
    ),
  })
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame() // mount is idle — no frame needed

  expect(thumbTops()).toEqual(['120px', '120px', '120px', '120px', '120px'])
  expect(curvePoints()?.startsWith('0,120 10,120')).toBe(true)
  expect(curvePoints()?.endsWith('390,120 400,120')).toBe(true)

  // A frame arrives: fresh again, vcbg speaks.
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbg: fixtureRamp(8) }),
  })
  vi.advanceTimersToNextFrame()
  expect(thumbTops()[4]).toBe('106px')

  // 250 ms of feed silence: idle again, back to the preset's curve.
  vi.advanceTimersByTime(250)
  vi.advanceTimersToNextFrame()
  expect(thumbTops()).toEqual(['120px', '120px', '120px', '120px', '120px'])
})

// Behavior 9 (#25): a `genb` state change re-renders the slider count,
// the curve vertices, and the visible-count cap — pitch, fractional
// step, and labels all re-derive.
it('re-renders sliders, vertices, and the visible cap on a genb change', () => {
  renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame()
  expect(curvePoints()?.split(' ')).toHaveLength(22) // 20 vertices + edges

  // genb 10: still five sliders (the cap is genb, not the pref), step
  // (10−1)/4 = 2.25 → x = (2.25i + 0.5) · 40.
  applySnapshot(fixtureStateWithParams({ genb: [10] }))
  vi.advanceTimersToNextFrame()
  expect(curvePoints()?.split(' ')).toHaveLength(12)
  expect(sliders()).toHaveLength(5)
  expect(sliders().map((slider) => slider.style.left)).toEqual([
    '20px',
    '110px',
    '200px',
    '290px',
    '380px',
  ])

  // genb 3 caps the visible count itself; step 1, labels re-derive.
  applySnapshot(fixtureStateWithParams({ genb: [3] }))
  vi.advanceTimersToNextFrame()
  expect(curvePoints()?.split(' ')).toHaveLength(5)
  expect(sliders()).toHaveLength(3)
  expect(sliders().map((slider) => slider.style.left)).toEqual([
    '66.67px',
    '200px',
    '333.33px',
  ])
  expect(sliders().map((slider) => slider.getAttribute('aria-label'))).toEqual([
    '43 Hz',
    '129 Hz',
    '215 Hz',
  ])
})

// — Part C: the editor's hand. The pointer surface is the field (the
// editor layer): down/move resolve x → the nearest visible Slider
// (splat center = round of its fractional index), y → dB via the
// padded mapping; each resolves to a smoother enqueue, pumped by a rAF
// tick loop into live `edit_*` writes. The smoother is part A's real
// one (no mocks — its goldens live in gain_smoother.test.ts); the
// `Direct` kernel pref keeps worked literals hand-checkable.

/** One sent `edit_profile` / `edit_eq_preset` frame, typed. */
interface EditCommand extends SentCommand {
  readonly id: string
  readonly params: {
    readonly gebg?: readonly number[]
    readonly geon?: readonly number[]
  }
}

/** The sent live-edit batches, oldest first. */
const edits = (socket: MockWebSocket) =>
  socket
    .sentCommands()
    .filter((cmd): cmd is EditCommand => cmd.cmd.startsWith('edit_'))

/** The editor layer — the pointer surface. */
const editor = () => {
  const el = document.querySelector<HTMLElement>('.eq-sliders')
  if (!el) throw new Error('no editor layer rendered')
  return el
}

/** A 20-band raw batch: zeros except the given band ↦ value entries. */
const bandGains = (entries: Record<number, number> = {}) =>
  Array.from({ length: 20 }, (_slot, band) => entries[band] ?? 0)

// Behavior 11 (#25): a drag emits per-tick live edits — no throttle,
// the engine coalesces per process block. Worked literals on the bare
// 400 × 192 field: y = 120 → +6 dB, y = 96 → +12 dB; x = 200 → slider
// 2 (fractional 9.5, splat band 10), x = 295 → slider 3 (14.25 → band
// 14). `Direct` passes touches through, so batches carry the touched
// bands exactly; sweeping paints both. The snapped Slider carries
// `eq-slider--active`, the root `visualizer--eq-drag`, both dropped on
// release; settled and released, the ticks stop.
it('a drag emits live edits per tick; sweeping paints bands; active state rides the snap', () => {
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame() // the mount paint

  fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 200, clientY: 120 })
  const root = document.querySelector('.visualizer')
  expect(root?.classList.contains('visualizer--eq-drag')).toBe(true)
  expect(sliders()[2]?.classList.contains('eq-slider--active')).toBe(true)

  vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(1)
  expect(edits(socket)[0]).toMatchObject({
    cmd: 'edit_profile',
    id: 'music',
    params: { gebg: bandGains({ 10: 96 }) },
  })

  fireEvent.pointerMove(editor(), { pointerId: 1, clientX: 295, clientY: 96 })
  expect(sliders()[3]?.classList.contains('eq-slider--active')).toBe(true)
  expect(sliders()[2]?.classList.contains('eq-slider--active')).toBe(false)
  vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(2)
  expect(edits(socket)[1]?.params.gebg).toEqual(bandGains({ 10: 96, 14: 192 }))

  fireEvent.pointerUp(editor(), { pointerId: 1 })
  expect(root?.classList.contains('visualizer--eq-drag')).toBe(false)
  expect(
    sliders().some((slider) => slider.classList.contains('eq-slider--active')),
  ).toBe(false)
  for (let frame = 0; frame < 3; frame += 1) vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(2)
})

// Behavior 12 (#25): routing — the drag's writes target
// `edit_eq_preset` iff a preset is active on the current profile, else
// `edit_profile` (Slice 15's model; the first test pinned the profile
// leg). The optimistic apply lands on the preset itself — presets are
// global, so the edit reflects in every profile selecting it.
it('routes drag writes to the active preset', () => {
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  const seeded = fixtureState()
  applySnapshot({
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === 'music'
        ? { ...profile, selected_eq_preset: 'rich' }
        : profile,
    ),
  })
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame()

  fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 200, clientY: 120 })
  vi.advanceTimersToNextFrame()
  fireEvent.pointerUp(editor(), { pointerId: 1 })

  expect(edits(socket)).toHaveLength(1)
  expect(edits(socket)[0]).toMatchObject({
    cmd: 'edit_eq_preset',
    id: 'rich',
    params: { gebg: bandGains({ 10: 96 }) },
  })
  const rich = state.eq_presets.find((preset) => preset.id === 'rich')
  expect(rich?.params['gebg']?.[10]).toBe(96)
})

// Behavior 13 (#25): `geon` auto-on (the original's). Factory state
// ships geon = 0 — without this, a first-ever drag writes into a
// bypassed filterbank: the curve moves, the sound doesn't. A batch
// going out with any gain ≠ 0 while the resolved active geon is 0
// includes geon: [1] **in the same batch**; the optimistic apply flips
// the resolution, so it lands exactly once.
it('the first nonzero batch includes geon: [1] in the same batch, once', () => {
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame()

  fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 200, clientY: 120 })
  vi.advanceTimersToNextFrame()
  fireEvent.pointerMove(editor(), { pointerId: 1, clientX: 200, clientY: 96 })
  vi.advanceTimersToNextFrame()
  fireEvent.pointerUp(editor(), { pointerId: 1 })

  expect(edits(socket)).toHaveLength(2)
  expect(edits(socket)[0]?.params).toEqual({
    gebg: bandGains({ 10: 96 }),
    geon: [1],
  })
  expect(edits(socket)[1]?.params).toEqual({ gebg: bandGains({ 10: 192 }) })
})

// Behavior 13, the negative space: all-zero batches never write geon
// (a flat write never needs the filterbank on — and definitionally
// never auto-off), and an already-enabled filterbank is never touched.
it('flat batches never write geon; an enabled filterbank is never touched', () => {
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  applySnapshot(fixtureStateWithParams({ gebg: bandGains({ 10: 96 }) }))
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame()

  // geon 0, the stored curve dragged flat: gains only.
  fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 200, clientY: 144 })
  vi.advanceTimersToNextFrame()
  fireEvent.pointerUp(editor(), { pointerId: 1 })
  expect(edits(socket)).toHaveLength(1)
  expect(edits(socket)[0]?.params).toEqual({ gebg: bandGains() })

  // geon already 1: a nonzero batch carries gains only.
  applySnapshot(fixtureStateWithParams({ geon: [1] }))
  fireEvent.pointerDown(editor(), { pointerId: 2, clientX: 200, clientY: 120 })
  vi.advanceTimersToNextFrame()
  fireEvent.pointerUp(editor(), { pointerId: 2 })
  expect(edits(socket)).toHaveLength(2)
  expect(edits(socket)[1]?.params).toEqual({ gebg: bandGains({ 10: 96 }) })
})

// Behavior 14 (#25): a preset switch mid-session rehydrates — the
// next stroke continues the new curve with no jump. The broadcast
// (another tab's switch; our own acked selection patch applies the
// same store change) moves the resolved active `gebg` from flat 0 to
// the preset's flat +6 dB; without the rehydrate the Brush buffer
// would still hold the old flat-zero curve, and the first tick would
// snap every untouched band back to 0 — the jump. `Direct` keeps the
// literals exact (rehydrate = identity); the inverse-matrix
// continuation itself is part A's roundtrip property. The smoother's
// own writes never retrigger: the hold test above would never
// converge if each optimistic apply rebuilt the brush.
it('a preset switch rehydrates: the next stroke continues the new curve', () => {
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame()

  const seeded = fixtureState()
  socket.serverMessage({
    type: 'state',
    snapshot: {
      ...seeded,
      profiles: seeded.profiles.map((profile) =>
        profile.id === 'music'
          ? { ...profile, selected_eq_preset: 'rich' }
          : profile,
      ),
      eq_presets: seeded.eq_presets.map((preset) =>
        preset.id === 'rich'
          ? {
              ...preset,
              params: {
                ...preset.params,
                gebg: Array.from({ length: 20 }, () => 96),
              },
            }
          : preset,
      ),
    },
  })

  // The next stroke: +7 dB on band 10 (y = 116) — one band moves, the
  // other nineteen hold the preset's curve.
  fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 200, clientY: 116 })
  vi.advanceTimersToNextFrame()
  fireEvent.pointerUp(editor(), { pointerId: 1 })

  expect(edits(socket)).toHaveLength(1)
  expect(edits(socket)[0]).toMatchObject({
    cmd: 'edit_eq_preset',
    id: 'rich',
    params: {
      gebg: Array.from({ length: 20 }, (_slot, band) =>
        band === 10 ? 112 : 96,
      ),
    },
  })
})

// Behavior 15 (#25): keyboard per Slider — an arrow on a focused
// thumb emits through the same pipeline (enqueue → tick loop → routed
// live edit). The ±1 dB rides the *splat band's* rendered gain, so up
// then down is an exact inverse and repeated presses walk the whole
// window (an interpolated base would converge short of the clamps on
// fractional sliders). `aria-valuenow` tracks the rendered source —
// idle here, so the optimistic apply moves what the next paint
// reports: the interpolated 9.5 shows half the band-10 step.
it('arrows emit through the drag pipeline; aria-valuenow tracks the rendered source', () => {
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  const socket = renderConnected()
  sizeField()
  vi.advanceTimersToNextFrame()
  const slider = sliders()[2]
  if (!slider) throw new Error('no slider rendered')

  fireEvent.keyDown(slider, { key: 'ArrowUp' })
  vi.advanceTimersToNextFrame() // the pump: one live edit
  expect(edits(socket)).toHaveLength(1)
  expect(edits(socket)[0]?.params.gebg).toEqual(bandGains({ 10: 16 }))
  vi.advanceTimersToNextFrame() // the paint after the optimistic apply
  expect(slider.getAttribute('aria-valuenow')).toBe('0.5')

  fireEvent.keyDown(slider, { key: 'ArrowDown' })
  vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(2)
  expect(edits(socket)[1]?.params.gebg).toEqual(bandGains())
  vi.advanceTimersToNextFrame()
  expect(slider.getAttribute('aria-valuenow')).toBe('0')
})

// Behavior 11, the hold — and the issue-pinned loop rule. Rehydration
// routinely parks Brush-buffer cells outside the edit window (the
// pseudoinverse sharpens: a +5 dB hill reaches ≈ −17 dB), and parked
// they must stay: rehydrate never starts the tick loop, or a preset
// switch would decay-rewrite the stored curve with zero input. A
// pointer down starts it; a still hold re-enqueues per tick, the decay
// emits until settled, then the writes go quiet. Convergence itself
// also pins the own-write guard: if the editor's optimistic applies
// retriggered rehydrate, the brush would rebuild (sharp again) every
// tick and never settle.
it('a still hold keeps emitting while decay pends, then ticks go quiet', () => {
  applySnapshot(
    fixtureStateWithParams({
      gebg: bandGains({ 8: 80, 9: 80, 10: 80, 11: 80 }),
    }),
  )
  const socket = renderConnected()
  sizeField()
  // Parked: rehydrate alone never ticks — frames pass, nothing writes.
  for (let frame = 0; frame < 5; frame += 1) vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(0)

  // Hold slider 0 (band 0) at +6 dB, Mobile default kernel.
  fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 10, clientY: 120 })
  for (let frame = 0; frame < 200; frame += 1) vi.advanceTimersToNextFrame()
  const settledCount = edits(socket).length
  expect(settledCount).toBeGreaterThan(5) // the decay kept writing
  // The held band paints exactly — every splat cell around it is 6 dB.
  expect(edits(socket).at(-1)?.params.gebg?.[0]).toBe(96)

  // Still held, converged: further ticks emit nothing…
  for (let frame = 0; frame < 10; frame += 1) vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(settledCount)

  // …and release parks the loop for good.
  fireEvent.pointerUp(editor(), { pointerId: 1 })
  for (let frame = 0; frame < 5; frame += 1) vi.advanceTimersToNextFrame()
  expect(edits(socket)).toHaveLength(settledCount)
})

// Issue #105 — network- and fps-agnostic. The vis round trip is a
// delay line: the frame the pump reads at tick t reflects the gain
// sent N ticks earlier — `vcbg[t] = sent[t − N] + IEQ`, `gebg[t] =
// sent[t − N]`, IEQ +3 dB (48) on every band. Pairing each frame's
// `vcbg` with its own `gebg` makes the residual exact whatever N: a
// hold at +12 dB (y = 96) on band 10 sends 9 dB (144) on every emitted
// batch, and the composed curve lands on the finger (192). N = 1 is
// the tightest loop, stable even against the smoother's own last gain;
// from N = 2 that rebase swung rail to rail (9, 18, 18, 9, 0, …).
it.each([1, 2, 3, 8])(
  'a hold lands where the finger points through an N = %i frame vis delay',
  (delay) => {
    localStorage.setItem('dolbyx.geq.kernel', 'Direct')
    const socket = renderConnected()
    sizeField()
    const IEQ = 48
    /** The gain in force per tick — `sent[t]`; the engine holds its last write. */
    const sent = [0]
    const frameReflecting = (tick: number) => {
      const gebg = sent[Math.max(0, tick)] ?? 0
      return fixtureVis({
        vcbg: Array.from({ length: 20 }, (_slot, band) =>
          band === 10 ? gebg + IEQ : IEQ,
        ),
        gebg: bandGains({ 10: gebg }),
      })
    }
    socket.serverMessage({ type: 'vis', params: frameReflecting(0) })
    vi.advanceTimersToNextFrame()

    fireEvent.pointerDown(editor(), { pointerId: 1, clientX: 200, clientY: 96 })
    for (let tick = 1; tick <= 30; tick += 1) {
      vi.advanceTimersToNextFrame() // the pump: re-enqueue the hold, tick
      sent.push(edits(socket).at(-1)?.params.gebg?.[10] ?? 0)
      // The frame tick + 1 reads: what the engine applied N ticks before.
      socket.serverMessage({
        type: 'vis',
        params: frameReflecting(tick + 1 - delay),
      })
    }
    fireEvent.pointerUp(editor(), { pointerId: 1 })

    const gains = edits(socket).map((edit) => edit.params.gebg?.[10])
    expect(gains.length).toBeGreaterThan(0)
    expect(gains).toEqual(gains.map(() => 144))
    expect(sent.at(-1)).toBe(144)
    expect(visFrame()?.vcbg[10]).toBe(192)
  },
)
