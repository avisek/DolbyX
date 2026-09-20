import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  fixtureBootstrap,
  fixtureCategories,
  fixtureState,
  fixtureVis,
} from '../test/fixture'
import { MockWebSocket } from '../test/mock-ws'

// The store and the parameter table both read window.__BOOTSTRAP__ at
// module init (ADR-0006) — install the fixture before the dynamic
// imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: AdvancedPanel } = await import('./AdvancedPanel')
const { applySnapshot } = await import('../store/state')
const { resetVis } = await import('../store/vis')
const { startWs, stopWs } = await import('../store/ws')

beforeEach(() => {
  MockWebSocket.reset()
  // The store modules are singletons — re-seed them between tests.
  applySnapshot(fixtureState())
  resetVis()
})

afterEach(() => {
  stopWs()
  cleanup()
  localStorage.clear()
})

const panelHeader = () => screen.getByRole('button', { name: 'Advanced' })

/** Renders the panel opened — the shell inside is the subject. */
function renderOpen(): HTMLElement {
  render(() => <AdvancedPanel />)
  panelHeader().click()
  return screen.getByRole('region', { name: 'Advanced' })
}

const categorySections = (panel: HTMLElement) => [
  ...panel.querySelectorAll<HTMLElement>('.adv-cat'),
]

// Behavior 1 (#85): one section per bootstrap category, in table order,
// titled by its label and counting its params — nothing hand-listed
// (ADR-0004).
it('renders one section per bootstrap category, in order, titled by label', () => {
  const panel = renderOpen()
  const sections = categorySections(panel)

  const title = (section: HTMLElement) =>
    section.querySelector('.adv-cat__title')?.textContent
  expect(sections.map(title)).toEqual([
    'Volume Leveler',
    'Intelligent Equalizer',
    'Graphic Equalizer',
    'Dialog Enhancer',
    'Volume Maximizer',
    'Speaker Virtualizer',
    'Headphone Virtualizer',
    'Next Gen Surround',
    'Audio Regulator',
    'Audio Optimizer',
    'Peak Limiter',
    'Endpoint Volume',
    'Visualizer',
    'Build',
    'License',
  ])
  const count = (section: HTMLElement) =>
    section.querySelector('.adv-cat__count')?.textContent
  expect(sections.map(count)).toEqual([
    ...['6', '5', '4', '3', '2', '5', '3', '1'],
    ...['7', '5', '3', '5', '9', '3', '3'],
  ])
  // Each section is a labelled region so the tree reads by category.
  expect(
    screen.getByRole('region', { name: 'Graphic Equalizer' }).classList,
  ).toContain('adv-cat')
})

const cards = (panel: HTMLElement, label: string) => [
  ...panel.querySelectorAll<HTMLElement>(`[aria-label="${label}"] .adv-card`),
]

// Behavior 6 (#85): each category body holds one card per listed 4-CC
// in `params` order — 64 in all — carrying the 4-CC, the def's short
// label, and its description as the hover title.
it('renders one card per listed 4-CC with code, label and title', () => {
  const panel = renderOpen()
  expect(panel.querySelectorAll('.adv-card')).toHaveLength(64)

  const code = (card: HTMLElement) =>
    card.querySelector('.adv-card__code')?.textContent
  expect(cards(panel, 'Volume Leveler').map(code)).toEqual([
    'dvla',
    'dvli',
    'dvlo',
    'dvle',
    'dvmc',
    'dvme',
  ])
  for (const { label, params } of fixtureCategories()) {
    expect(cards(panel, label).map(code)).toEqual(params)
  }

  const [amount, , , enable] = cards(panel, 'Volume Leveler')
  expect(amount?.querySelector('.adv-card__label')?.textContent).toBe('Amount')
  expect(amount?.title).toBe(
    'Sets how much the leveler adjusts the loudness to normalize different audio content.',
  )
  expect(enable?.querySelector('.adv-card__label')?.textContent).toBe('Enable')
  expect(enable?.title).toBe(
    'Specifies the preferential enable for the Dolby Volume Leveler feature.',
  )
})

const card = (panel: HTMLElement, code: string) => {
  const found = [...panel.querySelectorAll<HTMLElement>('.adv-card')].find(
    (node) => node.querySelector('.adv-card__code')?.textContent === code,
  )
  if (!found) throw new Error(`no card for ${code}`)
  return found
}

const modifiers = (node: HTMLElement) =>
  [...node.classList].filter((name) => name.startsWith('adv-card--')).sort()

// Behavior 7 (#85): access and shape arrive as modifiers — `--ro` on
// both read-only buckets, `--exp` on experimental, `--array` on
// `length > 1`, none on a settable scalar; the reset marker (disabled,
// wired in #92) exists on writable cards only — read-only params have
// no Content key.
it('publishes --ro / --exp / --array and a reset marker on writable cards only', () => {
  const panel = renderOpen()
  expect(modifiers(card(panel, 'vnnb'))).toEqual(['adv-card--ro'])
  expect(modifiers(card(panel, 'vnbg'))).toEqual([
    'adv-card--array',
    'adv-card--ro',
  ])
  expect(modifiers(card(panel, 'vol'))).toEqual(['adv-card--exp'])
  expect(modifiers(card(panel, 'gebg'))).toEqual(['adv-card--array'])
  expect(modifiers(card(panel, 'dvla'))).toEqual([])

  const reset = (node: HTMLElement) =>
    node.querySelector<HTMLButtonElement>('.adv-card__reset')
  expect(reset(card(panel, 'dvla'))?.disabled).toBe(true)
  expect(reset(card(panel, 'vol'))?.disabled).toBe(true)
  expect(reset(card(panel, 'vnnb'))).toBeNull()
  expect(reset(card(panel, 'vnbg'))).toBeNull()
})

const readout = (panel: HTMLElement, code: string) =>
  card(panel, code).querySelector('.adv-readout')?.textContent

// Behavior 9 (#85): every card reads through the Source rule and shows
// its value as a plain readout — ReadOnly-Static from the snapshot's
// Readouts, writable from the active profile — `frac_bits` applied and
// the kind's unit appended.
it('reads Readouts on static cards and the active profile on writable ones', () => {
  const panel = renderOpen()
  expect(readout(panel, 'vnnb')).toBe('20')
  expect(readout(panel, 'bver')).toBe('4, 28, 9, 0, 0')
  expect(readout(panel, 'dvla')).toBe('4') // Music
  expect(readout(panel, 'dhsb')).toBe('3 dB') // raw 48, 1/16 dB

  applySnapshot(fixtureState({ selected_profile: 'voice' }))
  expect(readout(panel, 'dvla')).toBe('0')
  expect(readout(panel, 'dhsb')).toBe('0 dB')
})

/** Completes the background WS handshake — the `vis` feed's door. */
function connect(): MockWebSocket {
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

// Behavior 9 (#85): the ReadOnly-Dynamic cards are Live arrays — a
// `vis` event lands on them, the last frame held (no Vis idle here).
it('lands a vis event on the ReadOnly-Dynamic cards', () => {
  const panel = renderOpen()
  const socket = connect()
  expect(readout(panel, 'vnbg')).toBe(Array(20).fill('0').join(', ') + ' dB')

  socket.serverMessage({
    type: 'vis',
    params: fixtureVis({ vcbg: [40, -8], vcbe: [-52] }),
  })
  expect(readout(panel, 'vcbg')).toBe(
    ['2.5', '-0.5', ...Array<string>(18).fill('0')].join(', ') + ' dB',
  )
  expect(readout(panel, 'vcbe')).toBe(
    ['-3.25', ...Array<string>(19).fill('-12')].join(', ') + ' dB',
  )
})

/** The fixture state with Music selecting `presetId`. */
function selectingState(presetId: string | null) {
  const seeded = fixtureState()
  return {
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === 'music'
        ? { ...profile, selected_eq_preset: presetId }
        : profile,
    ),
  }
}

// Behavior 9 (#85): a preset-carried card follows the EQ selection —
// the selected EQ preset's value while one is selected, the profile's
// own after `None` (the Source rule).
it('reads a preset-carried card from the selected EQ preset, else the profile', () => {
  const panel = renderOpen()
  expect(readout(panel, 'ieon')).toBe('0') // Music's own

  applySnapshot(selectingState('rich'))
  expect(readout(panel, 'ieon')).toBe('1') // Rich

  applySnapshot(selectingState(null))
  expect(readout(panel, 'ieon')).toBe('0')
})

const panelBody = () => document.querySelector('.advanced__body')

// Behavior 3 (#85): collapsed by default with the body unmounted; a
// click opens it and stores the pref (`dolbyx.advanced.open`).
it('starts collapsed with no body, opens on click, and stores the pref', () => {
  render(() => <AdvancedPanel />)
  const panel = screen.getByRole('region', { name: 'Advanced' })
  expect(panelHeader().getAttribute('aria-expanded')).toBe('false')
  expect(panel.classList).toContain('advanced--collapsed')
  expect(panelBody()).toBeNull()

  panelHeader().click()
  expect(panelHeader().getAttribute('aria-expanded')).toBe('true')
  expect(panel.classList).not.toContain('advanced--collapsed')
  expect(panelBody()).not.toBeNull()
  expect(localStorage.getItem('dolbyx.advanced.open')).toBe('1')

  panelHeader().click()
  expect(panelBody()).toBeNull()
  expect(localStorage.getItem('dolbyx.advanced.open')).toBe('0')
})

// Behavior 3 (#85): a stored `1` opens on mount; junk falls back to
// the default (collapsed), like every `dolbyx.*` pref.
it('opens on mount from a stored 1 and ignores junk', () => {
  localStorage.setItem('dolbyx.advanced.open', '1')
  render(() => <AdvancedPanel />)
  expect(panelHeader().getAttribute('aria-expanded')).toBe('true')
  expect(panelBody()).not.toBeNull()
  cleanup()

  for (const junk of ['', 'true', 'yes', '2']) {
    localStorage.setItem('dolbyx.advanced.open', junk)
    render(() => <AdvancedPanel />)
    expect(panelHeader().getAttribute('aria-expanded')).toBe('false')
    cleanup()
  }
})

const foldToggle = (label: string) =>
  screen.getByRole('button', { name: `${label} 4` })

// Behavior 4 (#85): a fold toggle publishes `adv-cat--collapsed` +
// `aria-expanded=false` and leaves the content mounted (the skin
// animates); the pref stores the category name.
it('folds a category on toggle click, keeping its content mounted', () => {
  renderOpen()
  const section = screen.getByRole('region', { name: 'Graphic Equalizer' })
  const toggle = foldToggle('Graphic Equalizer')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')

  toggle.click()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(section.classList).toContain('adv-cat--collapsed')
  expect(section.querySelectorAll('.adv-cat__body .adv-card')).toHaveLength(4)
  expect(
    JSON.parse(localStorage.getItem('dolbyx.advanced.collapsed') ?? 'null'),
  ).toEqual(['geq'])

  toggle.click()
  expect(section.classList).not.toContain('adv-cat--collapsed')
  expect(
    JSON.parse(localStorage.getItem('dolbyx.advanced.collapsed') ?? 'null'),
  ).toEqual([])
})

// Behavior 4 (#85): stored names start collapsed, every other category
// expanded; junk in the list is dropped, junk instead of a list is
// the default.
it('starts stored categories collapsed and the rest expanded', () => {
  localStorage.setItem(
    'dolbyx.advanced.collapsed',
    JSON.stringify(['ieq', 'visualizer', 7, 'no_such_category']),
  )
  const collapsed = () =>
    categorySections(renderOpen())
      .filter((section) => section.classList.contains('adv-cat--collapsed'))
      .map((section) => section.getAttribute('aria-label'))
  expect(collapsed()).toEqual(['Intelligent Equalizer', 'Visualizer'])
  cleanup()

  for (const junk of ['', 'ieq', '{"ieq":true}', '["ieq"']) {
    localStorage.setItem('dolbyx.advanced.collapsed', junk)
    expect(collapsed()).toEqual([])
    cleanup()
  }
})
