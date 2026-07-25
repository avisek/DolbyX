import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import { fixtureBootstrap, fixtureState } from '../test/fixture'

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
  screen.getByRole('switch', { name: `${label} enable` })
const amountSlider = (label: string) =>
  screen.getByRole<HTMLInputElement>('slider', { name: `${label} amount` })

// Behavior 1 (#22): the three controls render from the descriptor, each
// half resolved against the bootstrap metadata — kind, range, frac_bits.
it('renders the three controls resolved against the bootstrap table', () => {
  render(() => <MasterControls />)

  const switches = screen.getAllByRole('switch')
  expect(switches.map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
    'Surround Virtualizer enable',
    'Dialog Enhancer enable',
    'Volume Leveller enable',
  ])
  // Music: vdhe=2 (on), deon=1 (on), dvle=0 (off).
  expect(switches.map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(
    ['true', 'true', 'false'],
  )

  // dhsb: 0..96 raw, frac_bits 4 ⇒ a 0..6 dB slider in 1/16 steps.
  const surround = amountSlider('Surround Virtualizer')
  expect([surround.min, surround.max, surround.step]).toEqual([
    '0',
    '6',
    '0.0625',
  ])
  expect(surround.value).toBe('3') // Music dhsb=48 → 3 dB
  expect(screen.getByText('3 dB')).toBeTruthy() // Decibel kind → dB unit

  // dvla: 0..10 raw, frac_bits 0 ⇒ a plain 0..10 integer slider.
  const leveller = amountSlider('Volume Leveller')
  expect([leveller.min, leveller.max, leveller.step]).toEqual(['0', '10', '1'])
  expect(leveller.value).toBe('4') // Music dvla=4
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
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
  })
  await waitFor(() => {
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})

// Behavior 3 (#22): each drag step writes `dea` to the active profile
// immediately — display → raw i16 via `frac_bits`, 1-entry batches.
it('dragging Dialog Enhancer amount streams dB→i16 writes', () => {
  const socket = renderConnected()
  const slider = amountSlider('Dialog Enhancer')

  for (const position of ['0.25', '0.375', '0.5']) {
    slider.value = position
    slider.dispatchEvent(new Event('input', { bubbles: true }))
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
  expect(slider.value).toBe('0.5')
})

// Behavior 5 (#22): values are per-profile — switching shows the
// selected profile's own values.
it('switching profiles shows that profile’s values', () => {
  render(() => <MasterControls />)
  const dialog = amountSlider('Dialog Enhancer')
  expect(dialog.value).toBe('0.125') // Music dea=2 → 2/16

  applySnapshot(fixtureState({ selected_profile: 'voice' }))
  expect(dialog.value).toBe('0.625') // Voice dea=10 → 10/16
  expect(
    enableSwitch('Surround Virtualizer').getAttribute('aria-checked'),
  ).toBe('false') // Voice ships vdhe=0
  expect(amountSlider('Volume Leveller').value).toBe('0') // Voice dvla=0
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
  expect(amountSlider('Volume Leveller').value).toBe('9')
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
