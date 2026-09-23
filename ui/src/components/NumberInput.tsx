import {
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  type Component,
} from 'solid-js'
import { ENGAGE_PX } from '../lib/gesture'
import {
  clampTo,
  stepMode,
  stepped,
  type StepAxis,
  type StepMode,
} from '../lib/step'

/** A complete number — rejects the partials typing passes through. */
const NUMBER = /^[-+]?(\d+(\.\d+)?|\.\d+)$/
/** Css px of travel per step while scrubbing. */
const PX_PER_STEP = 4

/**
 * The one numeric box (#87), a shared control: the engine follows *as
 * you type*. Every complete number is a live write clamped to
 * `[min, max]` while the text stays as typed; blur / Enter commits if
 * it differs from store truth and re-syncs the text; Esc reverts.
 * ↑ / ↓ step what the box shows by the Step rule (`axis`; Alt / Shift
 * from the event), write it live, and leave the re-synced
 * text selected so the next keystroke replaces it. Uncontrolled while
 * focused, mirroring the store otherwise (read-only always). Display
 * units in and out — the caller converts.
 *
 * `scrub` (#88) adds the Scrub: a press on the box arms; past
 * `ENGAGE_PX` of vertical travel the pointer locks and every
 * `PX_PER_STEP` css px is one Step-rule step under the modifiers held
 * at that moment (up = +), written live; release exits the lock and
 * commits. The box stays focused with its text selected throughout —
 * the selected text is the gesture's live display. A plain click falls
 * through to typing.
 */
const NumberInput: Component<{
  id: string
  /** Accessible name. */
  name: string
  /** Store truth, display units. */
  value: () => number
  /** Range, lattice, and scale — the Step rule's axis, display units. */
  axis: StepAxis
  /** The kind's unit label — empty renders no overlay. */
  unit: string
  readOnly?: boolean | undefined
  /** Opts a writable box into the Scrub; publishes `adv-input--scrub`. */
  scrub?: boolean | undefined
  /** Roving-tabindex members (band editors) pass -1. */
  tabIndex?: number | undefined
  /** The field element, for composites that focus it programmatically. */
  ref?: ((input: HTMLInputElement) => void) | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit?: ((value: number) => void) | undefined
}> = (props) => {
  let input!: HTMLInputElement
  let wrapper!: HTMLSpanElement
  const editable = () => props.readOnly !== true
  const scrub = () => props.scrub === true && editable()
  const clamp = (value: number): number => clampTo(props.axis, value)

  /** The field's text as a complete number, else undefined. */
  const parsed = (): number | undefined => {
    const text = input.value
    return NUMBER.test(text) ? Number(text) : undefined
  }

  /** Re-syncs the text to store truth. */
  const sync = (): void => {
    input.value = String(props.value())
  }

  // Mirror the store whenever the field isn't being typed in.
  createEffect(
    on(
      () => props.value(),
      () => {
        if (!editable() || document.activeElement !== input) sync()
      },
    ),
  )

  // — The Scrub (#88): a state machine over one press —
  // armed (pressed, not yet moved ENGAGE_PX) → scrubbing (locked,
  // tracked on the window) → released. Chromium fires `pointercancel`
  // and drops pointer capture the instant the lock engages, so the
  // wrapper's own listeners can't carry the gesture: from engage on,
  // capture-phase window listeners track it, locked or not.
  const [scrubbing, setScrubbing] = createSignal(false)
  let armed = false
  /** A scrub just ended: the compat `click` behind it re-selects
   * instead of placing a caret. */
  let clickPending = false
  let startY = 0
  /** The value `accum` steps from. */
  let base = 0
  /** Css px of upward travel since the last rebase. */
  let accum = 0
  let mode: StepMode = 'base'
  /** The last value the gesture wrote. */
  let last: number | undefined

  /** The field as the gesture's live display: focused, fully selected. */
  const holdSelected = (): void => {
    input.focus()
    input.select()
  }

  /** After a live write: the store's (synchronously applied) truth,
   * selected, ready to be typed over. */
  const showSynced = (): void => {
    sync()
    input.select()
  }

  /** One tracked movement sample → possibly one live step. Locked
   * `movementY` is device px; unlocked (the lock refused) css px. */
  const track = (event: PointerEvent): void => {
    if (stepMode(event) !== mode) {
      // A modifier flip rebases: the new step size counts from the
      // last value written, so the value never jumps.
      mode = stepMode(event)
      base = last ?? base
      accum = 0
    }
    const locked = document.pointerLockElement === wrapper
    // Up = increase.
    accum -= locked ? event.movementY / devicePixelRatio : event.movementY
    const steps = Math.trunc(accum / PX_PER_STEP)
    const value = stepped(props.axis, base, steps, event)
    if (
      (steps > 0 && value === props.axis.max) ||
      (steps < 0 && value === props.axis.min)
    ) {
      // Pinned at a bound: rebase to it, so reversing bites within one
      // step instead of unwinding dead travel.
      base = value
      accum = 0
    }
    if (value !== last) {
      last = value
      props.onLive?.(value)
      showSynced()
    }
    event.preventDefault()
  }

  /** Stops following the pointer; releases the lock if held. */
  const detach = (): void => {
    window.removeEventListener('pointermove', track, true)
    window.removeEventListener('pointerup', endScrub, true)
    window.removeEventListener('blur', endScrub)
    setScrubbing(false)
    if (document.pointerLockElement === wrapper) document.exitPointerLock()
  }
  // Unmounted mid-gesture: abandon it — the live writes already landed.
  onCleanup(detach)

  const endScrub = (): void => {
    detach()
    if (last !== undefined) props.onCommit?.(last)
    // The lock's exit and the compat mouseup both disturb focus and
    // selection — re-assert.
    holdSelected()
  }

  /** A not-yet-engaged press released or cancelled: a plain click. */
  const disarm = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!armed) return
    armed = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /** Past the threshold: lock the pointer, follow it on the window. */
  const engage = (event: PointerEvent): void => {
    armed = false
    clickPending = true
    mode = stepMode(event)
    setScrubbing(true)
    holdSelected()
    window.addEventListener('pointermove', track, true)
    window.addEventListener('pointerup', endScrub, true)
    // Losing the window mid-gesture would strand the lock: end it.
    window.addEventListener('blur', endScrub)
    // Best-effort: Chromium refuses the lock e.g. while the window
    // lacks focus — synchronously or through the returned promise —
    // and the gesture scrubs on unlocked deltas instead.
    try {
      // Typed `Promise<void>`; older engines return nothing — guard.
      const lock = wrapper.requestPointerLock() as unknown
      if (lock instanceof Promise) lock.catch(() => undefined)
    } catch {
      // Refused — unlocked scrub.
    }
  }

  return (
    <span
      ref={wrapper}
      class="adv-input"
      classList={{
        'adv-input--scrub': scrub(),
        'adv-input--scrubbing': scrubbing(),
      }}
      // Arm only — no preventDefault, so a click still focuses the
      // field for typing.
      onPointerDown={(event) => {
        if (!scrub() || event.button !== 0 || scrubbing()) return
        armed = true
        startY = event.clientY
        base = props.value()
        accum = 0
        last = undefined
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!armed || Math.abs(event.clientY - startY) < ENGAGE_PX) return
        engage(event)
      }}
      onPointerUp={disarm}
      onPointerCancel={disarm}
      onClick={() => {
        if (!clickPending) return
        clickPending = false
        input.select()
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
        inputmode="decimal"
        aria-label={props.name}
        readonly={!editable()}
        tabindex={props.tabIndex}
        // Selected text must never start a drag — the scrub (#88)
        // depends on it.
        onDragStart={(event) => {
          event.preventDefault()
        }}
        onInput={() => {
          // Instant, clamped: the text stays as typed.
          const value = parsed()
          if (value !== undefined) props.onLive?.(clamp(value))
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
          } else if (editable() && (key === 'ArrowUp' || key === 'ArrowDown')) {
            // From what the box shows — typed text counts — live; then
            // the store's (optimistically applied) truth, selected.
            const shown = clamp(parsed() ?? props.value())
            props.onLive?.(
              stepped(props.axis, shown, key === 'ArrowUp' ? 1 : -1, event),
            )
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
