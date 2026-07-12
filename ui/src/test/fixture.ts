import type { Bootstrap } from '../lib/bootstrap'
import type { Profile, StateSnapshot } from '../lib/ws'

/** One factory profile as the snapshot carries it. */
function factoryProfile(id: string, name: string): Profile {
  return {
    id,
    name,
    is_factory: true,
    selected_eq_preset: null,
    params: { dvla: [4] },
  }
}

/** A daemon-truthful state snapshot (values from `defaults.toml`). */
export function fixtureState(
  overrides: Partial<StateSnapshot> = {},
): StateSnapshot {
  return {
    power: true,
    selected_profile: 'music',
    profiles: [
      factoryProfile('movie', 'Movie'),
      factoryProfile('music', 'Music'),
      factoryProfile('game', 'Game'),
      factoryProfile('voice', 'Voice'),
    ],
    readouts: { vnnb: [20] },
    ...overrides,
  }
}

/** What the daemon injects as `window.__BOOTSTRAP__` (Slice 04, #12). */
export function fixtureBootstrap(
  overrides: Partial<StateSnapshot> = {},
): Bootstrap {
  return { params: [{ name: 'vnnb' }], state: fixtureState(overrides) }
}
