/**
 * The GEQ editor's gain smoother (issue #25 part A) — pure UI math
 * transcribing the original painter's pipeline
 * (`GraphicEqualizerPainter.java`): drain the touch queue into the
 * Brush buffer, decay out-of-window cells, convolve with the selected
 * kernel, emit quantized 20-band `gebg` writes. Smoothing is UI-only —
 * wire and engine always carry the smoothed, clamped curve.
 */
import {
  GAIN_SMOOTHER_INV_MOBILE,
  GAIN_SMOOTHER_INV_SOFT,
} from './gain_smoother_inv'
import { displayToRaw, rawToDisplay } from './units'

/** A smoothing kernel: half-width `L`, weights `k` (2L + 1 cells). */
export interface Kernel {
  readonly L: number
  readonly k: readonly number[]
}

/** The selectable smoothing kernels (a UI display pref). */
export const KERNELS = {
  /** The original's mobile smoother. */
  Mobile: { L: 2, k: [0.1, 0.25, 0.3, 0.25, 0.1] },
  /** The original's tablet smoother. */
  Soft: { L: 1, k: [0.25, 0.5, 0.25] },
  /** No smoothing — touches pass through. */
  Direct: { L: 0, k: [1.0] },
} as const satisfies Record<string, Kernel>

/** A `KERNELS` key. */
export type KernelName = keyof typeof KERNELS

/** `gebg`'s fixed wire shape — the smoother is 20-slot end to end. */
export const WIRE_BANDS = 20

/** `gebg` is dB-coded at 1/16 dB. */
const FRAC_BITS = 4

/** The edit window in dB … */
const EDIT_MIN_DB = -12
const EDIT_MAX_DB = 36
/** … and in i16 1/16-dB wire units (−192..+576). */
const EDIT_MIN_RAW = displayToRaw(EDIT_MIN_DB, FRAC_BITS)
const EDIT_MAX_RAW = displayToRaw(EDIT_MAX_DB, FRAC_BITS)

/** Clamps an i16 value to the edit window. */
function clampToWindow(raw: number): number {
  return Math.min(Math.max(raw, EDIT_MIN_RAW), EDIT_MAX_RAW)
}

/** Half-life of the out-of-window decay (the original's 0.3 s). */
const DECAY_HALF_LIFE_S = 0.3
/** Cells this close to the violated clamp snap exact. */
const SNAP_DB = 0.2

/** Each kernel's 20×20 pseudoinverse; `Direct`'s is the identity. */
const INVERSES: Record<KernelName, readonly (readonly number[])[] | null> = {
  Mobile: GAIN_SMOOTHER_INV_MOBILE,
  Soft: GAIN_SMOOTHER_INV_SOFT,
  Direct: null,
}

/**
 * Smooths drag input into 20-band `gebg` writes. Feed touches with
 * {@link enqueue}, pump {@link tick} per rAF; each non-`null` result is
 * one wire batch.
 */
export class GainSmoother {
  private readonly kernel: Kernel
  private readonly inv: readonly (readonly number[])[] | null
  /** The Brush buffer — 2L edge cells around the 20 band cells. */
  private readonly temp: Float64Array
  /** The convolved curve in dB — what the engine carries. */
  private readonly smooth = new Float64Array(WIRE_BANDS)
  /** Per-band coalescing queue; insertion order = drain order. */
  private readonly queue = new Map<number, { dB: number; offset: number }>()
  private lastEmitted = new Int16Array(WIRE_BANDS)
  /** Last tick's timestamp; `null` ⇒ the next tick sees Δt = 0. */
  private lastTick: number | null = null

  constructor(kernel: KernelName) {
    this.kernel = KERNELS[kernel]
    this.inv = INVERSES[kernel]
    this.temp = new Float64Array(WIRE_BANDS + 2 * this.kernel.L)
  }

  /**
   * Rebuilds the Brush buffer from a stored `gebg` (i16 wire units) so
   * the convolution reproduces that curve exactly and the next stroke
   * continues it: `temp = INV · gains`, edge cells replicated outward.
   * Clears any queued touches; the curve counts as already emitted, so
   * the following tick is `null` unless something moves.
   */
  rehydrate(gebg: readonly number[]): void {
    const { L } = this.kernel
    for (let band = 0; band < WIRE_BANDS; band += 1) {
      const raw = clampToWindow(gebg[band] ?? 0)
      this.smooth[band] = rawToDisplay(raw, FRAC_BITS)
      this.lastEmitted[band] = raw
    }
    for (let band = 0; band < WIRE_BANDS; band += 1) {
      let cell = 0
      if (this.inv === null) {
        cell = this.smooth[band] ?? 0
      } else {
        const row = this.inv[band] ?? []
        for (let i = 0; i < WIRE_BANDS; i += 1) {
          cell += (row[i] ?? 0) * (this.smooth[i] ?? 0)
        }
      }
      this.temp[L + band] = cell
    }
    for (let i = 0; i < L; i += 1) {
      this.temp[i] = this.temp[L] ?? 0
      this.temp[L + WIRE_BANDS + i] = this.temp[L + WIRE_BANDS - 1] ?? 0
    }
    this.queue.clear()
    this.lastTick = null
  }

  /**
   * Queues a touch: `dB` for `band`, less `offset` — the band's non-GEQ
   * contribution as the caller measured it (one frame's `vcbg − gebg`,
   * display dB), so the painted gain plus that contribution lands where
   * the finger points. The smoother's own state never enters the
   * rebase. Re-enqueueing a band moves it to the drain tail; the last
   * value wins.
   */
  enqueue(band: number, dB: number, offset = 0): void {
    this.queue.delete(band)
    this.queue.set(band, { dB, offset })
  }

  /**
   * Runs one smoothing pass at timestamp `now` (ms). Returns the
   * 20-band i16 batch iff it differs from the last emitted, else
   * `null`.
   */
  tick(now: number): Int16Array | null {
    const { L, k } = this.kernel
    // A ≥ 1 s gap means the loop was parked, not that a second of decay
    // elapsed — a resumed drag never jump-decays.
    const deltaMs =
      this.lastTick === null || now - this.lastTick >= 1000
        ? 0
        : now - this.lastTick
    this.lastTick = now
    // Drain: splat each queued touch across its (2L+1)-cell window —
    // every cell the same value, the thick-brush feel.
    for (const [band, { dB, offset }] of this.queue) {
      const gain = dB - offset
      for (let cell = band; cell <= band + 2 * L; cell += 1) {
        this.temp[cell] = gain
      }
    }
    this.queue.clear()
    // Decay: cells outside the edit window move toward the violated
    // clamp at the half-life; within `SNAP_DB` they snap exact
    // (Δt-independent, like the original's). In-range cells untouched.
    const alpha = Math.pow(0.5, deltaMs / 1000 / DECAY_HALF_LIFE_S)
    for (let cell = 0; cell < this.temp.length; cell += 1) {
      const value = this.temp[cell] ?? 0
      if (value > EDIT_MAX_DB) {
        this.temp[cell] =
          value - EDIT_MAX_DB < SNAP_DB
            ? EDIT_MAX_DB
            : value * alpha + (1 - alpha) * EDIT_MAX_DB
      } else if (value < EDIT_MIN_DB) {
        this.temp[cell] =
          EDIT_MIN_DB - value < SNAP_DB
            ? EDIT_MIN_DB
            : value * alpha + (1 - alpha) * EDIT_MIN_DB
      }
    }
    // Convolve: smooth[b] = Σ kernel[i] · temp[b + i], skipping moves
    // within 0.02 dB (the original's per-band threshold).
    for (let band = 0; band < WIRE_BANDS; band += 1) {
      let gain = 0
      for (let i = 0; i <= 2 * L; i += 1) {
        gain += (k[i] ?? 0) * (this.temp[band + i] ?? 0)
      }
      if (Math.abs((this.smooth[band] ?? 0) - gain) > 0.02) {
        this.smooth[band] = gain
      }
    }
    // Emit: quantize clamped to the edit window; dedupe post-quantization.
    const batch = new Int16Array(WIRE_BANDS)
    let changed = false
    for (let band = 0; band < WIRE_BANDS; band += 1) {
      batch[band] = clampToWindow(
        displayToRaw(this.smooth[band] ?? 0, FRAC_BITS),
      )
      changed ||= batch[band] !== this.lastEmitted[band]
    }
    if (!changed) return null
    this.lastEmitted = batch.slice()
    return batch
  }

  /**
   * True ⟺ every Brush-buffer cell is inside the edit window and the
   * queue is empty — all future ticks are `null`, so the tick loop can
   * stop.
   */
  settled(): boolean {
    if (this.queue.size > 0) return false
    return this.temp.every(
      (value) => value >= EDIT_MIN_DB && value <= EDIT_MAX_DB,
    )
  }
}
