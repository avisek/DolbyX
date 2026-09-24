// PROTOTYPE — throwaway, do not review
import { For, Show, type Component } from 'solid-js'
import RenameInput from './RenameInput'

export interface PickerOption {
  readonly id: string | null
  readonly name: string
  readonly checked: boolean
  readonly factory: boolean
}

/**
 * The shared item picker behind the profile tabs and the EQ preset
 * picker: native radios (Tristate idiom — one Tab stop, Arrow keys
 * move natively, the click cancels the native check and asks the
 * store) with `label` pills, then four actions — Add / Rename / Delete
 * as empty buttons the skin captions, Reset as the Reset marker
 * (`disabled` while clean). Renaming swaps the checked pill for the
 * inline field. Zero appearance policy (ADR-0011).
 */
const Picker: Component<{
  kind: 'profile' | 'eq'
  /** Visible label: "Profile" | "EQ preset". */
  label: string
  /** Accessible-name qualifier: "profile" | "EQ preset". */
  noun: string
  options: readonly PickerOption[]
  onPick: (id: string | null) => void
  onAdd: () => void
  renameDisabled: boolean
  onRename: () => void
  deleteDisabled: boolean
  onDelete: () => void
  resetDisabled: boolean
  onReset: () => void
  renaming: boolean
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
}> = (props) => {
  const radioId = (id: string | null) =>
    `picker-${props.kind}-${id === null ? 'none' : encodeURIComponent(id)}`
  return (
    <div
      class="picker"
      classList={{
        'picker--profile': props.kind === 'profile',
        'picker--eq': props.kind === 'eq',
        'picker--diverged': !props.resetDisabled,
      }}
    >
      <span class="picker__label">{props.label}</span>
      <div class="picker__options" role="radiogroup" aria-label={props.label}>
        <For each={props.options}>
          {(option) => (
            <>
              <input
                type="radio"
                id={radioId(option.id)}
                class="picker__radio"
                name={`picker-${props.kind}`}
                checked={option.checked}
                onClick={(event) => {
                  event.preventDefault()
                  if (!option.checked) props.onPick(option.id)
                }}
              />
              <Show
                when={!(props.renaming && option.checked)}
                fallback={
                  <RenameInput
                    label={`${props.label} name`}
                    name={option.name}
                    class="picker__field"
                    onCommit={props.onRenameCommit}
                    onCancel={props.onRenameCancel}
                  />
                }
              >
                <label
                  class="picker__option"
                  classList={{ 'picker__option--factory': option.factory }}
                  for={radioId(option.id)}
                >
                  {option.name}
                </label>
              </Show>
            </>
          )}
        </For>
      </div>
      <div class="picker__actions">
        <button
          type="button"
          class="picker__add"
          aria-label={`Add ${props.noun}`}
          title={`Add ${props.noun}`}
          onClick={() => {
            props.onAdd()
          }}
        />
        <button
          type="button"
          class="picker__rename"
          aria-label={`Rename ${props.noun}`}
          title={`Rename ${props.noun}`}
          disabled={props.renameDisabled}
          onClick={() => {
            props.onRename()
          }}
        />
        <button
          type="button"
          class="picker__delete"
          aria-label={`Delete ${props.noun}`}
          title={`Delete ${props.noun}`}
          disabled={props.deleteDisabled}
          onClick={() => {
            props.onDelete()
          }}
        />
        <button
          type="button"
          class="picker__reset"
          aria-label={`Reset ${props.noun}`}
          title={`Reset ${props.noun}`}
          disabled={props.resetDisabled}
          onClick={() => {
            props.onReset()
          }}
        />
      </div>
    </div>
  )
}

export default Picker
