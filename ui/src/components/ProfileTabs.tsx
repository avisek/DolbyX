import { createSignal, For, Show, type Component } from 'solid-js'
import { cloneName } from '../lib/naming'
import { selectedProfile, state } from '../store/state'
import {
  addProfile,
  removeProfile,
  renameProfile,
  resetProfile,
  setProfile,
} from '../store/ws'
import ActionRow from './ActionRow'
import RenameInput from './RenameInput'
import './ProfileTabs.css'

/**
 * The profile tabs plus their action row (issue #26): tabs from the
 * snapshot's profiles, selection local-first on ack; the four CRUD
 * affordances act on the selected profile — Rename/Delete disabled on
 * factory items, Reset disabled iff nothing diverges (`overridden`
 * empty), all derived, never hidden.
 */
const ProfileTabs: Component = () => {
  const selected = () => selectedProfile()
  const [renaming, setRenaming] = createSignal(false)
  return (
    <div class="profile-tabs">
      <div class="profile-tabs__tabs" role="tablist" aria-label="Profiles">
        <For each={state.profiles}>
          {(profile) => (
            <Show
              when={!(renaming() && profile.id === state.selected_profile)}
              fallback={
                <RenameInput
                  label="Profile name"
                  name={profile.name}
                  class="profile-tabs__rename"
                  onCommit={(name) => {
                    setRenaming(false)
                    renameProfile(profile.id, name)
                  }}
                  onCancel={() => setRenaming(false)}
                />
              }
            >
              <button
                type="button"
                class="profile-tabs__tab"
                role="tab"
                aria-selected={state.selected_profile === profile.id}
                onClick={() => {
                  setProfile(profile.id)
                }}
              >
                {profile.name}
              </button>
            </Show>
          )}
        </For>
      </div>
      <ActionRow
        kind="profile"
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
        resetDisabled={(selected()?.overridden.length ?? 0) === 0}
        onReset={() => {
          resetProfile(state.selected_profile)
        }}
      />
    </div>
  )
}

export default ProfileTabs
