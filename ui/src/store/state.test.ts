import { expect, it } from 'vitest'
import { fixtureBootstrap, fixtureState } from '../test/fixture'

// The store reads window.__BOOTSTRAP__ synchronously at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap({
  power: false,
  selected_profile: 'movie',
})
const {
  state,
  applyEqPreset,
  applyEqPresetAdded,
  applyEqPresetEdit,
  applyEqPresetRename,
  applyProfileAdded,
  applyProfileEdit,
  applyProfileRename,
  applySnapshot,
  resolvedEqParam,
} = await import('./state')

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

// The GEQ editor's drag writes route to the active preset (issue #25
// part C) — the local-first apply merges like the profile one, and a
// preset edit is global: every profile selecting it sees the change.
it('applies an EQ preset edit by overlaying the head of the allocation', () => {
  applySnapshot(fixtureState())

  applyEqPresetEdit('rich', { gebg: [96], geon: [1] })

  const rich = state.eq_presets.find((preset) => preset.id === 'rich')
  expect(rich?.params['gebg']?.slice(0, 3)).toEqual([96, 0, 0])
  expect(rich?.params['geon']).toEqual([1])
  const open = state.eq_presets.find((preset) => preset.id === 'open')
  expect(open?.params['geon']).toEqual([0])
})

// Behavior 2 (#26), the originator half: `overridden` is daemon-derived
// (baselines live in the cascade), but the originator's own snapshots
// are suppressed (ADR-0005) — so a local edit unions its keys in, and
// Reset-disabled flips live as edits land. Approximate on purpose: an
// edit back to the baseline value keeps the key until the next
// snapshot corrects it.
it('a local edit unions its keys into the item overridden list', () => {
  applySnapshot(fixtureState())

  applyProfileEdit('music', { dvla: [9] })
  const music = () => state.profiles.find((profile) => profile.id === 'music')
  expect(music()?.overridden).toEqual(['dvla'])

  // Re-edits stay deduped; fresh keys append.
  applyProfileEdit('music', { dvla: [3], gebg: [96] })
  expect(music()?.overridden).toEqual(['dvla', 'gebg'])

  applyEqPresetEdit('rich', { gebg: [96] })
  const rich = state.eq_presets.find((preset) => preset.id === 'rich')
  expect(rich?.overridden).toEqual(['gebg'])
})

// The selection is a content key like any param (ADR-0007) — an acked
// selection patch unions `"selected_eq_preset"` the same way.
it('a local selection patch unions selected_eq_preset into overridden', () => {
  applySnapshot(fixtureState())
  applyEqPreset('music', 'rich')
  const music = state.profiles.find((profile) => profile.id === 'music')
  expect(music?.selected_eq_preset).toBe('rich')
  expect(music?.overridden).toEqual(['selected_eq_preset'])
})

// Behavior 3 (#26), the store half: the add ack's minted id lets the
// originator insert its clone locally without waiting for a snapshot
// (ADR-0005); a rename patch lands the same local-first way.
it('inserts acked clones locally and applies renames in place', () => {
  applySnapshot(fixtureState())
  const music = state.profiles.find((profile) => profile.id === 'music')
  if (!music) throw new Error('fixture lost Music')

  applyProfileAdded({
    ...music,
    id: 'user_a3f1',
    name: 'Music 2',
    is_factory: false,
  })
  expect(state.profiles.map((profile) => profile.id)).toContain('user_a3f1')

  applyProfileRename('user_a3f1', 'Late Night')
  const clone = state.profiles.find((profile) => profile.id === 'user_a3f1')
  expect(clone?.name).toBe('Late Night')
  expect(clone?.overridden).not.toContain('name') // a label, never reset

  applyEqPresetAdded({
    id: 'user_91c2',
    name: 'Preset 1',
    is_factory: false,
    params: { gebg: [96] },
    overridden: [],
  })
  applyEqPresetRename('user_91c2', 'Warm')
  expect(state.eq_presets.at(-1)?.name).toBe('Warm')
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
