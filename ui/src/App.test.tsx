import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from './test/mock-ws'
import { FIXTURE_LAN_URL, fixtureBootstrap, fixtureState } from './test/fixture'

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
  // Behavior 1 (#22): the master controls sit on the main screen.
  expect(screen.getByRole('region', { name: 'Master controls' })).toBeTruthy()
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
  })
  await waitFor(() => {
    expect(powerToggle().getAttribute('aria-checked')).toBe('false')
  })
})

const lanToggle = () => screen.getByRole('switch', { name: 'LAN access' })

// Issue #70: click → `set_lan_access` on the wire; the flip lands
// local-first on the daemon's `ack` — by then the listener is already
// rebound (ADR-0012). The broadcast goes to *other* clients.
it('sends set_lan_access on click and applies the flip on the ack', async () => {
  const socket = renderConnected()

  expect(lanToggle().getAttribute('aria-checked')).toBe('false')
  lanToggle().click()
  const sent = socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'set_lan_access')
  expect(sent).toEqual([
    {
      cmd: 'set_lan_access',
      request_id: expect.any(String) as string,
      on: true,
    },
  ])

  // Not yet acked — the toggle still shows daemon truth.
  expect(lanToggle().getAttribute('aria-checked')).toBe('false')

  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
  })
  await waitFor(() => {
    expect(lanToggle().getAttribute('aria-checked')).toBe('true')
  })
})

// Issue #70: a refused flip (`LAN_BIND_FAILED`) never moves the toggle
// — the daemon's store never moved either; the error-path reconcile
// restores daemon truth. No error surface exists.
it('leaves the LAN toggle where it was when the flip is refused', async () => {
  const socket = renderConnected()

  lanToggle().click()
  const sent = socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'set_lan_access')
  socket.serverMessage({
    type: 'error',
    request_id: sent[0]?.request_id,
    code: 'LAN_BIND_FAILED',
    message: 'bind failed',
  })
  await waitFor(() => {
    // The rejection triggered the standard reconcile…
    expect(
      socket.sentCommands().filter((frame) => frame.cmd === 'get_state'),
    ).toHaveLength(2)
  })
  // …and the switch is exactly where it was.
  expect(lanToggle().getAttribute('aria-checked')).toBe('false')
})

// Issue #70: another tab flipped LAN access — its broadcast `state`
// event reconciles this tab's toggle.
it('updates the LAN toggle on a broadcast state event', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ lan_access: true }),
  })
  expect(lanToggle().getAttribute('aria-checked')).toBe('true')
})

const discoveryQr = () =>
  screen.queryByRole('img', { name: 'Scan to open DolbyX on your phone' })

// Issue #71: the snapshot carries `lan_url` even while off — showing
// the URL + QR only while on is this UI's policy.
it('hides the discovery URL and QR while LAN access is off', () => {
  render(() => <App />)
  expect(discoveryQr()).toBeNull()
  expect(screen.queryByText(FIXTURE_LAN_URL)).toBeNull()
})

// Issue #71: the flipping tab renders the QR from the `lan_url` it
// already holds — the ack alone reveals it; originator suppression
// means no snapshot follows for this tab (ADR-0005).
it('shows the URL and QR beside the toggle on the on-flip ack', async () => {
  const socket = renderConnected()

  lanToggle().click()
  const sent = socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'set_lan_access')
  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(discoveryQr()).toBeTruthy()
    expect(screen.getByText(FIXTURE_LAN_URL)).toBeTruthy()
  })
})

// Issue #71: another tab flipped on — the broadcast reveals the
// discovery block here too; a later off-flip hides it again.
it('walks the discovery block through broadcast on and off', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ lan_access: true }),
  })
  expect(discoveryQr()).toBeTruthy()
  expect(screen.getByText(FIXTURE_LAN_URL)).toBeTruthy()

  socket.serverMessage({ type: 'state', snapshot: fixtureState() })
  expect(discoveryQr()).toBeNull()
})

// Issue #71: a routeless host snapshots `lan_url: null` — the toggle
// stands alone; there is nothing to render.
it('shows no discovery block when lan_url is null', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ lan_access: true, lan_url: null }),
  })
  expect(lanToggle().getAttribute('aria-checked')).toBe('true')
  expect(discoveryQr()).toBeNull()
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
// the active profile marked.
it('renders the four factory profile tabs with the active one marked', () => {
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
  })
  await waitFor(() => {
    expect(isSelected('Movie')).toBe('true')
    expect(isSelected('Music')).toBe('false')
  })
})

// Behavior 10 (#18): another client switched — its broadcast `state`
// event moves this tab's active profile.
it('updates the selected tab on a broadcast state event', () => {
  const socket = renderConnected()

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ selected_profile: 'game' }),
  })
  expect(isSelected('Game')).toBe('true')
  expect(isSelected('Music')).toBe('false')
})
