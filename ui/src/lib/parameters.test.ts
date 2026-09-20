import { expect, it } from 'vitest'
import { fixtureBootstrap } from '../test/fixture'

// The parameter table reads window.__BOOTSTRAP__ at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap()

const { categories, paramDef, presetCarried } = await import('./parameters')

// Behavior 10 (issue #83): the bootstrap's `[[category]]` table is served
// as-is — section order and labels per the shipped table, card order per
// row — and every listed 4-CC resolves.
it('serves the bootstrap category table in section order', () => {
  expect(categories().map((category) => category.name)).toEqual([
    'volume_leveller',
    'ieq',
    'geq',
    'dialog_enhancer',
    'volume_maximizer',
    'speaker_virtualizer',
    'headphone_virtualizer',
    'next_gen_surround',
    'audio_regulator',
    'audio_optimizer',
    'peak_limiter',
    'endpoint_volume',
    'visualizer',
    'build',
    'license',
  ])
  expect(categories()[0]).toEqual({
    name: 'volume_leveller',
    label: 'Volume Leveler',
    params: ['dvla', 'dvli', 'dvlo', 'dvle', 'dvmc', 'dvme'],
  })
  for (const { params } of categories()) {
    for (const name of params) expect(paramDef(name).name).toBe(name)
  }
})

// Preset eligibility stays derived from the per-param `category` the
// daemon derives (ADR-0003) — the nine, in `[[param]]` (engine) order.
it('still derives the nine preset-carried 4-CCs', () => {
  expect(presetCarried()).toEqual([
    'ienb',
    'iebf',
    'iebt',
    'ieon',
    'iea',
    'geon',
    'genb',
    'gebf',
    'gebg',
  ])
})
