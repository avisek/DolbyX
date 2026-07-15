/**
 * The visualizer's client math (Slice 16 #24, ADR-0008): the brick
 * grid's dB mapping and color zones transcribed from
 * `GraphicVisualiserPainter.java` — never re-derived — plus the display
 * ballistics the original didn't need (its pump repainted at a fixed
 * 20 fps; the v2 feed is one event per audio block at whatever rate the
 * host runs, so the client smooths and derives idle itself). Values are
 * engine-native i16 1/16-dB throughout; only [`excitationIdx`] touches
 * dB.
 */

/** Spectrum columns — the custom-grid band count the daemon stages. */
export const BANDS = 20
/** Brick rows: 48 rows of 1 dB (`GraphicVisualiserPainter.ROWS`). */
export const ROWS = 48
/** Rows 0..11 render red (`ROWS_RED`). */
export const ROWS_RED = 12
/** Rows 12..17 render yellow (`ROWS_YELLOW`). */
export const ROWS_YELLOW = 6
/** Raw −192 = −12 dB — the display floor and the pre-audio rest state. */
export const FLOOR_RAW = -192
/** Silence long enough to freeze the last frame (issue #24 idle). */
export const IDLE_FREEZE_MS = 200
/** The freeze-to-floor fade window that follows. */
export const IDLE_FADE_MS = 500
/** Decay half-life: a falling band halves its overshoot every 120 ms. */
const DECAY_HALF_LIFE_MS = 120

/**
 * The excitation row index of a raw 1/16-dB value —
 * `GraphicVisualiserPainter.convertValue` verbatim: dB ∈ [−12, +36]
 * (asymmetric — the engine's output range, never ±12) onto 48 rows of
 * 1 dB, `(int)`-truncated. Brick `(c, r)` is filled iff
 * `excitationIdx ≥ 47 − r`.
 */
export function excitationIdx(raw: number): number {
  return Math.trunc(((raw / 16 - -12) * 47) / 48)
}

/** The color zone of row `r`: red on top, yellow, blue to the floor. */
export function brickZone(row: number): 'red' | 'yellow' | 'blue' {
  if (row < ROWS_RED) return 'red'
  if (row < ROWS_RED + ROWS_YELLOW) return 'yellow'
  return 'blue'
}

/**
 * Per-band display ballistics: fast attack (a rising band lands the
 * frame it arrives), slow exponential decay by wall-clock time — so
 * the picture is identical at any host block rate — and client-derived
 * idle: [`IDLE_FREEZE_MS`] without an event freezes the last frame,
 * then [`IDLE_FADE_MS`] fades it to the floor. The render loop calls
 * [`VisBallistics.tick`] every rAF and draws the returned buffer.
 */
export class VisBallistics {
  readonly #display = new Float64Array(BANDS).fill(FLOOR_RAW)
  readonly #target = new Float64Array(BANDS).fill(FLOOR_RAW)
  #lastEventAt = Number.NEGATIVE_INFINITY
  #lastTickAt: number | null = null
  /** The fade's base — the display as of the tick the freeze began. */
  #frozen: Float64Array | null = null

  /** Feeds one `vis` event's band values, stamped with its arrival. */
  enqueue(values: readonly number[], atMs: number): void {
    for (let band = 0; band < BANDS; band += 1) {
      this.#target[band] = values[band] ?? FLOOR_RAW
    }
    this.#lastEventAt = atMs
    this.#frozen = null
  }

  /**
   * Advances the ballistics to `nowMs` and returns the display buffer
   * (owned by this instance — read, don't hold).
   */
  tick(nowMs: number): Float64Array {
    const dt = Math.max(0, nowMs - (this.#lastTickAt ?? nowMs))
    this.#lastTickAt = nowMs
    const silence = nowMs - this.#lastEventAt
    if (silence < IDLE_FREEZE_MS) {
      const keep = 0.5 ** (dt / DECAY_HALF_LIFE_MS)
      for (let band = 0; band < BANDS; band += 1) {
        const target = this.#target[band] ?? FLOOR_RAW
        const display = this.#display[band] ?? FLOOR_RAW
        this.#display[band] =
          target >= display ? target : target + (display - target) * keep
      }
    } else {
      this.#frozen ??= this.#display.slice()
      const faded = Math.min(1, (silence - IDLE_FREEZE_MS) / IDLE_FADE_MS)
      for (let band = 0; band < BANDS; band += 1) {
        const frozen = this.#frozen[band] ?? FLOOR_RAW
        this.#display[band] = frozen + (FLOOR_RAW - frozen) * faded
      }
    }
    return this.#display
  }
}
