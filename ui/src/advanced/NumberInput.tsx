// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The one numeric box every number in the panel uses — scalars, band
 * editors, read-only readouts. The real `<input>` fills the wrapper edge
 * to edge; the unit is an inert overlay (`pointer-events: none`) the
 * field reserves padding for — no label hack, the unit never
 * selectable. Typing commits INSTANTLY, no debounce: every `input`
 * event whose text is a complete number is a live optimistic write of
 * that number CLAMPED to [min, max] — the text stays exactly as typed
 * ("500" in a 0–10 box writes 10 and keeps reading "500"); blur or
 * Enter re-syncs the field to the committed value. Partials ("-",
 * "1.") are ignored. The field is uncontrolled while focused (store
 * updates never clobber typing) and mirrors the store otherwise
 * (read-only fields always — live arrays keep ticking in an open
 * editor).
 *
 * ↑ / ↓ step the value by the shared rule (`step.ts`: 1 display unit,
 * Alt 0.1×, Shift 10×; log axes multiplicative), write it live through
 * the typing path, and leave the text SELECTED so the next keystroke
 * replaces it.
 *
 * `scrub` adds the vertical pointer-lock scrub (scalars AND band cells
 * — a gesture that starts on the box is never a paint): pointerdown
 * arms; > 3 px of vertical movement engages `requestPointerLock`, then
 * every 4 css px is one step under the modifiers held at that moment
 * (rebased on every modifier flip so the value never jumps); release
 * exits the lock and commits. The box stays FOCUSED with its text
 * selected throughout and after release — the field is the value's
 * readout while scrubbing. Locked `movementY` arrives in device px, so
 * deltas divide by `devicePixelRatio`. Pinning at a bound resets the
 * accumulator, so reversal bites immediately. A plain click falls
 * through to typing.
 */
import { Show, createEffect, createSignal, on, type Component } from 'solid-js'
import { clampTo, stepped, type Modifiers, type StepAxis } from './step'

const ENGAGE_PX = 3
const PX_PER_STEP = 4

/** A complete number — rejects the partials typing passes through. */
const NUMBER = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/

/** Modifier combination key — a flip rebases the scrub. */
const modeOf = (mods: Modifiers): string =>
  mods.altKey ? 'alt' : mods.shiftKey ? 'shift' : 'base'

const NumberInput: Component<{
  id: string
  /** Accessible name. */
  name: string
  value: () => number
  min: number
  max: number
  /** One raw unit in display units (the step lattice). */
  fine?: number | undefined
  /** `log` for frequencies: multiplicative steps. */
  scale?: 'linear' | 'log' | undefined
  unit: string
  readOnly?: boolean | undefined
  scrub?: boolean | undefined
  /** Roving-tabindex members (band editors) pass -1. */
  tabIndex?: number | undefined
  /** The field element, for composites that focus it programmatically. */
  ref?: ((input: HTMLInputElement) => void) | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit?: ((value: number) => void) | undefined
}> = (props) => {
  let input!: HTMLInputElement
  const [scrubbing, setScrubbing] = createSignal(false)
  const editable = props.readOnly !== true
  const scrub = props.scrub === true && editable

  const axis = (): StepAxis => ({
    min: props.min,
    max: props.max,
    fine: props.fine ?? 1,
    scale: props.scale,
  })
  const clamp = (value: number): number => clampTo(axis(), value)
  const live = (value: number): void => {
    ;(props.onLive ?? props.onCommit)?.(value)
  }

  /** The field's text as a complete number, else undefined. */
  const parsed = (): number | undefined => {
    const text = input.value.trim()
    return NUMBER.test(text) ? Number(text) : undefined
  }

  /** Re-syncs the text to store truth. */
  const sync = (): void => {
    input.value = String(props.value())
  }

  /** After a stepped live write: the store's (synchronously applied)
   * truth, selected, ready to be typed over. */
  const showSynced = (): void => {
    sync()
    input.select()
  }

  // Mirror the store whenever the field isn't being typed in.
  createEffect(
    on(props.value, () => {
      if (!editable || document.activeElement !== input) sync()
    }),
  )

  // — Scrub state —
  let span!: HTMLSpanElement
  let armed = false
  let scrubbed = false
  let startY = 0
  let base = 0
  let accum = 0
  let mode = 'base'
  let last: number | undefined

  /** One locked / unlocked movement sample → a live step. */
  const track = (event: PointerEvent): void => {
    if (modeOf(event) !== mode) {
      // Rebase on a modifier flip so the value never jumps.
      mode = modeOf(event)
      base = last ?? base
      accum = 0
    }
    // Up = increase; device px → css px via devicePixelRatio.
    accum -= event.movementY / devicePixelRatio
    const steps = Math.trunc(accum / PX_PER_STEP)
    const value = stepped(axis(), base, steps, event)
    if (
      (steps > 0 && value === props.max) ||
      (steps < 0 && value === props.min)
    ) {
      // Pinned at a bound — rebase so reversal bites immediately.
      base = value
      accum = 0
    }
    if (value !== last) {
      last = value
      live(value)
      showSynced()
    }
    event.preventDefault()
  }

  const endScrub = (): void => {
    window.removeEventListener('pointermove', track, true)
    window.removeEventListener('pointerup', endScrub, true)
    window.removeEventListener('blur', endScrub)
    setScrubbing(false)
    if (document.pointerLockElement === span) document.exitPointerLock()
    if (last !== undefined) props.onCommit?.(last)
    // The lock's exit and the compat mouseup both like to disturb
    // focus / selection — reassert.
    input.focus()
    input.select()
  }

  /** Past the threshold: lock the pointer, follow it on the window.
   * Chromium fires `pointercancel` (and drops pointer capture) the
   * moment the lock engages, so the span's own capture can't carry
   * the gesture — window listeners do, locked or not. */
  const engage = (event: PointerEvent): void => {
    setScrubbing(true)
    scrubbed = true
    mode = modeOf(event)
    input.focus()
    input.select()
    window.addEventListener('pointermove', track, true)
    window.addEventListener('pointerup', endScrub, true)
    // Losing the window mid-gesture would strand the lock: end it.
    window.addEventListener('blur', endScrub)
    // Best-effort lock: Chromium refuses it e.g. while the window
    // lacks focus — movementY still scrubs without it.
    try {
      const lock = span.requestPointerLock() as unknown
      if (lock instanceof Promise) lock.catch(() => undefined)
    } catch {
      // Refused — scrub on without the lock.
    }
  }

  const disarm = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!armed) return
    armed = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <span
      ref={span}
      class="adv-input"
      classList={{
        'adv-input--scrub': scrub,
        'adv-input--scrubbing': scrubbing(),
      }}
      onPointerDown={(event) => {
        if (!scrub || event.button !== 0 || scrubbing()) return
        armed = true
        startY = event.clientY
        base = props.value()
        accum = 0
        last = undefined
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        // Pre-engage only: typing still works, the lock engages past
        // the threshold; from then on the window listeners track.
        if (!armed || scrubbing()) return
        if (Math.abs(event.clientY - startY) < ENGAGE_PX) return
        armed = false
        engage(event)
      }}
      onPointerUp={disarm}
      onPointerCancel={disarm}
      onClick={() => {
        // The compat click after a scrub: keep the readout selected.
        if (scrubbed) {
          scrubbed = false
          input.select()
        }
      }}
    >
      <input
        ref={(element) => {
          input = element
          props.ref?.(element)
        }}
        id={props.id}
        class="adv-input__field"
        type="text"
        onDragStart={(event) => event.preventDefault()}
        inputmode="decimal"
        aria-label={props.name}
        readonly={!editable}
        tabindex={props.tabIndex}
        onInput={() => {
          // Instant, clamped: the text stays as typed.
          const value = parsed()
          if (value !== undefined) live(clamp(value))
        }}
        onBlur={() => {
          const value = parsed()
          if (value !== undefined) {
            const clamped = clamp(value)
            if (clamped !== props.value()) props.onCommit?.(clamped)
          }
          sync()
        }}
        onKeyDown={(event) => {
          const key = event.key
          if (key === 'Enter') input.blur()
          else if (key === 'Escape') {
            sync()
            input.blur()
          } else if (editable && (key === 'ArrowUp' || key === 'ArrowDown')) {
            // Step from what the field shows (typed text counts), live.
            const current = clamp(parsed() ?? props.value())
            const next = stepped(
              axis(),
              current,
              key === 'ArrowUp' ? 1 : -1,
              event,
            )
            live(next)
            showSynced()
            event.preventDefault()
          }
        }}
      />
      <Show when={props.unit !== ''}>
        <span class="adv-input__unit" aria-hidden="true">
          {props.unit}
        </span>
      </Show>
    </span>
  )
}

export default NumberInput
