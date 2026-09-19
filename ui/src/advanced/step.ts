// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * THE one step rule every numeric gesture shares — box ↑/↓, slider
 * keys, strip ↑/↓, pointer-lock scrub. Base step = 1 display unit;
 * Alt = 0.1× (fine), Shift = 10× (coarse); Alt wins when both are
 * held. Linear steps snap to the raw lattice (`fine` = one raw unit
 * in display units) and never go under one raw unit — on 1/16-dB
 * params Alt lands on 0.125 dB (2 raw), the lattice step nearest
 * 0.1. Log axes (FrequencyHz) step multiplicatively with the same
 * modifier feel: base = a semitone, Alt = a tenth of one, Shift = an
 * octave — and never move less than one raw unit, so 20 Hz still
 * climbs.
 */

export interface Modifiers {
  readonly altKey: boolean
  readonly shiftKey: boolean
}

export interface StepAxis {
  readonly min: number
  readonly max: number
  /** One raw unit in display units. */
  readonly fine: number
  readonly scale?: 'linear' | 'log' | undefined
}

const SEMITONE = 2 ** (1 / 12)

/** Float noise trim — the lattice is powers of two, 4 places suffice. */
export const round = (value: number): number => Number(value.toFixed(4))

/** Modifier multiplier: Alt 0.1, Shift 10, else 1. */
const multiplier = (mods: Modifiers): number =>
  mods.altKey ? 0.1 : mods.shiftKey ? 10 : 1

/** Whether the axis steps multiplicatively (strictly positive log). */
export const isLog = (axis: StepAxis): boolean =>
  axis.scale === 'log' && axis.min > 0 && axis.max > axis.min

/** Linear step in display units under `mods`, lattice-snapped, ≥ fine. */
export function linearStep(fine: number, mods: Modifiers): number {
  const want = multiplier(mods)
  return round(Math.max(fine, Math.round(want / fine) * fine))
}

/** Log factor under `mods`: semitone, Alt = semitone^0.1, Shift = octave. */
export function logFactor(mods: Modifiers): number {
  return mods.altKey ? SEMITONE ** 0.1 : mods.shiftKey ? 2 : SEMITONE
}

export const clampTo = (axis: StepAxis, value: number): number =>
  round(Math.min(axis.max, Math.max(axis.min, value)))

/** Snaps to the raw lattice and clamps. */
export const quantize = (axis: StepAxis, value: number): number =>
  clampTo(axis, Math.round(value / axis.fine) * axis.fine)

/**
 * `value` moved `steps` steps (signed, may be several — the scrub
 * accumulates) under `mods`, quantized and clamped. Log: × factor^n,
 * but never less than one raw unit per step.
 */
export function stepped(
  axis: StepAxis,
  value: number,
  steps: number,
  mods: Modifiers,
): number {
  if (steps === 0) return quantize(axis, value)
  if (isLog(axis)) {
    const next = quantize(axis, value * logFactor(mods) ** steps)
    // A tiny factor on a small value may not clear one raw unit.
    if (next === quantize(axis, value)) {
      return quantize(axis, value + Math.sign(steps) * axis.fine)
    }
    return next
  }
  return quantize(axis, value + steps * linearStep(axis.fine, mods))
}
