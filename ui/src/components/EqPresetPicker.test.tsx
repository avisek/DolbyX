import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@solidjs/testing-library'
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

/** The `set_eq_preset` frames the client sent. */
function sentSelections(socket: MockWebSocket) {
  return socket.sentCommands().filter((frame) => frame.cmd === 'set_eq_preset')
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

// Behavior 2 (#23), client half: picking Rich targets the active
// profile explicitly (EQ selection is per-profile) and applies
// local-first on the daemon's ack.
it('picking Rich sends set_eq_preset for the active profile', async () => {
  const socket = renderConnected()

  option('Rich').click()
  const sent = sentSelections(socket)
  expect(sent).toEqual([
    {
      cmd: 'set_eq_preset',
      request_id: expect.any(String) as string,
      profile_id: 'music',
      id: 'rich',
    },
  ])

  // Not yet acked — the picker still shows daemon truth.
  expect(option('Rich').getAttribute('aria-checked')).toBe('false')
  socket.serverMessage({
    type: 'ack',
    request_id: sent[0]?.request_id,
    ok: true,
  })
  await waitFor(() => {
    expect(option('Rich').getAttribute('aria-checked')).toBe('true')
    expect(option('None').getAttribute('aria-checked')).toBe('false')
  })
})

// Behavior 3 (#23), client half: the None affordance detaches with
// `id: null` — "Off" is null, not a preset.
it('picking None detaches with id null', () => {
  applySnapshot(selectingState('music', 'rich'))
  const socket = renderConnected()
  expect(option('Rich').getAttribute('aria-checked')).toBe('true')

  option('None').click()
  expect(sentSelections(socket)).toEqual([
    {
      cmd: 'set_eq_preset',
      request_id: expect.any(String) as string,
      profile_id: 'music',
      id: null,
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

/** The fixture plus one custom preset (a Rich clone) selected by music. */
function withCustomPreset(): StateSnapshot {
  const seeded = selectingState('music', 'user_91c2')
  const rich = seeded.eq_presets.find((preset) => preset.id === 'rich')
  if (!rich) throw new Error('fixture rich missing')
  return {
    ...seeded,
    eq_presets: [
      ...seeded.eq_presets,
      { ...rich, id: 'user_91c2', name: 'Vocal', is_factory: false },
    ],
  }
}

const action = (name: string) => screen.getByRole('button', { name })
const maybeAction = (name: string) => screen.queryByRole('button', { name })

/** The frames of one command kind the client sent. */
function sent(socket: MockWebSocket, cmd: string) {
  return socket.sentCommands().filter((frame) => frame.cmd === cmd)
}

// Behaviors 4 + 7 (#26), client half: the actions target the selected
// preset — factory ones reset, custom ones rename/delete, and with
// None selected there is nothing to act on.
it('shows actions per the selected preset kind, none for None', () => {
  render(() => <EqPresetPicker />)
  expect(maybeAction('Add EQ preset')).toBeNull()
  expect(maybeAction('Reset EQ preset')).toBeNull()

  applySnapshot(selectingState('music', 'rich'))
  expect(action('Add EQ preset')).toBeTruthy()
  expect(action('Reset EQ preset')).toBeTruthy()
  expect(maybeAction('Rename EQ preset')).toBeNull()
  expect(maybeAction('Delete EQ preset')).toBeNull()

  applySnapshot(withCustomPreset())
  expect(maybeAction('Reset EQ preset')).toBeNull()
  expect(action('Rename EQ preset')).toBeTruthy()
  expect(action('Delete EQ preset')).toBeTruthy()
})

// Behavior 2 (#26), client half: Add clones the selected preset under
// the ack's minted id and selects the clone on the active profile, so
// edits continue on the copy.
it('Add clones the selected preset and selects the minted id', async () => {
  applySnapshot(selectingState('music', 'rich'))
  const socket = renderConnected()

  action('Add EQ preset').click()
  const adds = sent(socket, 'add_eq_preset')
  expect(adds).toEqual([
    {
      cmd: 'add_eq_preset',
      request_id: expect.any(String) as string,
      from: 'rich',
      name: 'Rich Copy',
    },
  ])

  socket.serverMessage({
    type: 'ack',
    request_id: adds[0]?.request_id,
    ok: true,
    id: 'user_91c2',
  })
  await waitFor(() => {
    expect(option('Rich Copy')).toBeTruthy()
    expect(sentSelections(socket)).toEqual([
      {
        cmd: 'set_eq_preset',
        request_id: expect.any(String) as string,
        profile_id: 'music',
        id: 'user_91c2',
      },
    ])
  })
})

// Behavior 3 (#26), client half: rename goes by name — inline input,
// Enter commits, applied on the ack; the id (and so the option) stays.
it('renames a custom preset inline on Enter', async () => {
  applySnapshot(withCustomPreset())
  const socket = renderConnected()

  action('Rename EQ preset').click()
  const input = screen.getByRole<HTMLInputElement>('textbox', {
    name: 'EQ preset name',
  })
  expect(input.value).toBe('Vocal')
  input.value = 'Vocal Forward'
  fireEvent.keyDown(input, { key: 'Enter' })

  const renames = sent(socket, 'rename_eq_preset')
  expect(renames).toEqual([
    {
      cmd: 'rename_eq_preset',
      request_id: expect.any(String) as string,
      id: 'user_91c2',
      name: 'Vocal Forward',
    },
  ])
  socket.serverMessage({
    type: 'ack',
    request_id: renames[0]?.request_id,
    ok: true,
  })
  await waitFor(() => {
    expect(option('Vocal Forward')).toBeTruthy()
  })
})

// Behavior 5 (#26), client half: the None fallback for every selecting
// profile is daemon-owned — Delete reconciles instead of mirroring it.
it('Delete removes the custom preset and reconciles', async () => {
  applySnapshot(withCustomPreset())
  const socket = renderConnected()
  const before = sent(socket, 'get_state').length

  action('Delete EQ preset').click()
  const removes = sent(socket, 'remove_eq_preset')
  expect(removes).toEqual([
    {
      cmd: 'remove_eq_preset',
      request_id: expect.any(String) as string,
      id: 'user_91c2',
    },
  ])

  socket.serverMessage({
    type: 'ack',
    request_id: removes[0]?.request_id,
    ok: true,
  })
  await waitFor(() => {
    expect(sent(socket, 'get_state').length).toBe(before + 1)
  })
  socket.serverMessage({ type: 'state', snapshot: fixtureState() })
  await waitFor(() => {
    expect(screen.queryByRole('radio', { name: 'Vocal' })).toBeNull()
    expect(option('None').getAttribute('aria-checked')).toBe('true')
  })
})

// Behavior 7 (#26), client half: Reset on the selected factory preset.
it('Reset sends reset_eq_preset for the factory preset', () => {
  applySnapshot(selectingState('music', 'rich'))
  const socket = renderConnected()
  action('Reset EQ preset').click()
  expect(sent(socket, 'reset_eq_preset')).toEqual([
    {
      cmd: 'reset_eq_preset',
      request_id: expect.any(String) as string,
      id: 'rich',
    },
  ])
})
