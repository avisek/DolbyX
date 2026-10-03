import { Index, Show, type Component } from 'solid-js'
import { cardRule } from '../lib/card_rule'
import RenameInput from './RenameInput'

/** One pickable item — `id: null` is the EQ row's None. */
export interface PickerOption {
  readonly id: string | null
  readonly name: string
  readonly checked: boolean
  readonly factory: boolean
}

/** The four Picker actions on the checked item — omitted ⇒ none render. */
export interface PickerActions {
  readonly onAdd: () => void
  readonly renameDisabled: boolean
  readonly onRename: () => void
  readonly deleteDisabled: boolean
  readonly onDelete: () => void
  readonly resetDisabled: boolean
  readonly onReset: () => void
}

/** Renaming the checked item in place — omitted ⇒ no field ever mounts. */
export interface PickerRename {
  readonly renaming: boolean
  readonly onRenameCommit: (name: string) => void
  readonly onRenameCancel: () => void
}

/**
 * The shared Picker (#119, #137, CONTEXT.md): the one item chooser
 * behind the profile, EQ preset and Skin rows. A label, a native radio
 * group of pills (the Tristate idiom — one Tab stop, Arrow keys move
 * natively, the click cancels the native check and asks the store;
 * re-picking the checked one asks nothing). Editable items add two
 * optional groups, each rendering nothing when omitted. `actions`: the
 * four Picker actions — Add / Rename / Delete / Reset — rendered empty
 * and named by `aria-label`, glyphs from the skin (ADR-0011 addendum
 * 2); Rename / Delete / Reset `disabled` when they mean nothing.
 * `rename`: renaming keeps the checked pill in place (`--renaming`) and
 * mounts the field inside it beside the name — the skin swaps one for
 * the other; the label's card rule keeps a click in the field from
 * forwarding to the radio (which would steal its focus and
 * blur-commit). Options
 * render by position (`Index`): callers rebuild the array every
 * snapshot, and identity keying would recreate every radio — and drop
 * the one holding focus. Each radio's `value` is its item's id (`''`
 * for None) — the DOM's own statement of what a pill picks, which the
 * e2e skin loop reads. Modifiers: `--profile` / `--eq` / `--skin`
 * (the kind), `--diverged` (Reset means something).
 */
const Picker: Component<{
  kind: 'profile' | 'eq' | 'skin'
  /** Visible label: "Profile" | "EQ Preset" | "Skin". */
  label: string
  /** Accessible-name qualifier: "profile" | "EQ preset" | "skin". */
  noun: string
  options: readonly PickerOption[]
  onPick: (id: string | null) => void
  actions?: PickerActions
  rename?: PickerRename
}> = (props) => {
  const radioId = (id: string | null) =>
    `picker-${props.kind}-${id === null ? 'none' : encodeURIComponent(id)}`
  return (
    <div
      class="picker"
      classList={{
        'picker--profile': props.kind === 'profile',
        'picker--eq': props.kind === 'eq',
        'picker--skin': props.kind === 'skin',
        'picker--diverged': props.actions?.resetDisabled === false,
      }}
    >
      <span class="picker__label">{props.label}</span>
      <div class="picker__options" role="radiogroup" aria-label={props.label}>
        <Index each={props.options}>
          {(option) => {
            const renaming = () =>
              props.rename?.renaming === true && option().checked
            return (
              <>
                <input
                  type="radio"
                  id={radioId(option().id)}
                  class="picker__radio"
                  name={`picker-${props.kind}`}
                  value={option().id ?? ''}
                  checked={option().checked}
                  onClick={(event) => {
                    event.preventDefault()
                    if (!option().checked) props.onPick(option().id)
                  }}
                />
                <label
                  class="picker__option"
                  classList={{
                    'picker__option--factory': option().factory,
                    'picker__option--renaming': renaming(),
                  }}
                  for={radioId(option().id)}
                  on:click={cardRule('.picker__field')}
                >
                  <span class="picker__name">{option().name}</span>
                  <Show when={renaming() && props.rename}>
                    {(rename) => (
                      <RenameInput
                        label={`${props.label} name`}
                        name={option().name}
                        class="picker__field"
                        onCommit={rename().onRenameCommit}
                        onCancel={rename().onRenameCancel}
                      />
                    )}
                  </Show>
                </label>
              </>
            )
          }}
        </Index>
      </div>
      <Show when={props.actions}>
        {(actions) => (
          <div class="picker__actions">
            <button
              type="button"
              class="picker__action picker__add"
              aria-label={`Add ${props.noun}`}
              title={`Add ${props.noun}`}
              onClick={() => {
                actions().onAdd()
              }}
            />
            <button
              type="button"
              class="picker__action picker__rename"
              aria-label={`Rename ${props.noun}`}
              title={`Rename ${props.noun}`}
              disabled={actions().renameDisabled}
              onClick={() => {
                actions().onRename()
              }}
            />
            <button
              type="button"
              class="picker__action picker__delete"
              aria-label={`Delete ${props.noun}`}
              title={`Delete ${props.noun}`}
              disabled={actions().deleteDisabled}
              onClick={() => {
                actions().onDelete()
              }}
            />
            <button
              type="button"
              class="picker__action picker__reset"
              aria-label={`Reset ${props.noun}`}
              title={`Reset ${props.noun}`}
              disabled={actions().resetDisabled}
              onClick={() => {
                actions().onReset()
              }}
            />
          </div>
        )}
      </Show>
    </div>
  )
}

export default Picker
