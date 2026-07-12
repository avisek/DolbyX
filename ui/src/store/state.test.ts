import { expect, it } from 'vitest'
import { fixtureBootstrap, fixtureState } from '../test/fixture'

// The store reads window.__BOOTSTRAP__ synchronously at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap({
  power: false,
  selected_profile: 'movie',
})
const { state, applyProfileEdit, applySnapshot } = await import('./state')

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
