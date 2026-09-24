// PROTOTYPE — throwaway, do not review
import { createMemo, createSignal, type Component } from 'solid-js'
import { captureName, cloneName } from '../lib/naming'
import { presetCarried } from '../lib/parameters'
import {
  paramsDiverge,
  presetDiverges,
  selectedEqPreset,
  selectedProfile,
  state,
} from '../store/state'
import {
  addEqPreset,
  removeEqPreset,
  renameEqPreset,
  resetEqPreset,
  resetProfile,
  setEqPreset,
} from '../store/ws'
import Picker from './Picker'

/**
 * The EQ preset picker: None (the profile's own EQ params — `null`,
 * not a preset) plus the global presets, the actions acting on the
 * picked item, None included (issue #26). Per-profile selection,
 * local-first on ack (ADR-0003).
 */
const EqPresetPicker: Component = () => {
  const picked = () => selectedProfile()?.selected_eq_preset ?? null
  const preset = () => selectedEqPreset()
  const resetDisabled = createMemo(() => {
    const target = preset()
    if (target) return !presetDiverges(target)
    const profile = selectedProfile()
    return profile === undefined || !paramsDiverge(profile, presetCarried())
  })
  const [renaming, setRenaming] = createSignal(false)
  return (
    <Picker
      kind="eq"
      label="EQ preset"
      noun="EQ preset"
      options={[
        { id: null, name: 'None', checked: picked() === null, factory: true },
        ...state.eq_presets.map((entry) => ({
          id: entry.id,
          name: entry.name,
          checked: entry.id === picked(),
          factory: entry.is_factory,
        })),
      ]}
      onPick={(id) => {
        setEqPreset(state.selected_profile, id)
      }}
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
      renaming={renaming()}
      onRenameCommit={(name) => {
        setRenaming(false)
        const target = preset()
        if (target) renameEqPreset(target.id, name)
      }}
      onRenameCancel={() => setRenaming(false)}
    />
  )
}

export default EqPresetPicker
