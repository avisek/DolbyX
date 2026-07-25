import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import { fixtureBootstrap, fixtureState } from '../test/fixture'
import type { StateSnapshot } from '../lib/ws'

// The store reads window.__BOOTSTRAP__ at module init (ADR-0006) —
// install the fixture before the dynamic imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: EqPresetPicker } = await import('./EqPresetPicker')
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

/** Renders the picker and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <EqPresetPicker />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

const option = (name: string) => screen.getByRole('radio', { name })

/** The fixture state with `profileId` selecting `presetId`. */
function selectingState(
  profileId: string,
  presetId: string | null,
): StateSnapshot {
  const seeded = fixtureState()
  return {
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === profileId
        ? { ...profile, selected_eq_preset: presetId }
        : profile,
    ),
  }
}

/** The selection-patch `edit_profile` frames the client sent. */
function sentSelections(socket: MockWebSocket) {
  return socket
    .sentCommands()
    .filter(
      (frame) => frame.cmd === 'edit_profile' && 'selected_eq_preset' in frame,
    )
}

// Behaviors 1 + 7 (#23), client half: the picker renders the None
// affordance plus the snapshot's global presets — and out of the box no
// factory profile selects one, so None is checked.
it('renders None + the factory presets with None selected', () => {
  render(() => <EqPresetPicker />)
  const options = screen.getAllByRole('radio')
  expect(options.map((radio) => radio.textContent)).toEqual([
    'None',
    'Open',
    'Rich',
    'Focused',
  ])
  expect(options.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'true',
    'false',
    'false',
    'false',
  ])
})

// Behavior 1 (#57) / behavior 2 (#23), client half: picking Rich sends
// the tri-state `edit_profile` patch targeting the active profile
// explicitly (EQ selection is per-profile) and applies local-first on
// the daemon's ack.
it('picking Rich sends an edit_profile selection patch', async () => {
  const socket = renderConnected()

  option('Rich').click()
  const sent = sentSelections(socket)
  expect(sent).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      selected_eq_preset: 'rich',
    },
  ])

  // Not yet acked — the picker still shows daemon truth.
  expect(option('Rich').getAttribute('aria-checked')).toBe('false')
  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
  })
  await waitFor(() => {
    expect(option('Rich').getAttribute('aria-checked')).toBe('true')
    expect(option('None').getAttribute('aria-checked')).toBe('false')
  })
})

// Behavior 1 (#57) / behavior 3 (#23), client half: the None
// affordance detaches with `selected_eq_preset: null` — "Off" is
// null, not a preset (absent would mean untouched).
it('picking None detaches with a null selection patch', () => {
  applySnapshot(selectingState('music', 'rich'))
  const socket = renderConnected()
  expect(option('Rich').getAttribute('aria-checked')).toBe('true')

  option('None').click()
  expect(sentSelections(socket)).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'music',
      selected_eq_preset: null,
    },
  ])
})

// Behavior 6 (#23), client half: selection is per-profile — switching
// the active profile shows that profile's own selection.
it("shows each profile's own selection", () => {
  render(() => <EqPresetPicker />)
  applySnapshot(selectingState('game', 'open'))
  expect(option('None').getAttribute('aria-checked')).toBe('true') // music

  applySnapshot({ ...selectingState('game', 'open'), selected_profile: 'game' })
  expect(option('Open').getAttribute('aria-checked')).toBe('true')
  expect(option('None').getAttribute('aria-checked')).toBe('false')
})

// Another client's selection arrives as a broadcast state event and
// moves this tab's picker.
it('updates the selection on a broadcast state event', () => {
  const socket = renderConnected()
  socket.serverMessage({
    type: 'state',
    snapshot: selectingState('music', 'focused'),
  })
  expect(option('Focused').getAttribute('aria-checked')).toBe('true')
})
