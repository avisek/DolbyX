import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@solidjs/testing-library'
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
  renderOpen()
  const enable = toggle('Intelligent Equalizer Enable')
  expect(enable.checked).toBe(false) // Music's own ieon=0

  applySnapshot(selectingState('rich'))
  expect(enable.checked).toBe(true) // Rich ships ieon=1

  applySnapshot(selectingState(null))
  expect(enable.checked).toBe(false)
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

// — Discrete controls + the Source rule's write half (#86) —

/** The `edit_profile` / `edit_eq_preset` frames the client sent. */
const sentEdits = (socket: MockWebSocket) =>
  socket
    .sentCommands()
    .filter(
      (frame) => frame.cmd === 'edit_profile' || frame.cmd === 'edit_eq_preset',
    )

const toggle = (name: string) =>
  screen.getByRole<HTMLInputElement>('switch', { name })

/** Acks the last sent command and waits for the store to apply it. */
async function ack(socket: MockWebSocket, applied: () => void): Promise<void> {
  const last = socket.sentCommands().at(-1)
  socket.serverMessage({ type: 'ack', request_id: last?.request_id })
  await waitFor(applied)
}

// Behavior 1 (#86): clicking a settable toggle sends exactly one
// 1-entry `edit_profile` on the active profile; `checked` stays on
// daemon truth until the ack, then flips — issue #28's tracer bullet.
it('settable toggle click sends one 1-entry edit_profile and applies on ack', async () => {
  renderOpen()
  const socket = connect()
  const enable = toggle('Volume Leveler Enable')
  expect(enable.checked).toBe(false) // Music ships dvle=0

  enable.click()
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dvle: [1] },
    },
  ])
  expect(enable.checked).toBe(false)

  await ack(socket, () => {
    expect(enable.checked).toBe(true)
  })
})

// Behavior 2 (#86): the next click writes `[0]`; an experimental toggle
// takes exactly the same path, its card carrying `--exp`.
it('writes 0 on the next click, and experimental toggles take the same path', async () => {
  const panel = renderOpen()
  const socket = connect()
  const enable = toggle('Volume Leveler Enable')
  enable.click()
  await ack(socket, () => {
    expect(enable.checked).toBe(true)
  })

  enable.click()
  expect(sentEdits(socket)[1]?.params).toEqual({ dvle: [0] })
  await ack(socket, () => {
    expect(enable.checked).toBe(false)
  })

  const vis = toggle('Visualizer Enable')
  expect(vis.checked).toBe(true) // Music ships ven=1
  expect(card(panel, 'ven').classList).toContain('adv-card--exp')
  vis.click()
  expect(sentEdits(socket)[2]).toEqual({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    params: { ven: [0] },
  })
  await ack(socket, () => {
    expect(vis.checked).toBe(false)
  })
})

/** A tristate's three radios, Off / On / Auto — values 0 / 1 / 2. */
const tristate = (name: string) => {
  const group = screen.getByRole('radiogroup', { name })
  const [off, on, auto] = within(group).getAllByRole<HTMLInputElement>('radio')
  if (!off || !on || !auto) throw new Error(`${name}: not three radios`)
  expect([off.value, on.value, auto.value]).toEqual(['0', '1', '2'])
  const segText = (radio: HTMLInputElement) =>
    group.querySelector(`label[for="${radio.id}"]`)?.textContent
  expect([off, on, auto].map(segText)).toEqual(['Off', 'On', 'Auto'])
  return { group, off, on, auto }
}

// Behavior 3 (#86): a tristate is a native radio group — Off / On /
// Auto write 0 / 1 / 2 — ack-then-apply like the switch; re-picking
// the checked option writes nothing.
it('tristate: clicking Auto sends [2] and checks on ack; the checked option sends nothing', async () => {
  renderOpen()
  const socket = connect()
  const { off, on, auto } = tristate('Speaker Virtualizer Enable')
  expect([off.checked, on.checked, auto.checked]).toEqual([true, false, false])

  auto.click()
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { vspe: [2] },
    },
  ])
  // Not yet acked: the clicked radio never checked. (happy-dom leaves
  // the group's previous radio unchecked on a cancelled click — real
  // browsers restore it; the Playwright spec covers the group.)
  expect(auto.checked).toBe(false)
  await ack(socket, () => {
    expect([off.checked, auto.checked]).toEqual([false, true])
  })

  auto.click()
  expect(sentEdits(socket)).toHaveLength(1)
  expect(auto.checked).toBe(true)
})

// Behavior 4 (#86): the Source rule's write half — a preset-carried
// toggle writes `edit_eq_preset` on the selected EQ preset and applies
// on the ack; with `None` selected it writes the profile.
it('preset-carried toggle writes edit_eq_preset with a preset selected, edit_profile on None', async () => {
  renderOpen()
  const socket = connect()
  applySnapshot(selectingState('rich'))
  const enable = toggle('Intelligent Equalizer Enable')
  expect(enable.checked).toBe(true) // Rich ships ieon=1

  enable.click()
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_eq_preset',
      request_id: expect.any(String) as string,
      id: 'rich',
      params: { ieon: [0] },
    },
  ])
  expect(enable.checked).toBe(true)
  await ack(socket, () => {
    expect(enable.checked).toBe(false)
  })

  applySnapshot(selectingState(null))
  expect(enable.checked).toBe(false) // Music's own ieon=0
  enable.click()
  expect(sentEdits(socket)[1]).toEqual({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    params: { ieon: [1] },
  })
})

// Behavior 5 (#86): `adv-card--preset` marks the nine preset-carried
// cards and `adv-cat--preset` the `ieq` / `geq` sections while an EQ
// preset is selected — gone on `None`. The skin captions them.
it('publishes --preset on the carried cards and their categories while a preset is selected', () => {
  const panel = renderOpen()
  const presetCards = () =>
    [...panel.querySelectorAll<HTMLElement>('.adv-card--preset')]
      .map((node) => node.querySelector('.adv-card__code')?.textContent)
      .sort()
  const presetSections = () =>
    [...panel.querySelectorAll('.adv-cat--preset')].map((node) =>
      node.getAttribute('aria-label'),
    )
  expect(presetCards()).toEqual([])
  expect(presetSections()).toEqual([])

  applySnapshot(selectingState('rich'))
  expect(presetCards()).toEqual(
    [
      'genb',
      'gebf',
      'geon',
      'gebg',
      'ienb',
      'iebf',
      'ieon',
      'iebt',
      'iea',
    ].sort(),
  )
  expect(presetSections()).toEqual([
    'Intelligent Equalizer',
    'Graphic Equalizer',
  ])

  applySnapshot(selectingState(null))
  expect(presetCards()).toEqual([])
  expect(presetSections()).toEqual([])
})

// Behavior 6 (#86): the card is a `label` for its primary control —
// clicking the card's own text forwards to the switch exactly once; a
// tristate card's `for` is the currently checked radio's id, following
// the value so a label click just focuses the current state.
it('card label text toggles the switch once; a tristate card targets its checked radio', async () => {
  const panel = renderOpen()
  const socket = connect()
  const leveler = card(panel, 'dvle')
  expect(leveler.getAttribute('for')).toBe('adv-dvle')

  leveler.querySelector<HTMLElement>('.adv-card__label')?.click()
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dvle: [1] },
    },
  ])

  const speaker = card(panel, 'vspe')
  const { off, auto } = tristate('Speaker Virtualizer Enable')
  expect(speaker.getAttribute('for')).toBe(off.id)
  auto.click()
  await ack(socket, () => {
    expect(auto.checked).toBe(true)
  })
  expect(speaker.getAttribute('for')).toBe(auto.id)
  // Readouts have no control yet: no `for`.
  expect(card(panel, 'vnnb').hasAttribute('for')).toBe(false)
})

// Behavior 7 (#86): a click inside a control that manages its own focus
// (`.adv-input`, `[role=slider]`, `.adv-bands` — #87 on) never forwards
// to the card's `for` target: no command, focus untouched. None exist
// yet, so the test plants one in a switch card's control region.
it('a click inside a guarded control does not activate the label target', () => {
  const panel = renderOpen()
  const socket = connect()
  const leveler = card(panel, 'dvle')
  const planted = document.createElement('span')
  planted.className = 'adv-input'
  planted.tabIndex = 0
  leveler.querySelector('.adv-card__control')?.append(planted)

  planted.focus()
  planted.click()
  expect(sentEdits(socket)).toEqual([])
  expect(document.activeElement).toBe(planted)
})

// Behavior 8 (#86): an `error` reply leaves the control on daemon
// truth — never flipped — and the client's existing reconcile issues
// `get_state`.
it('an error reply leaves the switch unflipped and reconciles', async () => {
  renderOpen()
  const socket = connect()
  const enable = toggle('Volume Leveler Enable')
  enable.click()
  const sent = sentEdits(socket)
  expect(sent).toHaveLength(1)

  socket.serverMessage({
    type: 'error',
    request_id: sent[0]?.request_id,
    code: 'INVALID_REQUEST',
    message: 'out of range',
  })
  await waitFor(() => {
    const after = socket.sentCommands().slice(-1)
    expect(after.map((frame) => frame.cmd)).toEqual(['get_state'])
  })
  expect(enable.checked).toBe(false)
})
