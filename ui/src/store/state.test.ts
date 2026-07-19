import { expect, it } from 'vitest'
import { fixtureBootstrap, fixtureState } from '../test/fixture'

// The store reads window.__BOOTSTRAP__ synchronously at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap({
  power: false,
  selected_profile: 'movie',
})
const { state, applyProfileEdit, applySnapshot, resolvedEqParam } =
  await import('./state')

it('hydrates the store from window.__BOOTSTRAP__ at module init', () => {
  expect(state.power).toBe(false)
  expect(state.selected_profile).toBe('movie')
  expect(state.readouts['vnnb']).toEqual([20])
})

// The daemon merges short writes onto the head of the full allocation
// (`Profile::splice`) — the local-first apply must agree.
it('applies a profile edit by overlaying the head of the allocation', () => {
  const seeded = fixtureState()
  applySnapshot({
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === 'music'
        ? { ...profile, params: { ...profile.params, dea: [1, 2, 3] } }
        : profile,
    ),
  })

  applyProfileEdit('music', { dvla: [9], dea: [8] })

  const music = state.profiles.find((profile) => profile.id === 'music')
  expect(music?.params['dvla']).toEqual([9])
  expect(music?.params['dea']).toEqual([8, 2, 3])
  const movie = state.profiles.find((profile) => profile.id === 'movie')
  expect(movie?.params['dvla']).toEqual([7])
})

// ADR-0003: a selected preset's EQ params shadow the profile's own
// *entirely* — presets arrive complete, resolution never falls through
// per-param; `null` detaches back to the profile's own.
it('resolves EQ-carried params through the selected preset, entirely', () => {
  const seeded = fixtureState()
  const profileGains = Array.from({ length: 20 }, () => 32)
  const presetGains = Array.from({ length: 20 }, () => -64)
  applySnapshot({
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === 'music'
        ? {
            ...profile,
            selected_eq_preset: 'rich',
            params: { ...profile.params, gebg: profileGains },
          }
        : profile,
    ),
    eq_presets: seeded.eq_presets.map((preset) =>
      preset.id === 'rich'
        ? { ...preset, params: { ...preset.params, gebg: presetGains } }
        : preset,
    ),
  })

  expect(resolvedEqParam('gebg')).toEqual(presetGains)
  expect(resolvedEqParam('genb')).toEqual([20]) // the preset's own copy

  applySnapshot(seeded) // selected_eq_preset back to null
  const music = state.profiles.find((profile) => profile.id === 'music')
  expect(music?.params['gebg']).toBeDefined()
  expect(resolvedEqParam('gebg')).toEqual(music?.params['gebg'])
})
