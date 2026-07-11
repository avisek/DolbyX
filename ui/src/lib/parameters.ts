/**
 * AK parameter metadata, mirroring the daemon's `ParameterDef` table
 * (single source of truth: `parameters.toml`, ADR-0004). Delivered once
 * per page load via `window.__BOOTSTRAP__` — never re-broadcast.
 *
 * Placeholder: the full schema lands with the bootstrap contract
 * (Slice 04, #12).
 */
export interface ParameterDef {
  /** 4-CC name identifying the AK parameter on the wire. */
  readonly name: string
}
