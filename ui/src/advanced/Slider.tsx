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
 * near the middle. Keys follow the shared step rule (`step.ts`):
 * arrows = one step (linear: 1 display unit; log: a semitone), Alt =
 * fine, Shift = coarse, PageUp/Down = the coarse step regardless;
 * Home/End = bounds. Falls back to linear when the range isn't
 * strictly positive.
 *
 * `disabled` (read-only scalars keep a slider for consistency):
 * `aria-disabled`, out of the tab order, every gesture ignored — the
 * `adv-slider--disabled` modifier is the skin's cue to mute it.
 */
import type { Component } from 'solid-js'
import { isLog, quantize, stepped, type Modifiers, type StepAxis } from './step'

const COARSE: Modifiers = { altKey: false, shiftKey: true }

const Slider: Component<{
  /** Accessible name. */
  name: string
  value: () => number
  min: number
  max: number
  /** One raw unit in display units (the step lattice). */
  fine: number
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
  const axis = (): StepAxis => ({
    min: props.min,
    max: props.max,
    fine: props.fine,
    scale: props.scale,
  })
  const log = isLog(axis())
  const span = (): number => props.max - props.min || 1

  /** Value → 0–1 track position. */
  const toNorm = (value: number): number =>
    log
      ? Math.log(value / props.min) / Math.log(props.max / props.min)
      : (value - props.min) / span()

  /** 0–1 track position → lattice value. */
  const fromNorm = (norm: number): number =>
    quantize(
      axis(),
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

  const nudge = (direction: 1 | -1, mods: Modifiers): void => {
    commit(stepped(axis(), props.value(), direction, mods))
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
      onKeyDown={(event) => {
        if (disabled) return
        const key = event.key
        if (key === 'ArrowUp' || key === 'ArrowRight') nudge(1, event)
        else if (key === 'ArrowDown' || key === 'ArrowLeft') nudge(-1, event)
        else if (key === 'PageUp') nudge(1, COARSE)
        else if (key === 'PageDown') nudge(-1, COARSE)
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
