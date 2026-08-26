// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The custom slider replacing native `input[type=range]` everywhere:
 * `role="slider"` + tabindex + aria-value*, arrow-key steps (fine =
 * one raw unit; PageUp/Down = coarse; Home/End = bounds), pointer drag
 * mapping absolute x → value. Publishes `--value` (display units) and
 * `--norm` (0–1); the skin paints track / fill / thumb entirely in
 * CSS. Drag = optimistic live per step, commit on release (the panel's
 * shared write discipline).
 */
import type { Component } from 'solid-js'

const Slider: Component<{
  label: string
  value: () => number
  min: number
  max: number
  /** Display units per arrow step (one raw unit). */
  fine: number
  /** Display units per PageUp/Down step. */
  coarse: number
  unit?: string | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit: (value: number) => void
}> = (props) => {
  let root!: HTMLDivElement
  let dragging = false
  let last: number | undefined

  const span = (): number => props.max - props.min || 1

  const clamp = (value: number): number =>
    Math.min(props.max, Math.max(props.min, Number(value.toFixed(4))))

  /** Absolute pointer x → fine-quantized value. */
  const fromEvent = (event: PointerEvent): number => {
    const rect = root.getBoundingClientRect()
    const frac = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / (rect.width || 1)),
    )
    return clamp(
      props.min + Math.round((frac * span()) / props.fine) * props.fine,
    )
  }

  const nudge = (delta: number): void => {
    props.onCommit(clamp(props.value() + delta))
  }

  return (
    <div
      ref={root}
      class="adv-slider"
      role="slider"
      tabindex="0"
      aria-label={props.label}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value()}
      aria-valuetext={
        props.unit === undefined || props.unit === ''
          ? undefined
          : `${String(props.value())} ${props.unit}`
      }
      style={{
        '--value': String(props.value()),
        '--norm': String((props.value() - props.min) / span()),
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        root.setPointerCapture(event.pointerId)
        root.focus()
        dragging = true
        last = fromEvent(event)
        ;(props.onLive ?? props.onCommit)(last)
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        const value = fromEvent(event)
        if (value !== last) {
          last = value
          ;(props.onLive ?? props.onCommit)(value)
        }
      }}
      onPointerUp={(event) => {
        if (!dragging) return
        dragging = false
        root.releasePointerCapture(event.pointerId)
        if (last !== undefined) props.onCommit(last)
      }}
      onKeyDown={(event) => {
        const key = event.key
        if (key === 'ArrowUp' || key === 'ArrowRight') nudge(props.fine)
        else if (key === 'ArrowDown' || key === 'ArrowLeft') nudge(-props.fine)
        else if (key === 'PageUp') nudge(props.coarse)
        else if (key === 'PageDown') nudge(-props.coarse)
        else if (key === 'Home') props.onCommit(props.min)
        else if (key === 'End') props.onCommit(props.max)
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
