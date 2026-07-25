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
import type { EqPreset, StateSnapshot } from '../lib/ws'

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

const action = (name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name })

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

/** The fixture state plus a custom preset, selected by `profileId`. */
function customPresetState(
  profileId: string,
  overrides: Partial<EqPreset> = {},
): StateSnapshot {
  const seeded = selectingState(profileId, 'user_91c2')
  const rich = seeded.eq_presets.find((preset) => preset.id === 'rich')
  if (!rich) throw new Error('fixture lost Rich')
  return {
    ...seeded,
    eq_presets: [
      ...seeded.eq_presets,
      {
        ...rich,
        id: 'user_91c2',
        name: 'Rich 2',
        is_factory: false,
        ...overrides,
      },
    ],
  }
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

// Re-picking the checked option is a no-op gesture: no patch goes
// out, so the local `overridden` union can't falsely enable Reset on
// a pristine profile (behavior 2's disabled-iff rule).
it('re-picking the checked option sends nothing', () => {
  const socket = renderConnected() // Music with None selected

  option('None').click()
  expect(sentSelections(socket)).toEqual([])
  expect(action('Reset EQ preset').disabled).toBe(true)

  applySnapshot(selectingState('music', 'rich'))
  option('Rich').click()
  expect(sentSelections(socket)).toEqual([])
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

// Behavior 1 (#26), preset half: the action row renders all four
// actions always, acting on the current selection — None included;
// None and factory selections disable Rename/Delete, a custom enables
// them, presence never changes (zero layout shift).
it('renders all four actions always; None/factory/custom flip disabled only', () => {
  render(() => <EqPresetPicker />) // Music with None selected

  expect(action('Add EQ preset').disabled).toBe(false)
  expect(action('Rename EQ preset').disabled).toBe(true)
  expect(action('Delete EQ preset').disabled).toBe(true)

  applySnapshot(selectingState('music', 'rich')) // factory preset
  expect(action('Rename EQ preset').disabled).toBe(true)
  expect(action('Delete EQ preset').disabled).toBe(true)

  applySnapshot(customPresetState('music')) // custom preset
  expect(action('Rename EQ preset').disabled).toBe(false)
  expect(action('Delete EQ preset').disabled).toBe(false)
  expect(screen.getAllByRole('button')).toHaveLength(4)
})

/** The fixture state with the active profile's `overridden` set. */
function overriddenState(overridden: readonly string[]): StateSnapshot {
  const seeded = fixtureState()
  return {
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === seeded.selected_profile
        ? { ...profile, overridden }
        : profile,
    ),
  }
}

// Behavior 2 (#26), preset half: the None row resets the profile's
// own EQ scoped to the nine preset-carried keys — disabled iff
// `overridden ∩ the-9` is empty, flipping live as edits land.
it('the None row sends a reset_profile scoped to the 9', () => {
  const socket = renderConnected()

  // Fresh Music: nothing diverges → nothing to clear.
  expect(action('Reset EQ preset').disabled).toBe(true)
  // A non-EQ divergence doesn't intersect the 9 → still disabled.
  applySnapshot(overriddenState(['dvla']))
  expect(action('Reset EQ preset').disabled).toBe(true)
  // An EQ divergence lands → enabled.
  applySnapshot(overriddenState(['dvla', 'gebg']))
  expect(action('Reset EQ preset').disabled).toBe(false)

  action('Reset EQ preset').click()
  expect(socket.sentCommands().at(-1)).toEqual({
    cmd: 'reset_profile',
    request_id: expect.any(String) as string,
    id: 'music',
    only: [
      'ieon',
      'ienb',
      'iebf',
      'iebt',
      'iea',
      'geon',
      'genb',
      'gebf',
      'gebg',
    ],
  })
})

// Behavior 2 (#26), preset half: a selected preset resets whole-item
// via `reset_eq_preset`, disabled iff its own `overridden` is empty.
it('a selected EQ preset resets whole-item via reset_eq_preset', () => {
  const socket = renderConnected()

  applySnapshot(customPresetState('music'))
  expect(action('Reset EQ preset').disabled).toBe(true)
  applySnapshot(customPresetState('music', { overridden: ['iebt'] }))
  expect(action('Reset EQ preset').disabled).toBe(false)

  action('Reset EQ preset').click()
  const sent = socket.sentCommands().at(-1)
  expect(sent).toEqual({
    cmd: 'reset_eq_preset',
    request_id: expect.any(String) as string,
    id: 'user_91c2',
  })
  expect(sent && 'only' in sent).toBe(false) // whole item, not scoped
})

// Behavior 3 (#26), preset half: Add clones the selected preset —
// its resolved params under the minted `«base» n` name — and the
// ack's minted id auto-selects the clone for this profile (the
// daemon never moves selection on add).
it('Add clones the selected preset and the acked minted id selects it', async () => {
  applySnapshot(selectingState('music', 'rich'))
  const socket = renderConnected()
  const rich = fixtureState().eq_presets.find((preset) => preset.id === 'rich')

  action('Add EQ preset').click()
  const sent = socket.sentCommands().at(-1)
  expect(sent).toEqual({
    cmd: 'add_eq_preset',
    request_id: expect.any(String) as string,
    name: 'Rich 2',
    params: rich?.params,
  })

  socket.serverMessage({
    type: 'ack',
    request_id: sent?.request_id,
    id: 'user_91c2',
  })
  // The originator applies the clone off its ack, then selects it —
  // an `edit_profile` selection patch, per-profile.
  const follow = await waitFor(() => {
    const frame = sentSelections(socket).at(-1)
    expect(frame).toMatchObject({
      id: 'music',
      selected_eq_preset: 'user_91c2',
    })
    return frame
  })
  expect(option('Rich 2')).toBeTruthy()

  socket.serverMessage({ type: 'ack', request_id: follow?.request_id })
  await waitFor(() => {
    expect(option('Rich 2').getAttribute('aria-checked')).toBe('true')
  })
})

// Behavior 4 (#26): Add on None captures the profile's own resolved
// preset-carried values — exactly the 9, derived category ∈ {Ieq,
// Geq} — as `Preset n`, smallest n ≥ 1.
it('Add on None captures the profile own 9 as Preset 1', () => {
  const socket = renderConnected() // Music with None selected
  const music = fixtureState().profiles.find((p) => p.id === 'music')

  action('Add EQ preset').click()
  expect(socket.sentCommands().at(-1)).toEqual({
    cmd: 'add_eq_preset',
    request_id: expect.any(String) as string,
    name: 'Preset 1',
    params: {
      ieon: music?.params['ieon'],
      ienb: music?.params['ienb'],
      iebf: music?.params['iebf'],
      iebt: music?.params['iebt'],
      iea: music?.params['iea'],
      geon: music?.params['geon'],
      genb: music?.params['genb'],
      gebf: music?.params['gebf'],
      gebg: music?.params['gebg'],
    },
  })
})

// Behavior 5 (#26), preset half: the checked option's label becomes
// an inline field — Enter commits `edit_eq_preset { id, name }`, Esc
// cancels with no wire call.
it('inline EQ preset rename commits on Enter, cancels on Esc', async () => {
  applySnapshot(customPresetState('music'))
  const socket = renderConnected()
  const field = () => screen.getByRole<HTMLInputElement>('textbox')
  const sentRenames = () =>
    socket
      .sentCommands()
      .filter((frame) => frame.cmd === 'edit_eq_preset' && 'name' in frame)

  // Esc: no frame, the option label untouched.
  action('Rename EQ preset').click()
  expect(field().value).toBe('Rich 2')
  fireEvent.input(field(), { target: { value: 'Scrapped' } })
  fireEvent.keyDown(field(), { key: 'Escape' })
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(sentRenames()).toEqual([])
  expect(option('Rich 2')).toBeTruthy()

  // Enter commits; the label updates local-first on the ack — the
  // preset is global, so the new label shows under every profile.
  action('Rename EQ preset').click()
  fireEvent.input(field(), { target: { value: 'Warm' } })
  fireEvent.keyDown(field(), { key: 'Enter' })
  const sent = sentRenames()
  expect(sent).toEqual([
    {
      cmd: 'edit_eq_preset',
      request_id: expect.any(String) as string,
      id: 'user_91c2',
      name: 'Warm',
    },
  ])
  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(option('Warm').getAttribute('aria-checked')).toBe('true')
  })
})

// Delete sends `remove_eq_preset` and reconciles off the ack — the
// daemon falls every selecting profile to explicit None at delete
// time (a delete never activates the selection beneath, ADR-0003).
it('Delete sends remove_eq_preset and the reconcile falls to None', async () => {
  applySnapshot(customPresetState('music'))
  const socket = renderConnected()

  action('Delete EQ preset').click()
  expect(socket.sentCommands().at(-1)).toEqual({
    cmd: 'remove_eq_preset',
    request_id: expect.any(String) as string,
    id: 'user_91c2',
  })

  const sent = socket.sentCommands().at(-1)
  socket.serverMessage({ type: 'ack', request_id: sent?.request_id })
  await waitFor(() => {
    expect(socket.sentCommands().at(-1)?.cmd).toBe('get_state')
  })
  socket.serverMessage({
    type: 'state',
    snapshot: fixtureState(),
    request_id: socket.sentCommands().at(-1)?.request_id,
  })
  await waitFor(() => {
    expect(screen.queryByRole('radio', { name: 'Rich 2' })).toBeNull()
    expect(option('None').getAttribute('aria-checked')).toBe('true')
  })
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
