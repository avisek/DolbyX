import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, it } from 'vitest'
import { fixtureBootstrap } from '../test/fixture'

// The parameter table reads window.__BOOTSTRAP__ at module init
// (ADR-0006) — install the fixture before the dynamic import evaluates.
window.__BOOTSTRAP__ = fixtureBootstrap()

const { default: AdvancedPanel } = await import('./AdvancedPanel')

afterEach(() => {
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
    'Headphone Virtualizer',
    'Visualizer',
  ])
  const count = (section: HTMLElement) =>
    section.querySelector('.adv-cat__count')?.textContent
  expect(sections.map(count)).toEqual(['2', '5', '4', '2', '2', '1'])
  // Each section is a labelled region so the tree reads by category.
  expect(
    screen.getByRole('region', { name: 'Graphic Equalizer' }).classList,
  ).toContain('adv-cat')
})

// Behavior 2 (#85): the placeholder body lists the category's 4-CCs in
// `params` order — Part 2 replaces this with the card test.
it('lists each category’s 4-CCs in params order', () => {
  const panel = renderOpen()
  const codes = (label: string) =>
    [
      ...panel.querySelectorAll(`[aria-label="${label}"] .adv-cat__body code`),
    ].map((code) => code.textContent)
  expect(codes('Intelligent Equalizer')).toEqual([
    'ienb',
    'iebf',
    'iebt',
    'ieon',
    'iea',
  ])
  expect(codes('Volume Leveler')).toEqual(['dvla', 'dvle'])
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
  expect(section.querySelectorAll('.adv-cat__body code')).toHaveLength(4)
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
