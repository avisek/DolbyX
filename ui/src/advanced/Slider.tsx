// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The custom slider replacing native `input[type=range]` everywhere:
 * `role="slider"` + tabindex + aria-value*, arrow-key steps, pointer
 * drag mapping absolute x → value. Publishes `--value` (display units)
 * and `--norm` (0–1 track position); the skin paints track / fill /
 * thumb entirely in CSS. Drag = optimistic live per step, commit on
 * release (the panel's shared write discipline).
 *
 * `scale` is kind-driven (`log` for FrequencyHz): the value ↔ position
 * map is logarithmic, so `--norm` is too — 20 Hz–20 kHz puts 1 kHz
 * near the middle. Keyboard on a log slider is multiplicative: arrows
 * = a semitone (×2^±1/12), PageUp/Down = an octave, always at least
 * one `fine` step; linear sliders step `fine` / `coarse`. Home/End =
 * bounds. Falls back to linear when the range isn't strictly positive.
 *
 * `disabled` (read-only scalars keep a slider for consistency):
 * `aria-disabled`, out of the tab order, every gesture ignored — the
 * `adv-slider--disabled` modifier is the skin's cue to mute it.
 *
 * Lives inside the card LABEL: a div with tabindex is not "interactive
 * content", so the label would forward its clicks to the card's text
 * field — `click` is cancelled here to keep focus on the slider.
 */
import type { Component } from 'solid-js'

const SEMITONE = 2 ** (1 / 12)

const Slider: Component<{
  /** Accessible name. */
  name: string
  value: () => number
  min: number
  max: number
  /** Display units per arrow step (one raw unit). */
  fine: number
  /** Display units per PageUp/Down step. */
  coarse: number
  unit: string
  scale?: 'linear' | 'log' | undefined
  disabled?: boolean | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit?: ((value: number) => void) | undefined
}> = (props) => {
  let root!: HTMLDivElement
  let dragging = false
  let last: number | undefined

  const disabled = props.disabled === true
  const log = props.scale === 'log' && props.min > 0 && props.max > props.min
  const span = (): number => props.max - props.min || 1

  const clamp = (value: number): number =>
    Math.min(props.max, Math.max(props.min, Number(value.toFixed(4))))
  /** Snaps to the `fine` lattice (one raw unit). */
  const quantize = (value: number): number =>
    clamp(Math.round(value / props.fine) * props.fine)

  /** Value → 0–1 track position. */
  const toNorm = (value: number): number =>
    log
      ? Math.log(value / props.min) / Math.log(props.max / props.min)
      : (value - props.min) / span()

  /** 0–1 track position → fine-quantized value. */
  const fromNorm = (norm: number): number =>
    quantize(
      log
        ? props.min * (props.max / props.min) ** norm
        : props.min + norm * span(),
    )

  const commit = (value: number): void => {
    props.onCommit?.(value)
  }
  const live = (value: number): void => {
    ;(props.onLive ?? props.onCommit)?.(value)
  }

  /** Absolute pointer x → value. */
  const fromEvent = (event: PointerEvent): number => {
    const rect = root.getBoundingClientRect()
    return fromNorm(
      Math.min(1, Math.max(0, (event.clientX - rect.left) / (rect.width || 1))),
    )
  }

  /** Linear: ± step. Log: × factor^±1, never less than one fine step. */
  const nudge = (direction: 1 | -1, coarse: boolean): void => {
    const value = props.value()
    let next: number
    if (log) {
      const factor = coarse ? 2 : SEMITONE
      next = quantize(direction > 0 ? value * factor : value / factor)
      if (next === value) next = quantize(value + direction * props.fine)
    } else {
      next = quantize(value + direction * (coarse ? props.coarse : props.fine))
    }
    commit(next)
  }

  const end = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    root.releasePointerCapture(event.pointerId)
    if (last !== undefined) commit(last)
  }

  return (
    <div
      ref={root}
      class="adv-slider"
      classList={{ 'adv-slider--disabled': disabled }}
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={props.name}
      aria-disabled={disabled ? 'true' : undefined}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value()}
      aria-valuetext={
        props.unit === '' ? undefined : `${String(props.value())} ${props.unit}`
      }
      style={{
        '--value': String(props.value()),
        '--norm': String(toNorm(props.value())),
      }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        root.setPointerCapture(event.pointerId)
        root.focus()
        dragging = true
        last = fromEvent(event)
        live(last)
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        const value = fromEvent(event)
        if (value !== last) {
          last = value
          live(value)
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(event) => {
        // Not interactive content: cancel the card label's forwarding.
        event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (disabled) return
        const key = event.key
        if (key === 'ArrowUp' || key === 'ArrowRight') nudge(1, false)
        else if (key === 'ArrowDown' || key === 'ArrowLeft') nudge(-1, false)
        else if (key === 'PageUp') nudge(1, true)
        else if (key === 'PageDown') nudge(-1, true)
        else if (key === 'Home') commit(props.min)
        else if (key === 'End') commit(props.max)
        else return
        event.preventDefault()
      }}
    >
      <span class="adv-slider__track" aria-hidden="true">
        <span class="adv-slider__fill" />
        <span class="adv-slider__thumb" />
      </span>
    </div>
  )
}

export default Slider
