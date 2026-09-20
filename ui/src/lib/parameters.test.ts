import { expect, it } from 'vitest'
import { fixtureBootstrap, fixtureCategories } from '../test/fixture'

// The parameter table reads window.__BOOTSTRAP__ at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap()

const { categories, paramDef, presetCarried } = await import('./parameters')

// Behavior 10 (issue #83): the bootstrap's `[[category]]` table is served
// as-is — order, labels, card order — and every listed 4-CC resolves.
it('serves the bootstrap category table in order', () => {
  expect(categories()).toEqual(fixtureCategories())
  const listed = categories().flatMap((category) => category.params)
  for (const name of listed) expect(paramDef(name).name).toBe(name)
  expect(new Set(listed).size).toBe(listed.length)
  expect(listed.length).toBe(fixtureBootstrap().params.length)
})

// Preset eligibility stays derived from the per-param `category` the
// daemon derives (ADR-0003) — the nine, in table order.
it('still derives the nine preset-carried 4-CCs', () => {
  expect(presetCarried()).toEqual([
    'ieon',
    'ienb',
    'iebf',
    'iebt',
    'iea',
    'geon',
    'genb',
    'gebf',
    'gebg',
  ])
})
