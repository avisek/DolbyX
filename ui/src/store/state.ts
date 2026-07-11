/**
 * UI state — a `solid-js/store` hydrated synchronously from
 * `window.__BOOTSTRAP__` at module init, so the first paint is fully
 * populated with no pre-paint network round-trip (ADR-0006). WS `state`
 * events reconcile any drift after connect.
 */
import { createStore, reconcile } from 'solid-js/store'
import type { StateSnapshot } from '../lib/ws'

// The wire type is readonly; the store's setter needs writable paths.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

// Bootstrap-less init only happens on a direct :5173 visit, where
// main.tsx redirects to the daemon before anything renders — the inert
// snapshot just keeps module init from throwing until then.
const inert: StateSnapshot = {
  power: false,
  selected_profile: '',
  readouts: {},
}

const [state, setState] = createStore<Mutable<StateSnapshot>>(
  window.__BOOTSTRAP__?.state ?? inert,
)

/** The live snapshot, read by components. */
export { state }

/** Reconciles a full daemon snapshot into the store. */
export function applySnapshot(snapshot: StateSnapshot): void {
  setState(reconcile(snapshot))
}

/** Applies the originator's own acked power flip (local-first). */
export function applyPower(on: boolean): void {
  setState('power', on)
}
