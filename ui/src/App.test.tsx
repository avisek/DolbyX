import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from './test/mock-ws'
import { fixtureBootstrap, fixtureState } from './test/fixture'

// The store hydrates from window.__BOOTSTRAP__ at module init
// (ADR-0006) — install the fixture before the dynamic imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: App } = await import('./App')
const { applySnapshot } = await import('./store/state')
const { startWs, stopWs } = await import('./store/ws')

beforeEach(() => {
  MockWebSocket.reset()
  // The store module is a singleton — re-seed it between tests.
  applySnapshot(fixtureState())
})

afterEach(() => {
  stopWs()
  cleanup()
})

/** Renders the app and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <App />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

const powerToggle = () => screen.getByRole('switch', { name: 'Power' })

it('renders the DolbyX shell', () => {
  render(() => <App />)
  expect(screen.getByRole('heading', { name: 'DolbyX' })).toBeTruthy()
})

// Behavior 1 (#13): first paint comes fully populated from the
// bootstrap — no WS round-trip involved.
it('paints the bootstrap power state on first render without any WS', () => {
  render(() => <App />)
  expect(powerToggle().getAttribute('aria-checked')).toBe('true')
  expect(MockWebSocket.instances).toHaveLength(0)
})

// The slice's tracer bullet + behavior 2 (#13): click → `set_power` on
// the wire; the flip lands local-first on the daemon's `ack` (the
// broadcast goes to *other* clients — ADR-0005).
it('sends set_power on click and applies the flip on the ack', async () => {
  const socket = renderConnected()

  powerToggle().click()
  const sent = socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'set_power')
  expect(sent).toEqual([
    { cmd: 'set_power', request_id: expect.any(String) as string, on: false },
  ])

  // Not yet acked — the toggle still shows daemon truth.
  expect(powerToggle().getAttribute('aria-checked')).toBe('true')

  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
    ok: true,
  })
  await waitFor(() => {
    expect(powerToggle().getAttribute('aria-checked')).toBe('false')
  })
})

// Behavior 5 (#13): drop → badge reconnecting; reconnect → `get_state`
// issued, badge connected, state reconciled.
it('walks the badge through drop and recovery, reconciling state', () => {
  vi.useFakeTimers()
  const socket = renderConnected()
  const badge = screen.getByRole('status')
  expect(badge.textContent).toBe('Connected')

  socket.drop()
  expect(badge.textContent).toBe('Reconnecting…')

  vi.advanceTimersByTime(250)
  const reopened = MockWebSocket.latest()
  expect(reopened).not.toBe(socket)
  reopened.open()
  expect(badge.textContent).toBe('Connected')
  expect(reopened.sentCommands().map((f) => f.cmd)).toEqual(['get_state'])

  // Power flipped while this tab was gone — the reconcile lands it.
  reopened.serverMessage({
    type: 'state',
    snapshot: fixtureState({ power: false }),
  })
  expect(powerToggle().getAttribute('aria-checked')).toBe('false')
  vi.useRealTimers()
})

// Behavior 3 (#13): another tab flipped power — its broadcast `state`
// event reconciles this tab's toggle.
it('updates the toggle on a broadcast state event', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ power: false }),
  })
  expect(powerToggle().getAttribute('aria-checked')).toBe('false')
})

const profileTab = (name: string) => screen.getByRole('tab', { name })
const isSelected = (name: string) =>
  profileTab(name).getAttribute('aria-selected')

// Behavior 10 (#18): the four factory tabs render from the snapshot,
// the factory selection marked.
it('renders the four factory profile tabs with the selection marked', () => {
  render(() => <App />)
  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
  expect(tabs).toEqual(['Movie', 'Music', 'Game', 'Voice'])
  expect(isSelected('Music')).toBe('true')
  expect(isSelected('Movie')).toBe('false')
})

// Behavior 10 (#18): switching updates via the ack (the broadcast goes
// to *other* clients — ADR-0005).
it('sends set_profile on click and applies the switch on the ack', async () => {
  const socket = renderConnected()

  profileTab('Movie').click()
  const sent = socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'set_profile')
  expect(sent).toEqual([
    {
      cmd: 'set_profile',
      request_id: expect.any(String) as string,
      id: 'movie',
    },
  ])

  // Not yet acked — the tabs still show daemon truth.
  expect(isSelected('Music')).toBe('true')

  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
    ok: true,
  })
  await waitFor(() => {
    expect(isSelected('Movie')).toBe('true')
    expect(isSelected('Music')).toBe('false')
  })
})

// Behavior 10 (#18): another client switched — its broadcast `state`
// event moves this tab's selection.
it('updates the selected tab on a broadcast state event', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ selected_profile: 'game' }),
  })
  expect(isSelected('Game')).toBe('true')
  expect(isSelected('Music')).toBe('false')
})
