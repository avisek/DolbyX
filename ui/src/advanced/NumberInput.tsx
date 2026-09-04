// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The one numeric box every number in the panel uses — scalars, band
 * cells, read-only readouts. The real `<input>` fills the wrapper edge
 * to edge; the unit is an inert overlay (`pointer-events: none`) the
 * field reserves padding for — no label hack, the unit never
 * selectable. Typing commits INSTANTLY: every `input` event whose text
 * is a complete number inside [min, max] is a live optimistic write;
 * partials ("-", "1.") and out-of-range text are ignored until blur,
 * which clamps + commits and normalizes the text to store truth. The
 * field is uncontrolled while focused (store updates never clobber
 * typing) and mirrors the store otherwise.
 *
 * `scrub` adds the vertical pointer-lock scrub (scalars only — bands
 * paint instead): pointerdown arms; > 3 px of vertical movement
 * engages `requestPointerLock`, then every 4 css px steps one `coarse`
 * display unit (Shift = one `fine` step — rebased on flip so the value
 * never jumps); release exits the lock and commits. Locked `movementY`
 * arrives in device px, so deltas divide by `devicePixelRatio`
 * (DPI-agnostic; the rare no-lock fallback under-scales on hiDPI).
 * Clamp re-baselining: pinning at a bound resets the accumulator, so
 * reversal bites immediately. A plain click falls through to typing.
 */
import { Show, createEffect, createSignal, on, type Component } from 'solid-js'

const ENGAGE_PX = 3
const PX_PER_STEP = 4

/** A complete number — rejects the partials typing passes through. */
const NUMBER = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/

const NumberInput: Component<{
  id: string
  /** Accessible name. */
  name: string
  value: () => number
  min: number
  max: number
  /** Display units per scrub step. */
  coarse?: number | undefined
  /** Display units per Shift-scrub step (one raw unit). */
  fine?: number | undefined
  unit: string
  readOnly?: boolean | undefined
  scrub?: boolean | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit?: ((value: number) => void) | undefined
}> = (props) => {
  let input!: HTMLInputElement
  const [scrubbing, setScrubbing] = createSignal(false)
  const scrub = props.scrub === true && props.readOnly !== true

  const round = (value: number): number => Number(value.toFixed(4))
  const clamp = (value: number): number =>
    round(Math.min(props.max, Math.max(props.min, value)))
  const live = (value: number): void => {
    ;(props.onLive ?? props.onCommit)?.(value)
  }

  /** The field's text as a complete number, else undefined. */
  const parsed = (): number | undefined => {
    const text = input.value.trim()
    return NUMBER.test(text) ? Number(text) : undefined
  }

  // Mirror the store whenever the field isn't being typed in (a scrub
  // blurs the field first, so live steps flow through here too).
  createEffect(
    on(props.value, (value) => {
      if (document.activeElement !== input) input.value = String(value)
    }),
  )

  // — Scrub state —
  let armed = false
  let scrubbed = false
  let startY = 0
  let base = 0
  let accum = 0
  let fineMode = false
  let last: number | undefined

  const endScrub = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!armed) return
    armed = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (!scrubbing()) return
    setScrubbing(false)
    document.exitPointerLock()
    if (last !== undefined) props.onCommit?.(last)
  }

  return (
    <span
      class="adv-input"
      classList={{
        'adv-input--scrub': scrub,
        'adv-input--scrubbing': scrubbing(),
      }}
      onPointerDown={(event) => {
        if (!scrub || event.button !== 0) return
        armed = true
        startY = event.clientY
        base = props.value()
        accum = 0
        last = undefined
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!armed) return
        if (!scrubbing()) {
          // Typing still works: lock only engages past the threshold.
          if (Math.abs(event.clientY - startY) < ENGAGE_PX) return
          setScrubbing(true)
          scrubbed = true
          fineMode = event.shiftKey
          input.blur()
          // Best-effort lock: Chromium refuses it e.g. while the
          // window lacks focus — movementY still scrubs without it.
          try {
            const lock = event.currentTarget.requestPointerLock() as unknown
            if (lock instanceof Promise) lock.catch(() => undefined)
          } catch {
            // Refused — scrub on without the lock.
          }
          return
        }
        if (event.shiftKey !== fineMode) {
          // Rebase on Shift flips so the value never jumps.
          fineMode = event.shiftKey
          base = last ?? base
          accum = 0
        }
        // Up = increase; device px → css px via devicePixelRatio.
        accum -= event.movementY / devicePixelRatio
        const step = fineMode ? (props.fine ?? 1) : (props.coarse ?? 1)
        const candidate = base + Math.trunc(accum / PX_PER_STEP) * step
        const value = clamp(candidate)
        if (value !== round(candidate)) {
          // Pinned at a bound — rebase so reversal bites immediately.
          base = value
          accum = 0
        }
        if (value !== last) {
          last = value
          live(value)
        }
        event.preventDefault()
      }}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
      onClick={(event) => {
        // Post-scrub click: keep the field out of text editing (and
        // block the card label's focus forwarding).
        if (scrubbed) {
          scrubbed = false
          event.preventDefault()
          input.blur()
        }
      }}
    >
      <input
        ref={input}
        id={props.id}
        class="adv-input__field"
        type="text"
        inputmode="decimal"
        aria-label={props.name}
        readonly={props.readOnly === true}
        onInput={() => {
          const value = parsed()
          if (value === undefined || value < props.min || value > props.max) {
            return
          }
          live(round(value))
        }}
        onBlur={() => {
          const value = parsed()
          if (value !== undefined) {
            const clamped = clamp(value)
            if (clamped !== props.value()) props.onCommit?.(clamped)
          }
          input.value = String(props.value())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') input.blur()
          else if (event.key === 'Escape') {
            input.value = String(props.value())
            input.blur()
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
