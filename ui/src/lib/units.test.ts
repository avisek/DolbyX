import { expect, it } from 'vitest'
import { displayToRaw, rawToDisplay } from './units'

// The Vitest mirror of `ddp-state/src/conversion.rs`'s proptest gate
// (behavior 8, issue #22) — deterministic sweeps instead of strategies.

// The docs' scaling cheat-sheet landmarks (docs/ddp/02-ak-parameters.md).
it('converts the documented landmarks', () => {
  expect(rawToDisplay(96, 4)).toBe(6)
  expect(rawToDisplay(-2080, 4)).toBe(-130)
  expect(displayToRaw(3, 4)).toBe(48)
  expect(displayToRaw(-6, 4)).toBe(-96)
  expect(rawToDisplay(7, 0)).toBe(7)
  expect(displayToRaw(7, 0)).toBe(7)
})

it('rounds half away from zero, saturates, and zeroes NaN', () => {
  expect(displayToRaw(0.03125, 4)).toBe(1) // half a step rounds up
  expect(displayToRaw(-0.03125, 4)).toBe(-1) // …and down below zero
  expect(displayToRaw(5000, 4)).toBe(32767)
  expect(displayToRaw(-5000, 4)).toBe(-32768)
  expect(displayToRaw(Number.NaN, 4)).toBe(0)
})

// Behavior 8, invertibility half: every i16 round-trips exactly through
// display units — exhaustive, not sampled (the domain is tiny).
it('round-trips every i16 exactly', () => {
  for (const fracBits of [0, 1, 4, 8]) {
    for (let raw = -32768; raw <= 32767; raw += 1) {
      if (displayToRaw(rawToDisplay(raw, fracBits), fracBits) !== raw) {
        expect.fail(
          `raw ${String(raw)} drifted at frac_bits ${String(fracBits)}`,
        )
      }
    }
  }
})

// Behavior 8, clamp half: clamping in display units then converting
// equals converting then clamping to the `ParameterDef` [min, max].
it('display-side clamps agree with engine-side clamps', () => {
  const clamp = (value: number, lo: number, hi: number) =>
    Math.min(Math.max(value, lo), hi)
  // Real table ranges: dhsb, dhrg, dvla, dvli.
  const ranges: [number, number][] = [
    [0, 96],
    [-2080, 96],
    [0, 10],
    [-640, 0],
  ]
  for (const fracBits of [0, 4]) {
    for (const [min, max] of ranges) {
      // Sweep in quarter-steps from below min to above max.
      const step = rawToDisplay(1, fracBits)
      const from = rawToDisplay(min, fracBits) - 3 * step
      const to = rawToDisplay(max, fracBits) + 3 * step
      for (let value = from; value <= to; value += step / 4) {
        const displayClamped = clamp(
          value,
          rawToDisplay(min, fracBits),
          rawToDisplay(max, fracBits),
        )
        expect(displayToRaw(displayClamped, fracBits)).toBe(
          clamp(displayToRaw(value, fracBits), min, max),
        )
      }
    }
  }
})

// Behavior 8, quantization half: display → raw → display moves a value
// at most half a quantization step.
it('display round-trips stay within half a step', () => {
  for (const fracBits of [0, 4]) {
    const step = rawToDisplay(1, fracBits)
    for (let value = -130; value <= 130; value += 0.093) {
      const roundTripped = rawToDisplay(displayToRaw(value, fracBits), fracBits)
      expect(Math.abs(roundTripped - value)).toBeLessThanOrEqual(step / 2)
    }
  }
})
