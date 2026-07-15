import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import { fixtureBootstrap } from '../test/fixture'

// The store and the parameter table both read window.__BOOTSTRAP__ at
// module init (ADR-0006) — install the fixture before the dynamic
// imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: Visualizer } = await import('./Visualizer')
const { startWs, stopWs } = await import('../store/ws')
const { clearVis } = await import('../store/vis')

beforeEach(() => {
  MockWebSocket.reset()
  clearVis() // the feed store is a singleton — re-seed between tests
  // The rAF render loop and the idle clock ride the same fake time.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  })
})

afterEach(() => {
  stopWs()
  cleanup()
  vi.useRealTimers()
})

/** Renders the visualizer and completes the background WS handshake. */
function renderConnected() {
  const rendered = render(() => <Visualizer />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return { container: rendered.container, socket }
}

const zeros = Array<number>(20).fill(0)

/** Delivers one `vis` event; `vcbe` drives the bricks, `vcbg` the pips. */
function visEvent(socket: MockWebSocket, vcbe: number[], vcbg = zeros) {
  socket.serverMessage({
    type: 'vis',
    params: { vnbg: zeros, vnbe: zeros, vcbg, vcbe },
  })
}

const columns = (container: HTMLElement) => [
  ...container.querySelectorAll('.visualizer__column'),
]

/** The `index`-th brick column; throws instead of asserting non-null. */
function column(container: HTMLElement, index: number): Element {
  const found = columns(container)[index]
  if (!found) throw new Error(`column ${String(index)} missing`)
  return found
}

/** The lit rows of one column, top row 0 → bottom row 47. */
function litRows(column: Element): number[] {
  return [...column.querySelectorAll('.visualizer__brick')].flatMap(
    (brick, row) =>
      brick.classList.contains('visualizer__brick--lit') ? [row] : [],
  )
}

// Behavior 7 (#24), the structure: the ADR-0008 layer stack — gradient
// background, 1-px grid lines, 20 × 48 bricks with the zone split,
// one pip per column, and the Slice 17 EQ overlay placeholder on top.
it('renders the SVG layer stack — bg, grid, 20×48 bricks, pips, EQ overlay', () => {
  const { container } = renderConnected()

  expect(container.querySelector('.visualizer__bg')).toBeTruthy()
  // 21 verticals + 49 horizontals — a line between (and around) every
  // column and row.
  expect(container.querySelectorAll('.visualizer__grid-line')).toHaveLength(70)

  const cols = columns(container)
  expect(cols).toHaveLength(20)
  for (const column of cols) {
    expect(column.querySelectorAll('.visualizer__brick')).toHaveLength(48)
    expect(column.querySelectorAll('.visualizer__pip')).toHaveLength(1)
  }
  // The color rule is positional: rows 0..11 red, 12..17 yellow, the
  // rest blue.
  const bricks = [
    ...column(container, 0).querySelectorAll('.visualizer__brick'),
  ]
  expect(bricks[0]?.classList).toContain('visualizer__brick--red')
  expect(bricks[11]?.classList).toContain('visualizer__brick--red')
  expect(bricks[12]?.classList).toContain('visualizer__brick--yellow')
  expect(bricks[17]?.classList).toContain('visualizer__brick--yellow')
  expect(bricks[18]?.classList).toContain('visualizer__brick--blue')
  expect(bricks[47]?.classList).toContain('visualizer__brick--blue')

  // The EQ overlay group sits last in the stack — above every brick.
  const overlay = container.querySelector('.visualizer__eq-overlay')
  expect(overlay).toBeTruthy()
  expect(overlay?.nextElementSibling).toBeNull()

  // At rest (no audio yet) the spectrum sits at the floor.
  expect(litRows(column(container, 0))).toEqual([47])
})

// Frequency labels resolve from the bootstrap's `gebf` at render time —
// no hardcoded table; a future engine with different band edges adapts.
it('labels each column with the resolved gebf frequency', () => {
  const { container } = renderConnected()
  const titles = [...container.querySelectorAll('.visualizer__column title')]
  expect(titles.map((title) => title.textContent)).toEqual([
    '43 Hz',
    '129 Hz',
    '215 Hz',
    '301 Hz',
    '431 Hz',
    '603 Hz',
    '775 Hz',
    '947 Hz',
    '1206 Hz',
    '1550 Hz',
    '2067 Hz',
    '2756 Hz',
    '3618 Hz',
    '4651 Hz',
    '5685 Hz',
    '7063 Hz',
    '8958 Hz',
    '11025 Hz',
    '13781 Hz',
    '18777 Hz',
  ])
})

// Behaviors 7 + 8 (#24): brick (c, r) fills iff excitation_idx(c) ≥
// 47 − r, on the asymmetric [−12, +36] dB mapping — raw 0 (0 dB) lights
// exactly 12 rows, not 24.
it('fills bricks bottom-up from the vis event, on the asymmetric dB mapping', () => {
  const { container, socket } = renderConnected()

  const vcbe = [...zeros]
  vcbe[0] = 576 // +36 dB — the whole column
  vcbe[1] = 0 //    0 dB — idx 11 ⇒ the bottom 12 rows
  vcbe[2] = -192 // −12 dB — the floor row only
  visEvent(socket, vcbe)
  vi.advanceTimersToNextFrame()

  expect(litRows(column(container, 0))).toHaveLength(48)
  const bottomTwelve = Array.from({ length: 12 }, (_, i) => 36 + i)
  expect(litRows(column(container, 1))).toEqual(bottomTwelve)
  expect(litRows(column(container, 2))).toEqual([47])
})

// Behavior 7 (#24): the level pip rides `vcbg[c]` — the per-column EQ
// indicator, the same source the Slice 17 curve will draw from.
it('positions each pip at the row for vcbg', () => {
  const { container, socket } = renderConnected()

  const vcbg = [...zeros]
  vcbg[0] = 576 // +36 dB ⇒ idx 47 ⇒ row 0
  vcbg[1] = 0 //    0 dB ⇒ idx 11 ⇒ row 36
  visEvent(socket, zeros, vcbg)

  // Cells are 5 px tall with a 1-px grid inset: row r ⇒ y = r × 5 + 1.
  const pips = [...container.querySelectorAll('.visualizer__pip')]
  expect(pips[0]?.getAttribute('y')).toBe('1') // row 0
  expect(pips[1]?.getAttribute('y')).toBe('181') // row 36
})

// Behavior 6 (#24), through the DOM: no events for ~200 ms freezes the
// frame; ~500 ms later the spectrum has faded to the floor. The pip is
// an EQ indicator — it holds, it never fades.
it('freezes then fades to the floor when events stop', () => {
  const { container, socket } = renderConnected()
  const vcbe = [...zeros]
  vcbe[0] = 576
  visEvent(socket, vcbe)
  vi.advanceTimersToNextFrame()
  const first = column(container, 0)
  expect(litRows(first)).toHaveLength(48)

  // Inside the freeze window the frame holds.
  vi.advanceTimersByTime(150)
  expect(litRows(first)).toHaveLength(48)

  // Past freeze + fade the spectrum rests at the floor…
  vi.advanceTimersByTime(1000)
  expect(litRows(first)).toEqual([47])
  // …and the pip still shows the last EQ gains.
  expect(container.querySelectorAll('.visualizer__pip')).toHaveLength(20)
})
