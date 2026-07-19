import { For, Show, createSignal, type Component } from 'solid-js'
import { selectedProfile, state } from '../store/state'
import {
  addProfile,
  removeProfile,
  renameProfile,
  resetProfile,
  setProfile,
} from '../store/ws'
import RenameInput from './RenameInput'
import './ProfileTabs.css'

/**
 * The profile tabs: rendered from the snapshot's profiles (factory
 * first, custom after), selection switching local-first on ack — plus
 * the CRUD affordances on the active profile (issue #26): Add clones
 * it under a server-minted id; factory items reset, custom items
 * rename and delete.
 */
const ProfileTabs: Component = () => {
  const [renaming, setRenaming] = createSignal(false)
  return (
    <div class="profile-tabs">
      <div class="profile-tabs__list" role="tablist" aria-label="Profiles">
        <For each={state.profiles}>
          {(profile) => (
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
          )}
        </For>
      </div>
      <div class="profile-tabs__actions">
        <Show
          when={renaming() && selectedProfile()}
          fallback={
            <>
              <button
                type="button"
                class="profile-tabs__action"
                aria-label="Add profile"
                onClick={() => {
                  const profile = selectedProfile()
                  if (profile) addProfile(profile.id, `${profile.name} Copy`)
                }}
              >
                Add
              </button>
              <Show when={selectedProfile()?.is_factory === false}>
                <button
                  type="button"
                  class="profile-tabs__action"
                  aria-label="Rename profile"
                  onClick={() => setRenaming(true)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  class="profile-tabs__action"
                  aria-label="Delete profile"
                  onClick={() => {
                    const profile = selectedProfile()
                    if (profile) removeProfile(profile.id)
                  }}
                >
                  Delete
                </button>
              </Show>
              <Show when={selectedProfile()?.is_factory === true}>
                <button
                  type="button"
                  class="profile-tabs__action"
                  aria-label="Reset profile"
                  onClick={() => {
                    const profile = selectedProfile()
                    if (profile) resetProfile(profile.id)
                  }}
                >
                  Reset
                </button>
              </Show>
            </>
          }
        >
          {(profile) => (
            <RenameInput
              class="profile-tabs__rename"
              label="Profile name"
              value={profile().name}
              onRename={(name) => {
                renameProfile(profile().id, name)
              }}
              onClose={() => setRenaming(false)}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

export default ProfileTabs
