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

// Tracer bullet (#93, behavior 2): the amount is the shared Slider —
// `role=slider` in display units — and no native range input remains.
it('exposes each amount as a role=slider in display units, with no input[type=range]', () => {
  const { container } = render(() => <MasterControls />)
  expect(container.querySelector('input[type=range]')).toBeNull()
  // Music dea=2 → 2/16 = 0.125 (dea is a 0..16 raw integer, frac_bits 4)
  expect(amountSlider('Dialog Enhancer').getAttribute('aria-valuenow')).toBe(
    '0.13', // 2/16, the panel's 2-place display (#87)
  )
})

// Behavior 1 (#22, #93): the three controls render from the descriptor
// in the original's order, each half resolved against the bootstrap
// metadata — kind, range, frac_bits — on the shared controls; the
// curated surface shows no 4-CC.
it('renders the three controls resolved against the bootstrap table', () => {
  const { container } = render(() => <MasterControls />)

  const switches = screen.getAllByRole<HTMLInputElement>('switch')
  expect(switches.map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
    'Surround Virtualizer enable',
    'Dialog Enhancer enable',
    'Volume Leveller enable',
  ])
  // Music: vdhe=2 (on), deon=1 (on), dvle=0 (off).
  expect(switches.map((toggle) => toggle.checked)).toEqual([true, true, false])
  expect(container.textContent).not.toMatch(/vdhe|dhsb|deon|dea|dvle|dvla/)

  // dhsb: 0..96 raw, frac_bits 4 ⇒ a 0..6 dB axis in 1/16 steps.
  const surround = amountSlider('Surround Virtualizer')
  expect([
    surround.getAttribute('aria-valuemin'),
    surround.getAttribute('aria-valuemax'),
    surround.getAttribute('aria-valuenow'),
  ]).toEqual(['0', '6', '3']) // Music dhsb=48 → 3 dB
  expect(surround.style.getPropertyValue('--norm')).toBe('0.5')
  // The box shows the display value; the Decibel kind's unit overlays it.
  const surroundBox = amountBox('Surround Virtualizer')
  expect(surroundBox.value).toBe('3')
  expect(
    surroundBox.parentElement?.querySelector('.adv-input__unit')?.textContent,
  ).toBe('dB')

  // dvla: 0..10 raw, frac_bits 0 ⇒ a plain 0..10 integer axis, no unit.
  const leveller = amountSlider('Volume Leveller')
  expect([
    leveller.getAttribute('aria-valuemin'),
    leveller.getAttribute('aria-valuemax'),
    leveller.getAttribute('aria-valuenow'),
  ]).toEqual(['0', '10', '4']) // Music dvla=4
  expect(leveller.style.getPropertyValue('--norm')).toBe('0.4')
  const levellerBox = amountBox('Volume Leveller')
  expect(levellerBox.value).toBe('4')
  expect(
    levellerBox.parentElement?.querySelector('.adv-input__unit'),
  ).toBeNull()
})

/** The `edit_profile` frames the client sent. */
function sentEdits(socket: MockWebSocket) {
  return socket.sentCommands().filter((frame) => frame.cmd === 'edit_profile')
}

// Behavior 2 (#22): toggling Volume Leveller writes its enable to the
// active profile — a 1-entry batch, applied local-first on the ack.
it('toggling Volume Leveller writes dvle to the active profile', async () => {
  const socket = renderConnected()
  const toggle = enableSwitch('Volume Leveller')

  toggle.click() // Music ships dvle=0 — toggling turns it on
  const sent = sentEdits(socket)
  expect(sent).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      params: { dvle: [1] },
    },
  ])

  // Not yet acked — the switch still shows daemon truth.
  expect(toggle.checked).toBe(false)
  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
  })
  await waitFor(() => {
    expect(toggle.checked).toBe(true)
  })
})

// Behavior 3 (#22, #93): each Slider step writes `dea` to the active
// profile immediately — display → raw i16 via `frac_bits`, 1-entry
// batches. Alt+ArrowRight is the Step rule's fine step: 0.1 display
// units, snapped to the 1/16 lattice ⇒ 2 raw from Music's dea=2.
it('stepping Dialog Enhancer amount streams display→i16 writes', () => {
  const socket = renderConnected()
  const slider = amountSlider('Dialog Enhancer')

  for (let step = 0; step < 3; step += 1) {
    fireEvent.keyDown(slider, { key: 'ArrowRight', altKey: true })
  }

  const edit = (raw: number) => ({
    cmd: 'edit_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    params: { dea: [raw] }, // display × 2^4
  })
  expect(sentEdits(socket)).toEqual([edit(4), edit(6), edit(8)])
  // Optimistic apply: the store already carries the sent value — an
  // ack round-trip must never yank a mid-drag thumb backward.
  expect(slider.getAttribute('aria-valuenow')).toBe('0.5')
  expect(amountBox('Dialog Enhancer').value).toBe('0.5')
})

// Behavior 5 (#93): typing into the box is the live path — every
// keystroke that parses is a clamped `edit_profile`, partials ignored.
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
    { dea: [8] },
  ])
  expect(box.value).toBe('0.5') // as typed, never fought
})

// Behavior 6 (#93): ↑ on the box and ArrowRight on the Slider share the
// Step rule — one display unit (16 raw on dea), Shift ten (160 raw),
// clamped to the range.
it('↑ on the box and ArrowRight on the slider step by the Step rule, clamped', () => {
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

// Behavior 8 (#93): the Reset marker is one button per pair — disabled
// at Baseline, enabled when either half diverges — and its click is
// `reset_profile { only: [enable, amount] }` chased by `get_state`.
it('the reset marker enables when either half diverges and resets the pair', async () => {
  const socket = renderConnected()
  const reset = screen.getByRole('button', { name: 'Reset Volume Leveller' })
  const row = reset.closest('.master-control')
  expect(reset).toHaveProperty('disabled', true)
  expect(row?.classList).not.toContain('master-control--diverged')

  applySnapshot(fixtureStateWithParams({ dvle: [1] }))
  expect(reset).toHaveProperty('disabled', false)
  expect(row?.classList).toContain('master-control--diverged')
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

// Behavior 7 (#22), client half: another client's master-control edit
// arrives as a broadcast `state` event and moves this tab's controls
// (the daemon half — originator suppression — is pinned in
// `ddp-daemon/tests/master_controls.rs`).
it('updates the controls on a broadcast state event', () => {
  const socket = renderConnected()
  const seeded = fixtureState()
  socket.serverMessage({
    type: 'state',
    snapshot: {
      ...seeded,
      profiles: seeded.profiles.map((profile) =>
        profile.id === 'music'
          ? { ...profile, params: { ...profile.params, dvla: [9] } }
          : profile,
      ),
    },
  })
  expect(amountBox('Volume Leveller').value).toBe('9')
  expect(amountSlider('Volume Leveller').getAttribute('aria-valuenow')).toBe(
    '9',
  )
})

// Behavior 4 (#22): the Surround Virtualizer enable maps per
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
