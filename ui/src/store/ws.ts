/**
 * The WS ↔ store glue: one [`WsClient`] per tab feeding the state store,
 * plus the connection signal and the command actions components call.
 */
import { createSignal } from 'solid-js'
import { WsClient } from '../lib/ws'
import { applyPower, applySnapshot } from './state'

const [connected, setConnected] = createSignal(false)

/** True while the daemon WS is open — drives the ConnectionBadge. */
export { connected }

let client: WsClient | undefined

/**
 * Connects to the daemon in the background — `main.tsx` calls this once
 * right after the first paint; tests per case, against a mocked socket.
 */
export function startWs(url = `ws://${location.host}/ws`): void {
  client?.close()
  client = new WsClient(url, {
    onSnapshot: applySnapshot,
    onConnected: setConnected,
  })
}

/** Drops the connection for good (test teardown). */
export function stopWs(): void {
  client?.close()
  client = undefined
  setConnected(false)
}

/**
 * Local-first `set_power`: sends the command, applies the flip when the
 * daemon acks it — the resulting `state` broadcast goes to *other*
 * clients only (originator-aware, ADR-0005).
 */
export function setPower(on: boolean): void {
  void client
    ?.request({ cmd: 'set_power', on })
    .then(() => {
      applyPower(on)
    })
    .catch(() => {
      // Rejected or errored — the client's get_state reconcile restores
      // daemon truth; the toggle simply never moved.
    })
}
