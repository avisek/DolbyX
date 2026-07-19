import { expect, it } from 'vitest'
import { GainSmoother, KERNELS, type KernelName } from './gain_smoother'
import {
  GAIN_SMOOTHER_INV_MOBILE,
  GAIN_SMOOTHER_INV_SOFT,
} from './gain_smoother_inv'

// Seam 1 of issue #25 (part A): the smoother in isolation — pure math,
// no mocks. Worked literals are hand-derived from the spec's pipeline
// (splat → decay → convolve → quantize), never from the implementation.

// Behavior 1: a single touch splats a (2L+1)-cell brush and convolves
// into the thick-brush spread. Mobile kernel [0.1, 0.25, 0.3, 0.25, 0.1]
// over temp[5..9] = 10 dB: band 5 sums the full kernel (10 dB → 160),
// band 4/6 drop one tail (0.9 · 10 → 144), then 6.5 → 104, 3.5 → 56,
// 1.0 → 16, and 0 beyond the brush reach.
it('convolves a single touch into the thick-brush spread', () => {
  const smoother = new GainSmoother('Mobile')
  smoother.enqueue(5, 10)
  expect(smoother.tick(0)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 16, 56, 104, 144, 160, 144, 104, 56, 16,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
})

// Behavior 2: kernel selection changes the output shape. Soft
// [0.25, 0.5, 0.25] spreads the same touch one band each side (7.5 →
// 120, 2.5 → 40); Direct passes touches through unsmoothed, exact.
it('shapes the spread per the selected kernel', () => {
  const soft = new GainSmoother('Soft')
  soft.enqueue(5, 10)
  expect(soft.tick(0)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 0, 0, 40, 120, 160, 120, 40, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )

  const direct = new GainSmoother('Direct')
  direct.enqueue(5, 10)
  direct.enqueue(6, -3)
  expect(direct.tick(0)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 0, 0, 0, 0, 160, -48, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
})

// Behavior 3: Brush-buffer cells outside [−12, +36] dB move toward the
// violated clamp at a 0.3 s half-life. A 42 dB paint (touch 36, ref −6)
// halves its 6 dB overshoot per 300 ms: 42 → 39 → 37.5. Band 5 stays
// clamped at 576 throughout; the off-center bands ride the decay
// (0.9 · 39 = 35.1 → 562, 0.9 · 37.5 = 33.75 → 540).
it('decays out-of-window cells toward the violated clamp', () => {
  const smoother = new GainSmoother('Mobile')
  smoother.enqueue(5, 36, -6)
  expect(smoother.tick(1000)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 67, 235, 437, 576, 576, 576, 437, 235, 67,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
  expect(smoother.tick(1300)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 62, 218, 406, 562, 576, 562, 406, 218, 62,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
  expect(smoother.tick(1600)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 60, 210, 390, 540, 576, 540, 390, 210, 60,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
})

// Behavior 3: within 0.2 dB of the violated clamp a cell snaps exact —
// Δt-independent, so it lands on the very first tick. A 36.15 dB paint
// snaps to 36: band 4 emits 0.9 · 36 = 32.4 dB → 518 (an unsnapped
// 36.15 would emit 0.9 · 36.15 = 32.535 dB → 521).
it('snaps cells within 0.2 dB of the clamp exact', () => {
  const smoother = new GainSmoother('Mobile')
  smoother.enqueue(5, 36, -0.15)
  expect(smoother.tick(0)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 58, 202, 374, 518, 576, 518, 374, 202, 58,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
})

// Behavior 3: a ≥ 1 s tick gap means the loop was parked — Δt = 0, so
// the first resumed tick decays nothing (and emits `null`: nothing
// changed). The tick after resumes the half-life from the gap tick.
it('decays nothing on the first tick after a ≥ 1 s gap', () => {
  const smoother = new GainSmoother('Mobile')
  smoother.enqueue(5, 36, -6)
  expect(smoother.tick(1000)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 67, 235, 437, 576, 576, 576, 437, 235, 67,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
  expect(smoother.tick(5000)).toBeNull()
  expect(smoother.tick(5300)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 62, 218, 406, 562, 576, 562, 406, 218, 62,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
})

// Behavior 1, tracer bullet: a scripted drag sweeping bands 3 → 8 at
// 16.7 ms ticks, coalescing included (two bands one tick; band 6
// re-enqueued — the last value wins: 12.5 dB → 200). Golden frozen from
// the implementation the worked-literal tests above verify; landmarks
// re-checked by hand (t0 band 3 = 96 = 6 dB · 16; t83.5 band 8 = 224 =
// 14 dB · 16). The empty-queue tail tick emits nothing.
it('emits the frozen golden sequence for a scripted drag trace', () => {
  const smoother = new GainSmoother('Mobile')
  const trace: [number, [number, number][], readonly number[] | null][] = [
    // prettier-ignore
    [0, [[3, 6]], [
      34, 62, 86, 96, 86, 62, 34, 10, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]],
    // prettier-ignore
    [16.7, [[4, 8]], [
      37, 74, 107, 125, 128, 115, 83, 45, 13, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]],
    // prettier-ignore
    [33.4, [[5, 10], [6, 11]], [
      37, 77, 120, 151, 167, 174, 176, 158, 114, 62,
      18, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]],
    // prettier-ignore
    [50.1, [[6, 12], [6, 12.5]], [
      37, 77, 122, 160, 183, 196, 200, 180, 130, 70,
      20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]],
    // prettier-ignore
    [66.8, [[7, 13]], [
      37, 77, 122, 160, 186, 201, 207, 208, 187, 135,
      73, 21, 0, 0, 0, 0, 0, 0, 0, 0,
    ]],
    // prettier-ignore
    [83.5, [[8, 14]], [
      37, 77, 122, 160, 187, 207, 218, 222, 224, 202,
      146, 78, 22, 0, 0, 0, 0, 0, 0, 0,
    ]],
    [100.2, [], null],
  ]
  for (const [now, touches, expected] of trace) {
    for (const [band, dB] of touches) smoother.enqueue(band, dB)
    const batch = smoother.tick(now)
    if (expected === null) expect(batch).toBeNull()
    else expect(batch).toEqual(new Int16Array(expected))
  }
})

// Behavior 4: a tick that moves nothing returns `null`, and a held
// still pointer (re-enqueueing its own (band, dB)) keeps emitting
// nothing once settled — with the queue drained and every cell
// in-window, `settled()` reports all future ticks `null`.
it('returns null on no-change ticks and settles under a held pointer', () => {
  const smoother = new GainSmoother('Direct')
  smoother.enqueue(5, 10)
  expect(smoother.tick(0)).not.toBeNull()
  expect(smoother.tick(17)).toBeNull()
  smoother.enqueue(5, 10)
  expect(smoother.settled()).toBe(false) // queued touch pending
  expect(smoother.tick(33)).toBeNull()
  expect(smoother.settled()).toBe(true)
})

// Behavior 4: out-of-window cells hold `settled()` false while their
// decay converges; the snap ends it. The 42 dB paint reaches +36
// through 6 half-life steps and the 0.2 dB snap — the last emit is the
// snapped curve (0.9 · 36 → 518 at band 4), then ticks go `null`.
it('settles once decay snaps every cell into the window', () => {
  const smoother = new GainSmoother('Mobile')
  smoother.enqueue(5, 36, -6)
  let lastBatch: Int16Array | null = null
  let ticks = 0
  for (let now = 0; !smoother.settled(); now += 300) {
    ticks += 1
    expect(ticks).toBeLessThan(20)
    lastBatch = smoother.tick(now) ?? lastBatch
  }
  expect(ticks).toBe(7)
  expect(lastBatch).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 58, 202, 374, 518, 576, 518, 374, 202, 58,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  )
  expect(smoother.tick(2100)).toBeNull()
})

// Behavior 5: `rehydrate(gebg)` rebuilds the Brush buffer so the
// convolution reproduces the stored curve — the tick after emits
// nothing, and a stroke continues the curve instead of painting over
// zeros. Direct's inverse is the identity: after rehydrate, a touch
// replaces exactly its band and every other band re-emits the stored
// curve. Mobile roundtrips through the 20×20 pseudoinverse: bands the
// splat can't reach (> 2L away) must still re-emit the stored values
// exactly — sub-quantum roundtrip through INV and back. Only
// rehydration puts Brush-buffer cells outside the edit window (the
// pseudoinverse amplifies curvature), so Mobile lands unsettled; the
// continuation tick uses a ≥ 1 s gap (Δt = 0) so decay can't blur the
// exact comparison.
it('rehydrates a stored curve and continues it under a stroke', () => {
  // A gentle hill in i16 quanta, well inside the window.
  // prettier-ignore
  const stored = [
    0, 8, 16, 32, 48, 64, 80, 64, 48, 32,
    16, 8, 0, -8, -16, -24, -16, -8, 0, 0,
  ]

  const direct = new GainSmoother('Direct')
  direct.rehydrate(stored)
  expect(direct.settled()).toBe(true)
  expect(direct.tick(0)).toBeNull()
  direct.enqueue(5, 10)
  const directBatch = direct.tick(17)
  expect(directBatch).toEqual(
    new Int16Array([...stored.slice(0, 5), 160, ...stored.slice(6)]),
  )

  const mobile = new GainSmoother('Mobile')
  mobile.rehydrate(stored)
  expect(mobile.settled()).toBe(false) // INV painted past the window
  expect(mobile.tick(0)).toBeNull()
  mobile.enqueue(10, 10)
  const batch = mobile.tick(5000)
  expect(batch).not.toBeNull()
  // Bands 0–5 and 15–19 sit outside the splat's reach (band 10 ± 2L).
  expect([...(batch ?? []).slice(0, 6)]).toEqual(stored.slice(0, 6))
  expect([...(batch ?? []).slice(15)]).toEqual(stored.slice(15))
  expect((batch ?? [])[10]).toBe(160)
})

// Behavior 5, property: `convolve(rehydrate(g)) ≈ g` within the 0.02 dB
// skip threshold for random in-window curves, all three kernels — a
// transcription error in the ~800 script-transcribed floats breaks the
// roundtrip. The pipeline below (INV · g, edge replication, kernel
// convolution) is restated from the spec, independent of the class.
it('roundtrips random in-window curves through the pseudoinverses', () => {
  const identity = Array.from({ length: 20 }, (_, i) =>
    Array.from({ length: 20 }, (_, j) => (i === j ? 1 : 0)),
  )
  const inverses: Record<KernelName, readonly (readonly number[])[]> = {
    Mobile: GAIN_SMOOTHER_INV_MOBILE,
    Soft: GAIN_SMOOTHER_INV_SOFT,
    Direct: identity,
  }
  // mulberry32 — a tiny seeded PRNG; deterministic sweep, no dep.
  let seed = 0x9e3779b9
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (const name of ['Mobile', 'Soft', 'Direct'] as const) {
    const { L, k } = KERNELS[name]
    const inv = inverses[name]
    for (let trial = 0; trial < 150; trial += 1) {
      // Random i16 curve across the full edit window −192..+576.
      const gains = Array.from(
        { length: 20 },
        () => Math.floor(random() * 769 - 192) / 16,
      )
      const temp = new Array<number>(20 + 2 * L).fill(0)
      for (let band = 0; band < 20; band += 1) {
        temp[L + band] = gains.reduce(
          (sum, gain, i) => sum + (inv[band]?.[i] ?? 0) * gain,
          0,
        )
      }
      for (let i = 0; i < L; i += 1) {
        temp[i] = temp[L] ?? 0
        temp[L + 20 + i] = temp[L + 19] ?? 0
      }
      for (let band = 0; band < 20; band += 1) {
        const convolved = k.reduce(
          (sum, weight, i) => sum + weight * (temp[band + i] ?? 0),
          0,
        )
        expect(Math.abs(convolved - (gains[band] ?? 0))).toBeLessThanOrEqual(
          0.02,
        )
      }
    }
  }
})

// Behavior 5, structural pin: both pseudoinverses are centro-symmetric —
// INV[i][j] = INV[19−i][19−j] — matching the mirror symmetry of the
// edge-replicated convolution they invert. A row swapped, dropped, or
// shifted in transcription breaks the pin.
it('pins the pseudoinverses centro-symmetric', () => {
  for (const inv of [GAIN_SMOOTHER_INV_MOBILE, GAIN_SMOOTHER_INV_SOFT]) {
    for (let i = 0; i < 20; i += 1) {
      for (let j = 0; j < 20; j += 1) {
        expect(inv[i]?.[j]).toBe(inv[19 - i]?.[19 - j])
      }
    }
  }
})

// Behavior 1: a reference gain rebases the touch (`touchDB − (ref −
// smooth[band])`), which can paint past the window — the emit clamps to
// −192..+576. Touch 36 dB against ref −5 paints 41 dB: bands 4–6 land
// past +36 dB and clamp to 576; the spread beyond stays live (26.65 →
// 426, 14.35 → 230, 4.1 → 66). Touch −12 against ref 3 paints −15 dB:
// bands 14–16 clamp to −192 (0.9 · −15 = −13.5 dB is already past −12).
it('clamps emitted writes to the edit window', () => {
  const smoother = new GainSmoother('Mobile')
  smoother.enqueue(5, 36, -5)
  smoother.enqueue(15, -12, 3)
  expect(smoother.tick(0)).toEqual(
    // prettier-ignore
    new Int16Array([
      0, 66, 230, 426, 576, 576, 576, 426, 230, 66,
      0, -24, -84, -156, -192, -192, -192, -156, -84, -24,
    ]),
  )
})
