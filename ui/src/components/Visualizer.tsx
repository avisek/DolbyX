import {
  For,
  batch,
  createEffect,
  createMemo,
  createUniqueId,
  onCleanup,
  onMount,
  type Component,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import { paramDef } from '../lib/parameters'
import {
  BANDS,
  FLOOR_RAW,
  ROWS,
  VisBallistics,
  brickZone,
  excitationIdx,
} from '../lib/visualizer'
import { state } from '../store/state'
import { visSample } from '../store/vis'
import './Visualizer.css'

// The Java painter's integer cell grid (`GraphicVisualiserPainter.
// onSizeChanged`): each cell is a brick plus a 1-px grid line, with one
// closing line on the right/bottom edge. The SVG scales the lot.
const CELL_W = 24
const CELL_H = 5
const WIDTH = BANDS * CELL_W + 1
const HEIGHT = ROWS * CELL_H + 1

const COLUMN_INDICES = [...Array(BANDS).keys()]
const ROW_INDICES = [...Array(ROWS).keys()]

/** The row a raw 1/16-dB value maps to, pinned inside the grid. */
function rowFor(raw: number): number {
  return ROWS - 1 - Math.min(Math.max(excitationIdx(raw), 0), ROWS - 1)
}

/**
 * The 20 × 48 spectrum brick field (Slice 16 #24, ADR-0008) — the SVG
 * layer stack: radial-gradient background, 1-px grid, bottom-up brick
 * columns driven by `vcbe` through fast-attack / slow-decay ballistics
 * at rAF, a level pip per column at `vcbg`, and the Slice 17 (#25) EQ
 * overlay placeholder on top. Idle is client-derived: no event for
 * ~200 ms freezes the frame, then ~500 ms fades it to the floor — the
 * pip is an EQ indicator and holds. Column frequencies resolve from
 * the bootstrap's `gebf` at render time; nothing is hardcoded.
 */
const Visualizer: Component = () => {
  const ballistics = new VisBallistics()
  const [excitations, setExcitations] = createStore<number[]>(
    Array<number>(BANDS).fill(excitationIdx(FLOOR_RAW)),
  )

  createEffect(() => {
    const sample = visSample()
    if (sample) ballistics.enqueue(sample.params.vcbe, sample.at)
  })

  let frameHandle = 0
  const frame = (now: number) => {
    const display = ballistics.tick(now)
    batch(() => {
      for (let column = 0; column < BANDS; column += 1) {
        setExcitations(column, excitationIdx(display[column] ?? FLOOR_RAW))
      }
    })
    frameHandle = requestAnimationFrame(frame)
  }
  onMount(() => {
    frameHandle = requestAnimationFrame(frame)
  })
  onCleanup(() => {
    cancelAnimationFrame(frameHandle)
  })

  // The pip rides the latest `vcbg` directly — near-static EQ gains
  // need no ballistics, and the original keeps them up while suspended.
  const pipRows = createMemo(() => {
    const gains = visSample()?.params.vcbg ?? paramDef('vcbg').default
    return COLUMN_INDICES.map((column) => rowFor(gains[column] ?? 0))
  })

  // gebf is preset-carried: a selected EQ preset's params shadow the
  // profile's own entirely (ADR-0003).
  const frequencies = createMemo(() => {
    const profile = state.profiles.find(
      (candidate) => candidate.id === state.selected_profile,
    )
    const preset = state.eq_presets.find(
      (candidate) => candidate.id === profile?.selected_eq_preset,
    )
    const gebf =
      preset?.params['gebf'] ??
      profile?.params['gebf'] ??
      paramDef('gebf').default
    return gebf.slice(0, BANDS)
  })

  const gradientId = createUniqueId()
  return (
    <svg
      class="visualizer"
      role="img"
      aria-label="Visualizer"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
    >
      <defs>
        <radialGradient id={gradientId} cx="50%" cy="0%" r="120%">
          <stop offset="0%" style={{ 'stop-color': 'var(--color-vis-bg)' }} />
          <stop
            offset="100%"
            style={{ 'stop-color': 'var(--color-vis-bg-edge)' }}
          />
        </radialGradient>
      </defs>
      <rect
        class="visualizer__bg"
        width={WIDTH}
        height={HEIGHT}
        fill={`url(#${gradientId})`}
      />
      <g class="visualizer__grid">
        <For each={[...Array(BANDS + 1).keys()]}>
          {(column) => (
            <line
              class="visualizer__grid-line"
              x1={column * CELL_W + 0.5}
              y1={0}
              x2={column * CELL_W + 0.5}
              y2={HEIGHT}
            />
          )}
        </For>
        <For each={[...Array(ROWS + 1).keys()]}>
          {(row) => (
            <line
              class="visualizer__grid-line"
              x1={0}
              y1={row * CELL_H + 0.5}
              x2={WIDTH}
              y2={row * CELL_H + 0.5}
            />
          )}
        </For>
      </g>
      <For each={COLUMN_INDICES}>
        {(column) => (
          <g class="visualizer__column">
            <title>{`${String(frequencies()[column] ?? 0)} Hz`}</title>
            <For each={ROW_INDICES}>
              {(row) => (
                <rect
                  class={`visualizer__brick visualizer__brick--${brickZone(row)}`}
                  classList={{
                    'visualizer__brick--lit':
                      (excitations[column] ?? 0) >= ROWS - 1 - row,
                  }}
                  x={column * CELL_W + 1}
                  y={row * CELL_H + 1}
                  width={CELL_W - 1}
                  height={CELL_H - 1}
                />
              )}
            </For>
            <rect
              class="visualizer__pip"
              x={column * CELL_W + 1}
              y={(pipRows()[column] ?? ROWS - 1) * CELL_H + 1}
              width={CELL_W - 1}
              height={CELL_H - 1}
            />
          </g>
        )}
      </For>
      {/* EQ track/thumbs/curve land in Slice 17 (#25); the group and
          its opacity transition are the hand-off point. */}
      <g class="visualizer__eq-overlay" />
    </svg>
  )
}

export default Visualizer
