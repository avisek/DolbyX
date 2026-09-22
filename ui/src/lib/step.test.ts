import { expect, it } from 'vitest'
import {
  clampTo,
  fromNorm,
  quantize,
  stepped,
  toNorm,
  type StepAxis,
} from './step'

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

  const atZero: StepAxis = { min: 0, max: 100, fine: 1, scale: 'log' }
  expect(stepped(atZero, 10, 1, none)).toBe(11)
  expect(stepped(atZero, 10, 1, shift)).toBe(20)
})

// The exported helpers the box (and #88 / #89 / #91) lean on.
it('quantizes to the lattice and clamps, trimming float noise', () => {
  const db: StepAxis = { min: -130, max: 30, fine: 0.0625 }
  expect(quantize(db, 3.1)).toBe(3.125)
  expect(quantize(db, 99)).toBe(30)
  expect(clampTo(db, -200)).toBe(-130)
  expect(clampTo(db, 0.1 + 0.2)).toBe(0.3)
})

// The Slider's position map (#89), forward: `--norm` is linear over
// [min, max], log over a strictly positive log axis (200 Hz over
// 20–20000 sits at 1/3 — one decade of three), unclamped so an
// out-of-range value reads outside 0–1; a log axis touching zero maps
// linearly.
it('maps a value to a linear norm, log on a positive Hz axis, unclamped', () => {
  const hz: StepAxis = { min: 20, max: 20000, fine: 1, scale: 'log' }
  expect(toNorm(hz, 200)).toBeCloseTo(1 / 3, 10)
  expect(toNorm(hz, 20)).toBe(0)
  expect(toNorm(hz, 20000)).toBe(1)

  const db: StepAxis = { min: 0, max: 6, fine: 0.0625 }
  expect(toNorm(db, 3)).toBe(0.5)
  expect(toNorm(db, 9)).toBe(1.5)

  const atZero: StepAxis = { min: 0, max: 100, fine: 1, scale: 'log' }
  expect(toNorm(atZero, 50)).toBe(0.5)
})

// The inverse lands on the lattice, clamped: 50 % of 20–20000 is
// 20 · 1000^0.5 = 632.46 → 632; 0.165 of 0–6 dB is 0.99 → the nearest
// 1/16, 1; positions past the ends clamp.
it('maps a norm back to a lattice value, clamped', () => {
  const hz: StepAxis = { min: 20, max: 20000, fine: 1, scale: 'log' }
  expect(fromNorm(hz, 0.5)).toBe(632)
  expect(fromNorm(hz, 1 / 3)).toBe(200)
  expect(fromNorm(hz, 1.5)).toBe(20000)

  const db: StepAxis = { min: 0, max: 6, fine: 0.0625 }
  expect(fromNorm(db, 0.165)).toBe(1)
  expect(fromNorm(db, -1)).toBe(0)

  const atZero: StepAxis = { min: 0, max: 100, fine: 1, scale: 'log' }
  expect(fromNorm(atZero, 0.25)).toBe(25)
})
