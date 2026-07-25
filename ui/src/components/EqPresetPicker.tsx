import { createSignal, For, Show, type Component } from 'solid-js'
import { captureName, cloneName } from '../lib/naming'
import { presetCarried } from '../lib/parameters'
import { selectedEqPreset, selectedProfile, state } from '../store/state'
import {
  addEqPreset,
  removeEqPreset,
  renameEqPreset,
  resetEqPreset,
  resetProfile,
  setEqPreset,
} from '../store/ws'
import ActionRow from './ActionRow'
import RenameInput from './RenameInput'
import './EqPresetPicker.css'

/**
 * The EQ preset picker: None (the profile's own EQ params — "Off" is
 * `null`, not a preset) plus the global presets from the snapshot,
 * with the action row acting on the current selection, None included
 * (issue #26). Selection is per-profile and applies local-first on
 * ack; the daemon has already overlaid the resolved nine EQ params
 * (ADR-0003).
 */
const EqPresetPicker: Component = () => {
  const selected = () => selectedProfile()?.selected_eq_preset ?? null
  const preset = () => selectedEqPreset()
  // Nothing to clear ⇒ disabled: a preset when its own `overridden`
  // is empty; the None row when the profile's `overridden` misses the
  // nine entirely (its reset is scoped to them).
  const resetDisabled = () => {
    const target = preset()
    if (target) return target.overridden.length === 0
    const overridden = selectedProfile()?.overridden ?? []
    return !presetCarried().some((name) => overridden.includes(name))
  }
  const [renaming, setRenaming] = createSignal(false)
  return (
    <div class="eq-preset-picker">
      <div
        class="eq-preset-picker__options"
        role="radiogroup"
        aria-label="EQ preset"
      >
        <For each={[null, ...state.eq_presets]}>
          {(entry) => (
            <Show
              when={!(renaming() && entry !== null && entry.id === selected())}
              fallback={
                <RenameInput
                  label="EQ preset name"
                  name={entry?.name ?? ''}
                  class="eq-preset-picker__rename"
                  onCommit={(name) => {
                    setRenaming(false)
                    if (entry) renameEqPreset(entry.id, name)
                  }}
                  onCancel={() => setRenaming(false)}
                />
              }
            >
              <button
                type="button"
                class="eq-preset-picker__option"
                role="radio"
                aria-checked={selected() === (entry?.id ?? null)}
                onClick={() => {
                  // Re-picking the checked option is a no-op gesture —
                  // no patch, so the local `overridden` union can't
                  // falsely mark a pristine profile diverging.
                  const id = entry?.id ?? null
                  if (id !== selected()) setEqPreset(state.selected_profile, id)
                }}
              >
                {entry?.name ?? 'None'}
              </button>
            </Show>
          )}
        </For>
      </div>
      <ActionRow
        kind="EQ preset"
        onAdd={() => {
          const names = state.eq_presets.map((p) => p.name)
          const source = preset()
          if (source) {
            addEqPreset(
              state.selected_profile,
              cloneName(source.name, names),
              source.params,
            )
          } else {
            // None capture: birth the profile's own resolved 9 as a
            // preset — same content grammar, no wire special case.
            const own = selectedProfile()?.params ?? {}
            const captured: Record<string, readonly number[]> = {}
            for (const name of presetCarried()) {
              const values = own[name]
              if (values) captured[name] = values
            }
            addEqPreset(state.selected_profile, captureName(names), captured)
          }
        }}
        renameDisabled={preset()?.is_factory ?? true}
        onRename={() => setRenaming(true)}
        deleteDisabled={preset()?.is_factory ?? true}
        onDelete={() => {
          const target = preset()
          if (target) removeEqPreset(target.id)
        }}
        resetDisabled={resetDisabled()}
        onReset={() => {
          const target = preset()
          if (target) resetEqPreset(target.id)
          else resetProfile(state.selected_profile, presetCarried())
        }}
      />
    </div>
  )
}

export default EqPresetPicker
