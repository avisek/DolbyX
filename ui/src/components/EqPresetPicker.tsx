import { For, type Component } from 'solid-js'
import { state } from '../store/state'
import { setEqPreset } from '../store/ws'
import './EqPresetPicker.css'

/**
 * The EQ preset picker: None (the profile's own EQ params — "Off" is
 * `null`, not a preset) plus the global presets from the snapshot.
 * Selection is per-profile and applies local-first on ack; the daemon
 * has already overlaid the resolved nine EQ params (ADR-0003).
 */
const EqPresetPicker: Component = () => {
  const selected = () =>
    state.profiles.find((profile) => profile.id === state.selected_profile)
      ?.selected_eq_preset ?? null
  return (
    <div class="eq-preset-picker" role="radiogroup" aria-label="EQ preset">
      <button
        type="button"
        class="eq-preset-picker__option"
        role="radio"
        aria-checked={selected() === null}
        onClick={() => {
          setEqPreset(state.selected_profile, null)
        }}
      >
        None
      </button>
      <For each={state.eq_presets}>
        {(preset) => (
          <button
            type="button"
            class="eq-preset-picker__option"
            role="radio"
            aria-checked={selected() === preset.id}
            onClick={() => {
              setEqPreset(state.selected_profile, preset.id)
            }}
          >
            {preset.name}
          </button>
        )}
      </For>
    </div>
  )
}

export default EqPresetPicker
