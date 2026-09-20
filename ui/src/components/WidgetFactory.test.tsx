import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import type { ParamKind } from '../lib/parameters'
import { fixtureBootstrap, fixtureParamsWith } from '../test/fixture'

// A def the table never ships: `dvla` with a kind the factory has no
// branch for — metadata growth, seen before the UI learns it. Installed
// before the dynamic import: the table reads it at module init.
const bootstrap = fixtureBootstrap()
window.__BOOTSTRAP__ = {
  ...bootstrap,
  params: fixtureParamsWith('dvla', { kind: 'bogus' as ParamKind }),
}

const { default: AdvancedPanel } = await import('./AdvancedPanel')

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// Behavior 8 (#85): an unknown `(kind, access)` combo never throws —
// the card falls back to the generic readout and warns exactly once,
// naming the combo.
it('renders the readout for an unknown kind and warns once', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  render(() => <AdvancedPanel />)
  screen.getByRole('button', { name: 'Advanced' }).click()

  const card = screen.getByRole('status', { name: 'Volume Leveler Amount' })
  expect(card.classList).toContain('adv-readout')
  expect(card.textContent).toBe('4') // Music's `dvla`, still read
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]?.join(' ')).toMatch(/dvla/)
  expect(warn.mock.calls[0]?.join(' ')).toMatch(/bogus/)
  expect(warn.mock.calls[0]?.join(' ')).toMatch(/settable/)
})
