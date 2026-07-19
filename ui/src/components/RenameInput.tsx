import { type Component } from 'solid-js'

/**
 * The inline rename affordance ProfileTabs and EqPresetPicker share:
 * an input seeded with the current name — Enter or blur commits
 * (trimmed, non-empty, actually different), Escape cancels; either way
 * `onClose` ends the edit.
 */
const RenameInput: Component<{
  class?: string
  /** Accessible name, e.g. "Profile name". */
  label: string
  /** The current display name, seeded into the input. */
  value: string
  /** Called with the trimmed new name when it commits. */
  onRename: (name: string) => void
  /** Called when editing ends — committed or cancelled. */
  onClose: () => void
}> = (props) => {
  let closed = false
  const close = () => {
    closed = true
    props.onClose()
  }
  const commit = (input: HTMLInputElement) => {
    if (closed) return
    const name = input.value.trim()
    if (name && name !== props.value) props.onRename(name)
    close()
  }
  return (
    <input
      class={props.class}
      type="text"
      aria-label={props.label}
      value={props.value}
      ref={(input) => {
        queueMicrotask(() => {
          input.focus()
          input.select()
        })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget)
        else if (event.key === 'Escape') close()
      }}
      onBlur={(event) => {
        commit(event.currentTarget)
      }}
    />
  )
}

export default RenameInput
