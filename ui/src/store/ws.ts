/**
 * The WS ↔ store glue: one [`WsClient`] per tab feeding the state store,
 * plus the connection signal and the command actions components call.
 */
import { createSignal } from 'solid-js'
import { WsClient, type Command } from '../lib/ws'
import {
  applyEqPreset,
  applyEqPresetAdded,
  applyEqPresetEdit,
  applyEqPresetRename,
  applyLanAccess,
  applyPower,
  applyProfile,
  applyProfileAdded,
  applyProfileEdit,
  applyProfileRename,
  applySnapshot,
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
 * Pulls the daemon's full truth after an acked op whose result the
 * originator cannot compute locally (reset values, remove fallbacks,
 * a fresh clone's `baseline` — the cascade lives daemon-side). Safe
 * where the in-flight-edit hazard (ADR-0005) isn't: structural clicks
 * never race a drag.
 */
function reconcile(): void {
  void client?.request({ cmd: 'get_state' }).catch(() => {
    // Handled as any other error event; never unhandled-rejection noise.
  })
}

/**
 * A plain deep copy of a params map. Insert paths need one copy per
 * destination: handing the store one object for both `params` and
 * `baseline.params` would let a reconcile move the two sides at once
 * (real snapshots never alias — they arrive JSON-parsed).
 */
function copyParams(
  params: Readonly<Record<string, readonly number[]>>,
): Record<string, readonly number[]> {
  return Object.fromEntries(
    Object.entries(params).map(([name, values]) => [name, [...values]]),
  )
}

/**
 * Sends one command whose outcome only a reconcile can apply — the
 * shared shape of every reset/remove action.
 */
function requestThenReconcile(command: Command): void {
  void client
    ?.request(command)
    .then(reconcile)
    .catch(() => {
      // Rejected or errored — the error-path reconcile already ran.
    })
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
 * Local-first `set_lan_access` (ADR-0012), shaped like [`setPower`].
 * A remote tab toggling off is severed right after this ack — the
 * last snapshot keeps rendering and commands stop, by design.
 */
export function setLanAccess(on: boolean): void {
  void client
    ?.request({ cmd: 'set_lan_access', on })
    .then(() => {
      applyLanAccess(on)
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
 * Local-first EQ selection — an `edit_profile` tri-state
 * `selected_eq_preset` patch (ADR-0005): id selects, `null` detaches
 * one profile's overlay; applied on the daemon's ack — the daemon has
 * already pushed the resolved nine EQ params in one atomic batch.
 */
export function setEqPreset(profileId: string, id: string | null): void {
  void client
    ?.request({ cmd: 'edit_profile', id: profileId, selected_eq_preset: id })
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
 * `add_profile` from the content the UI already holds — clone is a UI
 * gesture, never a source reference (ADR-0005). On the ack the
 * originator inserts the clone under the minted id and auto-selects
 * it (the daemon never moves the active profile on add); the
 * reconcile fetches the clone's true `baseline` — only the daemon's
 * cascade knows what resolves beneath a custom row, and a Music clone
 * genuinely diverges from it, so Reset enables as the snapshot lands.
 */
export function addProfile(
  name: string,
  params: Readonly<Record<string, readonly number[]>>,
  selectedEqPreset: string | null,
): void {
  void client
    ?.request({
      cmd: 'add_profile',
      name,
      params,
      selected_eq_preset: selectedEqPreset,
    })
    .then((minted) => {
      if (minted === undefined) return
      applyProfileAdded({
        id: minted,
        name,
        is_factory: false,
        selected_eq_preset: selectedEqPreset,
        params: copyParams(params),
        // Baseline unknown until the reconcile: content-as-sent means
        // "diverges nowhere yet" — never a false Reset.
        baseline: {
          selected_eq_preset: selectedEqPreset,
          params: copyParams(params),
        },
      })
      setProfile(minted)
      reconcile()
    })
    .catch(() => {
      // Rejected or errored — the error-path reconcile already ran.
    })
}

/**
 * Local-first rename — an `edit_profile` name patch (ADR-0005: there
 * is no `rename_*`), applied on the ack; ids and persistence keys
 * stay stable, divergence untouched (`name` is a label, never a
 * content key).
 */
export function renameProfile(id: string, name: string): void {
  void client
    ?.request({ cmd: 'edit_profile', id, name })
    .then(() => {
      applyProfileRename(id, name)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/**
 * `add_eq_preset` from content the UI already holds — the clone and
 * None-capture gestures share it (ADR-0005). On the ack the
 * originator inserts the preset under the minted id and selects it
 * for `profileId` via the usual `edit_profile` EQ selection patch;
 * the reconcile fetches the true `baseline`, as [`addProfile`]'s.
 */
export function addEqPreset(
  profileId: string,
  name: string,
  params: Readonly<Record<string, readonly number[]>>,
): void {
  void client
    ?.request({ cmd: 'add_eq_preset', name, params })
    .then((minted) => {
      if (minted === undefined) return
      applyEqPresetAdded({
        id: minted,
        name,
        is_factory: false,
        params: copyParams(params),
        baseline: { params: copyParams(params) },
      })
      setEqPreset(profileId, minted)
      reconcile()
    })
    .catch(() => {
      // Rejected or errored — the error-path reconcile already ran.
    })
}

/**
 * `reset_profile` — whole-item when `only` is absent, else scoped to
 * exactly those content keys (ADR-0007). The reset values aren't
 * locally computable, so the ack triggers a reconcile instead of a
 * local apply.
 */
export function resetProfile(id: string, only?: readonly string[]): void {
  requestThenReconcile(
    only ? { cmd: 'reset_profile', id, only } : { cmd: 'reset_profile', id },
  )
}

/**
 * As [`renameProfile`], for an EQ preset — presets are global, so the
 * new label reaches every profile selecting it.
 */
export function renameEqPreset(id: string, name: string): void {
  void client
    ?.request({ cmd: 'edit_eq_preset', id, name })
    .then(() => {
      applyEqPresetRename(id, name)
    })
    .catch(() => {
      // Rejected or errored — the reconcile restores daemon truth.
    })
}

/** As [`resetProfile`], for an EQ preset. */
export function resetEqPreset(id: string): void {
  requestThenReconcile({ cmd: 'reset_eq_preset', id })
}

/**
 * `remove_profile` — deleting the selected profile falls the active
 * profile to the Fallback profile, which only `defaults.toml` knows:
 * reconcile off the ack rather than guess.
 */
export function removeProfile(id: string): void {
  requestThenReconcile({ cmd: 'remove_profile', id })
}

/**
 * `remove_eq_preset` — the daemon falls every selecting profile to
 * explicit None at delete time (ADR-0003); reconcile off the ack.
 */
export function removeEqPreset(id: string): void {
  requestThenReconcile({ cmd: 'remove_eq_preset', id })
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
