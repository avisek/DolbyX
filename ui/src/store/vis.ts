/**
 * The visualizer feed — the latest `vis` event plus its arrival time
 * (Slice 16 #24). A pure event stream: the Visualizer renders from the
 * latest frame at rAF and derives idle itself (~200 ms without an
 * event ⇒ freeze, then fade — ADR-0008; no suspend protocol exists).
 * Values stay engine-native i16 1/16-dB.
 */
import { createSignal } from 'solid-js'
import type { VisParams } from '../lib/ws'

/** One received `vis` event, stamped for the client-derived idle clock. */
export interface VisSample {
  /** The vis tail's four arrays, verbatim. */
  readonly params: VisParams
  /** `performance.now()` at arrival — comparable to rAF timestamps. */
  readonly at: number
}

const [visSample, setVisSample] = createSignal<VisSample | null>(null)

/** The latest `vis` event; `null` until the first block arrives. */
export { visSample }

/** Applies one `vis` event — the latest frame supersedes. */
export function applyVis(params: VisParams): void {
  setVisSample({ params, at: performance.now() })
}

/**
 * Drops the feed back to the pre-audio rest state — a fresh page
 * starts here naturally; tests re-seed the singleton between cases.
 */
export function clearVis(): void {
  setVisSample(null)
}
