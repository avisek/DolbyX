/**
 * UI state — a `solid-js/store` hydrated synchronously from
 * `window.__BOOTSTRAP__` at module init, so the first paint is fully
 * populated with no pre-paint network round-trip (ADR-0006). WS `state`
 * events reconcile any drift after connect.
 */
import { createStore, reconcile } from 'solid-js/store'
import type { EqPreset, Profile, StateSnapshot } from '../lib/ws'

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

/**
 * Resolved `ven` — whether the DSP fills the vis slots. The Visualizer
 * mirrors it as `visualizer--off`; the GEQ editor's source rule treats
 * `ven = 0`'s frozen frames as unable to speak. Never a data gate.
 */
export function visEnabled(): boolean {
  return (selectedProfile()?.params['ven']?.[0] ?? 0) !== 0
}

/** The selected profile's EQ preset, when one is selected. */
export function selectedEqPreset(): EqPreset | undefined {
  const id = selectedProfile()?.selected_eq_preset
  if (id == null) return undefined
  return state.eq_presets.find((preset) => preset.id === id)
}

/**
 * The resolved active value of an EQ-preset-carried param: the
 * selected preset's entry shadows the profile's own *entirely*
 * (ADR-0003) — presets arrive complete, so resolution never falls
 * through per-param.
 */
export function resolvedEqParam(name: string): readonly number[] | undefined {
  const preset = selectedEqPreset()
  return preset ? preset.params[name] : selectedProfile()?.params[name]
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
 * per-profile, `null` detaching to the profile's own EQ params. The
 * selection is a content key (ADR-0007), so it unions into
 * `overridden` like any edit.
 */
export function applyEqPreset(profileId: string, id: string | null): void {
  setState('profiles', (profiles) =>
    profiles.map((profile) =>
      profile.id === profileId
        ? {
            ...profile,
            selected_eq_preset: id,
            overridden: unionOverridden(profile.overridden, [
              'selected_eq_preset',
            ]),
          }
        : profile,
    ),
  )
}

/** Overlays edited entries onto the head of each param's allocation. */
function mergeParams(
  base: Readonly<Record<string, readonly number[]>>,
  params: Readonly<Record<string, readonly number[]>>,
): Record<string, readonly number[]> {
  const merged: Record<string, readonly number[]> = { ...base }
  for (const [name, values] of Object.entries(params)) {
    merged[name] = [...values, ...(base[name] ?? []).slice(values.length)]
  }
  return merged
}

/**
 * Unions freshly edited content keys into an item's `overridden`.
 * `overridden` is daemon-derived (the baselines live in the cascade),
 * but the originator's own snapshots are suppressed (ADR-0005) — this
 * keeps its Reset affordances flipping live as edits land. Approximate
 * on purpose: an edit back to the baseline value keeps the key until
 * the next snapshot corrects it; a wrongly enabled Reset is a no-op
 * whose reconcile then disables it.
 */
function unionOverridden(
  overridden: readonly string[],
  edited: readonly string[],
): readonly string[] {
  return [...overridden, ...edited.filter((key) => !overridden.includes(key))]
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
    profiles.map((profile) =>
      profile.id === id
        ? {
            ...profile,
            params: mergeParams(profile.params, params),
            overridden: unionOverridden(
              profile.overridden,
              Object.keys(params),
            ),
          }
        : profile,
    ),
  )
}

/**
 * Inserts this tab's own acked clone — content as sent, id as minted
 * (ADR-0005: the ack id exists so the originator applies locally
 * without waiting for a snapshot). `overridden` starts as the caller's
 * guess; the add's `get_state` chaser trues it up.
 */
export function applyProfileAdded(profile: Profile): void {
  setState('profiles', (profiles) => [...profiles, profile])
}

/** As [`applyProfileAdded`], for a fresh custom EQ preset. */
export function applyEqPresetAdded(preset: EqPreset): void {
  setState('eq_presets', (presets) => [...presets, preset])
}

/** Applies this tab's own acked rename — a label change, id stable. */
export function applyProfileRename(id: string, name: string): void {
  setState('profiles', (profiles) =>
    profiles.map((profile) =>
      profile.id === id ? { ...profile, name } : profile,
    ),
  )
}

/** As [`applyProfileRename`], for an EQ preset. */
export function applyEqPresetRename(id: string, name: string): void {
  setState('eq_presets', (presets) =>
    presets.map((preset) => (preset.id === id ? { ...preset, name } : preset)),
  )
}

/**
 * Applies one of this tab's own EQ preset edits — same head overlay;
 * presets are global, so the change reaches every profile selecting it.
 */
export function applyEqPresetEdit(
  id: string,
  params: Readonly<Record<string, readonly number[]>>,
): void {
  setState('eq_presets', (presets) =>
    presets.map((preset) =>
      preset.id === id
        ? {
            ...preset,
            params: mergeParams(preset.params, params),
            overridden: unionOverridden(preset.overridden, Object.keys(params)),
          }
        : preset,
    ),
  )
}
