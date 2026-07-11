import type { Bootstrap } from '../lib/bootstrap'
import type { StateSnapshot } from '../lib/ws'

/** A daemon-truthful state snapshot (values from `defaults.toml`). */
export function fixtureState(
  overrides: Partial<StateSnapshot> = {},
): StateSnapshot {
  return {
    power: true,
    selected_profile: 'music',
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
