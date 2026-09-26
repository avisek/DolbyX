import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import {
  fixtureBootstrap,
  fixtureState,
  fixtureStateWithParams,
} from '../test/fixture'

// The store and the parameter table both read window.__BOOTSTRAP__ at
// module init (ADR-0006) — install the fixture before the dynamic
// imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: MasterControls } = await import('./MasterControls')
const { applySnapshot } = await import('../store/state')
const { startWs, stopWs } = await import('../store/ws')

beforeEach(() => {
  MockWebSocket.reset()
  // The store module is a singleton — re-seed it between tests.
  applySnapshot(fixtureState())
})

afterEach(() => {
  stopWs()
  cleanup()
})

/** Renders the controls and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <MasterControls />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

const enableSwitch = (label: string) =>
  screen.getByRole<HTMLInputElement>('switch', { name: `${label} enable` })
const amountSlider = (label: string) =>
  screen.getByRole('slider', { name: `${label} amount` })
const amountBox = (label: string) =>
  screen.getByRole<HTMLInputElement>('textbox', { name: `${label} amount` })
/** A Row by its title text. */
const row = (label: string) =>
  screen.getByText(label).closest<HTMLLabelElement>('.master-control')

/** The `edit_profile` frames the client sent. */
function sentEdits(socket: MockWebSocket) {
  return socket.sentCommands().filter((frame) => frame.cmd === 'edit_profile')
}

// Tracer bullet (#93, behavior 3): each Master control is a Row — a
// `label` for its enable switch — so a click on the title is the
// switch's click: one 1-entry `edit_profile` for the enable param,
// flipped only on the ack.
it('a row is a label for its switch: clicking the title sends the enable edit, flipped on ack', async () => {
  const socket = renderConnected()
  const leveller = row('Volume Leveller')
  const toggle = enableSwitch('Volume Leveller')
  expect(leveller?.tagName).toBe('LABEL')
  expect(leveller?.htmlFor).toBe(toggle.id)

  screen.getByText('Volume Leveller').click() // Music ships dvle=0
  const sent = sentEdits(socket)
  expect(sent).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dvle: [1] },
    },
  ])
  expect(toggle.checked).toBe(false)
  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(toggle.checked).toBe(true)
  })
})

// Behavior 1 (#22, #93): three Rows in the original's order, curated
// labels, each resolved against the bootstrap table on the shared
// controls; switches read the active profile; no 4-CC text, no native
// range input.
it('renders the three rows resolved against the bootstrap table', () => {
  const { container } = render(() => <MasterControls />)

  const rows = container.querySelectorAll<HTMLLabelElement>(
    'label.master-control',
  )
  expect(
    [...rows].map(
      (el) => el.querySelector('.master-control__label')?.textContent,
    ),
  ).toEqual(['Surround Virtualizer', 'Dialog Enhancer', 'Volume Leveller'])
  const switches = screen.getAllByRole<HTMLInputElement>('switch')
  expect(switches.map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
    'Surround Virtualizer enable',
    'Dialog Enhancer enable',
    'Volume Leveller enable',
  ])
  expect([...rows].map((el) => el.htmlFor)).toEqual(switches.map((s) => s.id))
  // Music: vdhe=2 (on), deon=1 (on), dvle=0 (off).
  expect(switches.map((toggle) => toggle.checked)).toEqual([true, true, false])
  expect(container.textContent).not.toMatch(/vdhe|dhsb|deon|dea|dvle|dvla/)
  expect(container.querySelector('input[type=range]')).toBeNull()
  // Ids are the row's own — the panel's `adv-<4-CC>` render the same params.
  expect(switches.map((s) => s.id)).toEqual([
    'master-vdhe',
    'master-deon',
    'master-dvle',
  ])
  expect(amountBox('Dialog Enhancer').id).toBe('master-dea')
})

// Behavior 2 (#93): the box shows the display value with the unit
// overlay; the Slider exposes `aria-value*` in display units and
// `--norm`.
it('shows display values in the box + unit, and on the Slider as aria-value* + --norm', () => {
  render(() => <MasterControls />)

  // dhsb: 0..96 raw, frac_bits 4 ⇒ a 0..6 dB axis; Music dhsb=48 → 3 dB.
  const surround = amountSlider('Surround Virtualizer')
  expect([
    surround.getAttribute('aria-valuemin'),
    surround.getAttribute('aria-valuemax'),
    surround.getAttribute('aria-valuenow'),
  ]).toEqual(['0', '6', '3'])
  expect(surround.style.getPropertyValue('--norm')).toBe('0.5')
  const surroundBox = amountBox('Surround Virtualizer')
  expect(surroundBox.value).toBe('3')
  expect(
    surroundBox.parentElement?.querySelector('.adv-input__unit')?.textContent,
  ).toBe('dB')

  // dvla: 0..10 raw, frac_bits 0 ⇒ a plain 0..10 axis, no unit; Music dvla=4.
  const leveller = amountSlider('Volume Leveller')
  expect([
    leveller.getAttribute('aria-valuemin'),
    leveller.getAttribute('aria-valuemax'),
    leveller.getAttribute('aria-valuenow'),
  ]).toEqual(['0', '10', '4'])
  expect(leveller.style.getPropertyValue('--norm')).toBe('0.4')
  const levellerBox = amountBox('Volume Leveller')
  expect(levellerBox.value).toBe('4')
  expect(
    levellerBox.parentElement?.querySelector('.adv-input__unit'),
  ).toBeNull()
})

// Behavior 3 (#93), the guard: a click inside the box — its wrapper,
// where a browser would otherwise forward to the `for` target — never
// reaches the switch: no command, focus stays in the box.
it('a click inside the box sends nothing and keeps focus in the box', () => {
  const socket = renderConnected()
  const box = amountBox('Volume Leveller')
  box.focus()
  box.parentElement?.click() // the `.adv-input` wrapper
  expect(sentEdits(socket)).toEqual([])
  expect(document.activeElement).toBe(box)
  expect(enableSwitch('Volume Leveller').checked).toBe(false)
})

// Behavior 4 (#22, #93): the Surround Virtualizer enable maps per
// `Tristate { on: 2 }` — off writes 0, on writes 2, never 1.
it('Surround Virtualizer toggles between 0 and 2, never 1', () => {
  const socket = renderConnected()
  const toggle = enableSwitch('Surround Virtualizer')

  toggle.click() // Music ships vdhe=2 (on) — toggling turns it off
  expect(sentEdits(socket)[0]?.params).toEqual({ vdhe: [0] })

  // Voice ships vdhe=0 (off) — from there, "on" is the auto value 2.
  applySnapshot(fixtureState({ selected_profile: 'voice' }))
  toggle.click()
  expect(sentEdits(socket)[1]).toEqual({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'voice',
    params: { vdhe: [2] },
  })
})

// Behavior 5 (#93): typing into the box is the live path — every
// keystroke that parses is a clamped `edit_profile`, partials ignored,
// the text never fought.
it('typing into Dialog Enhancer’s box writes live per parseable keystroke', () => {
  const socket = renderConnected()
  const box = amountBox('Dialog Enhancer')
  box.focus()
  for (const text of ['0', '0.', '0.5']) {
    box.value = text
    fireEvent.input(box)
  }
  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dea: [0] },
    { dea: [8] }, // 0.5 dB × 16
  ])
  expect(box.value).toBe('0.5')
})

// Behavior 5 (#93): ↑ on the box and ArrowRight on the Slider share the
// Step rule — one display unit (16 raw on dea), Shift ten (160 raw)
// clamped to the range.
it('↑ on the box and ArrowRight on the Slider step by the Step rule, clamped', () => {
  const socket = renderConnected()
  applySnapshot(fixtureStateWithParams({ dea: [0] }))
  const box = amountBox('Dialog Enhancer')
  const slider = amountSlider('Dialog Enhancer')

  fireEvent.keyDown(box, { key: 'ArrowUp' })
  applySnapshot(fixtureStateWithParams({ dea: [0] }))
  fireEvent.keyDown(box, { key: 'ArrowUp', shiftKey: true })
  applySnapshot(fixtureStateWithParams({ dea: [0] }))
  fireEvent.keyDown(slider, { key: 'ArrowRight' })

  expect(sentEdits(socket).map((frame) => frame.params)).toEqual([
    { dea: [16] }, // 0 + 1 display unit
    { dea: [16] }, // 0 + 160 raw, clamped to max
    { dea: [16] },
  ])
})

// Behavior 3 (#22) migrated: the range drag is now Slider keys — each
// Alt+ArrowRight is the Step rule's fine step (0.1 display units,
// snapped to the 1/16 lattice ⇒ 2 raw) from Music's dea=2: 4, 6, 8,
// applied optimistically so an ack never yanks the thumb back.
it('stepping Dialog Enhancer amount on the Slider streams display→i16 writes', () => {
  const socket = renderConnected()
  const slider = amountSlider('Dialog Enhancer')

  for (let step = 0; step < 3; step += 1) {
    fireEvent.keyDown(slider, { key: 'ArrowRight', altKey: true })
  }

  const edit = (raw: number) => ({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    params: { dea: [raw] },
  })
  expect(sentEdits(socket)).toEqual([edit(4), edit(6), edit(8)])
  expect(slider.getAttribute('aria-valuenow')).toBe('0.5')
  expect(amountBox('Dialog Enhancer').value).toBe('0.5')
})

// Behavior 6 (#93): the Reset marker is one button per pair — disabled
// at Baseline, enabled when either half diverges — and its click is
// `reset_profile { only: [enable, amount] }` chased by `get_state`.
it('the Reset marker enables when either half diverges and resets the pair', async () => {
  const socket = renderConnected()
  const reset = screen.getByRole('button', { name: 'Reset Volume Leveller' })
  const leveller = row('Volume Leveller')
  expect(reset).toHaveProperty('disabled', true)
  expect(leveller?.classList).not.toContain('master-control--diverged')

  applySnapshot(fixtureStateWithParams({ dvle: [1] }))
  expect(reset).toHaveProperty('disabled', false)
  expect(leveller?.classList).toContain('master-control--diverged')
  applySnapshot(fixtureStateWithParams({ dvla: [9] }))
  expect(reset).toHaveProperty('disabled', false)

  const mark = socket.sentCommands().length
  reset.click()
  const sent = socket.sentCommands().slice(mark)
  expect(sent).toEqual([
    {
      cmd: 'reset_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      only: ['dvle', 'dvla'],
    },
  ])
  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(
      socket
        .sentCommands()
        .slice(mark)
        .map((frame) => frame.cmd),
    ).toEqual(['reset_profile', 'get_state'])
  })
  // The reconcile's snapshot lands the reset; divergence clears live.
  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState(),
    request_id: socket.sentCommands().slice(mark)[1]?.request_id,
  })
  expect(amountBox('Volume Leveller').value).toBe('4')
  expect(reset).toHaveProperty('disabled', true)
})

// Behavior 5 (#22): values are per-profile — switching shows the
// selected profile's own values.
it('switching profiles shows that profile’s values', () => {
  render(() => <MasterControls />)
  const dialog = amountBox('Dialog Enhancer')
  expect(dialog.value).toBe('0.13') // Music dea=2 → 2/16, 2 places

  applySnapshot(fixtureState({ selected_profile: 'voice' }))
  expect(dialog.value).toBe('0.63') // Voice dea=10 → 10/16, 2 places
  expect(amountSlider('Dialog Enhancer').getAttribute('aria-valuenow')).toBe(
    '0.63',
  )
  expect(enableSwitch('Surround Virtualizer').checked).toBe(false) // Voice ships vdhe=0
  expect(amountBox('Volume Leveller').value).toBe('0') // Voice dvla=0
})

// Behavior 7 (#22, #93), client half: another client's edit arrives as
// a broadcast `state` event and moves switch, box and Slider (the
// daemon half — originator suppression — is pinned in
// `ddp-daemon/tests/master_controls.rs`).
it('updates switch, box and Slider on a broadcast state event', () => {
  const socket = renderConnected()
  const seeded = fixtureState()
  socket.serverMessage({
    type: 'state',
    snapshot: {
      ...seeded,
      profiles: seeded.profiles.map((profile) =>
        profile.id === 'music'
          ? { ...profile, params: { ...profile.params, dvle: [1], dvla: [9] } }
          : profile,
      ),
    },
  })
  expect(enableSwitch('Volume Leveller').checked).toBe(true)
  expect(amountBox('Volume Leveller').value).toBe('9')
  expect(amountSlider('Volume Leveller').getAttribute('aria-valuenow')).toBe(
    '9',
  )
})
