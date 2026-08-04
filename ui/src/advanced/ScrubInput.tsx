// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The scrub-or-type numeric input every number in the panel uses. The
 * unit renders INSIDE the bordered box (suffix span). Pointer-lock
 * scrub: pointerdown arms; > 3 px of horizontal movement engages
 * `requestPointerLock`, then every 4 px of `movementX` steps one
 * `coarse` display unit (Shift = one `fine` step — rebased on flip so
 * the value never jumps); release exits the lock and commits. A plain
 * click (no drag) falls through to normal text editing. Rough: Esc
 * mid-scrub just drops the lock; the captured pointermoves keep
 * applying (with jumpy movementX) until release.
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
  compact?: boolean | undefined
  title?: string | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit: (value: number) => void
}> = (props) => {
  let input!: HTMLInputElement
  const [scrubbing, setScrubbing] = createSignal(false)
  let armed = false
  let scrubbed = false
  let startX = 0
  let base = 0
  let accum = 0
  let fineMode = false
  let last: number | undefined

  const clamp = (value: number): number => {
    let clamped = value
    if (props.min !== undefined) clamped = Math.max(props.min, clamped)
    if (props.max !== undefined) clamped = Math.min(props.max, clamped)
    return Number(clamped.toFixed(4))
  }

  return (
    <span
      class="adv-input"
      classList={{
        'adv-input--compact': props.compact === true,
        'adv-input--scrubbing': scrubbing(),
      }}
      title={props.title ?? ''}
    >
      <input
        ref={input}
        class="adv-input__field"
        type="text"
        inputmode="decimal"
        aria-label={props.label}
        value={String(props.value())}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          armed = true
          startX = event.clientX
          base = props.value()
          accum = 0
          last = undefined
          input.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!armed) return
          if (!scrubbing()) {
            // Typing still works: lock only engages past the threshold.
            if (Math.abs(event.clientX - startX) < ENGAGE_PX) return
            setScrubbing(true)
            scrubbed = true
            fineMode = event.shiftKey
            input.blur()
            // Best-effort lock: Chromium refuses it e.g. while the
            // window lacks focus — movementX still scrubs without it.
            try {
              const lock = input.requestPointerLock() as unknown
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
          accum += event.movementX
          const step = fineMode ? props.fine : props.coarse
          const value = clamp(base + Math.trunc(accum / PX_PER_STEP) * step)
          if (value !== last) {
            last = value
            ;(props.onLive ?? props.onCommit)(value)
          }
          event.preventDefault()
        }}
        onPointerUp={(event) => {
          armed = false
          input.releasePointerCapture(event.pointerId)
          if (!scrubbing()) return
          setScrubbing(false)
          document.exitPointerLock()
          if (last !== undefined) props.onCommit(last)
        }}
        onClick={() => {
          // Post-scrub click: keep the field out of text editing.
          if (scrubbed) {
            scrubbed = false
            input.blur()
          }
        }}
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
    </span>
  )
}

export default ScrubInput
