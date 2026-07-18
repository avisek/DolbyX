import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import { fixtureBootstrap, fixtureState, fixtureVis } from '../test/fixture'

// The store and the parameter table both read window.__BOOTSTRAP__ at
// module init (ADR-0006) — install the fixture before the dynamic
// imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: Visualizer } = await import('./Visualizer')
const { default: App } = await import('../App')
const { applySnapshot } = await import('../store/state')
const { startWs, stopWs } = await import('../store/ws')

beforeEach(() => {
  // Frames paint at rAF and nothing else may tick — fake the frame
  // clock (and plain timers, so a smuggled-in timer would surface).
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  })
  MockWebSocket.reset()
  // The store module is a singleton — re-seed it between tests.
  applySnapshot(fixtureState())
})

afterEach(() => {
  stopWs()
  cleanup()
  vi.useRealTimers()
})

/** Renders the visualizer and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <Visualizer />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

const columns = () => [...document.querySelectorAll<HTMLElement>('.vis-column')]

/** One column's published data pair: [`--exc`, `--gain`]. */
const vars = (column: HTMLElement | undefined) => [
  column?.style.getPropertyValue('--exc'),
  column?.style.getPropertyValue('--gain'),
]

// Behavior 7 (#24): a `vis` event lands on the columns as continuous
// dB vars at the next display frame (raw i16 ÷ 16 — the UI's one
// conversion); several events in one frame → the last wins.
it('lands a vis event on the columns as dB vars; the last event in a frame wins', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [-52], vcbg: [40] }),
  })
  // rAF coalescing: nothing paints between display frames.
  expect(vars(columns()[0])).toEqual(['-12', '0'])

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [-52, 320], vcbg: [40, -8] }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[0])).toEqual(['-3.25', '2.5']) // raw −52, 40
  expect(vars(columns()[1])).toEqual(['20', '-0.5']) // the last event won
  expect(vars(columns()[19])).toEqual(['-12', '0']) // padded slot: silence
})

// Behavior 8 (#24): from mount every column carries the floor — what
// streamed silence produces — and once events stop the vars hold
// unchanged: no decay, no fade, no timer anywhere.
it('carries the floor from mount and holds the last frame once events stop', () => {
  const socket = renderConnected()
  expect(columns()).toHaveLength(20)
  for (const column of columns()) {
    expect(vars(column)).toEqual(['-12', '0'])
  }

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [96], vcbg: [-24] }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[0])).toEqual(['6', '-1.5'])

  vi.advanceTimersByTime(60_000) // a minute of silence on the wire
  expect(vars(columns()[0])).toEqual(['6', '-1.5'])
  expect(vars(columns()[19])).toEqual(['-12', '0'])
})

// Behavior 9 (#24): the app root mirrors power as the `app--off` BEM
// modifier — the whole-UI marker skins read — while `vis` events keep
// applying to the vars: power never gates data.
it('tracks power as app--off on the app root while frames keep applying', () => {
  render(() => <App />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()

  const root = document.querySelector('.app')
  expect(root?.classList.contains('app--off')).toBe(false)

  applySnapshot(fixtureState({ power: false }))
  expect(root?.classList.contains('app--off')).toBe(true)

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [-52], vcbg: [40] }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[0])).toEqual(['-3.25', '2.5'])
})

/** The fixture state with the active profile's params overridden. */
function stateWithParams(params: Record<string, readonly number[]>) {
  const seeded = fixtureState()
  return {
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === seeded.selected_profile
        ? { ...profile, params: { ...profile.params, ...params } }
        : profile,
    ),
  }
}

// Behavior 10 (#24): the component mirrors resolved `ven` as its
// `visualizer--off` modifier — 0 → present, 1 → absent — and frames
// keep applying either way (the off-look is skin CSS, not a data gate).
it('mirrors resolved ven as visualizer--off while frames keep applying', () => {
  const socket = renderConnected()
  const section = document.querySelector('.visualizer')
  expect(section?.classList.contains('visualizer--off')).toBe(false)

  applySnapshot(stateWithParams({ ven: [0] }))
  expect(section?.classList.contains('visualizer--off')).toBe(true)

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [-52], vcbg: [40] }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[0])).toEqual(['-3.25', '2.5'])

  applySnapshot(fixtureState()) // ven = 1 again
  expect(section?.classList.contains('visualizer--off')).toBe(false)
})

// Behavior 11 (#24): a `vcnb` state change re-renders the column count;
// the event arrays stay fixed 20-slot and the columns read the first
// `vcnb` slots — the stale rest is ignored.
it('re-renders the column count on a vcnb change, reading the first slots', () => {
  const socket = renderConnected()
  expect(columns()).toHaveLength(20)

  applySnapshot(stateWithParams({ vcnb: [10] }))
  expect(columns()).toHaveLength(10)

  // Distinct per-slot values: vcbe −8·band (−0.5 dB steps), vcbg 8·band.
  const ramp = (step: number) =>
    Array.from({ length: 20 }, (_slot, band) => band * step)
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: ramp(-8), vcbg: ramp(8) }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[9])).toEqual(['-4.5', '4.5'])

  applySnapshot(fixtureState()) // vcnb = 20 again
  expect(columns()).toHaveLength(20)
  expect(vars(columns()[9])).toEqual(['-4.5', '4.5']) // survived the grow
  expect(vars(columns()[19])).toEqual(['-12', '0']) // fresh mount: floor

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: ramp(-8), vcbg: ramp(8) }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[19])).toEqual(['-9.5', '9.5']) // now read again
})
