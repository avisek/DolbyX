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

const { default: Visualizer } = await import('./Visualizer')
const { default: App } = await import('../App')
const { applySnapshot } = await import('../store/state')
const { resetVis } = await import('../store/vis')
const { startWs, stopWs } = await import('../store/ws')

beforeEach(() => {
  // Frames paint at rAF and the only timer is Vis idle's 250 ms — fake
  // both clocks, so a smuggled-in extra timer would surface.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  })
  MockWebSocket.reset()
  // The store modules are singletons — re-seed them between tests.
  applySnapshot(fixtureState())
  resetVis()
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

/** The section root's Vis idle modifier. */
const idleClass = () =>
  document.querySelector('.visualizer')?.classList.contains('visualizer--idle')

// Behavior 6 (#25, supersedes #24 behavior 8's vars-hold): mount
// starts idle — floor vars + `visualizer--idle`; a fresh frame exits
// idle and applies its vars in the same rAF paint (no floor flash);
// 250 ms without a frame re-enters — every column snaps to the floor
// and the modifier returns, again inside the paint.
it('mounts idle, exits on a fresh frame in the same paint, re-enters after 250 ms', () => {
  const socket = renderConnected()
  expect(idleClass()).toBe(true)
  for (const column of columns()) {
    expect(vars(column)).toEqual(['-12', '0'])
  }

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [96], vcbg: [-24] }),
  })
  // rAF-gated: between display frames neither the vars nor the
  // modifier move — exit lands whole in one style recalc.
  expect(idleClass()).toBe(true)
  expect(vars(columns()[0])).toEqual(['-12', '0'])
  vi.advanceTimersToNextFrame()
  expect(idleClass()).toBe(false)
  expect(vars(columns()[0])).toEqual(['6', '-1.5'])

  // A second frame re-arms the timer; 249 ms of feed silence from it:
  // still live, vars hold. (The paint above already spent frame time —
  // measure from a fresh event for the exact boundary.)
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: [96], vcbg: [-24] }),
  })
  vi.advanceTimersByTime(249)
  expect(idleClass()).toBe(false)
  expect(vars(columns()[0])).toEqual(['6', '-1.5'])

  // The 250th ms kills the feed; the next paint floors every column.
  vi.advanceTimersByTime(1)
  vi.advanceTimersToNextFrame()
  expect(idleClass()).toBe(true)
  for (const column of columns()) {
    expect(vars(column)).toEqual(['-12', '0'])
  }
})

// Behavior 7 (#25): `ven = 0` and power-off are not idle — bypassed
// blocks keep emitting, and idle is feed death only. Frames flowing →
// never `visualizer--idle`, whatever the gates say.
it('never idles while frames flow, even with ven = 0 and power off', () => {
  const socket = renderConnected()
  applySnapshot({
    ...fixtureStateWithParams({ ven: [0] }),
    power: false,
  })

  for (let block = 0; block < 6; block += 1) {
    socket.serverMessage({
      type: 'vis',
      params: fixtureVis({ vcbe: [96], vcbg: [-24] }),
    })
    vi.advanceTimersByTime(200) // block cadence, well under 250 ms apart
    expect(idleClass()).toBe(false)
  }

  // Feed death, gates unchanged: idle after 250 ms — feed only.
  vi.advanceTimersByTime(250)
  vi.advanceTimersToNextFrame()
  expect(idleClass()).toBe(true)
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

// Behavior 10 (#24): the component mirrors resolved `ven` as its
// `visualizer--off` modifier — 0 → present, 1 → absent — and frames
// keep applying either way (the off-look is skin CSS, not a data gate).
it('mirrors resolved ven as visualizer--off while frames keep applying', () => {
  const socket = renderConnected()
  const section = document.querySelector('.visualizer')
  expect(section?.classList.contains('visualizer--off')).toBe(false)

  applySnapshot(fixtureStateWithParams({ ven: [0] }))
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

  applySnapshot(fixtureStateWithParams({ vcnb: [10] }))
  expect(columns()).toHaveLength(10)

  // Distinct per-slot values: vcbe −8·band (−0.5 dB steps), vcbg 8·band.
  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: fixtureRamp(-8), vcbg: fixtureRamp(8) }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[9])).toEqual(['-4.5', '4.5'])

  applySnapshot(fixtureState()) // vcnb = 20 again
  expect(columns()).toHaveLength(20)
  expect(vars(columns()[9])).toEqual(['-4.5', '4.5']) // survived the grow
  expect(vars(columns()[19])).toEqual(['-12', '0']) // fresh mount: floor

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbe: fixtureRamp(-8), vcbg: fixtureRamp(8) }),
  })
  vi.advanceTimersToNextFrame()
  expect(vars(columns()[19])).toEqual(['-9.5', '9.5']) // now read again
})
