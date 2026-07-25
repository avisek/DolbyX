/**
 * The typed command/event layer over the daemon WebSocket — the UI half
 * of the wire contract (ADR-0005, Slice 04 #12). Values are
 * engine-native i16 1/16-dB throughout; params travel by 4-CC name.
 */

/**
 * A profile's content shape — the EQ selection plus every writable
 * param: what a profile resolves and what its `baseline` mirrors
 * (ADR-0005).
 */
export interface ProfileContent {
  /** `null` ⇒ the profile's own EQ params apply. */
  readonly selected_eq_preset: string | null
  /** Every writable param, keyed by 4-CC, in engine-native i16. */
  readonly params: Readonly<Record<string, readonly number[]>>
}

/** An EQ preset's content shape — the nine preset-carried params. */
export interface PresetContent {
  readonly params: Readonly<Record<string, readonly number[]>>
}

/** One profile as the snapshot carries it — complete, cascade-resolved. */
export interface Profile {
  readonly id: string
  readonly name: string
  /** Factory items cannot be deleted or renamed (Reset still valid). */
  readonly is_factory: boolean
  /** `null` ⇒ the profile's own EQ params apply. */
  readonly selected_eq_preset: string | null
  /** Every writable param, keyed by 4-CC, in engine-native i16. */
  readonly params: Readonly<Record<string, readonly number[]>>
  /**
   * What resolves beneath the item's `config.toml` row, content-shaped
   * (ADR-0005). Divergence — resolved ≠ baseline per content key,
   * exactly what a whole-item reset would clear — is derived from it,
   * never shipped: the snapshot ships inputs, and every
   * Reset-disabled state follows.
   */
  readonly baseline: ProfileContent
}

/**
 * One EQ preset as the snapshot carries it — a global optional overlay;
 * when a profile selects it, its params shadow the profile's own EQ
 * params entirely (ADR-0003).
 */
export interface EqPreset {
  readonly id: string
  readonly name: string
  /** Factory items cannot be deleted or renamed (Reset still valid). */
  readonly is_factory: boolean
  /** The nine preset-carried params, keyed by 4-CC, in engine-native i16. */
  readonly params: Readonly<Record<string, readonly number[]>>
  /** As [`Profile.baseline`], over the preset-carried params. */
  readonly baseline: PresetContent
}

/** Mirror of the WS `state` event's snapshot. */
export interface StateSnapshot {
  readonly power: boolean
  readonly selected_profile: string
  readonly profiles: readonly Profile[]
  readonly eq_presets: readonly EqPreset[]
  /** The 8 ReadOnly-Static values, keyed by 4-CC. */
  readonly readouts: Readonly<Record<string, readonly number[]>>
}

/**
 * A `vis` event's payload: the main session's vis tail — four fixed
 * 20-slot arrays keyed by 4-CC, raw i16 1/16-dB (ADR-0005). The live
 * band count is the `vcnb` state param; the wire never changes shape.
 */
export interface VisParams {
  readonly vnbg: readonly number[]
  readonly vnbe: readonly number[]
  readonly vcbg: readonly number[]
  readonly vcbe: readonly number[]
}

/** A client → daemon command; the client stamps the `request_id`. */
export type Command =
  | { readonly cmd: 'get_state' }
  | { readonly cmd: 'set_power'; readonly on: boolean }
  | { readonly cmd: 'set_profile'; readonly id: string }
  | {
      /**
       * The one sparse patch verb (ADR-0005): params, a rename, and/or
       * the EQ preset selection, atomic — an invalid part rejects the
       * whole.
       */
      readonly cmd: 'edit_profile'
      readonly id: string
      /** A rename patch — factory ids reject. */
      readonly name?: string
      /** The edited entries: `{ "<4-CC>": [i16, …] }`. */
      readonly params?: Readonly<Record<string, readonly number[]>>
      /**
       * Tri-state EQ selection patch: absent = untouched, `null` =
       * detach (the profile's own EQ params apply), id = select. The
       * EQ selection is per-profile — the target is explicit.
       */
      readonly selected_eq_preset?: string | null
    }
  | {
      readonly cmd: 'edit_eq_preset'
      readonly id: string
      /** A rename patch — factory ids reject. */
      readonly name?: string
      /** The edited entries: `{ "<4-CC>": [i16, …] }`. */
      readonly params?: Readonly<Record<string, readonly number[]>>
    }
  | {
      /**
       * Create a custom profile from its content (ADR-0005) — never a
       * source reference: "clone" and "capture" are UI gestures, the
       * client copies resolved values it already holds. Unstated
       * params resolve from the custom baseline; the ack returns the
       * server-minted id.
       */
      readonly cmd: 'add_profile'
      readonly name: string
      readonly params?: Readonly<Record<string, readonly number[]>>
      /** The birth EQ selection; absent or `null` ⇒ no preset. */
      readonly selected_eq_preset?: string | null
    }
  | {
      /** As `add_profile`, over the preset-carried params. */
      readonly cmd: 'add_eq_preset'
      readonly name: string
      readonly params?: Readonly<Record<string, readonly number[]>>
    }
  | {
      /**
       * The un-edit (ADR-0007): drop the id's `config.toml`
       * divergences so the cascade beneath resolves. Valid on every
       * item; `name` never resets.
       */
      readonly cmd: 'reset_profile'
      readonly id: string
      /**
       * The scope: absent ⇒ the whole item (the EQ selection override
       * included); present ⇒ exactly these content keys. A key the
       * item doesn't carry rejects.
       */
      readonly only?: readonly string[]
    }
  | {
      /** As `reset_profile`, over the preset-carried params. */
      readonly cmd: 'reset_eq_preset'
      readonly id: string
      readonly only?: readonly string[]
    }
  | {
      /**
       * Delete a custom profile (factory ids reject). Deleting the
       * selected profile falls the active profile to the Fallback
       * profile.
       */
      readonly cmd: 'remove_profile'
      readonly id: string
    }
  | {
      /**
       * Delete a custom EQ preset (factory ids reject); selecting
       * profiles fall to explicit `None` at delete time.
       */
      readonly cmd: 'remove_eq_preset'
      readonly id: string
    }

/** A daemon → client event frame. */
export type ServerEvent =
  | {
      readonly type: 'state'
      readonly snapshot: StateSnapshot
      /**
       * Present exactly when the snapshot answers a `get_state` — the
       * total reply law (ADR-0005); broadcasts are id-less.
       */
      readonly request_id?: string
    }
  | { readonly type: 'vis'; readonly params: VisParams }
  | {
      readonly type: 'ack'
      readonly request_id: string
      /**
       * The server-minted item id — present exactly on `add_*` acks,
       * so the originator applies locally without waiting for a
       * snapshot (ADR-0005). Opaque beyond the `user_` prefix.
       */
      readonly id?: string
    }
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
  /** One per-block `vis` event arrived — the latest frame. */
  onVis(params: VisParams): void
  /** The connection opened (`true`) or dropped (`false`). */
  onConnected(connected: boolean): void
}

/** One command awaiting its reply (`ack` | `error` | `state`). */
interface Pending {
  readonly cmd: Command['cmd']
  readonly resolve: (minted?: string) => void
  readonly reject: (reason: Error) => void
}

/** First reconnect delay; doubles per failed attempt up to the max. */
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000

/**
 * The daemon WS client: one socket per UI tab, every command settled
 * promise-style by the one reply echoing its `request_id` — `ack`,
 * `error`, or, for `get_state`, the `state` event itself (ADR-0005).
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
   * settles on the daemon's matching reply — `ack` or an id-echoing
   * `state` (resolve), `error` (reject). An `add_*` ack resolves the
   * server-minted item id; every other reply resolves `undefined`.
   * Rejects immediately while the socket is not open.
   */
  request(command: Command): Promise<string | undefined> {
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
        // The state event itself answers get_state (ADR-0005).
        if (parsed.request_id !== undefined) {
          this.#settle(parsed.request_id)?.resolve()
        }
        break
      case 'vis':
        this.#handlers.onVis(parsed.params)
        break
      case 'ack':
        this.#settle(parsed.request_id)?.resolve(parsed.id)
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
        // Unknown (future) event types are ignored.
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
