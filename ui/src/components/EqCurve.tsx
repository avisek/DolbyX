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
import { GainSmoother, WIRE_BANDS } from '../lib/gain_smoother'
import { smootherKernel, visibleSliderCount } from '../lib/prefs'
import { DB_FRAC_BITS, rawToDisplay } from '../lib/units'
import {
  resolvedEqParam,
  selectedEqPreset,
  selectedProfile,
  visEnabled,
} from '../store/state'
import { editEqPresetLive, editProfileLive } from '../store/ws'
import { visFrame, visIdle } from '../store/vis'
import './EqCurve.css'

/** The GEQ edit window in dB — asymmetric, the engine's own. */
const EDIT_MIN_DB = -12
const EDIT_MAX_DB = 36
const WINDOW_DB = EDIT_MAX_DB - EDIT_MIN_DB

/** A pixel coordinate, float noise trimmed to sub-pixel (2 dp). */
const px = (value: number) => String(Math.round(value * 100) / 100)

/** Clamps a display dB to the edit window. */
const clampDb = (dB: number) => Math.min(EDIT_MAX_DB, Math.max(EDIT_MIN_DB, dB))

/** One resolved touch: the snapped Slider, its splat band, the dB.
 * (Named clear of the DOM's own `Touch`.) */
interface EditorTouch {
  readonly slider: number
  readonly band: number
  readonly dB: number
}

/**
 * The GEQ editor (issue #25 parts B + C; CONTEXT.md "GEQ editor"):
 * `eq-slider`s and the two-pass `eq-curve` riding the engine's `vis`
 * feed, appended into the visualizer root per ADR-0008's tree. One
 * source rule, three consumers (curve vertices, thumb Ys, the touch
 * reference): fresh and `ven ≠ 0` → the latest frame's `vcbg` — the
 * composed curve the DSP applies (the finger leads, the display
 * trails one audio block); Vis idle or `ven = 0` (frozen frames can't
 * follow edits) → the resolved active `gebg`. Geometry is
 * component-owned pixel space via ResizeObserver — vertices at column
 * centers, flat edge extensions, thumbs at fractional indices, the
 * original's `thumbHeight/4` track padding; paints coalesce to rAF
 * like the columns. Everything painterly — chrome, z-order,
 * visibility, the 5 s linger — is skin CSS (ADR-0011): no timers, no
 * appearance here.
 *
 * The hand (part C): the pointer surface is the field — down/move
 * snap to the nearest visible Slider and enqueue into the
 * {@link GainSmoother}; a rAF tick loop pumps it, each non-`null`
 * tick one optimistic live edit routed to the active preset or the
 * profile. Preset/profile switches rehydrate the smoother so the next
 * stroke continues the new curve.
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
   * The `vis` feed when it can speak for the editor — fresh and
   * `ven ≠ 0`; under Vis idle or `ven = 0` → `undefined`, consumers
   * fall back to the resolved active state. The source rule's one
   * seat, three consumers: curve vertices, thumb Ys, the touch
   * reference (ADR-0008).
   */
  const liveFrame = () => {
    const frame = visFrame()
    return !visIdle() && visEnabled() && frame !== undefined ? frame : undefined
  }

  /**
   * The rendered gains, raw i16 per live band — the source rule. The
   * curve reads `vcbg` by index: valid because the shipped defaults
   * pin the custom vis grid to mirror the GEQ grid (`vcnb = 20 =
   * genb`); Advanced-panel divergence renders misaligned (documented,
   * unsupported).
   */
  const sourceGains = (): readonly number[] => {
    const source = liveFrame()?.vcbg ?? resolvedEqParam('gebg') ?? []
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

  // — The hand: pointer + keyboard → smoother → per-tick live edits.
  // Smoothing is UI-only; wire and engine always carry the smoothed,
  // clamped 20-band `gebg`, whatever the kernel pref.
  const smoother = new GainSmoother(smootherKernel())
  /** The last batch emitted or absorbed — own applies never rehydrate. */
  let lastGains: readonly number[] | null = null
  /** The held touch, re-enqueued per tick; `null` between drags. */
  let held: EditorTouch | null = null
  let capturedPointer: number | null = null
  let tickRequest: number | undefined
  const [dragging, setDragging] = createSignal(false)
  const [activeSlider, setActiveSlider] = createSignal<number | null>(null)

  /**
   * Resolves a pointer position: x → the nearest visible Slider, splat
   * center = round of its fractional index (the original's mobile
   * formula generalized — centers {0, 5, 10, 14, 19} at N = 5); y → dB
   * via the padded mapping, clamped. Capture + clamp: dragging past
   * the edge holds the clamp (deliberate deviation from the original's
   * ignore-outside).
   */
  const resolveTouch = (event: PointerEvent): EditorTouch | null => {
    const { width, height } = field()
    const bands = bandCount()
    if (width <= 0 || height <= 0 || bands === 0) return null
    const pad = thumbHeight() / 4
    const usable = height - 2 * pad
    if (usable <= 0) return null
    const rect = slidersEl.getBoundingClientRect()
    const index = (event.clientX - rect.left) / (width / bands) - 0.5
    const step = sliderStep()
    const slider = Math.min(
      sliderCount() - 1,
      Math.max(0, step > 0 ? Math.round(index / step) : 0),
    )
    const dB = clampDb(
      ((height - pad - (event.clientY - rect.top)) * WINDOW_DB) / usable +
        EDIT_MIN_DB,
    )
    return { slider, band: Math.round(sliderIndex(slider)), dB }
  }

  /**
   * Queues one touch. The reference gain follows the source rule:
   * sourcing `vcbg` → the band's composed value rebases the touch so
   * the painted Brush-buffer value plus the non-GEQ contribution
   * lands where the finger points; sourcing resolved state → the raw
   * path (the original's suspended branch).
   */
  const queueTouch = ({ band, dB }: EditorTouch): void => {
    const frame = liveFrame()
    if (frame) {
      smoother.enqueue(
        band,
        dB,
        rawToDisplay(frame.vcbg[band] ?? 0, DB_FRAC_BITS),
      )
    } else {
      smoother.enqueue(band, dB)
    }
  }

  /**
   * Routes one emitted batch as an optimistic live edit (Slice 15's
   * model): `edit_eq_preset` when a preset is active on the current
   * profile, else `edit_profile`. `lastGains` lands before the apply —
   * the rehydrate effect fires synchronously inside it.
   */
  const send = (batch: Int16Array): void => {
    const preset = selectedEqPreset()
    const profile = selectedProfile()
    if (!preset && !profile) return
    const gains = Array.from(batch)
    lastGains = gains
    const params: Record<string, readonly number[]> = { gebg: gains }
    // `geon` auto-on (the original's): any gain ≠ 0 while the resolved
    // filterbank is bypassed flips it in the same batch — atomic,
    // routed with the gains; factory state ships geon = 0, and without
    // this a first-ever drag moves the curve but not the sound. The
    // optimistic apply flips the resolution, so it lands once. Never
    // auto-off.
    if (
      (resolvedEqParam('geon')?.[0] ?? 0) === 0 &&
      gains.some((gain) => gain !== 0)
    ) {
      params['geon'] = [1]
    }
    if (preset) editEqPresetLive(preset.id, params)
    else if (profile) editProfileLive(profile.id, params)
  }

  /** One smoothing pass per display frame while input is live. */
  const pump = (now: number): void => {
    tickRequest = undefined
    // The hold: a still pointer re-enqueues its (band, dB) every tick —
    // keeps the decay converging, the original's hold behavior.
    if (held) queueTouch(held)
    const emitted = smoother.tick(now)
    if (emitted) send(emitted)
    if (held !== null || !smoother.settled()) {
      tickRequest = requestAnimationFrame(pump)
    }
  }

  // User input starts the loop; `!settled()` keeps it alive (the
  // post-drag decay). Rehydration alone never starts it — a preset
  // switch parks out-of-window brush cells, and decaying them with no
  // input would rewrite the stored curve (issue #25 comment).
  const startTicking = (): void => {
    tickRequest ??= requestAnimationFrame(pump)
  }

  const onPointerDown = (event: PointerEvent): void => {
    // One primary pointer paints; a second finger or button waits.
    if (capturedPointer !== null || event.button !== 0) return
    const touch = resolveTouch(event)
    if (!touch) return
    slidersEl.setPointerCapture(event.pointerId)
    capturedPointer = event.pointerId
    batch(() => {
      setDragging(true)
      setActiveSlider(touch.slider)
    })
    held = touch
    queueTouch(touch)
    startTicking()
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== capturedPointer) return
    const touch = resolveTouch(event)
    if (!touch) return
    setActiveSlider(touch.slider)
    held = touch
    queueTouch(touch)
  }

  /** Up or cancel: state drops; the loop parks itself once settled. */
  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== capturedPointer) return
    capturedPointer = null
    held = null
    batch(() => {
      setDragging(false)
      setActiveSlider(null)
    })
  }

  /**
   * Arrows ±1 dB through a touch's pipeline. The step rides the splat
   * band's rendered gain, not the thumb's interpolated display value —
   * an interpolated base converges geometrically on fractional sliders
   * and could never walk the window.
   */
  const onSliderKey = (slider: number, event: KeyboardEvent): void => {
    const delta =
      event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? -1
          : 0
    if (delta === 0) return
    event.preventDefault()
    const band = Math.round(sliderIndex(slider))
    const gain = rawToDisplay(sourceGains()[band] ?? 0, DB_FRAC_BITS)
    queueTouch({ slider, band, dB: clampDb(gain + delta) })
    startTicking()
  }

  // The one drag-state modifier skins reveal on (ADR-0011), published
  // on the visualizer root the editor rides in (ADR-0008's tree).
  createEffect(() => {
    slidersEl
      .closest('.visualizer')
      ?.classList.toggle('visualizer--eq-drag', dragging())
  })

  // Rehydrate (CONTEXT.md): whenever the resolved active `gebg`
  // changes by any path other than the smoother's own emit —
  // preset/profile switch, external `state` broadcasts, error
  // reconcile — rebuild the Brush buffer so the convolution reproduces
  // the new curve and the next stroke continues it. Own optimistic
  // applies land exactly `lastGains` and skip.
  createEffect(
    on(
      () => (resolvedEqParam('gebg') ?? []).slice(0, WIRE_BANDS),
      (gains) => {
        const last = lastGains
        if (gains.length === 0) return
        if (
          last !== null &&
          gains.length === last.length &&
          gains.every((gain, band) => gain === last[band])
        ) {
          return
        }
        smoother.rehydrate(gains)
        lastGains = gains
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
    if (tickRequest !== undefined) cancelAnimationFrame(tickRequest)
  })

  return (
    <>
      <div
        class="eq-sliders"
        ref={slidersEl}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <Index each={Array.from({ length: sliderCount() })}>
          {(_slot, i) => (
            <div
              class="eq-slider"
              classList={{ 'eq-slider--active': activeSlider() === i }}
              role="slider"
              tabindex="0"
              aria-orientation="vertical"
              aria-valuemin={EDIT_MIN_DB}
              aria-valuemax={EDIT_MAX_DB}
              aria-label={`${String(
                bandFreqs()[Math.round(sliderIndex(i))] ?? 0,
              )} Hz`}
              onKeyDown={(event) => {
                onSliderKey(i, event)
              }}
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
