import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockWebSocket } from '../test/mock-ws'
import { WsClient, type StateSnapshot, type VisParams } from './ws'

vi.stubGlobal('WebSocket', MockWebSocket)

let snapshots: StateSnapshot[]
let connectionLog: boolean[]
let visFrames: VisParams[]
let client: WsClient

beforeEach(() => {
  MockWebSocket.reset()
  snapshots = []
  connectionLog = []
  visFrames = []
  client = new WsClient('ws://daemon.test/ws', {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onConnected: (connected) => connectionLog.push(connected),
    onVis: (params) => visFrames.push(params),
  })
})

afterEach(() => {
  client.close()
  vi.useRealTimers()
})

// Behavior 2 (#13), the correlation half: every command gets a fresh
// `request_id`, and an `ack` settles exactly its own pending promise.
it('stamps a fresh request_id per command and resolves the acked one', async () => {
  const socket = MockWebSocket.latest()
  socket.open()

  let firstSettled = false
  const first = client
    .request({ cmd: 'set_power', on: false })
    .then(() => (firstSettled = true))
  const second = client.request({ cmd: 'set_power', on: true })

  const sent = socket
    .sentCommands()
    .filter((frame) => frame.cmd === 'set_power')
  expect(sent).toHaveLength(2)
  const [a, b] = sent
  expect(a?.request_id).toBeTruthy()
  expect(b?.request_id).toBeTruthy()
  expect(a?.request_id).not.toBe(b?.request_id)

  socket.serverMessage({ type: 'ack', request_id: b?.request_id, ok: true })
  await second
  expect(firstSettled).toBe(false)

  socket.serverMessage({ type: 'ack', request_id: a?.request_id, ok: true })
  await first
})

it('rejects a command while the socket is not open', async () => {
  // Still CONNECTING — the daemon truth arrives on connect anyway.
  await expect(client.request({ cmd: 'get_state' })).rejects.toThrow(
    'WS not open',
  )
})

// Behavior 4 (#13): an `error` settles its pending as a rejection, and
// the client re-issues `get_state` — local optimism gets reconciled.
it('rejects the errored pending and reconciles with a get_state', async () => {
  const socket = MockWebSocket.latest()
  socket.open()

  const request = client.request({ cmd: 'set_power', on: false })
  const rejection = expect(request).rejects.toThrow(
    'INVALID_REQUEST: power is managed by the mixing desk',
  )
  const [sent] = socket.sentCommands().filter((f) => f.cmd === 'set_power')

  socket.serverMessage({
    type: 'error',
    request_id: sent?.request_id,
    code: 'INVALID_REQUEST',
    message: 'power is managed by the mixing desk',
  })
  await rejection

  // One on-open reconcile, a second triggered by the error.
  const reconciles = socket.sentCommands().filter((f) => f.cmd === 'get_state')
  expect(reconciles).toHaveLength(2)
})

// Behavior 5 (#13), the client half: a drop fails the in-flight
// commands, reports the disconnect, and a fresh socket reconciles.
it('reconnects after a drop and reconciles the reopened socket', async () => {
  vi.useFakeTimers()
  const socket = MockWebSocket.latest()
  socket.open()
  expect(connectionLog).toEqual([true])
  // Every open pulls daemon truth — reconnects reuse the same path.
  expect(socket.sentCommands().map((f) => f.cmd)).toEqual(['get_state'])

  const request = client.request({ cmd: 'set_power', on: false })
  const rejection = expect(request).rejects.toThrow('connection lost')
  socket.drop()
  await rejection
  expect(connectionLog).toEqual([true, false])

  vi.advanceTimersByTime(249)
  expect(MockWebSocket.instances).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(MockWebSocket.instances).toHaveLength(2)

  const reopened = MockWebSocket.latest()
  reopened.open()
  expect(connectionLog).toEqual([true, false, true])
  expect(reopened.sentCommands().map((f) => f.cmd)).toEqual(['get_state'])
})

it('doubles the backoff per failed attempt and resets on an open', () => {
  vi.useFakeTimers()
  MockWebSocket.latest().open()
  MockWebSocket.latest().drop()

  vi.advanceTimersByTime(250)
  expect(MockWebSocket.instances).toHaveLength(2)
  MockWebSocket.latest().drop() // connect attempt fails — daemon still down

  vi.advanceTimersByTime(499)
  expect(MockWebSocket.instances).toHaveLength(2)
  vi.advanceTimersByTime(1)
  expect(MockWebSocket.instances).toHaveLength(3)

  MockWebSocket.latest().open() // daemon back — backoff resets
  MockWebSocket.latest().drop()
  vi.advanceTimersByTime(250)
  expect(MockWebSocket.instances).toHaveLength(4)
})

it('close() stops the reconnect loop', () => {
  vi.useFakeTimers()
  MockWebSocket.latest().open()
  MockWebSocket.latest().drop()

  client.close()
  vi.advanceTimersByTime(60_000)
  expect(MockWebSocket.instances).toHaveLength(1)
})

// Slice 16 (#24): `vis` events are pure pub/sub — routed to onVis
// verbatim, no request lifecycle, no reconcile.
it('routes vis events to onVis without touching pendings', () => {
  const socket = MockWebSocket.latest()
  socket.open()
  const params = {
    vnbg: [0, 1, 2],
    vnbe: [20, 21, 22],
    vcbg: [40, 41, 42],
    vcbe: [60, 61, 62],
  }
  socket.serverMessage({ type: 'vis', params })
  expect(visFrames).toEqual([params])
  // Only the on-open reconcile was sent — a vis event triggers nothing.
  expect(socket.sentCommands().map((f) => f.cmd)).toEqual(['get_state'])
})

it('does not reconcile a failed get_state again (no error loop)', () => {
  const socket = MockWebSocket.latest()
  socket.open()
  const [reconcile] = socket.sentCommands() // the on-open get_state

  socket.serverMessage({
    type: 'error',
    request_id: reconcile?.request_id,
    code: 'INVALID_REQUEST',
    message: 'daemon had a moment',
  })

  const gets = socket.sentCommands().filter((f) => f.cmd === 'get_state')
  expect(gets).toHaveLength(1)
})
