import type { Component } from 'solid-js'

/**
 * A shared switch (#86): a native checkbox with `role=switch`, so Space
 * flips it natively and the skin paints it via `:checked` (ADR-0011). Commits are ack-then-apply: the click cancels the
 * native flip and hands the intended state to `onToggle`; `checked`
 * follows the store once the ack applies it. Consumed by the Advanced
 * panel and, later, the Master controls (#93) — never Advanced-private.
 */
const Toggle: Component<{
  id: string
  /** Accessible name. */
  name: string
  checked: boolean
  /** Called with the state the click asks for; the ack lands it. */
  onToggle: (checked: boolean) => void
}> = (props) => (
  <input
    type="checkbox"
    role="switch"
    id={props.id}
    class="adv-toggle"
    aria-label={props.name}
    checked={props.checked}
    onClick={(event) => {
      event.preventDefault()
      props.onToggle(!props.checked)
    }}
  />
)

export default Toggle
