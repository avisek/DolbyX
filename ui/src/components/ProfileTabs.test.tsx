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
import type { Profile, StateSnapshot } from '../lib/ws'

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

const action = (name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name })

/** Renders the tabs and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <ProfileTabs />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

/** Acks `frame` and answers the get_state chaser with `snapshot`. */
async function ackThenReconcile(
  socket: MockWebSocket,
  snapshot: StateSnapshot,
): Promise<void> {
  const sent = socket.sentCommands().at(-1)
  socket.serverMessage({ type: 'ack', request_id: sent?.request_id })
  // The op's result isn't locally computable — the store chases the
  // ack with a get_state reconcile; answer it.
  await waitFor(() => {
    expect(socket.sentCommands().at(-1)?.cmd).toBe('get_state')
  })
  socket.serverMessage({
    type: 'state',
    snapshot,
    request_id: socket.sentCommands().at(-1)?.request_id,
  })
}

/** The fixture state plus one custom clone of Music, selected. */
function customSelectedState(overrides: Partial<Profile> = {}): StateSnapshot {
  const seeded = fixtureState()
  const music = seeded.profiles.find((profile) => profile.id === 'music')
  if (!music) throw new Error('fixture lost Music')
  return {
    ...seeded,
    selected_profile: 'user_a3f1',
    profiles: [
      ...seeded.profiles,
      {
        ...music,
        id: 'user_a3f1',
        name: 'Music 2',
        is_factory: false,
        ...overrides,
      },
    ],
  }
}

// Behavior 1 (#26), profile half: the action row renders all four
// actions always — factory vs custom flips `disabled` per the matrix,
// never presence (zero layout shift).
it('renders all four actions always; factory vs custom flips disabled only', () => {
  render(() => <ProfileTabs />)

  // Factory (Music) selected: Add always live, the rest disabled —
  // Reset because nothing diverges (`overridden` empty).
  expect(action('Add profile').disabled).toBe(false)
  expect(action('Rename profile').disabled).toBe(true)
  expect(action('Delete profile').disabled).toBe(true)
  expect(action('Reset profile').disabled).toBe(true)

  // A custom selection flips Rename/Delete live; every action stays
  // in the DOM (disable, never hide).
  applySnapshot(customSelectedState({ overridden: ['dvla'] }))
  expect(action('Add profile').disabled).toBe(false)
  expect(action('Rename profile').disabled).toBe(false)
  expect(action('Delete profile').disabled).toBe(false)
  expect(action('Reset profile').disabled).toBe(false)
  expect(screen.getAllByRole('button')).toHaveLength(4)
})

// Behavior 2 (#26), profile half: Reset sends the whole-item
// `reset_profile` (no `only`), reconciles off its ack, and the
// disabled state tracks `overridden` end to end.
it('Reset sends a whole-item reset_profile and reconciles on the ack', async () => {
  const socket = renderConnected()
  applySnapshot(customSelectedState({ overridden: ['dvla', 'gebg'] }))

  action('Reset profile').click()
  const sent = socket.sentCommands().at(-1)
  expect(sent).toEqual({
    cmd: 'reset_profile',
    request_id: expect.any(String) as string,
    id: 'user_a3f1',
  })
  expect(sent && 'only' in sent).toBe(false) // whole item, not scoped

  // The reconcile's snapshot — divergences gone — disables Reset.
  await ackThenReconcile(socket, customSelectedState({ overridden: [] }))
  await waitFor(() => {
    expect(action('Reset profile').disabled).toBe(true)
  })
})

// Behavior 3 (#26) + the tracer bullet: Add sends the selection's
// resolved content under the minted `«base» n` name — never a source
// reference (ADR-0005) — and the ack's id auto-selects the clone
// (the daemon never moves selection on add).
it('Add clones the selected profile and the acked minted id selects it', async () => {
  const socket = renderConnected()
  const music = fixtureState().profiles.find((p) => p.id === 'music')

  action('Add profile').click()
  const sent = socket.sentCommands().at(-1)
  expect(sent).toEqual({
    cmd: 'add_profile',
    request_id: expect.any(String) as string,
    name: 'Music 2',
    params: music?.params,
    selected_eq_preset: null,
  })

  socket.serverMessage({
    type: 'ack',
    request_id: sent?.request_id,
    id: 'user_9f3a',
  })
  // The originator applies the clone off its ack, then selects it.
  const follow = await waitFor(() => {
    const frame = socket.sentCommands().find((f) => f.cmd === 'set_profile')
    expect(frame?.id).toBe('user_9f3a')
    return frame
  })
  expect(screen.getByRole('tab', { name: 'Music 2' })).toBeTruthy()

  socket.serverMessage({ type: 'ack', request_id: follow?.request_id })
  await waitFor(() => {
    expect(
      screen
        .getByRole('tab', { name: 'Music 2' })
        .getAttribute('aria-selected'),
    ).toBe('true')
  })
})

/** The rename-patch `edit_profile` frames the client sent. */
const sentRenames = (socket: MockWebSocket) =>
  socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'edit_profile' && 'name' in frame)

// Behavior 5 (#26), profile half: the selected tab's label becomes an
// inline field — Enter and blur commit `edit_profile { id, name }`,
// Esc (or an unchanged/emptied name) cancels with no wire call.
it('inline rename commits on Enter and blur, cancels on Esc', async () => {
  const socket = renderConnected()
  applySnapshot(customSelectedState())
  const field = () => screen.getByRole<HTMLInputElement>('textbox')

  // Esc: no frame, the label untouched.
  action('Rename profile').click()
  expect(field().value).toBe('Music 2')
  fireEvent.input(field(), { target: { value: 'Scrapped' } })
  fireEvent.keyDown(field(), { key: 'Escape' })
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(sentRenames(socket)).toEqual([])
  expect(screen.getByRole('tab', { name: 'Music 2' })).toBeTruthy()

  // Enter commits; the label updates local-first on the ack.
  action('Rename profile').click()
  fireEvent.input(field(), { target: { value: 'Late Night' } })
  fireEvent.keyDown(field(), { key: 'Enter' })
  const sent = sentRenames(socket)
  expect(sent).toEqual([
    {
      cmd: 'edit_profile',
      request_id: expect.any(String) as string,
      id: 'user_a3f1',
      name: 'Late Night',
    },
  ])
  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Late Night' })).toBeTruthy()
  })

  // Blur commits too…
  action('Rename profile').click()
  fireEvent.input(field(), { target: { value: 'Small Hours' } })
  fireEvent.blur(field())
  expect(sentRenames(socket)).toHaveLength(2)
  expect(sentRenames(socket).at(-1)?.name).toBe('Small Hours')

  // …but an untouched field blurring away is a cancel, not a send.
  action('Rename profile').click()
  fireEvent.blur(field())
  expect(sentRenames(socket)).toHaveLength(2)
})

// Delete sends `remove_profile` and reconciles off the ack — where
// the selection lands (the Fallback profile) is daemon knowledge, so
// the originator waits for the snapshot rather than guessing.
it('Delete sends remove_profile and the reconcile lands the fallback', async () => {
  const socket = renderConnected()
  applySnapshot(customSelectedState())

  action('Delete profile').click()
  expect(socket.sentCommands().at(-1)).toEqual({
    cmd: 'remove_profile',
    request_id: expect.any(String) as string,
    id: 'user_a3f1',
  })

  await ackThenReconcile(socket, fixtureState())
  await waitFor(() => {
    expect(screen.queryByRole('tab', { name: 'Music 2' })).toBeNull()
    expect(
      screen.getByRole('tab', { name: 'Music' }).getAttribute('aria-selected'),
    ).toBe('true')
  })
})
