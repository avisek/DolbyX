/**
 * The WS ↔ store glue: one [`WsClient`] per tab feeding the state store,
 * plus the connection signal and the command actions components call.
 */
import { createSignal } from 'solid-js'
import { WsClient } from '../lib/ws'
import {
  applyPower,
  applyProfile,
  applyProfileEdit,
  applySnapshot,
} from './state'

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

/**
 * Local-first `set_profile`: sends the switch, applies the selection
 * when the daemon acks it — the daemon has already pushed the profile's
 * full resolved set to the engine in one atomic batch.
 */
export function setProfile(id: string): void {
  void client
    ?.request({ cmd: 'set_profile', id })
    .then(() => {
      applyProfile(id)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth; the
      // selection simply never moved.
    })
}

/**
 * Local-first `edit_profile` for discrete controls (toggles): sends
 * the batch, applies it on the daemon's ack.
 */
export function editProfile(
  id: string,
  params: Readonly<Record<string, readonly number[]>>,
): void {
  void client
    ?.request({ cmd: 'edit_profile', id, params })
    .then(() => {
      applyProfileEdit(id, params)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/**
 * Optimistic `edit_profile` for continuous drags: applied immediately —
 * waiting for the ack would let a round-trip-lagged apply yank a
 * mid-drag slider backward (the in-flight-edit hazard originator
 * suppression exists for, ADR-0005). A rejection reconciles: the
 * client re-issues `get_state` on any command error.
 */
export function editProfileLive(
  id: string,
  params: Readonly<Record<string, readonly number[]>>,
): void {
  applyProfileEdit(id, params)
  void client?.request({ cmd: 'edit_profile', id, params }).catch(() => {
    // The error-path reconcile restores daemon truth.
  })
}
