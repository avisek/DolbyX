import { describe, expect, it } from 'vitest'
import {
  FLOOR_RAW,
  ROWS_RED,
  ROWS_YELLOW,
  VisBallistics,
  brickZone,
  excitationIdx,
} from './visualizer'

// Behavior 8 (#24): the dB mapping is asymmetric — [−12, +36] onto 48
// rows of 1 dB (GraphicVisualiserPainter.convertValue), never ±12.
describe('excitationIdx', () => {
  it('maps the asymmetric [−12, +36] dB range onto rows', () => {
    expect(excitationIdx(-192)).toBe(0) // −12 dB — the floor
    expect(excitationIdx(576)).toBe(47) // +36 dB — full column
    // 0 dB sits 12 rows up, not centred: (0 + 12) × 47/48 = 11.75 → 11.
    expect(excitationIdx(0)).toBe(11)
    expect(excitationIdx(384)).toBe(35) // +24 dB → 35.25 → 35
  })
})

// Behavior 7 (#24), the color rule's zone half: rows 0..11 red,
// 12..17 yellow, 18..47 blue (ROWS_RED = 12, ROWS_YELLOW = 6).
describe('brickZone', () => {
  it('splits rows into the red/yellow/blue zones', () => {
    expect(ROWS_RED).toBe(12)
    expect(ROWS_YELLOW).toBe(6)
    expect(brickZone(0)).toBe('red')
    expect(brickZone(11)).toBe('red')
    expect(brickZone(12)).toBe('yellow')
    expect(brickZone(17)).toBe('yellow')
    expect(brickZone(18)).toBe('blue')
    expect(brickZone(47)).toBe('blue')
  })
})

/** All twenty bands at one raw value. */
const bands = (raw: number) => Array<number>(20).fill(raw)

describe('VisBallistics', () => {
  it('rests at the floor before any event', () => {
    const ballistics = new VisBallistics()
    expect([...ballistics.tick(0)]).toEqual(bands(FLOOR_RAW))
  })

  // Behavior 5 (#24), attack half: a rising band lands within the
  // frame it arrives — fast attack is instant.
  it('attacks instantly on a rising value', () => {
    const ballistics = new VisBallistics()
    ballistics.enqueue(bands(576), 0)
    expect([...ballistics.tick(0)]).toEqual(bands(576))
  })

  // Behavior 5 (#24), decay half: a falling band halves its overshoot
  // every DECAY_HALF_LIFE_MS (120 ms) of wall-clock time.
  it('decays a falling value by half-lives of wall-clock time', () => {
    const ballistics = new VisBallistics()
    ballistics.enqueue(bands(576), 0)
    ballistics.tick(0)
    ballistics.enqueue(bands(FLOOR_RAW), 10)
    // One half-life after the peak: −192 + (576 − −192) × 0.5 = 192.
    expect(ballistics.tick(120)[0]).toBeCloseTo(192, 6)
  })

  // Behavior 5 (#24): ballistics ride wall-clock ticks, not event
  // arrivals — a 10 ms-block host and a 50 ms-block host carrying the
  // same values render identically at every frame.
  it('is stable across block-rate changes', () => {
    const at10ms = new VisBallistics()
    const at50ms = new VisBallistics()
    for (const ballistics of [at10ms, at50ms]) {
      ballistics.enqueue(bands(576), 0)
      ballistics.tick(0)
    }
    for (let at = 10; at <= 110; at += 10) at10ms.enqueue(bands(FLOOR_RAW), at)
    for (let at = 10; at <= 110; at += 50) at50ms.enqueue(bands(FLOOR_RAW), at)

    for (const now of [30, 60, 90, 120]) {
      const fast = [...at10ms.tick(now)]
      expect([...at50ms.tick(now)]).toEqual(fast)
    }
    expect(at10ms.tick(120)[0]).toBeCloseTo(192, 6) // the half-life math held
  })

  // Behavior 6 (#24): ~200 ms without an event freezes the last frame,
  // then ~500 ms fades it to the floor — all client-derived.
  it('freezes after 200 ms of silence, then fades to the floor over 500 ms', () => {
    const ballistics = new VisBallistics()
    ballistics.enqueue(bands(576), 0)
    ballistics.tick(0)

    // Still live just under the threshold.
    expect(ballistics.tick(199)[0]).toBe(576)
    // Mid-fade: (450 − 200) / 500 = half way from the frozen frame.
    expect(ballistics.tick(450)[0]).toBeCloseTo(192, 6)
    // Fade complete — and it stays there.
    expect(ballistics.tick(700)[0]).toBe(FLOOR_RAW)
    expect(ballistics.tick(10_000)[0]).toBe(FLOOR_RAW)
  })

  it('a fresh event revives an idle spectrum instantly', () => {
    const ballistics = new VisBallistics()
    ballistics.enqueue(bands(576), 0)
    ballistics.tick(0)
    ballistics.tick(900) // faded to the floor
    ballistics.enqueue(bands(400), 1000)
    expect(ballistics.tick(1000)[0]).toBe(400)
  })
})
