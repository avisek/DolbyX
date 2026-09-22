import {
  cleanup,
  fireEvent,
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
  fixtureStateWithParams,
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

/** A scalar card's numeric box text. */
const boxText = (panel: HTMLElement, code: string) =>
  card(panel, code).querySelector<HTMLInputElement>('.adv-input__field')?.value

// Behavior 9 (#85): every card reads through the Source rule —
// ReadOnly-Static from the snapshot's Readouts, writable from the
// active profile — `frac_bits` applied. Arrays are still the plain
// readout (#90); scalars read in the numeric box (#87).
it('reads Readouts on static cards and the active profile on writable ones', () => {
  const panel = renderOpen()
  expect(boxText(panel, 'vnnb')).toBe('20')
  expect(readout(panel, 'bver')).toBe('4, 28, 9, 0, 0')
  expect(boxText(panel, 'dvla')).toBe('4') // Music
  expect(boxText(panel, 'dhsb')).toBe('3') // raw 48, 1/16 dB

  applySnapshot(fixtureState({ selected_profile: 'voice' }))
  expect(boxText(panel, 'dvla')).toBe('0')
  expect(boxText(panel, 'dhsb')).toBe('0')
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
  // A read-only scalar's `for` is its readonly box (select / copy);
  // array readouts have no control yet: no `for` (#90).
  expect(card(panel, 'vnnb').getAttribute('for')).toBe('adv-vnnb')
  expect(card(panel, 'vnbf').hasAttribute('for')).toBe(false)
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

// — Numeric input: typing, unit overlay, readonly (#87 part 1) —

const field = (name: string) =>
  screen.getByRole<HTMLInputElement>('textbox', { name })

/** Types `text` into a focused field the way a keyboard would land it. */
function type(input: HTMLInputElement, text: string): void {
  input.focus()
  input.value = text
  input.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

// Behavior 2 (#87): typing a complete number is one live 1-entry
// `edit_profile` against the active profile, in raw units — `3` dB on a
// `frac_bits = 4` param is `[48]` — the slice's tracer bullet.
it('typing 3 into a dB field sends one live edit_profile carrying the raw 48', () => {
  renderOpen()
  const socket = connect()
  type(field('Headphone Virtualizer Surround Boost'), '3')
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dhsb: [48] },
    },
  ])
})

// Behavior 3 (#87): out of range, the wire carries the clamped raw while
// the text stays exactly as typed; blur re-syncs the text to store truth
// and, the value already applied live, commits nothing more.
it('clamps an out-of-range typed value on the wire, keeps the text, re-syncs on blur', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount') // dvla, 0–10
  type(amount, '500')
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dvla: [10] },
  ])
  expect(amount.value).toBe('500')

  amount.blur()
  expect(amount.value).toBe('10')
  expect(sentEdits(socket)).toHaveLength(1)
})

// Behavior 5 (#87): Enter is blur — a typed value the store moved
// under (behavior 7) commits against the new truth and the text
// re-syncs, the field no longer focused; Esc reverts the text to store
// truth without a write.
it('Enter commits and re-syncs; Esc reverts the text without a write', () => {
  renderOpen()
  const socket = connect()
  const boost = field('Headphone Virtualizer Surround Boost')
  type(boost, '2')
  applySnapshot(fixtureStateWithParams({ dhsb: [80] })) // 5 dB
  press(boost, 'Enter')
  expect(boost.value).toBe('5')
  expect(document.activeElement).not.toBe(boost)
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dhsb: [32] }, // live
    { dhsb: [32] }, // the Enter commit, against the changed truth
  ])

  type(boost, '7.') // a partial: nothing written
  press(boost, 'Escape')
  expect(boost.value).toBe('5')
  expect(document.activeElement).not.toBe(boost)
  expect(sentEdits(socket)).toHaveLength(2)
})

// Behavior 4 (#87): partials write nothing; the first complete number
// writes once.
it('ignores partials and writes once on the completed number', () => {
  renderOpen()
  const socket = connect()
  const boost = field('Headphone Virtualizer Surround Boost')
  type(boost, '-')
  type(boost, '1.')
  expect(sentEdits(socket)).toEqual([])
  type(boost, '1.5')
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dhsb: [24] },
  ])
})

// Behavior 8 (#87): a read-only scalar is the same box, `readonly`,
// showing its Readouts value; an Opaque scalar (`lcpt`) reads as a
// read-only Integer. Typing into either writes nothing.
it('read-only scalars render a readonly box that never writes', () => {
  renderOpen()
  const socket = connect()
  const count = field('Visualizer Native Band Count') // vnnb
  expect(count.readOnly).toBe(true)
  expect(count.value).toBe('20')
  type(count, '5')
  count.blur()
  expect(sentEdits(socket)).toEqual([])

  const pointer = field('License Data Pointer') // lcpt, opaque
  expect(pointer.readOnly).toBe(true)
  expect(pointer.closest('.adv-input')).not.toBeNull()
})

// Behavior 1 (#87): the box's DOM contract — the skin's seam — and its
// place: first inside `adv-card__control`, the Slider slot after it.
it('renders a writable dB scalar as the numeric box with a unit overlay, first in the control', () => {
  const panel = renderOpen()
  const boost = field('Headphone Virtualizer Surround Boost')
  expect(boost.type).toBe('text')
  expect(boost.getAttribute('inputmode')).toBe('decimal')
  expect(boost.id).toBe('adv-dhsb')
  expect(boost.readOnly).toBe(false)
  expect(boost.value).toBe('3') // Music: raw 48, frac_bits 4

  const box = boost.parentElement
  expect(box?.tagName).toBe('SPAN')
  expect(box?.classList).toContain('adv-input')
  const unit = box?.querySelector('.adv-input__unit')
  expect(unit?.textContent).toBe('dB')
  const control = card(panel, 'dhsb').querySelector('.adv-card__control')
  expect(control?.firstElementChild).toBe(box)
  expect(card(panel, 'dhsb').getAttribute('for')).toBe('adv-dhsb')
})

// Behavior 9 (#87): the unit overlay is inert chrome — `aria-hidden`,
// present only on unit-bearing kinds — and every numeric box shares the
// one class contract the skin sizes uniformly (geometry: Playwright).
it('unit overlays are aria-hidden and every numeric box shares the class contract', () => {
  const panel = renderOpen()
  // The scalar boxes — direct children of the control; band editors
  // (#90) nest inside strips.
  const boxes = [
    ...panel.querySelectorAll<HTMLElement>('.adv-card__control > .adv-input'),
  ]
  expect(boxes).toHaveLength(30) // the shipped table's numeric scalars
  for (const box of boxes) {
    expect(box.querySelector('.adv-input__field')).not.toBeNull()
    const unit = box.querySelector('.adv-input__unit')
    if (unit) expect(unit.getAttribute('aria-hidden')).toBe('true')
  }
  const unitOf = (code: string) =>
    card(panel, code).querySelector('.adv-input__unit')?.textContent ?? null
  expect(unitOf('dhsb')).toBe('dB')
  expect(unitOf('vol')).toBe('dB')
  expect(unitOf('dvla')).toBeNull() // integer: no overlay
  expect(unitOf('vnnb')).toBeNull()
})

// Behavior 6 (#87): the Source rule's live half — a preset-carried
// numeric param writes `edit_eq_preset` on the selected EQ preset;
// with `None` selected, `edit_profile`.
it('a preset-carried numeric writes the preset while one is selected, else the profile', () => {
  renderOpen()
  const socket = connect()
  applySnapshot(selectingState('rich'))
  const amount = field('Intelligent Equalizer Amount') // iea, 0–16 raw, frac_bits 4
  expect(amount.value).toBe('0.63') // Rich ships iea=10
  type(amount, '0.5')
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_eq_preset',
      request_id: expect.any(String) as string,
      id: 'rich',
      params: { iea: [8] },
    },
  ])
  amount.blur()

  applySnapshot(selectingState(null))
  type(amount, '1')
  expect(sentEdits(socket)[1]).toEqual({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    params: { iea: [16] },
  })
})

// Behavior 7 (#87): the field is uncontrolled while focused — a store
// update never clobbers the typing; on blur the typed value commits
// against the new truth and the field mirrors the store.
it('a store update while focused leaves the typed text; blur re-syncs', () => {
  renderOpen()
  const socket = connect()
  const boost = field('Headphone Virtualizer Surround Boost')
  type(boost, '2')
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dhsb: [32] },
  ])
  applySnapshot(fixtureStateWithParams({ dhsb: [80] })) // 5 dB
  expect(boost.value).toBe('2')

  boost.blur()
  expect(boost.value).toBe('5')
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dhsb: [32] },
    { dhsb: [32] }, // the blur commit, against the changed truth
  ])

  // Store truth is raw: text that rounds to the shown 1/16-dB step
  // (`5.001` over `5`) writes the same raw live and commits nothing.
  type(boost, '5.001')
  boost.blur()
  expect(
    sentEdits(socket)
      .map((frame) => frame.params)
      .slice(2),
  ).toEqual([{ dhsb: [80] }])
})

// Behavior 10 (#87): selected text never starts a drag — `dragstart`
// on the field is default-prevented (the scrub, #88, depends on it).
it('default-prevents dragstart on the field', () => {
  renderOpen()
  const boost = field('Headphone Virtualizer Surround Boost')
  const drag = new Event('dragstart', { bubbles: true, cancelable: true })
  expect(boost.dispatchEvent(drag)).toBe(false)
  expect(drag.defaultPrevented).toBe(true)
})

// — Numeric input: step rule + arrow keys (#87 part 2) —

/** Presses one key on a focused control, with modifiers. */
function press(
  input: HTMLElement,
  key: string,
  mods: { altKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  input.focus()
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  })
  input.dispatchEvent(event)
  return event
}

/** Whether a field's text is fully selected — ready to be typed over. */
const fullySelected = (input: HTMLInputElement) =>
  input.selectionStart === 0 && input.selectionEnd === input.value.length

// Behavior 13 (#87): ↑ steps one display unit under the Step rule —
// Alt the lattice step nearest a tenth (0.125 dB = 2 raw on
// `frac_bits = 4`), Shift ten, clamped — each a live write, each
// leaving the re-synced text selected; the caret never moves — part
// 2's tracer bullet.
it('↑ steps a dB field live: +1, Alt +0.125, Shift +10 clamped, text selected', () => {
  renderOpen()
  const socket = connect()
  const boost = field('Headphone Virtualizer Surround Boost') // dhsb, 0–6 dB, Music 3
  const up = press(boost, 'ArrowUp')
  expect(up.defaultPrevented).toBe(true)
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dhsb: [64] },
    },
  ])
  expect(boost.value).toBe('4')
  expect(fullySelected(boost)).toBe(true)

  press(boost, 'ArrowUp', { altKey: true })
  expect(sentEdits(socket)[1]?.params).toEqual({ dhsb: [66] })
  expect(boost.value).toBe('4.13')
  expect(fullySelected(boost)).toBe(true)

  press(boost, 'ArrowUp', { shiftKey: true })
  expect(sentEdits(socket)[2]?.params).toEqual({ dhsb: [96] })
  expect(boost.value).toBe('6')
  expect(fullySelected(boost)).toBe(true)
  expect(document.activeElement).toBe(boost)
})

// Behavior 14 (#87): a FrequencyHz field steps on the log axis — ↑ from
// 440 Hz is a semitone: 440 × 2^(1/12) = 466.16 → raw 466 (Hz are
// `frac_bits = 0`); Shift ↑ an octave.
it('↑ on a Hz field steps a semitone, Shift an octave', () => {
  renderOpen()
  const socket = connect()
  applySnapshot(fixtureStateWithParams({ dssf: [440] }))
  const start = field('Speaker Virtualizer Start Frequency')
  expect(start.value).toBe('440')
  press(start, 'ArrowUp')
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dssf: [466] },
  ])
  expect(start.value).toBe('466')
  expect(fullySelected(start)).toBe(true)

  press(start, 'ArrowUp', { shiftKey: true })
  expect(sentEdits(socket)[1]?.params).toEqual({ dssf: [932] })
})

// Behavior 15 (#87): a read-only box ignores ↑ / ↓ — no frame, the
// text untouched, the key left to the browser.
it('↑ on a read-only scalar writes nothing and leaves the text', () => {
  renderOpen()
  const socket = connect()
  const count = field('Visualizer Native Band Count') // vnnb
  const up = press(count, 'ArrowUp')
  press(count, 'ArrowDown')
  expect(up.defaultPrevented).toBe(false)
  expect(sentEdits(socket)).toEqual([])
  expect(count.value).toBe('20')
})

// — Pointer-lock scrub (#88) —

/** The `adv-input` wrapper a field sits in — the scrub surface. */
const box = (input: HTMLInputElement): HTMLElement => {
  const wrapper = input.parentElement
  if (!wrapper) throw new Error('field without a wrapper')
  return wrapper
}

/** Whether a field's box publishes `--scrubbing`. */
const scrubbingOn = (input: HTMLInputElement): boolean =>
  box(input).classList.contains('adv-input--scrubbing')

/** The sent edit frames' `params`, oldest first. */
const sentParams = (socket: MockWebSocket): unknown[] =>
  sentEdits(socket).map((frame) => frame.params)

/**
 * happy-dom has no Pointer Lock. The stub emulates the API's observable
 * surface: `requestPointerLock` records the caller, makes it
 * `document.pointerLockElement`, and resolves; `exitPointerLock`
 * releases. Tests swap `requestPointerLock` to a refusal (behavior 10).
 */
const lock: { held: Element | null; requests: Element[]; exits: number } = {
  held: null,
  requests: [],
  exits: 0,
}
// On the instance: happy-dom's `document` doesn't chain to the global
// `Document.prototype`.
Object.defineProperty(document, 'pointerLockElement', {
  configurable: true,
  get: () => lock.held,
})
document.exitPointerLock = () => {
  lock.exits += 1
  lock.held = null
}
HTMLElement.prototype.requestPointerLock = function requestPointerLock() {
  lock.requests.push(this)
  lock.held = this
  return Promise.resolve()
}
beforeEach(() => {
  lock.held = null
  lock.requests = []
  lock.exits = 0
})

/** A press at `clientY` on a field's box, pointer 1, button 0. */
function pressAt(input: HTMLInputElement, clientY: number): void {
  fireEvent.pointerDown(box(input), { pointerId: 1, button: 0, clientY })
}

/** A pre-engage move on the box: the element's own listeners see it. */
function moveTo(input: HTMLInputElement, clientY: number): void {
  fireEvent.pointerMove(box(input), { pointerId: 1, clientY })
}

/** A tracked move — window-level, carrying a locked `movementY`. */
function scrubBy(
  movementY: number,
  mods: { altKey?: boolean; shiftKey?: boolean } = {},
): void {
  fireEvent.pointerMove(window, { pointerId: 1, movementY, ...mods })
}

/** Presses at y = 100 and drags past the 3 px threshold: engaged. */
function engage(input: HTMLInputElement): void {
  pressAt(input, 100)
  moveTo(input, 97)
}

/** The tracked gesture's end — a window-level release. */
function release(): void {
  fireEvent.pointerUp(window, { pointerId: 1, button: 0 })
}

// Tracer bullet (#88): past the threshold the gesture is engaged; one
// window-tracked move of −4 px (up, DPR 1) is one step — raw +1 on
// `dvla` (`frac_bits = 0`, Music 4) — a live `edit_profile`, the field
// focused with its text fully selected as the readout.
it('engages past 3 px, then one −4 px window move steps dvla 4 → 5 live, field selected', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  scrubBy(-4)
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dvla: [5] },
    },
  ])
  expect(amount.value).toBe('5')
  expect(document.activeElement).toBe(amount)
  expect(fullySelected(amount)).toBe(true)
})

// Behavior 5 (#88): a modifier flip mid-gesture rebases — the value
// after the flip continues from the last emitted one, never jumping.
// `vol` (−130…30 dB, `frac_bits = 4`, Music 0): −16 px = +4 dB, then
// one Shift step (10 dB) from there = 14 dB → raws 64, 224.
it('holding Shift mid-scrub switches to 10× steps from the last value, no jump', () => {
  renderOpen()
  const socket = connect()
  const vol = field('Endpoint Volume Volume')
  engage(vol)
  scrubBy(-16)
  scrubBy(-4, { shiftKey: true })
  expect(sentParams(socket)).toEqual([{ vol: [64] }, { vol: [224] }])
  expect(vol.value).toBe('14')
  expect(fullySelected(vol)).toBe(true)
})

// Behavior 6 (#88): pinned at a bound the gesture rebases to it, so
// reversing by one step's px steps off the bound at once — no dead
// travel. `dvla` from 4: −32 px asks for 12, clamps to 10; +4 px → 9.
it('pinning at max then reversing one step emits max − 1 immediately', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  scrubBy(-32)
  scrubBy(4)
  expect(sentParams(socket)).toEqual([{ dvla: [10] }, { dvla: [9] }])
  expect(amount.value).toBe('9')
})

// Behavior 7 (#88): Chromium cancels the wrapper's pointer as the lock
// engages — a `pointercancel` there leaves the gesture running (window
// moves still step); the window `pointerup` ends it (moves after it
// step nothing).
it('a wrapper pointercancel after engage keeps scrubbing; a window pointerup ends it', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  fireEvent.pointerCancel(box(amount), { pointerId: 1 })
  scrubBy(-4)
  expect(sentParams(socket)).toEqual([{ dvla: [5] }])
  release()
  scrubBy(-4)
  expect(sentEdits(socket)).toHaveLength(1)
})

// Behavior 8 (#88): release exits the lock, drops `--scrubbing`, and
// commits the last value once — observable when a peer moved the truth
// mid-gesture (the live writes already applied the rest) — leaving the
// field focused with its text fully selected.
it('release exits the lock, drops --scrubbing, commits the last value, keeps focus + selection', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  expect(lock.held).toBe(box(amount))
  expect(scrubbingOn(amount)).toBe(true)
  scrubBy(-8)
  applySnapshot(fixtureStateWithParams({ dvla: [2] })) // a peer's edit
  release()
  expect(lock.exits).toBe(1)
  expect(lock.held).toBeNull()
  expect(scrubbingOn(amount)).toBe(false)
  expect(sentParams(socket)).toEqual([
    { dvla: [6] }, // live
    { dvla: [6] }, // the release commit, against the changed truth
  ])
  expect(amount.value).toBe('6')
  expect(document.activeElement).toBe(amount)
  expect(fullySelected(amount)).toBe(true)
})

// Behavior 1 (#88): a press without drag is a plain click — the
// `pointerdown` keeps its default (the browser's focus — happy-dom runs
// no default actions, so the un-prevented event stands in; Playwright
// sees the focus itself), no lock is requested, nothing is written, and
// the wrapper's `pointerup` disarms: a later drag past the threshold
// engages nothing.
it('a press released without movement never locks or writes, and disarms', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  const down = new PointerEvent('pointerdown', {
    pointerId: 1,
    button: 0,
    clientY: 100,
    bubbles: true,
    cancelable: true,
  })
  expect(box(amount).dispatchEvent(down)).toBe(true)
  fireEvent.pointerUp(box(amount), { pointerId: 1, button: 0 })
  expect(lock.requests).toEqual([])
  expect(scrubbingOn(amount)).toBe(false)

  moveTo(amount, 90)
  scrubBy(-16)
  expect(lock.requests).toEqual([])
  expect(sentEdits(socket)).toEqual([])
})

// Behavior 2 (#88): two px of travel keep the press a click; the third
// engages — exactly one lock request on the wrapper, `--scrubbing`
// published, the field focused with its text fully selected — and
// further wrapper moves request nothing more.
it('a 2 px move keeps the press armed; the third px engages once', () => {
  renderOpen()
  const amount = field('Volume Leveler Amount')
  pressAt(amount, 100)
  moveTo(amount, 98)
  expect(lock.requests).toEqual([])
  expect(scrubbingOn(amount)).toBe(false)

  moveTo(amount, 97)
  expect(lock.requests).toEqual([box(amount)])
  expect(scrubbingOn(amount)).toBe(true)
  expect(document.activeElement).toBe(amount)
  expect(fullySelected(amount)).toBe(true)

  moveTo(amount, 80)
  expect(lock.requests).toHaveLength(1)
})

// Behavior 3 (#88): one tracked move of −16 px (up, DPR 1) is four
// steps at 4 px each — one live frame carrying raw 4 + 4 = 8 on `dvla`.
it('a −16 px window move at DPR 1 is four steps: dvla 4 → 8 in one frame', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  scrubBy(-16)
  expect(sentParams(socket)).toEqual([{ dvla: [8] }])
  expect(amount.value).toBe('8')
})

// Behavior 4 (#88): locked `movementY` is device px — at DPR 2 the same
// −16 is 8 css px, two steps: dvla 4 → 6. Scrubbing feels the same on
// every display.
it('at devicePixelRatio 2 a locked −16 px move is two steps', () => {
  vi.stubGlobal('devicePixelRatio', 2)
  try {
    renderOpen()
    const socket = connect()
    const amount = field('Volume Leveler Amount')
    engage(amount)
    scrubBy(-16)
    expect(sentParams(socket)).toEqual([{ dvla: [6] }])
  } finally {
    vi.stubGlobal('devicePixelRatio', 1)
  }
})

// Behavior 9 (#88): a read-only box never scrubs — no `--scrub`
// capability, a press-drag requests no lock and writes nothing.
it('a read-only box publishes no --scrub and never arms', () => {
  renderOpen()
  const socket = connect()
  const count = field('Visualizer Native Band Count') // vnnb
  expect(box(count).classList.contains('adv-input--scrub')).toBe(false)
  expect(box(field('Volume Leveler Amount')).classList).toContain(
    'adv-input--scrub',
  )
  engage(count)
  scrubBy(-16)
  expect(lock.requests).toEqual([])
  expect(scrubbingOn(count)).toBe(false)
  expect(sentEdits(socket)).toEqual([])
  expect(count.value).toBe('20')
})

// Behavior 10 (#88): the lock is best-effort — refused synchronously or
// by a rejected promise (a window without focus), the gesture scrubs on
// unlocked movement deltas.
it('scrubs on plain movement when requestPointerLock throws or rejects', async () => {
  const request = vi.spyOn(HTMLElement.prototype, 'requestPointerLock')
  try {
    renderOpen()
    const socket = connect()
    const amount = field('Volume Leveler Amount')

    request.mockImplementation(() => {
      throw new Error('refused')
    })
    engage(amount)
    scrubBy(-4)
    release()
    expect(sentParams(socket)).toEqual([{ dvla: [5] }])

    request.mockImplementation(() => Promise.reject(new Error('refused')))
    engage(amount)
    scrubBy(-4)
    release()
    await Promise.resolve() // the rejection settles, handled
    expect(sentParams(socket)).toEqual([{ dvla: [5] }, { dvla: [6] }])
  } finally {
    request.mockRestore()
  }
})

// (#88) Unlocked deltas are css px already: with the lock refused at
// DPR 2, −16 px is still four steps — the fallback never under-scales
// on hiDPI.
it('with the lock refused at devicePixelRatio 2, −16 px is still four steps', () => {
  const request = vi
    .spyOn(HTMLElement.prototype, 'requestPointerLock')
    .mockImplementation(() => Promise.reject(new Error('refused')))
  vi.stubGlobal('devicePixelRatio', 2)
  try {
    renderOpen()
    const socket = connect()
    const amount = field('Volume Leveler Amount')
    engage(amount)
    scrubBy(-16)
    expect(sentParams(socket)).toEqual([{ dvla: [8] }])
  } finally {
    vi.stubGlobal('devicePixelRatio', 1)
    request.mockRestore()
  }
})

// Behavior 11 (#88): the selected text never starts a text drag —
// `dragstart` on the field is default-prevented while scrubbing too.
it('default-prevents dragstart on the selected field mid-scrub', () => {
  renderOpen()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  expect(fullySelected(amount)).toBe(true)
  const drag = new Event('dragstart', { bubbles: true, cancelable: true })
  expect(amount.dispatchEvent(drag)).toBe(false)
})

// (#88) Losing the window mid-gesture would strand the lock: a window
// `blur` ends the scrub like a release — lock exited, `--scrubbing`
// dropped, later moves step nothing.
it('a window blur mid-scrub ends the gesture', () => {
  renderOpen()
  const socket = connect()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  scrubBy(-4)
  fireEvent.blur(window)
  expect(lock.held).toBeNull()
  expect(scrubbingOn(amount)).toBe(false)
  scrubBy(-4)
  expect(sentParams(socket)).toEqual([{ dvla: [5] }])
})

// (#88) The compat `click` the browser fires after the release would
// place a caret in the field — after a scrub it re-selects instead;
// a click without a scrub behind it is left alone (caret placement for
// typing).
it('the compat click after a scrub re-selects the text; a plain click does not', () => {
  renderOpen()
  const amount = field('Volume Leveler Amount')
  engage(amount)
  scrubBy(-4)
  release()
  amount.setSelectionRange(1, 1) // what the click's default would leave
  fireEvent.click(box(amount))
  expect(fullySelected(amount)).toBe(true)

  amount.setSelectionRange(1, 1)
  fireEvent.click(box(amount))
  expect(fullySelected(amount)).toBe(false)
})

// — Slider (#89) —

const slider = (name: string) => screen.getByRole('slider', { name })

// Tracer bullet (#89): → on `dhsb`'s Slider is one step under the Step
// rule — +1 dB, raw 48 + 16 — a live 1-entry `edit_profile` on the
// active profile, the key consumed.
it('→ on the dhsb slider sends one live edit_profile carrying raw 64', () => {
  renderOpen()
  const socket = connect()
  const right = press(
    slider('Headphone Virtualizer Surround Boost'),
    'ArrowRight',
  )
  expect(right.defaultPrevented).toBe(true)
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dhsb: [64] },
    },
  ])
})

/** A slider's published var, as a number. */
const sliderVar = (node: HTMLElement, name: '--value' | '--norm') =>
  Number(node.style.getPropertyValue(name))

// Behavior 4 (#89): `--norm` is the track position — a FrequencyHz
// slider at 200 Hz over 20–20000 sits at 1/3 (log: 200 is one decade
// of three above 20), a linear axis at its midpoint at 0.5; `--value`
// is the display value.
it('publishes --norm log for Hz (200 Hz → 1/3) and linear otherwise (midpoint → 0.5)', () => {
  renderOpen()
  applySnapshot(fixtureStateWithParams({ dssf: [200] }))
  const start = slider('Speaker Virtualizer Start Frequency')
  expect(sliderVar(start, '--norm')).toBeCloseTo(1 / 3, 10)
  expect(sliderVar(start, '--value')).toBe(200)

  const boost = slider('Headphone Virtualizer Surround Boost') // 0–6 dB, Music 3
  expect(sliderVar(boost, '--norm')).toBe(0.5)
  expect(sliderVar(boost, '--value')).toBe(3)

  applySnapshot(fixtureStateWithParams({ dssf: [20], dhsb: [96] }))
  expect(sliderVar(start, '--norm')).toBe(0)
  expect(sliderVar(boost, '--norm')).toBe(1)
})

/** A slider's track, its box mocked to `left 0, width 200` — happy-dom
 * lays nothing out; the drag math reads this rect. */
function mockTrack(node: HTMLElement): HTMLElement {
  const track = node.querySelector<HTMLElement>('.adv-slider__track')
  if (!track) throw new Error('slider without a track')
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 200,
  } as DOMRect)
  return track
}

/** A press on a slider's track at `clientX`, pointer 1, button 0. */
const pressTrack = (node: HTMLElement, clientX: number) =>
  fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX })

// Behavior 5 (#89): a press maps absolute x over the track — x 100 of
// 200 on `dhsb` (0–6 dB) is 3 dB, raw 48 on the 1/16-dB lattice — one
// live frame; the slider takes focus, the box does not. The release
// commits the last value through the box's guarded commit (#87): the
// live write already landed it, so a plain release sends nothing; a
// peer's edit mid-drag makes the release re-assert the drag's end.
it('a press at the track midpoint writes the lattice-snapped raw live; release commits only over a peer edit; slider focused', () => {
  renderOpen()
  const socket = connect()
  applySnapshot(fixtureStateWithParams({ dhsb: [0] }))
  const boost = slider('Headphone Virtualizer Surround Boost')
  mockTrack(boost)
  pressTrack(boost, 100)
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dhsb: [48] },
    },
  ])
  expect(document.activeElement).toBe(boost)
  expect(document.activeElement).not.toBe(
    field('Headphone Virtualizer Surround Boost'),
  )
  fireEvent.pointerUp(boost, { pointerId: 1, button: 0 })
  expect(sentParams(socket)).toEqual([{ dhsb: [48] }]) // nothing to commit

  pressTrack(boost, 100)
  applySnapshot(fixtureStateWithParams({ dhsb: [80] })) // a peer's edit
  fireEvent.pointerUp(boost, { pointerId: 1, button: 0 })
  expect(sentParams(socket)).toEqual([
    { dhsb: [48] },
    { dhsb: [48] }, // the second press, live
    { dhsb: [48] }, // the release commit, against the changed truth
  ])
  // Released: further moves write nothing.
  fireEvent.pointerMove(boost, { pointerId: 1, clientX: 150 })
  expect(sentEdits(socket)).toHaveLength(3)
})

// Behavior 5 (#89): a move while pressed follows x — one live frame
// per change, none for a move that lands on the same lattice value.
it('moves while pressed write live on change only', () => {
  renderOpen()
  const socket = connect()
  const amount = slider('Volume Leveler Amount') // dvla, 0–10, Music 4
  mockTrack(amount)
  pressTrack(amount, 0)
  fireEvent.pointerMove(amount, { pointerId: 1, clientX: 60 })
  fireEvent.pointerMove(amount, { pointerId: 1, clientX: 61 })
  fireEvent.pointerMove(amount, { pointerId: 1, clientX: 400 }) // past the end
  expect(sentParams(socket)).toEqual([
    { dvla: [0] },
    { dvla: [3] },
    { dvla: [10] },
  ])
})

// Behavior 7 (#89): a log drag — x at 50 % of a 20–20000 track is
// 20 · 1000^0.5 = 632.46 Hz, rounded to the integer lattice: raw 632.
it('a press at 50 % of a Hz track writes raw 632', () => {
  renderOpen()
  const socket = connect()
  const start = slider('Speaker Virtualizer Start Frequency') // dssf
  mockTrack(start)
  pressTrack(start, 100)
  expect(sentParams(socket)).toEqual([{ dssf: [632] }])
})

// Behavior 9 (#89): a read-only scalar's slider is disabled —
// `adv-slider--disabled`, `aria-disabled`, out of the tab order — keys
// and pointer write nothing, and `--norm` is still published so the
// skin can show the value muted. An Opaque scalar (`lcpt`) is the same.
it('read-only scalars render a disabled slider that never writes but publishes --norm', () => {
  renderOpen()
  const socket = connect()
  const count = slider('Visualizer Native Band Count') // vnnb, 1–20, reads 20
  expect(count.classList).toContain('adv-slider--disabled')
  expect(count.getAttribute('aria-disabled')).toBe('true')
  expect(count.tabIndex).toBe(-1)
  expect(sliderVar(count, '--norm')).toBe(1)
  expect(sliderVar(count, '--value')).toBe(20)

  const left = press(count, 'ArrowLeft')
  press(count, 'Home')
  expect(left.defaultPrevented).toBe(false)
  mockTrack(count)
  pressTrack(count, 0)
  fireEvent.pointerMove(count, { pointerId: 1, clientX: 100 })
  fireEvent.pointerUp(count, { pointerId: 1, button: 0 })
  expect(sentEdits(socket)).toEqual([])

  const pointer = slider('License Data Pointer') // lcpt, opaque, 0–255
  expect(pointer.classList).toContain('adv-slider--disabled')
  expect(sliderVar(pointer, '--norm')).toBe(0)
  expect(slider('Volume Leveler Amount').tabIndex).toBe(0)
  expect(slider('Volume Leveler Amount').classList).not.toContain(
    'adv-slider--disabled',
  )
})

// Behavior 1 (#89): every numeric scalar card is the box followed by
// the Slider — 30 in the shipped table — and no native range input
// exists anywhere in the panel: the Slider is the skinnable control.
it('every numeric scalar renders the box then a role=slider; no input[type=range]', () => {
  const panel = renderOpen()
  const sliders = panel.querySelectorAll('[role=slider]')
  expect(sliders).toHaveLength(30)
  for (const node of sliders) {
    expect(node.tagName).toBe('DIV')
    expect(node.classList).toContain('adv-slider')
    const box = node.previousElementSibling
    expect(box?.querySelector('.adv-input__field')).not.toBeNull()
    expect(node.parentElement?.classList).toContain('adv-card__control')
    const track = node.querySelector('.adv-slider__track')
    expect(track?.getAttribute('aria-hidden')).toBe('true')
    expect(track?.querySelector('.adv-slider__fill')).not.toBeNull()
    expect(track?.querySelector('.adv-slider__thumb')).not.toBeNull()
  }
  expect(panel.querySelectorAll('input[type=range]')).toHaveLength(0)
  // The box stays the card's `for` target.
  expect(card(panel, 'dhsb').getAttribute('for')).toBe('adv-dhsb')
})

// Behavior 2 (#89): `aria-valuemin / max / now` are display units and
// `aria-valuetext` reads `3 dB` for a Decibel at raw 48; a unit-less
// kind has no valuetext.
it('aria-value* are display units; valuetext carries the unit', () => {
  renderOpen()
  const boost = slider('Headphone Virtualizer Surround Boost') // dhsb 0–96 raw
  expect(boost.getAttribute('aria-valuemin')).toBe('0')
  expect(boost.getAttribute('aria-valuemax')).toBe('6')
  expect(boost.getAttribute('aria-valuenow')).toBe('3')
  expect(boost.getAttribute('aria-valuetext')).toBe('3 dB')

  const amount = slider('Volume Leveler Amount') // dvla, 0–10
  expect(amount.getAttribute('aria-valuemax')).toBe('10')
  expect(amount.getAttribute('aria-valuenow')).toBe('4')
  expect(amount.hasAttribute('aria-valuetext')).toBe(false)

  applySnapshot(fixtureStateWithParams({ dhsb: [66] }))
  expect(boost.getAttribute('aria-valuenow')).toBe('4.13')
  expect(boost.getAttribute('aria-valuetext')).toBe('4.13 dB')
})

// Behavior 3 (#89): the keys, each a live write from the store's
// (optimistically applied) truth on `vol` (−130…30 dB, `frac_bits =
// 4`, Music 0): ← −1 dB, Shift+← −10, Alt+← −0.125 (2 raw), PageUp the
// Shift step whatever is held, Home / End the bounds; ↑ / ↓ are → / ←.
// Every handled key is consumed; an unhandled one is not.
it('slider keys step live: ← −1, Shift −10, Alt −0.125, PageUp +10, Home/End bounds', () => {
  renderOpen()
  const socket = connect()
  const vol = slider('Endpoint Volume Volume')
  press(vol, 'ArrowLeft')
  press(vol, 'ArrowLeft', { shiftKey: true })
  press(vol, 'ArrowLeft', { altKey: true })
  press(vol, 'PageUp', { altKey: true })
  press(vol, 'PageDown')
  press(vol, 'ArrowUp')
  press(vol, 'ArrowDown', { shiftKey: true })
  const home = press(vol, 'Home')
  press(vol, 'End')
  const tab = press(vol, 'Tab')
  expect(sentParams(socket)).toEqual([
    { vol: [-16] }, // −1 dB
    { vol: [-176] }, // −11
    { vol: [-178] }, // −11.125
    { vol: [-18] }, // −1.125
    { vol: [-178] }, // −11.125
    { vol: [-162] }, // −10.125
    { vol: [-322] }, // −20.125
    { vol: [-2080] }, // −130
    { vol: [480] }, // 30
  ])
  expect(sentEdits(socket).every((frame) => frame.cmd === 'edit_profile')).toBe(
    true,
  )
  expect(home.defaultPrevented).toBe(true)
  expect(tab.defaultPrevented).toBe(false)
  expect(vol.getAttribute('aria-valuenow')).toBe('30')
  expect(document.activeElement).toBe(vol)
})

// Behavior 6 (#89): a press on the slider never reaches the box — the
// slider cancels its `click`, so the card `<label>` forwards nothing:
// the slider keeps the focus it took, the box never gets it.
it('a press + click on the slider keeps focus on the slider, never the box', () => {
  renderOpen()
  const socket = connect()
  const boost = slider('Headphone Virtualizer Surround Boost')
  const box = field('Headphone Virtualizer Surround Boost')
  mockTrack(boost)
  const down = new PointerEvent('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 100,
    bubbles: true,
    cancelable: true,
  })
  expect(boost.dispatchEvent(down)).toBe(false)
  fireEvent.pointerUp(boost, { pointerId: 1, button: 0 })
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  expect(boost.dispatchEvent(click)).toBe(false)
  expect(document.activeElement).toBe(boost)
  expect(document.activeElement).not.toBe(box)
  // Music's dhsb is already 3 dB: the press wrote the midpoint live,
  // the release had nothing left to commit.
  expect(sentParams(socket)).toEqual([{ dhsb: [48] }])
})

// Behavior 8 (#89): the Source rule — a preset-carried slider writes
// `edit_eq_preset` on the selected EQ preset (`iea`, Rich 0.625, Alt+←
// = −0.125 → raw 8); with `None` selected, `edit_profile`.
it('a preset-carried slider writes the preset while one is selected, else the profile', () => {
  renderOpen()
  const socket = connect()
  applySnapshot(selectingState('rich'))
  const amount = slider('Intelligent Equalizer Amount')
  expect(amount.getAttribute('aria-valuenow')).toBe('0.63')
  press(amount, 'ArrowLeft', { altKey: true })
  expect(sentEdits(socket)).toEqual([
    {
      cmd: 'edit_eq_preset',
      request_id: expect.any(String) as string,
      id: 'rich',
      params: { iea: [8] },
    },
  ])

  applySnapshot(selectingState(null))
  expect(amount.getAttribute('aria-valuenow')).toBe('0.63') // Music's own iea=10
  press(amount, 'End')
  expect(sentEdits(socket)[1]).toEqual({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    params: { iea: [16] },
  })
})

// — Band arrays: the Band strip, its vars, the effective count (#90 part 1) —

/** A 40-slot ramp from `min`: value = min + band · step. */
const ramp40 = (min: number, step: number) =>
  Array.from({ length: 40 }, (_slot, band) => min + band * step)

const strip = (panel: HTMLElement, code: string) => {
  const found = card(panel, code).querySelector<HTMLElement>(
    '.adv-bands__strip',
  )
  if (!found) throw new Error(`no strip for ${code}`)
  return found
}

const bands = (node: HTMLElement) => [
  ...node.querySelectorAll<HTMLElement>('.adv-bands__band'),
]

/** The `--value` / `--norm` a band's bar publishes, as numbers. */
const barVars = (band: HTMLElement) => {
  const bar = band.querySelector<HTMLElement>('.adv-bands__bar')
  if (!bar) throw new Error('no bar')
  return { value: sliderVar(bar, '--value'), norm: sliderVar(bar, '--norm') }
}

// Behavior 1 (#90): a 40-slot `gebg` under `genb = 10` is one strip
// carrying `--count: 10` with exactly 10 bands; each bar publishes the
// display value and the *linear* position over `[min, max]` — band 3
// at raw −480 on −576…576 dB/16 is −30 dB, (−480 + 576) / 1152.
it('renders a gebg strip of genb bands publishing --count, --value and --norm', () => {
  const panel = renderOpen()
  applySnapshot(fixtureStateWithParams({ genb: [10], gebg: ramp40(-576, 48) }))
  const gains = strip(panel, 'gebg')
  expect(gains.style.getPropertyValue('--count')).toBe('10')
  expect(
    card(panel, 'gebg').querySelectorAll('.adv-bands__strip'),
  ).toHaveLength(1)
  const all = bands(gains)
  expect(all).toHaveLength(10)
  expect(barVars(all[2] as HTMLElement)).toEqual({
    value: -30,
    norm: 96 / 1152,
  })
  expect(barVars(all[0] as HTMLElement)).toEqual({ value: -36, norm: 0 })
  expect(all[2]?.getAttribute('title')).toBe('gebg[3] = -30 dB')
})

// Behavior 2 (#90): the count follows the group's `*nb` — a snapshot
// with `genb = 20` re-renders 20 bands; `45` clamps to the 40-slot
// allocation.
it('re-renders the strip on a genb change and clamps to the allocation', () => {
  const panel = renderOpen()
  applySnapshot(fixtureStateWithParams({ genb: [10], gebg: ramp40(-576, 48) }))
  expect(bands(strip(panel, 'gebg'))).toHaveLength(10)

  applySnapshot(fixtureStateWithParams({ genb: [20], gebg: ramp40(-576, 48) }))
  expect(bands(strip(panel, 'gebg'))).toHaveLength(20)
  expect(strip(panel, 'gebg').style.getPropertyValue('--count')).toBe('20')

  applySnapshot(fixtureStateWithParams({ genb: [45], gebg: ramp40(-576, 48) }))
  expect(bands(strip(panel, 'gebg'))).toHaveLength(40)
  expect(strip(panel, 'gebg').style.getPropertyValue('--count')).toBe('40')
})

// Behavior 3 (#90): a FrequencyHz array's bars are linear over
// [20, 20000] — 200 Hz sits at (200 − 20) / 19980 ≈ 0.009, not at
// the log position (≈ 0.33) the Slider would use.
it('publishes a linear --norm on a Hz band array', () => {
  const panel = renderOpen()
  applySnapshot(
    fixtureStateWithParams({ gebf: [200, ...ramp40(20, 100).slice(1)] }),
  )
  const first = bands(strip(panel, 'gebf'))[0] as HTMLElement
  expect(barVars(first).value).toBe(200)
  expect(barVars(first).norm).toBeCloseTo(180 / 19980, 6)
  expect(barVars(first).norm).toBeLessThan(0.01)
  expect(first.getAttribute('title')).toBe('gebf[1] = 200 Hz')
})

/** Music selecting `presetId`, with distinguishable `iebt` curves on
 * both sides: the profile's ramps up from −30 dB, Rich's from +30. */
function selectingIebt(presetId: string | null) {
  const seeded = selectingState(presetId)
  return {
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === 'music'
        ? { ...profile, params: { ...profile.params, iebt: ramp40(-480, 16) } }
        : profile,
    ),
    eq_presets: seeded.eq_presets.map((preset) =>
      preset.id === 'rich'
        ? { ...preset, params: { ...preset.params, iebt: ramp40(480, -16) } }
        : preset,
    ),
  }
}

// Behavior 4 (#90): the Source rule — a preset-carried array reads the
// selected EQ preset's values while one is selected, the profile's own
// after `None`.
it('reads a preset-carried band array from the selected EQ preset, else the profile', () => {
  const panel = renderOpen()
  applySnapshot(selectingIebt('rich'))
  const targets = () => bands(strip(panel, 'iebt'))
  expect(targets()).toHaveLength(20) // Rich's ienb
  expect(barVars(targets()[0] as HTMLElement).value).toBe(30)
  expect(barVars(targets()[1] as HTMLElement).value).toBe(29)

  applySnapshot(selectingIebt(null))
  expect(barVars(targets()[0] as HTMLElement).value).toBe(-30)
  expect(barVars(targets()[1] as HTMLElement).value).toBe(-29)
})

const meta = (panel: HTMLElement, code: string) =>
  card(panel, code).querySelector('.adv-bands__meta')

// Behavior 5 (#90): hovering a band marks it (`--hover`) and puts
// `band N · value unit` on the meta line; leaving the strip restores
// the count summary.
it('hover marks the band and describes it on the meta line; leaving restores the summary', () => {
  const panel = renderOpen()
  applySnapshot(fixtureStateWithParams({ genb: [10], gebg: ramp40(-576, 48) }))
  const gains = strip(panel, 'gebg')
  const line = meta(panel, 'gebg')
  expect(line?.getAttribute('aria-live')).toBe('polite')
  expect(line?.textContent).toBe('10 of 40 bands · dB')

  const fifth = bands(gains)[4] as HTMLElement
  fireEvent.pointerMove(fifth.querySelector('.adv-bands__bar') as Element)
  expect(fifth.classList).toContain('adv-bands__band--hover')
  expect(line?.textContent).toBe('band 5 · -24 dB')
  expect(
    bands(gains).filter((band) =>
      band.classList.contains('adv-bands__band--hover'),
    ),
  ).toHaveLength(1)

  fireEvent.pointerMove(bands(gains)[0] as HTMLElement)
  expect(fifth.classList).not.toContain('adv-bands__band--hover')
  expect(line?.textContent).toBe('band 1 · -36 dB')

  fireEvent.pointerLeave(gains)
  expect(
    bands(gains).some((band) =>
      band.classList.contains('adv-bands__band--hover'),
    ),
  ).toBe(false)
  expect(line?.textContent).toBe('10 of 40 bands · dB')
})

/** A section's Tab stops in DOM order — focusable, enabled, in the
 * sequential order. */
const tabStops = (section: HTMLElement) =>
  [
    ...section.querySelectorAll<HTMLElement>('button, input, [tabindex]'),
  ].filter(
    (node) => !(node as HTMLButtonElement).disabled && node.tabIndex >= 0,
  )

// Behavior 6 (#90): the strip is one Tab stop — `tabindex=0`, named —
// and every editor inside is `tabindex=-1`, `readonly`: Tab from the
// previous card lands on the strip, never on a band input.
it('the strip is the one Tab stop; band editors are readonly and out of the sequence', () => {
  const panel = renderOpen()
  const gains = strip(panel, 'gebg')
  expect(gains.tabIndex).toBe(0)
  expect(gains.getAttribute('role')).toBe('group')
  expect(gains.getAttribute('aria-label')).toBe('Graphic Equalizer Band Gains')
  const editors = [...gains.querySelectorAll<HTMLInputElement>('input')]
  expect(editors).toHaveLength(20)
  for (const editor of editors) {
    expect(editor.tabIndex).toBe(-1)
    expect(editor.readOnly).toBe(true)
  }
  expect(editors[0]?.id).toBe('adv-gebg-b0')
  expect(card(panel, 'gebg').getAttribute('for')).toBe('adv-gebg-b0')

  // The section's Tab sequence: from `genb`'s Slider to `gebf`'s strip
  // to `gebg`'s — no band editor anywhere in it.
  const geq = screen.getByRole('region', { name: 'Graphic Equalizer' })
  const stops = tabStops(geq)
  expect(stops.slice(-3)).toEqual([
    slider('Graphic Equalizer Band Count'),
    strip(panel, 'gebf'),
    gains,
  ])
  expect(stops.some((node) => node.closest('.adv-bands__band'))).toBe(false)
})

// Behavior 7 (#90): a band card is a normal card — nothing in it spans
// the row; layout is the skin's (ADR-0011).
it('a band card carries no row span — no grid-column inline style or class', () => {
  const panel = renderOpen()
  const node = card(panel, 'gebg')
  expect(node.getAttribute('style')).toBeNull()
  expect([...node.classList]).toEqual(['adv-card', 'adv-card--array'])
  for (const child of node.querySelectorAll<HTMLElement>('*')) {
    expect(child.style.gridColumn).toBe('')
    expect([...child.classList].some((name) => /span|full/.test(name))).toBe(
      false,
    )
  }
})
