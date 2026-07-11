/**
 * UI state — a `solid-js/store` seeded from the bootstrap snapshot and
 * reconciled by WS `state` events. Store wiring lands with Slice 05
 * (#13).
 */

/** Mirror of the WS `state` event's snapshot. Fields land with the wire
 * contract (Slice 04, #12). */
export interface StateSnapshot {
  readonly power: boolean
}
