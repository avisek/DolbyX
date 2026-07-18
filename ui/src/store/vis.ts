/**
 * The `vis` feed — the client holds the last frame (CONTEXT.md "`vis`
 * event"): a pure event stream, no idle concept, no smoothing. The
 * Visualizer paints the held frame at rAF; between events — and from
 * boot until the first one — the signal simply holds.
 */
import { createSignal } from 'solid-js'
import type { VisParams } from '../lib/ws'

const [visFrame, setVisFrame] = createSignal<VisParams>()

/** The latest `vis` frame — `undefined` until the first event. */
export { visFrame }

/** Lands one `vis` event's params as the latest frame (the WS glue). */
export function applyVisFrame(params: VisParams): void {
  setVisFrame(params)
}
