import { expect, it } from 'vitest'
import { captureName, cloneName } from './naming'

// Behavior 3 (#26), the minting half: a clone is `«base» n`, smallest
// n ≥ 2 unused among that kind's names.
it('mints «base» 2 for a fresh clone', () => {
  expect(cloneName('Music', ['Movie', 'Music', 'Game', 'Voice'])).toBe(
    'Music 2',
  )
})

it('strips a trailing integer before minting — cloning a clone counts up', () => {
  expect(cloneName('Music 2', ['Music', 'Music 2'])).toBe('Music 3')
})

it('takes the smallest unused n, filling holes', () => {
  expect(cloneName('Music', ['Music', 'Music 2', 'Music 4'])).toBe('Music 3')
})

it('only a space-separated trailing integer is a counter', () => {
  expect(cloneName('Mix42', ['Mix42'])).toBe('Mix42 2')
})

// Behavior 4 (#26), the minting half: a None capture is `Preset n`,
// smallest n ≥ 1.
it('mints Preset n from 1 for a None capture', () => {
  expect(captureName(['Open', 'Rich', 'Focused'])).toBe('Preset 1')
  expect(captureName(['Preset 1', 'Preset 2'])).toBe('Preset 3')
  expect(captureName(['Preset 2'])).toBe('Preset 1')
})
