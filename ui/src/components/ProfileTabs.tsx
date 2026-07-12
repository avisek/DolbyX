import { For, type Component } from 'solid-js'
import { state } from '../store/state'
import { setProfile } from '../store/ws'
import './ProfileTabs.css'

/**
 * The profile tabs: rendered from the snapshot's profiles (factory
 * four for now), selection switches local-first on ack.
 */
const ProfileTabs: Component = () => (
  <div class="profile-tabs" role="tablist" aria-label="Profiles">
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
)

export default ProfileTabs
