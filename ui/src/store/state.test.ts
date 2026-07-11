import { expect, it } from 'vitest'
import { fixtureBootstrap } from '../test/fixture'

// The store reads window.__BOOTSTRAP__ synchronously at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap({
  power: false,
  selected_profile: 'movie',
})
const { state } = await import('./state')

it('hydrates the store from window.__BOOTSTRAP__ at module init', () => {
  expect(state.power).toBe(false)
  expect(state.selected_profile).toBe('movie')
  expect(state.readouts['vnnb']).toEqual([20])
})
