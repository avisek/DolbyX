/**
 * The WS ↔ store glue: one [`WsClient`] per tab feeding the state store,
 * plus the connection signal and the command actions components call.
 */
import { createSignal } from 'solid-js'
import { WsClient } from '../lib/ws'
import {
  applyEqPreset,
  applyEqPresetAdd,
  applyEqPresetEdit,
  applyEqPresetRename,
  applyPower,
  applyProfile,
  applyProfileAdd,
  applyProfileEdit,
  applyProfileRename,
  applySnapshot,
  state,
} from './state'
import { applyVisFrame } from './vis'

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
    onVis: applyVisFrame,
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
 * Local-first `set_eq_preset`: selects (or with `null` detaches) one
 * profile's EQ preset overlay, applied on the daemon's ack — the daemon
 * has already pushed the resolved nine EQ params in one atomic batch.
 */
export function setEqPreset(profileId: string, id: string | null): void {
  void client
    ?.request({ cmd: 'set_eq_preset', profile_id: profileId, id })
    .then(() => {
      applyEqPreset(profileId, id)
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

/**
 * Optimistic `edit_eq_preset` for continuous drags — the GEQ editor's
 * write path when a preset is active (issue #25 part C), same
 * local-first shape as [`editProfileLive`].
 */
export function editEqPresetLive(
  id: string,
  params: Readonly<Record<string, readonly number[]>>,
): void {
  applyEqPresetEdit(id, params)
  void client?.request({ cmd: 'edit_eq_preset', id, params }).catch(() => {
    // The error-path reconcile restores daemon truth.
  })
}

/**
 * Pulls a fresh snapshot — for acked mutations whose full effect the
 * client can't mirror (remove fallbacks are daemon-owned, baselines
 * never ride the snapshot). The `state` event does the applying.
 */
function reconcile(): void {
  void client?.request({ cmd: 'get_state' }).catch(() => {
    // The next state event or reconnect resyncs.
  })
}

/**
 * `add_profile` — clones `from` under the server-minted id the ack
 * carries, applied locally without waiting for a snapshot (ADR-0005),
 * then chains the selection onto the clone: the flow is add → tweak.
 */
export function addProfile(from: string, name: string): void {
  void client
    ?.request({ cmd: 'add_profile', from, name })
    .then((id) => {
      if (id === undefined) return
      applyProfileAdd(from, name, id)
      setProfile(id)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/** Local-first `rename_profile`, applied on the daemon's ack. */
export function renameProfile(id: string, name: string): void {
  void client
    ?.request({ cmd: 'rename_profile', id, name })
    .then(() => {
      applyProfileRename(id, name)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/**
 * `remove_profile` — the fallback rules (selection → the factory selection,
 * EQ preset selectors → None) are daemon-owned: reconcile on the ack
 * instead of mirroring them.
 */
export function removeProfile(id: string): void {
  void client
    ?.request({ cmd: 'remove_profile', id })
    .then(reconcile)
    .catch(() => {
      // The error-path reconcile restores daemon truth.
    })
}

/** `reset_profile` — baselines never ride the snapshot: reconcile. */
export function resetProfile(id: string): void {
  void client
    ?.request({ cmd: 'reset_profile', id })
    .then(reconcile)
    .catch(() => {
      // The error-path reconcile restores daemon truth.
    })
}

/**
 * `add_eq_preset` — [`addProfile`]'s EQ preset counterpart: the clone is
 * selected onto the active profile, so edits continue on the copy.
 */
export function addEqPreset(from: string, name: string): void {
  void client
    ?.request({ cmd: 'add_eq_preset', from, name })
    .then((id) => {
      if (id === undefined) return
      applyEqPresetAdd(from, name, id)
      setEqPreset(state.selected_profile, id)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/** Local-first `rename_eq_preset`, applied on the daemon's ack. */
export function renameEqPreset(id: string, name: string): void {
  void client
    ?.request({ cmd: 'rename_eq_preset', id, name })
    .then(() => {
      applyEqPresetRename(id, name)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/**
 * `remove_eq_preset` — selectors falling back to `None` is
 * daemon-owned (every selecting profile, not just the active one):
 * reconcile on the ack.
 */
export function removeEqPreset(id: string): void {
  void client
    ?.request({ cmd: 'remove_eq_preset', id })
    .then(reconcile)
    .catch(() => {
      // The error-path reconcile restores daemon truth.
    })
}

/** `reset_eq_preset` — baselines never ride the snapshot: reconcile. */
export function resetEqPreset(id: string): void {
  void client
    ?.request({ cmd: 'reset_eq_preset', id })
    .then(reconcile)
    .catch(() => {
      // The error-path reconcile restores daemon truth.
    })
}
