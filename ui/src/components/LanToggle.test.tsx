import { cleanup, render, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import {
  FIXTURE_LAN_URL,
  fixtureBootstrap,
  fixtureState,
} from '../test/fixture'

// The store hydrates from window.__BOOTSTRAP__ at module init
// (ADR-0006) — install the fixture before the dynamic imports evaluate.
window.__BOOTSTRAP__ = fixtureBootstrap()
vi.stubGlobal('WebSocket', MockWebSocket)

const { default: LanToggle } = await import('./LanToggle')
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

/** Renders the Row and completes the background WS handshake. */
function renderConnected(): MockWebSocket {
  render(() => <LanToggle />)
  startWs('ws://daemon.test/ws')
  const socket = MockWebSocket.latest()
  socket.open()
  return socket
}

const lanSwitch = () =>
  screen.getByRole<HTMLInputElement>('switch', { name: 'LAN access' })
const urlField = () =>
  screen.getByRole<HTMLInputElement>('textbox', { name: 'LAN URL' })
const copyButton = () => screen.getByRole('button', { name: 'Copy URL' })
const qrButton = () => screen.getByRole('button', { name: 'Show QR code' })

/** The `set_lan_access` frames the client sent. */
const sentFlips = (socket: MockWebSocket) =>
  socket.sentCommands().filter((frame) => frame.cmd === 'set_lan_access')

// Behavior 3 (#118), the card rule: a click on the URL field or either
// button — where a browser would otherwise forward to the `for` target
// — never reaches the switch: no command, focus stays where the click
// put it, and the field selects partially like any text field.
it('clicks on the field and the buttons send nothing; the field keeps focus and selects', () => {
  const socket = renderConnected()

  const field = urlField()
  field.focus()
  field.click()
  expect(document.activeElement).toBe(field)
  field.setSelectionRange(0, 4)
  expect(field.selectionEnd).toBe(4)

  copyButton().focus()
  copyButton().click()
  expect(document.activeElement).toBe(copyButton())

  qrButton().focus()
  qrButton().click()

  expect(sentFlips(socket)).toEqual([])
  expect(lanSwitch().checked).toBe(false)
  expect(field.value).toBe(FIXTURE_LAN_URL)
})

/** The Row itself — where the modifiers land. */
const row = () => {
  const label = lanSwitch().closest('label')
  if (!label) throw new Error('LAN switch has no label')
  return label
}
const copied = () => row().classList.contains('lan-access--copied')

// Behavior 4 (#118): Copy writes the URL to the clipboard and raises
// `--copied` once the write resolves; the component's own timer clears
// it 1.5 s later (timed state is component-side — ADR-0011 addendum 2).
it('Copy writes the URL to the clipboard and raises --copied for 1500 ms', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn(() => Promise.resolve())
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
  try {
    renderConnected()

    copyButton().click()
    expect(writeText).toHaveBeenCalledWith(FIXTURE_LAN_URL)
    // Not yet: the modifier follows the clipboard's resolve.
    expect(copied()).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(copied()).toBe(true)

    await vi.advanceTimersByTimeAsync(1499)
    expect(copied()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(copied()).toBe(false)
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

// Behavior 4 (#118), the insecure-context path: a LAN client over
// plain http has no `navigator.clipboard`. Copy then selects the URL
// field and issues the legacy copy command inside the click gesture,
// confirms on success, and hands focus back to the button.
it('without navigator.clipboard, Copy selects the field, runs execCommand and confirms', () => {
  vi.useFakeTimers()
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(
    undefined as unknown as Clipboard,
  )
  // happy-dom ships no execCommand: define one that records the
  // selection the command would copy.
  let selected = ''
  const execCommand = vi.fn((command: string) => {
    const field = urlField()
    selected = field.value.slice(
      field.selectionStart ?? 0,
      field.selectionEnd ?? 0,
    )
    return command === 'copy'
  })
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
  })
  try {
    renderConnected()
    copyButton().focus()
    copyButton().click()

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(selected).toBe(FIXTURE_LAN_URL)
    expect(document.activeElement).toBe(copyButton())
    expect(copied()).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(copied()).toBe(false)
  } finally {
    delete (document as { execCommand?: unknown }).execCommand
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

const qrOpen = () => row().classList.contains('lan-access--qr')
const figure = () => {
  const el = row().querySelector<HTMLElement>('figure.lan-access__qr')
  if (!el) throw new Error('QR figure not rendered')
  return el
}

/** Opens the popover from the button and asserts the open contract. */
function openQr() {
  qrButton().click()
  expect(qrOpen()).toBe(true)
  expect(qrButton().getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(figure())
}

// Behavior 5 (#118), the Popover (CONTEXT.md): the button opens it —
// `--qr`, `aria-pressed`, focus on the figure; Escape closes it and
// returns focus to the button; focus leaving the figure closes it;
// LAN going off closes it. The figure holds the QR image.
it('the QR button opens a focus-managed popover that Escape, focus loss and LAN off close', () => {
  const socket = renderConnected()
  applySnapshot(fixtureState({ lan_access: true }))
  expect(
    within(figure()).getByRole('img', {
      name: 'Scan to open DolbyX on your phone',
    }),
  ).toBeTruthy()
  expect(qrOpen()).toBe(false)
  expect(qrButton().getAttribute('aria-pressed')).toBe('false')

  openQr()
  figure().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  )
  expect(qrOpen()).toBe(false)
  expect(qrButton().getAttribute('aria-pressed')).toBe('false')
  expect(document.activeElement).toBe(qrButton())

  openQr()
  copyButton().focus()
  expect(qrOpen()).toBe(false)
  expect(document.activeElement).toBe(copyButton())

  openQr()
  socket.serverMessage({ type: 'state', snapshot: fixtureState() })
  expect(lanSwitch().checked).toBe(false)
  expect(qrOpen()).toBe(false)
})

// Behavior 5 (#118): the button toggles — a click while open closes
// without moving focus off the button; Enter on the figure closes and
// refocuses the button like Escape.
it('the QR button closes its own popover; Enter on the figure closes and refocuses the button', () => {
  renderConnected()
  applySnapshot(fixtureState({ lan_access: true }))

  openQr()
  qrButton().focus()
  qrButton().click()
  expect(qrOpen()).toBe(false)
  expect(document.activeElement).toBe(qrButton())

  openQr()
  figure().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  )
  expect(qrOpen()).toBe(false)
  expect(document.activeElement).toBe(qrButton())
})
