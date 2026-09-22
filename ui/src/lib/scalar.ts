/**
 * A def's scalar values in display units — `units.ts` applied per
 * `frac_bits` (the epic's invariant: i16 end-to-end, only the UI
 * converts) — and its step axis (`fine`, `scale`) for the Step rule.
 * What every numeric control shows, writes, and steps by.
 */
import type { ParameterDef } from './parameters'
import type { StepAxis, StepScale } from './step'
import { displayToRaw, rawToDisplay } from './units'

/** One raw value in display units, float noise trimmed to 2 places. */
export function displayValue(def: ParameterDef, raw: number): number {
  return Number(rawToDisplay(raw, def.frac_bits).toFixed(2))
}

/** A display value as the raw write, clamped to the def's range. */
export function rawValue(def: ParameterDef, value: number): number {
  return Math.min(
    def.max,
    Math.max(def.min, displayToRaw(value, def.frac_bits)),
  )
}

/** The step lattice: one raw unit in display units. */
export function fineStep(def: ParameterDef): number {
  return rawToDisplay(1, def.frac_bits)
}

/** The step / Slider scale by kind: frequencies live on a log axis. */
export function scaleOf(def: ParameterDef): StepScale {
  return def.kind === 'frequency_hz' ? 'log' : 'linear'
}

/** The def's Step-rule axis in display units — what every numeric
 * control shows, writes, and steps by. */
export function axisOf(def: ParameterDef): StepAxis {
  return {
    min: displayValue(def, def.min),
    max: displayValue(def, def.max),
    fine: fineStep(def),
    scale: scaleOf(def),
  }
}
