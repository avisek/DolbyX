import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { skins } from '../skins'
import { MockWebSocket } from '../test/mock-ws'
import { fixtureBootstrap, fixtureState } from '../test/fixture'

// The store reads window.__BOOTSTRAP__ at module init (ADR-0006) —
// install the fixture before the dynamic imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: SkinPicker } = await import('./SkinPicker')
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

/** Renders the Skin picker and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <SkinPicker />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

const radios = () => screen.getAllByRole<HTMLInputElement>('radio')
const option = (name: string) =>
  screen.getByRole<HTMLInputElement>('radio', { name })

/** The `set_skin` frames the client sent. */
const sentSetSkin = (socket: MockWebSocket) =>
  socket.sentCommands().filter((frame) => frame.cmd === 'set_skin')

// Behavior 2 (#137), the tracer bullet: the Skin picker is a Picker
// over the Skin registry — one radio per entry in registry order,
// labelled by the registry, `picker--skin`; no Picker actions, no
// rename (CONTEXT.md "Skin picker").
it('renders one radio per registry entry, in order, labelled from the registry', () => {
  render(() => <SkinPicker />)
  expect(radios().map((radio) => radio.labels?.[0]?.textContent)).toEqual(
    skins.map((skin) => skin.label),
  )
  expect(screen.getByRole('radiogroup', { name: 'Skin' })).toBeTruthy()
  expect(option('Classic').closest('.picker--skin')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(document.querySelector('.picker__actions')).toBeNull()
})

// Behavior 2 (#137): `checked` is the store's `skin`; an id the registry
// doesn't ship checks no pill (ADR-0013 — the default paints, nothing
// claims to be it).
it('checks the pill matching state.skin; none for an unknown id', () => {
  render(() => <SkinPicker />)
  expect(option('Remastered').checked).toBe(true)
  expect(option('Classic').checked).toBe(false)

  applySnapshot(fixtureState({ skin: 'classic' }))
  expect(option('Classic').checked).toBe(true)
  expect(option('Remastered').checked).toBe(false)

  applySnapshot(fixtureState({ skin: 'nope' }))
  expect(radios().map((radio) => radio.checked)).toEqual([false, false])
})

// Behavior 2 (#137): a pick is ack-then-apply — the click cancels the
// native check and sends `set_skin`; the pill flips on the ack alone.
it('clicking Classic sends set_skin and checks it only on the ack', async () => {
  const socket = renderConnected()

  option('Classic').click()
  const sent = sentSetSkin(socket)
  expect(sent).toEqual([
    {
      cmd: 'set_skin',
      request_id: expect.any(String) as string,
      id: 'classic',
    },
  ])
  // Not yet acked: the clicked radio never checked.
  expect(option('Classic').checked).toBe(false)

  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(option('Classic').checked).toBe(true)
  })
  expect(option('Remastered').checked).toBe(false)
})

// Behavior 2 (#137): Arrow keys move natively within the group — in a
// browser ArrowRight checks the next radio, focuses it and dispatches
// its click, which asks the store; happy-dom has no radio roving, so
// the test dispatches what Chromium would. Positional keying keeps the
// focused node alive across the rebuilt options: focus stays on it
// through the ack.
it('ArrowRight moves to the next skin and keeps focus on it', async () => {
  const socket = renderConnected()
  option('Remastered').focus()
  option('Classic').focus()
  option('Classic').click()

  const sent = sentSetSkin(socket)
  expect(sent.map((frame) => frame.id)).toEqual(['classic'])
  socket.serverMessage({ type: 'ack', request_id: sent[0]?.request_id })
  await waitFor(() => {
    expect(option('Classic').checked).toBe(true)
  })
  expect(document.activeElement).toBe(option('Classic'))
})
