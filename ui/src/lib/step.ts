/**
 * The Step rule (CONTEXT.md) — the one increment law every numeric
 * gesture shares: box ↑/↓ (#87), Slider keys (#89), Band strip ↑/↓
 * (#91), the Scrub (#88). Nothing else steps.
 *
 * Linear: base = 1 display unit; Alt = 0.1×, Shift = 10×, Alt wins
 * when both are held. Steps snap to the raw lattice
 * (`fine` = one raw unit in display units) and never go under one raw
 * unit — on 1/16-dB params Alt lands on 0.125 dB (2 raw), the lattice
 * step nearest 0.1; on integers Alt = 1.
 *
 * Log (`scale: 'log'` over a strictly positive range, else linear):
 * multiplicative with the same modifier feel — base a semitone, Alt a
 * tenth of one, Shift an octave — and never less than one raw unit,
 * so 20 Hz still climbs.
 */

/** What a `KeyboardEvent` / `PointerEvent` carries of the modifiers. */
export interface Modifiers {
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** How an axis steps (and how the Slider positions, #89). */
export type StepScale = 'linear' | 'log'

/** A numeric axis in display units. */
export interface StepAxis {
  readonly min: number
  readonly max: number
  /** One raw unit in display units — the lattice. */
  readonly fine: number
  /** Linear when absent. */
  readonly scale?: StepScale | undefined
}

const SEMITONE = 2 ** (1 / 12)

/** Float-noise trim — the lattice is powers of two, 4 places suffice. */
const trim = (value: number): number => Number(value.toFixed(4))

/** Alt 0.1, Shift 10, else 1 — Alt wins. */
const multiplier = (mods: Modifiers): number =>
  mods.altKey ? 0.1 : mods.shiftKey ? 10 : 1

/** Whether the axis steps multiplicatively: log over a strictly
 * positive range. */
const isLog = (axis: StepAxis): boolean =>
  axis.scale === 'log' && axis.min > 0 && axis.max > axis.min

/** The linear step under `mods`: lattice-snapped, never under `fine`. */
const linearStep = (fine: number, mods: Modifiers): number =>
  trim(Math.max(fine, Math.round(multiplier(mods) / fine) * fine))

/** The log factor under `mods`: semitone, Alt a tenth, Shift an octave. */
const logFactor = (mods: Modifiers): number =>
  mods.altKey ? SEMITONE ** 0.1 : mods.shiftKey ? 2 : SEMITONE

/** `value` clamped to the axis. */
export const clampTo = (axis: StepAxis, value: number): number =>
  trim(Math.min(axis.max, Math.max(axis.min, value)))

/** `value` snapped to the raw lattice and clamped. */
export const quantize = (axis: StepAxis, value: number): number =>
  clampTo(axis, Math.round(value / axis.fine) * axis.fine)

/**
 * `value` moved `steps` steps (signed; the scrub accumulates several)
 * under `mods`, quantized and clamped.
 */
export function stepped(
  axis: StepAxis,
  value: number,
  steps: number,
  mods: Modifiers,
): number {
  const from = quantize(axis, value)
  if (steps === 0) return from
  if (isLog(axis)) {
    const next = quantize(axis, value * logFactor(mods) ** steps)
    // A small factor on a small value may not clear one raw unit.
    return next === from
      ? quantize(axis, from + Math.sign(steps) * axis.fine)
      : next
  }
  return quantize(axis, value + steps * linearStep(axis.fine, mods))
}
