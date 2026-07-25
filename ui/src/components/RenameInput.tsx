import { onMount, type Component } from 'solid-js'
import './RenameInput.css'

/**
 * The inline rename field (issue #26), swapped in over the selected
 * item's label: Enter and blur commit the trimmed name through the
 * caller's `edit_*` patch; Esc cancels. An unchanged or
 * empty-after-trim value is a cancel too — the daemon would reject
 * empty names, and names are labels, so a no-op send buys nothing.
 * Exactly one outcome fires (a commit's unmount must not blur-fire a
 * second).
 */
const RenameInput: Component<{
  /** The accessible name: "Profile name" | "EQ preset name". */
  label: string
  /** The current display name — prefilled, selected whole. */
  name: string
  /** The caller's layout hook (`profile-tabs__rename`, …). */
  class: string
  onCommit: (name: string) => void
  onCancel: () => void
}> = (props) => {
  let field!: HTMLInputElement
  let done = false
  const finish = (commit: boolean) => {
    if (done) return
    done = true
    const trimmed = field.value.trim()
    if (commit && trimmed !== '' && trimmed !== props.name) {
      props.onCommit(trimmed)
    } else {
      props.onCancel()
    }
  }
  onMount(() => {
    field.focus()
    field.select()
  })
  return (
    <input
      ref={field}
      type="text"
      class={`rename-input ${props.class}`}
      aria-label={props.label}
      value={props.name}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') finish(false)
      }}
      onBlur={() => {
        finish(true)
      }}
    />
  )
}

export default RenameInput
