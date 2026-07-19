import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
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
const { applySnapshot } = await import('../store/state')
const { resetVis } = await import('../store/vis')
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
