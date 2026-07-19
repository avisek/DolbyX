import { For, Show, createSignal, type Component } from 'solid-js'
import { selectedEqPreset, selectedProfile, state } from '../store/state'
import {
  addEqPreset,
  removeEqPreset,
  renameEqPreset,
  resetEqPreset,
  setEqPreset,
} from '../store/ws'
import RenameInput from './RenameInput'
import './EqPresetPicker.css'

/**
 * The EQ preset picker: None (the profile's own EQ params — "Off" is
 * `null`, not a preset) plus the global presets from the snapshot.
 * Selection is per-profile and applies local-first on ack; the daemon
 * has already overlaid the resolved nine EQ params (ADR-0003). The
 * CRUD affordances (issue #26) target the selected EQ preset: Add clones
 * it under a server-minted id; factory presets reset, custom ones
 * rename and delete — with None selected there is nothing to act on.
 */
const EqPresetPicker: Component = () => {
  const [renaming, setRenaming] = createSignal(false)
  const selected = () => selectedProfile()?.selected_eq_preset ?? null
  return (
    <div class="eq-preset-picker">
      <div
        class="eq-preset-picker__options"
        role="radiogroup"
        aria-label="EQ preset"
      >
        <For each={[null, ...state.eq_presets]}>
          {(preset) => (
            <button
              type="button"
              class="eq-preset-picker__option"
              role="radio"
              aria-checked={selected() === (preset?.id ?? null)}
              onClick={() => {
                setEqPreset(state.selected_profile, preset?.id ?? null)
              }}
            >
              {preset?.name ?? 'None'}
            </button>
          )}
        </For>
      </div>
      <Show when={selectedEqPreset()}>
        {(preset) => (
          <div class="eq-preset-picker__actions">
            <Show
              when={renaming()}
              fallback={
                <>
                  <button
                    type="button"
                    class="eq-preset-picker__action"
                    aria-label="Add EQ preset"
                    onClick={() => {
                      addEqPreset(preset().id, `${preset().name} Copy`)
                    }}
                  >
                    Add
                  </button>
                  <Show when={!preset().is_factory}>
                    <button
                      type="button"
                      class="eq-preset-picker__action"
                      aria-label="Rename EQ preset"
                      onClick={() => setRenaming(true)}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      class="eq-preset-picker__action"
                      aria-label="Delete EQ preset"
                      onClick={() => {
                        removeEqPreset(preset().id)
                      }}
                    >
                      Delete
                    </button>
                  </Show>
                  <Show when={preset().is_factory}>
                    <button
                      type="button"
                      class="eq-preset-picker__action"
                      aria-label="Reset EQ preset"
                      onClick={() => {
                        resetEqPreset(preset().id)
                      }}
                    >
                      Reset
                    </button>
                  </Show>
                </>
              }
            >
              <RenameInput
                class="eq-preset-picker__rename"
                label="EQ preset name"
                value={preset().name}
                onRename={(name) => {
                  renameEqPreset(preset().id, name)
                }}
                onClose={() => setRenaming(false)}
              />
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

export default EqPresetPicker
