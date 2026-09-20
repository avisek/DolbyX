import { expect, it } from 'vitest'
import { clampTo, quantize, stepped, type StepAxis } from './step'

const none = { altKey: false, shiftKey: false }
const alt = { altKey: true, shiftKey: false }
const shift = { altKey: false, shiftKey: true }
const both = { altKey: true, shiftKey: true }

// Behavior 11 (#87): a linear 1/16-dB axis — base one display unit,
// Alt the lattice step nearest a tenth (0.125 dB, 2 raw), Shift ten,
// Alt winning over Shift; clamped at the bounds; an integer axis
// never steps under one raw unit, so Alt = 1.
it('steps a linear 1/16-dB axis by 1, Alt 0.125, Shift 10, clamped', () => {
  const db: StepAxis = { min: 0, max: 6, fine: 0.0625 }
  expect(stepped(db, 3, 1, none)).toBe(4)
  expect(stepped(db, 3, -1, none)).toBe(2)
  expect(stepped(db, 3, 1, alt)).toBe(3.125)
  expect(stepped(db, 3, 1, shift)).toBe(6) // +10, clamped
  expect(stepped(db, 3, 1, both)).toBe(3.125)
  expect(stepped(db, 0.5, -1, none)).toBe(0)
  expect(stepped(db, 3, 3, alt)).toBe(3.375) // several at once
  expect(stepped(db, 3, 0, none)).toBe(3)

  const count: StepAxis = { min: 0, max: 10, fine: 1 }
  expect(stepped(count, 4, 1, alt)).toBe(5)
  expect(stepped(count, 4, 1, shift)).toBe(10)
})

// Behavior 12 (#87): a log axis steps multiplicatively — a semitone
// (440 × 2^(1/12) = 466.16 → 466 on the integer lattice), Shift an
// octave, Alt a tenth-semitone that still clears one raw unit at the
// floor (20 → 21); a range touching zero steps linearly.
it('steps a log Hz axis by semitone, octave, and never under one raw unit', () => {
  const hz: StepAxis = { min: 20, max: 20000, fine: 1, scale: 'log' }
  expect(stepped(hz, 440, 1, none)).toBe(466)
  expect(stepped(hz, 466, -1, none)).toBe(440)
  expect(stepped(hz, 440, 1, shift)).toBe(880)
  expect(stepped(hz, 440, -1, shift)).toBe(220)
  expect(stepped(hz, 20, 1, alt)).toBe(21)
  expect(stepped(hz, 20, -1, none)).toBe(20) // floor, clamped
  expect(stepped(hz, 15000, 1, shift)).toBe(20000)

  const signed: StepAxis = { min: 0, max: 100, fine: 1, scale: 'log' }
  expect(stepped(signed, 10, 1, none)).toBe(11)
  expect(stepped(signed, 10, 1, shift)).toBe(20)
})

// The exported helpers the box (and #88 / #89 / #91) lean on.
it('quantizes to the lattice and clamps, trimming float noise', () => {
  const db: StepAxis = { min: -130, max: 30, fine: 0.0625 }
  expect(quantize(db, 3.1)).toBe(3.125)
  expect(quantize(db, 99)).toBe(30)
  expect(clampTo(db, -200)).toBe(-130)
  expect(clampTo(db, 0.1 + 0.2)).toBe(0.3)
})
