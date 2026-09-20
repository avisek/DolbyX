/**
 * A def's scalar values in display units — `units.ts` applied per
 * `frac_bits` (the epic's invariant: i16 end-to-end, only the UI
 * converts). What every numeric control shows and writes; #87 part 2
 * adds the step axis (`fine`, `scale`) here.
 */
import type { ParameterDef } from './parameters'
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
