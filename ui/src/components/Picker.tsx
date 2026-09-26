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
 * store) with `label` pills, then four plain action buttons — Add /
 * Rename / Delete / Reset — the skin captions (icon + text via
 * pseudo-elements); Rename / Delete / Reset `disabled` when they mean
 * nothing. Renaming keeps the checked pill in place (`--renaming`) and
 * mounts the inline field inside it, so the pill's width never moves.
 * Zero appearance policy (ADR-0011).
 */
const Picker: Component<{
  kind: 'profile' | 'eq'
  /** Visible label: "Profile" | "EQ Preset". */
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
          {(option) => {
            const renaming = () => props.renaming && option.checked
            return (
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
                <label
                  class="picker__option"
                  classList={{
                    'picker__option--factory': option.factory,
                    'picker__option--renaming': renaming(),
                  }}
                  for={radioId(option.id)}
                  // Native: a click landing in the rename field must not
                  // forward to the radio (which would steal its focus
                  // and blur-commit the rename).
                  on:click={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest('.picker__field')
                    ) {
                      event.preventDefault()
                    }
                  }}
                >
                  <span class="picker__name">{option.name}</span>
                  <Show when={renaming()}>
                    <RenameInput
                      label={`${props.label} name`}
                      name={option.name}
                      class="picker__field"
                      onCommit={props.onRenameCommit}
                      onCancel={props.onRenameCancel}
                    />
                  </Show>
                </label>
              </>
            )
          }}
        </For>
      </div>
      <div class="picker__actions">
        <button
          type="button"
          class="picker__action picker__add"
          aria-label={`Add ${props.noun}`}
          title={`Add ${props.noun}`}
          onClick={() => {
            props.onAdd()
          }}
        />
        <button
          type="button"
          class="picker__action picker__rename"
          aria-label={`Rename ${props.noun}`}
          title={`Rename ${props.noun}`}
          disabled={props.renameDisabled}
          onClick={() => {
            props.onRename()
          }}
        />
        <button
          type="button"
          class="picker__action picker__delete"
          aria-label={`Delete ${props.noun}`}
          title={`Delete ${props.noun}`}
          disabled={props.deleteDisabled}
          onClick={() => {
            props.onDelete()
          }}
        />
        <button
          type="button"
          class="picker__action picker__reset"
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
