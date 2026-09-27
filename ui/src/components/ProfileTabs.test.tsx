import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import { fixtureBootstrap, fixtureRamp, fixtureState } from '../test/fixture'
import type { StateSnapshot } from '../lib/ws'

// The store reads window.__BOOTSTRAP__ at module init (ADR-0006) —
// install the fixture before the dynamic imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: ProfileTabs } = await import('./ProfileTabs')
const { applyProfileEdit, applySnapshot } = await import('../store/state')
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

/** Renders the Picker and completes the background WS handshake. */
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

/**
 * The fixture state plus one custom clone of Music, selected. `edits`
 * overlay the clone's params off its (copied) baseline — the way a
 * snapshot seeds divergence now that none is ever shipped.
 */
function customSelectedState(
  edits: Record<string, readonly number[]> = {},
): StateSnapshot {
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
        params: { ...music.params, ...edits },
      },
    ],
  }
}

const option = (name: string) =>
  screen.getByRole<HTMLInputElement>('radio', { name })

// Behavior 1 (#119), the tracer bullet: the profile row is a Picker —
// one native radio per profile, named by the profile, `checked` on the
// selected one (the store's truth, never a local mirror).
it('renders one radio per profile, checked on the selected one', () => {
  render(() => <ProfileTabs />)
  const radios = screen.getAllByRole<HTMLInputElement>('radio')
  expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual([
    'Movie',
    'Music',
    'Game',
    'Voice',
  ])
  expect(radios.map((radio) => radio.checked)).toEqual([
    false,
    true,
    false,
    false,
  ])
  expect(screen.getByRole('radiogroup', { name: 'Profile' })).toBeTruthy()
  expect(option('Music').closest('.picker--profile')).toBeTruthy()
})

// Behavior 1 (#119): a pick is ack-then-apply — the click cancels the
// native check and sends `set_profile`; the radio flips on the ack
// alone. Re-picking the checked one is a no-op gesture: no frame.
it('picking sends set_profile and flips on the ack; re-picking sends nothing', async () => {
  const socket = renderConnected()
  const sentPicks = () =>
    socket.sentCommands().filter((frame) => frame.cmd === 'set_profile')

  option('Music').click()
  expect(sentPicks()).toEqual([])

  option('Movie').click()
  expect(sentPicks()).toEqual([
    {
      cmd: 'set_profile',
      request_id: expect.any(String) as string,
      id: 'movie',
    },
  ])
  // Not yet acked: the clicked radio never checked. (happy-dom leaves
  // the group's previous radio unchecked on a cancelled click — real
  // browsers restore it — so only the clicked one is asserted here.)
  expect(option('Movie').checked).toBe(false)

  socket.serverMessage({ type: 'ack', request_id: sentPicks()[0]?.request_id })
  await waitFor(() => {
    expect(option('Movie').checked).toBe(true)
    expect(option('Music').checked).toBe(false)
  })
})

// Behavior 1 (#26), profile half: the Picker actions render all four
// actions always — factory vs custom flips `disabled` per the matrix,
// never presence (zero layout shift).
it('renders all four actions always; factory vs custom flips disabled only', () => {
  render(() => <ProfileTabs />)

  // Factory (Music) selected: Add always live, the rest disabled —
  // Reset because nothing diverges (content == baseline).
  expect(action('Add profile').disabled).toBe(false)
  expect(action('Rename profile').disabled).toBe(true)
  expect(action('Delete profile').disabled).toBe(true)
  expect(action('Reset profile').disabled).toBe(true)

  // Selecting a diverging custom flips the rest live; every action
  // stays in the DOM (disable, never hide).
  applySnapshot(customSelectedState({ dvla: [9] }))
  expect(action('Add profile').disabled).toBe(false)
  expect(action('Rename profile').disabled).toBe(false)
  expect(action('Delete profile').disabled).toBe(false)
  expect(action('Reset profile').disabled).toBe(false)
  expect(screen.getAllByRole('button')).toHaveLength(4)
})

// Behavior 2 (#26), the regression the spec correction exists for:
// divergence is a memo over the snapshot's baseline, so Reset flips
// live BOTH ways on the originating tab — an edit enables it,
// reverting to the baseline value disables it again — with no
// snapshot round-trip (the daemon suppresses the originator's).
it('an edit enables Reset and reverting to baseline disables it, locally', () => {
  render(() => <ProfileTabs />)
  // A divergence-free custom: content sits exactly at its baseline.
  applySnapshot(customSelectedState())
  expect(action('Reset profile').disabled).toBe(true)

  applyProfileEdit('user_a3f1', { dvla: [9] })
  expect(action('Reset profile').disabled).toBe(false)

  // Back to the baseline value — no reset, just the edit reverted.
  applyProfileEdit('user_a3f1', { dvla: [4] })
  expect(action('Reset profile').disabled).toBe(true)
})

// Behavior 2 (#26), profile half: Reset sends the whole-item
// `reset_profile` (no `only`), reconciles off its ack, and the
// disabled state tracks the derived divergence end to end.
it('Reset sends a whole-item reset_profile and reconciles on the ack', async () => {
  const socket = renderConnected()
  applySnapshot(customSelectedState({ dvla: [9], gebg: fixtureRamp(6) }))

  action('Reset profile').click()
  const sent = socket.sentCommands().at(-1)
  expect(sent).toEqual({
    cmd: 'reset_profile',
    request_id: expect.any(String) as string,
    id: 'user_a3f1',
  })
  expect(sent && 'only' in sent).toBe(false) // whole item, not scoped

  // The reconcile's snapshot — content back at baseline — disables
  // Reset.
  await ackThenReconcile(socket, customSelectedState())
  await waitFor(() => {
    expect(action('Reset profile').disabled).toBe(true)
  })
})

// Behavior 3 (#26) + the tracer bullet: Add sends the selected
// profile's resolved content under the minted `«base» n` name — never
// a source reference (ADR-0005) — and the ack's id auto-selects the
// clone (the daemon never moves the active profile on add).
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
  expect(option('Music 2').checked).toBe(false)

  socket.serverMessage({ type: 'ack', request_id: follow?.request_id })
  await waitFor(() => {
    expect(option('Music 2').checked).toBe(true)
  })
})

/** The rename-patch `edit_profile` frames the client sent. */
const sentRenames = (socket: MockWebSocket) =>
  socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'edit_profile' && 'name' in frame)

// Behavior 5 (#26), profile half: the checked pill takes an inline
// field — Enter and blur commit `edit_profile { id, name }`, Esc (or
// an unchanged/emptied name) cancels with no wire call.
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
  expect(option('Music 2').checked).toBe(true)

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
    expect(option('Late Night').checked).toBe(true)
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

// Behavior 4 (#119): Rename keeps the checked pill in place — it gains
// `--renaming` and holds the field, prefilled and selected whole. A
// click landing in the field stays there (the card rule): no forward
// to the radio, no blur-commit, no frame. Enter commits and the field
// is gone.
it('Rename mounts the field inside the checked pill; a click in it sends nothing', () => {
  const socket = renderConnected()
  applySnapshot(customSelectedState())
  const pill = option('Music 2').labels?.[0]
  if (!pill) throw new Error('Music 2 has no pill')
  expect(pill.classList.contains('picker__option--renaming')).toBe(false)

  action('Rename profile').click()
  expect(pill.classList.contains('picker__option--renaming')).toBe(true)
  const field = screen.getByRole<HTMLInputElement>('textbox', {
    name: 'Profile name',
  })
  expect(field.closest('.picker__option')).toBe(pill)
  expect(field.classList.contains('picker__field')).toBe(true)
  expect(field.value).toBe('Music 2')
  expect(document.activeElement).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 7])

  // The label's activation is cancelled (the card rule) — in a browser
  // the forward would focus the radio and blur-commit the field.
  // happy-dom never forwards, so the cancelled click is the one
  // assertion here that discriminates; the rest pin the outcome.
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  expect(field.dispatchEvent(click)).toBe(false)
  expect(
    socket.sentCommands().filter((frame) => frame.cmd !== 'get_state'),
  ).toEqual([])
  expect(document.activeElement).toBe(field)
  expect(screen.getByRole('textbox')).toBe(field)

  fireEvent.input(field, { target: { value: 'Late Night' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(sentRenames(socket).at(-1)?.name).toBe('Late Night')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(pill.classList.contains('picker__option--renaming')).toBe(false)
})

// Behavior 5 (#119): identity-stable rendering is keyboard
// accessibility (ADR-0011 addendum 2) — a broadcast snapshot rebuilds
// the options array with a different selection; the radios render by
// position, so the one holding focus is the same node afterwards.
it('focus stays in the radio group across a snapshot with a new selection', () => {
  const socket = renderConnected()
  const music = option('Music')
  music.focus()
  expect(document.activeElement).toBe(music)

  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState({ selected_profile: 'game' }),
  })
  expect(option('Game').checked).toBe(true)
  expect(option('Music')).toBe(music)
  expect(document.activeElement).toBe(music)
})

// Delete sends `remove_profile` and reconciles off the ack — where
// the active profile lands (the Fallback profile) is daemon knowledge,
// so the originator waits for the snapshot rather than guessing.
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
    expect(screen.queryByRole('radio', { name: 'Music 2' })).toBeNull()
    expect(option('Music').checked).toBe(true)
  })
})
