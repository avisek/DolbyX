import {
  Index,
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Component,
} from 'solid-js'
import { visibleSliderCount } from '../lib/prefs'
import { DB_FRAC_BITS, rawToDisplay } from '../lib/units'
import { resolvedEqParam, visEnabled } from '../store/state'
import { visFrame, visIdle } from '../store/vis'
import './EqCurve.css'

/** The GEQ edit window in dB — asymmetric, the engine's own. */
const EDIT_MIN_DB = -12
const EDIT_MAX_DB = 36
const WINDOW_DB = EDIT_MAX_DB - EDIT_MIN_DB

/** A pixel coordinate, float noise trimmed to sub-pixel (2 dp). */
const px = (value: number) => String(Math.round(value * 100) / 100)

/**
 * The GEQ editor's face (issue #25 part B; CONTEXT.md "GEQ editor"):
 * `eq-slider`s and the two-pass `eq-curve` riding the engine's `vis`
 * feed, appended into the visualizer root per ADR-0008's tree. One
 * source rule, three consumers (curve vertices, thumb Ys, part C's
 * touch reference): fresh and `ven ≠ 0` → the latest frame's `vcbg` —
 * the composed curve the DSP applies (the finger leads, the display
 * trails one audio block); Vis idle or `ven = 0` (frozen frames can't
 * follow edits) → the resolved active `gebg`. Geometry is
 * component-owned pixel space via ResizeObserver — vertices at column
 * centers, flat edge extensions, thumbs at fractional indices, the
 * original's `thumbHeight/4` track padding; paints coalesce to rAF
 * like the columns. Everything painterly — chrome, z-order,
 * visibility, the 5 s linger — is skin CSS (ADR-0011): no timers, no
 * appearance here.
 */
const EqCurve: Component = () => {
  let slidersEl!: HTMLDivElement
  let glow!: SVGPolylineElement
  let stroke!: SVGPolylineElement
  let frameRequest: number | undefined

  const [field, setField] = createSignal({ width: 0, height: 0 })
  const [thumbHeight, setThumbHeight] = createSignal(0)

  /** The resolved band count — `genb`, reactive like `vcnb`. */
  const bandCount = () => resolvedEqParam('genb')?.[0] ?? 0

  /** The resolved band centre frequencies, for the slider labels. */
  const bandFreqs = () => resolvedEqParam('gebf') ?? []

  /** Visible Slider count — the display pref capped by `genb`. */
  const sliderCount = () => visibleSliderCount(bandCount())

  /** Fractional band step between visible Sliders. */
  const sliderStep = () =>
    sliderCount() > 1 ? (bandCount() - 1) / (sliderCount() - 1) : 0

  /** Slider `i`'s fractional band index. */
  const sliderIndex = (i: number) => i * sliderStep()

  /**
   * The rendered gains, raw i16 per live band — the source rule. The
   * curve reads `vcbg` by index: valid because the shipped defaults
   * pin the custom vis grid to mirror the GEQ grid (`vcnb = 20 =
   * genb`); Advanced-panel divergence renders misaligned (documented,
   * unsupported).
   */
  const sourceGains = (): readonly number[] => {
    const frame = visFrame()
    const live = !visIdle() && visEnabled() && frame !== undefined
    const source = live ? frame.vcbg : (resolvedEqParam('gebg') ?? [])
    return Array.from(
      { length: bandCount() },
      (_slot, band) => source[band] ?? 0,
    )
  }

  /** The display-dB gain at a fractional band index, interpolated. */
  const gainAt = (gains: readonly number[], index: number) => {
    const lo = Math.floor(index)
    const hi = Math.ceil(index)
    const loDb = rawToDisplay(gains[lo] ?? 0, DB_FRAC_BITS)
    if (lo === hi) return loDb
    const hiDb = rawToDisplay(gains[hi] ?? 0, DB_FRAC_BITS)
    return loDb + (hiDb - loDb) * (index - lo)
  }

  /** Paints the rendered source onto the sliders and the curve. */
  const paint = () => {
    frameRequest = undefined
    const { width, height } = field()
    const bands = bandCount()
    if (width <= 0 || height <= 0 || bands === 0) return
    const gains = sourceGains()
    const pitch = width / bands
    // dB → y: the original's padded track mapping — `thumbHeight/4`
    // top and bottom, usable track = H − 2·pad.
    const pad = thumbHeight() / 4
    const usable = height - 2 * pad
    const y = (dB: number) =>
      height - pad - ((dB - EDIT_MIN_DB) * usable) / WINDOW_DB

    // The curve: vertices at column centers, flat to both field edges.
    const dB = (band: number) => rawToDisplay(gains[band] ?? 0, DB_FRAC_BITS)
    const points = [
      `0,${px(y(dB(0)))}`,
      ...Array.from(
        { length: bands },
        (_slot, band) => `${px((band + 0.5) * pitch)},${px(y(dB(band)))}`,
      ),
      `${px(width)},${px(y(dB(bands - 1)))}`,
    ].join(' ')
    glow.setAttribute('points', points)
    stroke.setAttribute('points', points)

    // The sliders: x at the fractional index's column center; y and
    // `--gain` (continuous display dB — the skin data contract) from
    // the interpolated gain.
    for (let i = 0; i < slidersEl.children.length; i += 1) {
      const slider = slidersEl.children[i]
      if (!(slider instanceof HTMLElement)) continue
      const gain = gainAt(gains, sliderIndex(i))
      slider.style.left = `${px((sliderIndex(i) + 0.5) * pitch)}px`
      slider.style.setProperty('--gain', String(gain))
      slider.setAttribute('aria-valuenow', String(gain))
      const thumb = slider.querySelector<HTMLElement>('.eq-slider__thumb')
      if (thumb) thumb.style.top = `${px(y(gain))}px`
    }
  }

  // Coalesce to display frames, like the columns: any input change —
  // frame, idle, resolved state, geometry, band count — schedules one
  // rAF, and `paint` reads the signals then.
  createEffect(
    on(
      () => {
        sourceGains()
        bandCount()
        sliderCount()
        field()
        thumbHeight()
      },
      () => {
        frameRequest ??= requestAnimationFrame(paint)
      },
    ),
  )

  // Pixel geometry: the wrapper spans the field (inset 0); the thumb —
  // skin-sized — yields the track padding. A skin swapping thumb size
  // without a field resize re-measures on the next resize.
  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      batch(() => {
        for (const entry of entries) {
          if (entry.target === slidersEl) {
            setField({
              width: entry.contentRect.width,
              height: entry.contentRect.height,
            })
          }
        }
        setThumbHeight(
          slidersEl.querySelector<HTMLElement>('.eq-slider__thumb')
            ?.offsetHeight ?? 0,
        )
      })
    })
    observer.observe(slidersEl)
    onCleanup(() => {
      observer.disconnect()
    })
  })
  onCleanup(() => {
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest)
  })

  return (
    <>
      <div class="eq-sliders" ref={slidersEl}>
        <Index each={Array.from({ length: sliderCount() })}>
          {(_slot, i) => (
            <div
              class="eq-slider"
              role="slider"
              tabindex="0"
              aria-orientation="vertical"
              aria-valuemin={EDIT_MIN_DB}
              aria-valuemax={EDIT_MAX_DB}
              aria-label={`${String(
                bandFreqs()[Math.round(sliderIndex(i))] ?? 0,
              )} Hz`}
            >
              <div class="eq-slider__track" />
              <div class="eq-slider__thumb" />
            </div>
          )}
        </Index>
      </div>
      <svg class="eq-curve" aria-hidden="true">
        <polyline class="eq-curve__glow" ref={glow} />
        <polyline class="eq-curve__stroke" ref={stroke} />
      </svg>
    </>
  )
}

export default EqCurve
