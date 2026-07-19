/**
 * UI display preferences — browser `localStorage`, never `config.toml`
 * (epic invariant: prefs shape what a browser shows, state shapes what
 * the engine does). Read-only this slice: defaults apply, the picker UI
 * is a later settings surface (issue #25 part B).
 */
import type { KernelName } from './gain_smoother'

const SLIDERS_KEY = 'dolbyx.geq.sliders'
const KERNEL_KEY = 'dolbyx.geq.kernel'

/** The original mobile layout's five sliders. */
const DEFAULT_SLIDERS = 5

/**
 * The visible Slider count `N ∈ [2, genb]` (default 5 → step 4.75 on
 * the shipped grid; `N = genb` → step 1, the original tablet). A `genb`
 * below the floor (Advanced divergence, unsupported) degrades to
 * `genb` itself.
 */
export function visibleSliderCount(genb: number): number {
  const stored = localStorage.getItem(SLIDERS_KEY)
  const parsed = stored === null ? NaN : Number(stored)
  // Positive integers clamp into range; anything else is junk.
  const wanted =
    Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_SLIDERS
  return Math.max(Math.min(wanted, genb), Math.min(2, genb))
}

/** The GEQ smoother kernel (default `Mobile`) — part C consumes it. */
export function smootherKernel(): KernelName {
  const stored = localStorage.getItem(KERNEL_KEY)
  return stored === 'Mobile' || stored === 'Soft' || stored === 'Direct'
    ? stored
    : 'Mobile'
}
