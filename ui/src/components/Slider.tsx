import type { Component } from 'solid-js'
import {
  fromNorm,
  stepped,
  toNorm,
  type Modifiers,
  type StepAxis,
} from '../lib/step'

/** PageUp / PageDown step as Shift does, whatever is held. */
const COARSE: Modifiers = { altKey: false, shiftKey: true }

/**
 * The Slider (#89), a shared control — the skinnable range control
 * after every numeric box; no native `input[type=range]` anywhere.
 * `role=slider` + `aria-value*`; publishes `--value` (display units)
 * and `--norm` (0–1 track position, log on a `log` axis; a value
 * outside the range reads outside 0–1 — the skin clamps) — the skin
 * paints track / fill / thumb from `--norm`, the component sets no
 * geometry.
 *
 * Keys follow the Step rule (`axis`; Alt / Shift from the event): ← ↓ / → ↑ one step, PageUp / PageDown the Shift step, Home /
 * End the bounds — each a live write, like the box's ↑ / ↓. Pointer:
 * a press captures, focuses the slider, and maps absolute x over the
 * track to a lattice value, live; moves follow; release commits the
 * last. The slider cancels its bubbling `click`, so a card `<label>`
 * never forwards it to the box. `disabled` (read-only scalars keep
 * one for a uniform column): `adv-slider--disabled`, `aria-disabled`,
 * out of the tab order, every gesture ignored, `--norm` still
 * published. Display units in and out — the caller converts.
 */
const Slider: Component<{
  /** Accessible name. */
  name: string
  /** Store truth, display units. */
  value: () => number
  /** Range, lattice, and scale — the Step rule's axis, display units;
   * `log` positions logarithmically. */
  axis: StepAxis
  /** The kind's unit label — `aria-valuetext` carries it; empty omits. */
  unit: string
  disabled?: boolean | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit?: ((value: number) => void) | undefined
}> = (props) => {
  let track!: HTMLSpanElement
  const disabled = () => props.disabled === true

  /** Absolute pointer x → lattice value over the track's box. */
  const valueAt = (event: PointerEvent): number => {
    const rect = track.getBoundingClientRect()
    const norm = (event.clientX - rect.left) / (rect.width || 1)
    return fromNorm(props.axis, Math.min(1, Math.max(0, norm)))
  }

  let dragging = false
  /** The last value the drag wrote. */
  let last: number | undefined

  const end = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!dragging) return
    dragging = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (last !== undefined) props.onCommit?.(last)
  }

  return (
    <div
      class="adv-slider"
      classList={{ 'adv-slider--disabled': disabled() }}
      role="slider"
      tabindex={disabled() ? -1 : 0}
      aria-label={props.name}
      aria-disabled={disabled() ? 'true' : undefined}
      aria-valuemin={props.axis.min}
      aria-valuemax={props.axis.max}
      aria-valuenow={props.value()}
      aria-valuetext={
        props.unit === '' ? undefined : `${String(props.value())} ${props.unit}`
      }
      style={{
        '--value': String(props.value()),
        '--norm': String(toNorm(props.axis, props.value())),
      }}
      onPointerDown={(event) => {
        if (disabled() || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.focus()
        dragging = true
        last = valueAt(event)
        props.onLive?.(last)
        // No compat mousedown: the focus and selection stay ours.
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        const value = valueAt(event)
        if (value !== last) {
          last = value
          props.onLive?.(value)
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      // A native listener, like the card's guard: the label's activation
      // behavior must see the cancel.
      on:click={(event) => {
        event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (disabled()) return
        const key = event.key
        const from = props.value()
        let next: number
        if (key === 'ArrowRight' || key === 'ArrowUp') {
          next = stepped(props.axis, from, 1, event)
        } else if (key === 'ArrowLeft' || key === 'ArrowDown') {
          next = stepped(props.axis, from, -1, event)
        } else if (key === 'PageUp') next = stepped(props.axis, from, 1, COARSE)
        else if (key === 'PageDown')
          next = stepped(props.axis, from, -1, COARSE)
        else if (key === 'Home') next = props.axis.min
        else if (key === 'End') next = props.axis.max
        else return
        props.onLive?.(next)
        event.preventDefault()
      }}
    >
      <span ref={track} class="adv-slider__track" aria-hidden="true">
        <span class="adv-slider__fill" />
        <span class="adv-slider__thumb" />
      </span>
    </div>
  )
}

export default Slider
