/**
 * The typed command/event layer over the daemon WebSocket — the UI half
 * of the wire contract (ADR-0005, Slice 04 #12). Values are
 * engine-native i16 1/16-dB throughout; params travel by 4-CC name.
 */

/** One profile as the snapshot carries it — complete, cascade-resolved. */
export interface Profile {
  readonly id: string
  readonly name: string
  /** Factory items reset instead of delete/rename. */
  readonly is_factory: boolean
  /** `null` ⇒ the profile's own EQ params apply (presets: Slice 15). */
  readonly selected_eq_preset: string | null
  /** Every writable param, keyed by 4-CC, in engine-native i16. */
  readonly params: Readonly<Record<string, readonly number[]>>
}

/** Mirror of the WS `state` event's snapshot. */
export interface StateSnapshot {
  readonly power: boolean
  readonly selected_profile: string
  readonly profiles: readonly Profile[]
  /** The 8 ReadOnly-Static values, keyed by 4-CC. */
  readonly readouts: Readonly<Record<string, readonly number[]>>
}

/** A client → daemon command; the client stamps the `request_id`. */
export type Command =
  | { readonly cmd: 'get_state' }
  | { readonly cmd: 'set_power'; readonly on: boolean }
  | { readonly cmd: 'set_profile'; readonly id: string }

/** A daemon → client event frame. */
export type ServerEvent =
  | { readonly type: 'state'; readonly snapshot: StateSnapshot }
  | { readonly type: 'ack'; readonly request_id: string; readonly ok: true }
  | {
      readonly type: 'error'
      /** `null` when the frame was too malformed to carry one. */
      readonly request_id: string | null
      readonly code: 'INVALID_REQUEST' | 'ENGINE_REJECTED'
      readonly message: string
    }

/** How [`WsClient`] feeds the store. */
export interface WsClientHandlers {
  /** A full `state` snapshot arrived — reconcile it. */
  onSnapshot(snapshot: StateSnapshot): void
  /** The connection opened (`true`) or dropped (`false`). */
  onConnected(connected: boolean): void
}

/** One command awaiting its `ack`/`error`. */
interface Pending {
  readonly cmd: Command['cmd']
  readonly resolve: () => void
  readonly reject: (reason: Error) => void
}

/** First reconnect delay; doubles per failed attempt up to the max. */
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000

/**
 * The daemon WS client: one socket per UI tab, every command settled
 * promise-style by the `ack`/`error` echoing its `request_id`.
 * Auto-reconnects with backoff after a drop or daemon restart; every
 * open (first and re-) issues a `get_state` reconcile.
 */
export class WsClient {
  readonly #url: string
  readonly #handlers: WsClientHandlers
  #socket: WebSocket
  readonly #pending = new Map<string, Pending>()
  #nextRequestId = 0
  #retries = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  constructor(url: string, handlers: WsClientHandlers) {
    this.#url = url
    this.#handlers = handlers
    this.#socket = this.#connect()
  }

  #connect(): WebSocket {
    const socket = new WebSocket(this.#url)
    socket.onopen = () => {
      this.#retries = 0
      this.#handlers.onConnected(true)
      this.#reconcile()
    }
    socket.onmessage = (event) => {
      this.#receive(event)
    }
    socket.onclose = () => {
      this.#disconnected()
    }
    return socket
  }

  /** A socket died (drop, restart, failed attempt) — schedule the next. */
  #disconnected(): void {
    if (this.#closed) return
    this.#failPending(new Error('connection lost'))
    this.#handlers.onConnected(false)
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.#retries,
      RECONNECT_MAX_MS,
    )
    this.#retries += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#socket = this.#connect()
    }, delay)
  }

  #failPending(reason: Error): void {
    for (const pending of this.#pending.values()) pending.reject(reason)
    this.#pending.clear()
  }

  /**
   * Sends one command with a fresh `request_id`; the returned promise
   * settles on the daemon's matching `ack` (resolve) or `error`
   * (reject). Rejects immediately while the socket is not open.
   */
  request(command: Command): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WS not open'))
    }
    const request_id = `r${String(++this.#nextRequestId)}`
    const frame = JSON.stringify({ ...command, request_id })
    return new Promise((resolve, reject) => {
      this.#pending.set(request_id, { cmd: command.cmd, resolve, reject })
      this.#socket.send(frame)
    })
  }

  /** Closes the socket for good — no reconnect, pendings rejected. */
  close(): void {
    this.#closed = true
    clearTimeout(this.#reconnectTimer)
    this.#failPending(new Error('WS closed'))
    this.#socket.close()
  }

  #receive(event: MessageEvent): void {
    // Trusted same-origin daemon; shapes pinned by the Slice 04 tests.
    const parsed = JSON.parse(event.data as string) as ServerEvent
    switch (parsed.type) {
      case 'state':
        this.#handlers.onSnapshot(parsed.snapshot)
        break
      case 'ack':
        this.#settle(parsed.request_id)?.resolve()
        break
      case 'error': {
        const pending = this.#settle(parsed.request_id)
        pending?.reject(new Error(`${parsed.code}: ${parsed.message}`))
        // Whatever the daemon refused, this tab's optimism may be stale
        // — reconcile. A failed reconcile itself doesn't retry (no loop);
        // the next state event or reconnect resyncs.
        if (pending?.cmd !== 'get_state') this.#reconcile()
        break
      }
      default:
        // Unknown event types (future `vis`, Slice 16) are ignored.
        break
    }
  }

  /** Pulls the daemon's full truth; its `state` event does the work. */
  #reconcile(): void {
    void this.request({ cmd: 'get_state' }).catch(() => {
      // Handled as any other error event; never unhandled-rejection noise.
    })
  }

  /** Removes and returns the pending command for `request_id`. */
  #settle(request_id: string | null): Pending | undefined {
    if (request_id === null) return undefined
    const pending = this.#pending.get(request_id)
    this.#pending.delete(request_id)
    return pending
  }
}
