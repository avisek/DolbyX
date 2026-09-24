// PROTOTYPE — throwaway, do not review
import { createMemo, createSignal, type Component } from 'solid-js'
import { cloneName } from '../lib/naming'
import { profileDiverges, selectedProfile, state } from '../store/state'
import {
  addProfile,
  removeProfile,
  renameProfile,
  resetProfile,
  setProfile,
} from '../store/ws'
import Picker from './Picker'

/**
 * The profile picker (issue #26): options from the snapshot's
 * profiles, switching local-first on ack; the four actions act on the
 * selected profile — Rename/Delete disabled on factory items, Reset
 * disabled iff nothing diverges, all derived, never hidden.
 */
const ProfileTabs: Component = () => {
  const selected = () => selectedProfile()
  const diverges = createMemo(() => {
    const profile = selected()
    return profile !== undefined && profileDiverges(profile)
  })
  const [renaming, setRenaming] = createSignal(false)
  return (
    <Picker
      kind="profile"
      label="Profile"
      noun="profile"
      options={state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        checked: profile.id === state.selected_profile,
        factory: profile.is_factory,
      }))}
      onPick={(id) => {
        if (id !== null) setProfile(id)
      }}
      onAdd={() => {
        const profile = selected()
        if (!profile) return
        addProfile(
          cloneName(
            profile.name,
            state.profiles.map((p) => p.name),
          ),
          profile.params,
          profile.selected_eq_preset,
        )
      }}
      renameDisabled={selected()?.is_factory ?? true}
      onRename={() => setRenaming(true)}
      deleteDisabled={selected()?.is_factory ?? true}
      onDelete={() => {
        removeProfile(state.selected_profile)
      }}
      resetDisabled={!diverges()}
      onReset={() => {
        resetProfile(state.selected_profile)
      }}
      renaming={renaming()}
      onRenameCommit={(name) => {
        setRenaming(false)
        renameProfile(state.selected_profile, name)
      }}
      onRenameCancel={() => setRenaming(false)}
    />
  )
}

export default ProfileTabs
