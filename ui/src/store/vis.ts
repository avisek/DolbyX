/**
 * The `vis` feed — the client holds the last frame plus the shared
 * **Vis idle** state (CONTEXT.md): idle ⟺ no `vis` event for 250 ms —
 * feed death only (zero sessions, host stopped processing, WS down),
 * never `ven` or power (bypassed blocks keep emitting). Mount starts
 * idle. Two consumers: the Visualizer's floor snap and the GEQ
 * editor's source rule. No smoothing anywhere — the timer changes what
 * the data *is*, never how it looks (ADR-0011).
 */
import { batch, createSignal } from 'solid-js'
import type { VisParams } from '../lib/ws'

/** Feed silence this long is death, not a gap between blocks. */
const IDLE_MS = 250

const [visFrame, setVisFrame] = createSignal<VisParams>()
const [visIdle, setVisIdle] = createSignal(true)

let idleTimer: ReturnType<typeof setTimeout> | undefined

/** The latest `vis` frame — `undefined` until the first event. */
export { visFrame }

/** True from mount and 250 ms after the last `vis` event. */
export { visIdle }

/**
 * One of the frame's arrays by 4-CC — the Live arrays' read
 * (CONTEXT.md); `undefined` before the first event or for any other
 * name.
 */
export function visArray(name: string): readonly number[] | undefined {
  const frame = visFrame()
  return frame && Object.hasOwn(frame, name)
    ? frame[name as keyof VisParams]
    : undefined
}

/**
 * Lands one `vis` event's params as the latest frame (the WS glue) and
 * re-arms the idle timer.
 */
export function applyVisFrame(params: VisParams): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    setVisIdle(true)
  }, IDLE_MS)
  batch(() => {
    setVisFrame(params)
    setVisIdle(false)
  })
}

/** Re-seeds the feed to its from-mount state (the module is a
 * singleton — test teardown, mirroring `applySnapshot`'s role). */
export function resetVis(): void {
  clearTimeout(idleTimer)
  idleTimer = undefined
  batch(() => {
    setVisFrame(undefined)
    setVisIdle(true)
  })
}
