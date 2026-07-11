/**
 * The mocked WebSocket — the one sanctioned UI test seam (issue #13
 * mock policy; the real daemon is exercised by the Slice 09 E2E). Tests
 * install it with `vi.stubGlobal('WebSocket', MockWebSocket)`, observe
 * the frames the client sent, and fabricate daemon events.
 */

/** One parsed client → daemon command frame. */
export interface SentCommand {
  readonly cmd: string
  readonly request_id: string
  readonly [key: string]: unknown
}

export class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  /** Every socket constructed since the last `reset()`, oldest first. */
  static instances: MockWebSocket[] = []

  static reset(): void {
    MockWebSocket.instances = []
  }

  /** The most recently constructed socket. */
  static latest(): MockWebSocket {
    const socket = MockWebSocket.instances.at(-1)
    if (!socket) throw new Error('no WebSocket constructed yet')
    return socket
  }

  readyState: number = MockWebSocket.CONNECTING
  readonly sent: string[] = []

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(readonly url: string | URL) {
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.drop()
  }

  /** The sent frames, parsed. */
  sentCommands(): SentCommand[] {
    return this.sent.map((frame) => JSON.parse(frame) as SentCommand)
  }

  // — test drivers, fabricating the daemon side —

  /** Completes the handshake. */
  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  /** Delivers one daemon event frame. */
  serverMessage(event: object): void {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(event) }),
    )
  }

  /** Drops the connection (daemon restart, network loss). */
  drop(): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}
