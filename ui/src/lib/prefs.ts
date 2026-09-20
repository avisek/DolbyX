/**
 * UI display preferences — browser `localStorage`, never `config.toml`
 * (epic invariant: prefs shape what a browser shows, state shapes what
 * the engine does). Every accessor is junk-tolerant: an unparseable or
 * out-of-vocabulary value reads as the default. The GEQ prefs have no
 * picker yet (issue #25 part B); the Advanced prefs are written by the
 * panel itself (#85).
 */
import type { KernelName } from './gain_smoother'

const SLIDERS_KEY = 'dolbyx.geq.sliders'
const KERNEL_KEY = 'dolbyx.geq.kernel'
const ADVANCED_OPEN_KEY = 'dolbyx.advanced.open'
const FOLDED_KEY = 'dolbyx.advanced.collapsed'

/** The original mobile layout's five sliders. */
const DEFAULT_SLIDERS = 5

/**
 * The visible EQ slider count `N ∈ [2, genb]` (default 5 → step 4.75 on
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

/** Whether the Advanced panel opens on mount — stored `1`; default closed. */
export function advancedOpen(): boolean {
  return localStorage.getItem(ADVANCED_OPEN_KEY) === '1'
}

export function setAdvancedOpen(open: boolean): void {
  localStorage.setItem(ADVANCED_OPEN_KEY, open ? '1' : '0')
}

/**
 * The Parameter categories whose Fold is closed, by name — a JSON list;
 * anything else reads as none, non-string members drop.
 */
export function foldedCategories(): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? 'null')
  } catch {
    return []
  }
  return Array.isArray(parsed)
    ? parsed.filter((name): name is string => typeof name === 'string')
    : []
}

export function setCategoryFolded(name: string, folded: boolean): void {
  const rest = foldedCategories().filter((stored) => stored !== name)
  localStorage.setItem(
    FOLDED_KEY,
    JSON.stringify(folded ? [...rest, name] : rest),
  )
}
