/**
 * Engine-native i16 ↔ display-unit conversion, driven by `frac_bits` —
 * the UI is the only layer that converts (epic invariant). Property-
 * gated reference twin: `ddp-state/src/conversion.rs` — same scaling,
 * same rounding (half away from zero), same saturation, kept in
 * lockstep by the mirrored suites.
 */

const I16_MIN = -32768
const I16_MAX = 32767

/**
 * The display value of an engine-native `raw`: `raw / 2^fracBits`
 * (`fracBits = 4` ⇒ 1/16-dB coding). Exact for every i16 — dividing by
 * a power of two loses no float bits.
 */
export function rawToDisplay(raw: number, fracBits: number): number {
  return raw / 2 ** fracBits
}

/**
 * The engine-native value of a display `value`:
 * `round(value × 2^fracBits)` half away from zero, saturated to the
 * i16 domain (NaN ⇒ 0).
 */
export function displayToRaw(value: number, fracBits: number): number {
  const scaled = value * 2 ** fracBits
  if (Number.isNaN(scaled)) return 0
  // Math.round alone rounds -0.5 up to -0 — mirror Rust's f64::round.
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return Math.min(Math.max(rounded, I16_MIN), I16_MAX)
}
