// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The scrub-or-type numeric input every number in the panel uses. The
 * wrapper is a LABEL, so the entire bordered box — unit suffix included
 * — focuses the input: no dead zones. Pointer-lock scrub is VERTICAL
 * (up = increase) and DPI-agnostic: locked `movementY` arrives in
 * unscaled device px, so deltas divide by `devicePixelRatio` to keep
 * physical distance per step stable across displays (the rare no-lock
 * fallback under-scales on hiDPI — accepted rough edge). pointerdown
 * arms; > 3 px of vertical movement engages `requestPointerLock`, then
 * every 4 css px steps one `coarse` display unit (Shift = one `fine`
 * step — rebased on flip so the value never jumps); release exits the
 * lock and commits. A plain click falls through to normal text editing.
 * Clamp re-baselining: pinning at min/max resets the accumulator to the
 * bound, so reversing direction responds immediately — no dead travel.
 * Rough: Esc mid-scrub just drops the lock; captured pointermoves keep
 * applying (with jumpy movementY) until release.
 */
import { Show, createSignal, type Component } from 'solid-js'

const ENGAGE_PX = 3
const PX_PER_STEP = 4

const ScrubInput: Component<{
  label: string
  value: () => number
  min?: number | undefined
  max?: number | undefined
  /** Display units per scrub step. */
  coarse: number
  /** Display units per Shift-scrub step (one raw unit). */
  fine: number
  unit?: string | undefined
  title?: string | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit: (value: number) => void
}> = (props) => {
  let input!: HTMLInputElement
  const [scrubbing, setScrubbing] = createSignal(false)
  let armed = false
  let scrubbed = false
  let startY = 0
  let base = 0
  let accum = 0
  let fineMode = false
  let last: number | undefined

  const round = (value: number): number => Number(value.toFixed(4))

  const clamp = (value: number): number => {
    let clamped = value
    if (props.min !== undefined) clamped = Math.max(props.min, clamped)
    if (props.max !== undefined) clamped = Math.min(props.max, clamped)
    return round(clamped)
  }

  return (
    <label
      class="adv-input"
      classList={{ 'adv-input--scrubbing': scrubbing() }}
      title={props.title ?? ''}
      onPointerDown={(event) => {
        if (event.button !== 0) return
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
        const step = fineMode ? props.fine : props.coarse
        const candidate = base + Math.trunc(accum / PX_PER_STEP) * step
        const value = clamp(candidate)
        if (value !== round(candidate)) {
          // Pinned at a bound — rebase so reversal bites immediately.
          base = value
          accum = 0
        }
        if (value !== last) {
          last = value
          ;(props.onLive ?? props.onCommit)(value)
        }
        event.preventDefault()
      }}
      onPointerUp={(event) => {
        armed = false
        event.currentTarget.releasePointerCapture(event.pointerId)
        if (!scrubbing()) return
        setScrubbing(false)
        document.exitPointerLock()
        if (last !== undefined) props.onCommit(last)
      }}
      onClick={(event) => {
        // Post-scrub click: keep the field out of text editing (and
        // block the label's own focus forwarding).
        if (scrubbed) {
          scrubbed = false
          event.preventDefault()
          input.blur()
        }
      }}
    >
      <input
        ref={input}
        class="adv-input__field"
        type="text"
        inputmode="decimal"
        aria-label={props.label}
        value={String(props.value())}
        onChange={(event) => {
          const value = Number.parseFloat(event.currentTarget.value)
          if (Number.isNaN(value)) {
            event.currentTarget.value = String(props.value())
            return
          }
          props.onCommit(clamp(value))
          // Snap the field back to store truth (ack-then-apply paths
          // update it when the ack lands).
          event.currentTarget.value = String(props.value())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      <Show when={props.unit !== undefined && props.unit !== ''}>
        <span class="adv-input__unit">{props.unit}</span>
      </Show>
    </label>
  )
}

export default ScrubInput
