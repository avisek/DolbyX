/**
 * UI state — a `solid-js/store` hydrated synchronously from
 * `window.__BOOTSTRAP__` at module init, so the first paint is fully
 * populated with no pre-paint network round-trip (ADR-0006). WS `state`
 * events reconcile any drift after connect.
 */
import { createStore, reconcile } from 'solid-js/store'
import type { Profile, StateSnapshot } from '../lib/ws'

// The wire type is readonly; the store's setter needs writable paths.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

// Bootstrap-less init only happens on a direct :5173 visit, where
// main.tsx redirects to the daemon before anything renders — the inert
// snapshot just keeps module init from throwing until then.
const inert: StateSnapshot = {
  power: false,
  selected_profile: '',
  profiles: [],
  eq_presets: [],
  readouts: {},
}

const [state, setState] = createStore<Mutable<StateSnapshot>>(
  window.__BOOTSTRAP__?.state ?? inert,
)

/** The live snapshot, read by components. */
export { state }

/** The selected profile — carries every resolved non-readonly param. */
export function selectedProfile(): Profile | undefined {
  return state.profiles.find((profile) => profile.id === state.selected_profile)
}

/** Reconciles a full daemon snapshot into the store. */
export function applySnapshot(snapshot: StateSnapshot): void {
  setState(reconcile(snapshot))
}

/** Applies the originator's own acked power flip (local-first). */
export function applyPower(on: boolean): void {
  setState('power', on)
}

/** Applies the originator's own acked profile switch (local-first). */
export function applyProfile(id: string): void {
  setState('selected_profile', id)
}

/**
 * Applies this tab's own acked EQ preset selection (local-first) —
 * per-profile, `null` detaching to the profile's own EQ params.
 */
export function applyEqPreset(profileId: string, id: string | null): void {
  setState('profiles', (profiles) =>
    profiles.map((profile) =>
      profile.id === profileId
        ? { ...profile, selected_eq_preset: id }
        : profile,
    ),
  )
}

/**
 * Applies one of this tab's own profile edits. Short value arrays
 * overlay the head of the param's full allocation — the daemon merges
 * the same way (`Profile::splice`).
 */
export function applyProfileEdit(
  id: string,
  params: Readonly<Record<string, readonly number[]>>,
): void {
  setState('profiles', (profiles) =>
    profiles.map((profile) => {
      if (profile.id !== id) return profile
      const merged: Record<string, readonly number[]> = { ...profile.params }
      for (const [name, values] of Object.entries(params)) {
        merged[name] = [
          ...values,
          ...(profile.params[name] ?? []).slice(values.length),
        ]
      }
      return { ...profile, params: merged }
    }),
  )
}
