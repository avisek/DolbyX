/**
 * AK parameter metadata, mirroring the daemon's `ParameterDef` table
 * (single source of truth: `parameters.toml`, ADR-0004). Delivered once
 * per page load via `window.__BOOTSTRAP__` — never re-broadcast. The
 * shapes mirror the Rust serde JSON exactly (`ddp-state/src/param_def.rs`).
 */

/**
 * What a parameter *is* for the UI — widget choice + unit label. Rust
 * enum variants serialize externally tagged: unit variants as strings,
 * struct variants as one-key objects.
 */
export type ParamKind =
  /** 0/1 switch. */
  | 'toggle'
  /** Plain integer. */
  | 'integer'
  /** Frequency in Hz. */
  | 'frequency_hz'
  /** Angle in degrees. */
  | 'degrees'
  /** Unit-less per-band array. */
  | 'per_band'
  /** `aobg` — channel-id-prefixed band-gain layout. */
  | 'aobg_channel_major'
  /** License blobs etc. — render as `int[]`. */
  | 'opaque'
  /** 0/1/2 switch; `on` is what "on" writes (2 = the engine's auto). */
  | { readonly tristate: { readonly on: number } }
  /** dB-coded value (raw / 2^`frac_bits` dB); `lkfs` swaps the label. */
  | { readonly decibel: { readonly lkfs: boolean } }

/** Settability bucket (ADR-0004). */
export type ParamAccess =
  'settable' | 'experimental' | 'read_only_dynamic' | 'read_only_static'

/** Parameter category id — the closed `ParamCategory` enum's serde ids. */
export type ParamCategory =
  | 'ieq'
  | 'geq'
  | 'volume_leveller'
  | 'dialog_enhancer'
  | 'headphone_virtualizer'
  | 'speaker_virtualizer'
  | 'next_gen_surround'
  | 'audio_regulator'
  | 'audio_optimizer'
  | 'volume_maximizer'
  | 'peak_limiter'
  | 'visualizer'
  | 'endpoint_volume'
  | 'build'
  | 'license'

/**
 * One `[[category]]` row — a Parameter category (ADR-0004 addendum).
 * Bootstrap order is section order; `params` order is card order.
 */
export interface CategoryDef {
  readonly name: ParamCategory
  /** Section title, as displayed. */
  readonly label: string
  /** The 4-CCs it owns, in card order. */
  readonly params: readonly string[]
}

/** Metadata for one AK parameter (one root leaf of the engine's tree). */
export interface ParameterDef {
  /** 4-CC name identifying the AK parameter on the wire. */
  readonly name: string
  /** The fixed allocation (band arrays: effective count is `*nb`). */
  readonly length: number
  /** Inclusive lower bound, in engine units. */
  readonly min: number
  /** Inclusive upper bound, in engine units. */
  readonly max: number
  /** Fixed-point scale: display = raw / 2^`frac_bits` (4 ⇒ 1/16 dB). */
  readonly frac_bits: number
  /** `length`-sized base value. */
  readonly default: readonly number[]
  /** Drives widget choice + unit label. */
  readonly kind: ParamKind
  /** The Parameter category owning this param (derived by the daemon). */
  readonly category: ParamCategory
  /** Settability bucket. */
  readonly access: ParamAccess
  /** Short, category-relative display name (`Enable`, `Amount`). */
  readonly label: string
  /** Engine one-liner. */
  readonly description: string
  /** Engine long help — may be empty. */
  readonly help: string
}

// The table is static per page load (parsed at daemon startup, injected
// at request time); absent only on a direct :5173 visit, where main.tsx
// redirects before anything resolves against it.
const paramTable: readonly ParameterDef[] = window.__BOOTSTRAP__?.params ?? []
const categoryTable: readonly CategoryDef[] =
  window.__BOOTSTRAP__?.categories ?? []

/**
 * Resolves a 4-CC against the bootstrap table. Throws when absent — a
 * curated descriptor naming an undeclared param is a programming error,
 * caught by the first render.
 */
export function paramDef(name: string): ParameterDef {
  const def = findParamDef(name)
  if (!def) throw new Error(`parameter \`${name}\` missing from bootstrap`)
  return def
}

/**
 * A 4-CC's row, `undefined` when the table has none — for mechanical
 * prefix rules (`<prefix>nb` gates a band array's count) that ask
 * whether a sibling exists rather than assert it.
 */
export function findParamDef(name: string): ParameterDef | undefined {
  return paramTable.find((entry) => entry.name === name)
}

/**
 * The Parameter categories in section order — the Advanced panel's
 * composition, straight from `parameters.toml`; the UI hand-lists
 * nothing (issue #83).
 */
export function categories(): readonly CategoryDef[] {
  return categoryTable
}

/**
 * Whether a param rides an EQ preset — eligibility is derived,
 * `category ∈ {Ieq, Geq}`, never a flag (ADR-0003).
 */
export function isPresetCarried(def: ParameterDef): boolean {
  return def.category === 'ieq' || def.category === 'geq'
}

/**
 * The nine preset-carried 4-CCs, in table order — the vocabulary of the
 * None row's scoped reset and its capture gesture (issue #26).
 */
export function presetCarried(): readonly string[] {
  return paramTable.filter(isPresetCarried).map((def) => def.name)
}

/**
 * The raw value an enable half writes for "on": a tristate's declared
 * `on` (`vdhe` writes 2 — auto — not 1), plain toggles 1. "Off" is
 * always 0.
 */
export function onValue(kind: ParamKind): number {
  return typeof kind === 'object' && 'tristate' in kind ? kind.tristate.on : 1
}

/** The display unit suffix for a kind — empty when unit-less. */
export function unitLabel(kind: ParamKind): string {
  if (typeof kind === 'object') {
    return 'decibel' in kind ? (kind.decibel.lkfs ? 'LKFS' : 'dB') : ''
  }
  if (kind === 'frequency_hz') return 'Hz'
  if (kind === 'degrees') return '°'
  return ''
}
