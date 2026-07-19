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

const { default: ProfileTabs } = await import('./ProfileTabs')
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

/** Renders the tabs and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <ProfileTabs />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

/** The fixture plus one custom profile (a Music clone), optionally active. */
function withCustomProfile(selected: boolean): StateSnapshot {
  const seeded = fixtureState()
  const music = seeded.profiles.find((profile) => profile.id === 'music')
  if (!music) throw new Error('fixture music missing')
  return {
    ...seeded,
    selected_profile: selected ? 'user_ab12' : seeded.selected_profile,
    profiles: [
      ...seeded.profiles,
      { ...music, id: 'user_ab12', name: 'Mine', is_factory: false },
    ],
  }
}

const action = (name: string) => screen.getByRole('button', { name })
const maybeAction = (name: string) => screen.queryByRole('button', { name })

/** The frames of one command kind the client sent. */
function sent(socket: MockWebSocket, cmd: string) {
  return socket.sentCommands().filter((frame) => frame.cmd === cmd)
}

// Behavior 4 (#26), client half: the affordances follow the factory
// rule — factory items reset, custom items rename/delete; Add always
// clones the active profile.
it('shows Reset on a factory profile, Rename/Delete on a custom one', () => {
  render(() => <ProfileTabs />)
  expect(action('Add profile')).toBeTruthy()
  expect(action('Reset profile')).toBeTruthy()
  expect(maybeAction('Rename profile')).toBeNull()
  expect(maybeAction('Delete profile')).toBeNull()

  applySnapshot(withCustomProfile(true))
  expect(maybeAction('Reset profile')).toBeNull()
  expect(action('Rename profile')).toBeTruthy()
  expect(action('Delete profile')).toBeTruthy()
})

// Behavior 2 (#26), client half: Add clones the active profile under
// the ack's minted id — applied locally without waiting for a
// snapshot — and chains the selection onto the clone.
it('Add clones the active profile and selects the minted id', async () => {
  const socket = renderConnected()

  action('Add profile').click()
  const adds = sent(socket, 'add_profile')
  expect(adds).toEqual([
    {
      cmd: 'add_profile',
      request_id: expect.any(String) as string,
      from: 'music',
      name: 'Music Copy',
    },
  ])

  socket.serverMessage({
    type: 'ack',
    request_id: adds[0]?.request_id,
    ok: true,
    id: 'user_ab12',
  })
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Music Copy' })).toBeTruthy()
    expect(sent(socket, 'set_profile')).toEqual([
      {
        cmd: 'set_profile',
        request_id: expect.any(String) as string,
        id: 'user_ab12',
      },
    ])
  })
})

// Behavior 3 (#26), client half: rename goes by name — an inline input
// seeded with the current name, committed on Enter, applied on the ack.
it('renames a custom profile inline on Enter', async () => {
  applySnapshot(withCustomProfile(true))
  const socket = renderConnected()

  action('Rename profile').click()
  const input = screen.getByRole<HTMLInputElement>('textbox', {
    name: 'Profile name',
  })
  expect(input.value).toBe('Mine')
  input.value = 'Nocturne'
  fireEvent.keyDown(input, { key: 'Enter' })

  const renames = sent(socket, 'rename_profile')
  expect(renames).toEqual([
    {
      cmd: 'rename_profile',
      request_id: expect.any(String) as string,
      id: 'user_ab12',
      name: 'Nocturne',
    },
  ])
  socket.serverMessage({
    type: 'ack',
    request_id: renames[0]?.request_id,
    ok: true,
  })
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Nocturne' })).toBeTruthy()
  })
})

it('Escape cancels the rename without sending', () => {
  applySnapshot(withCustomProfile(true))
  const socket = renderConnected()

  action('Rename profile').click()
  const input = screen.getByRole<HTMLInputElement>('textbox', {
    name: 'Profile name',
  })
  input.value = 'X'
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(sent(socket, 'rename_profile')).toEqual([])
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole('tab', { name: 'Mine' })).toBeTruthy()
})

// Behavior 6 (#26), client half: the fallback rules are daemon-owned —
// Delete reconciles with a get_state instead of mirroring them.
it('Delete removes the custom profile and reconciles', async () => {
  applySnapshot(withCustomProfile(true))
  const socket = renderConnected()
  const before = sent(socket, 'get_state').length

  action('Delete profile').click()
  const removes = sent(socket, 'remove_profile')
  expect(removes).toEqual([
    {
      cmd: 'remove_profile',
      request_id: expect.any(String) as string,
      id: 'user_ab12',
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
    expect(screen.queryByRole('tab', { name: 'Mine' })).toBeNull()
  })
})

// Behavior 7 (#26), client half: Reset shows on factory items only and
// reconciles on the ack (baselines never ride the snapshot).
it('Reset sends reset_profile for the factory profile', () => {
  const socket = renderConnected()
  action('Reset profile').click()
  expect(sent(socket, 'reset_profile')).toEqual([
    {
      cmd: 'reset_profile',
      request_id: expect.any(String) as string,
      id: 'music',
    },
  ])
})
