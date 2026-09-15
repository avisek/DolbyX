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
  /** Dotted version tuple, read-only display `a.b.c.d`. */
  | 'version'
  /** 0/1/2 switch; `on` is what "on" writes (2 = the engine's auto). */
  | { readonly tristate: { readonly on: number } }
  /** dB-coded value (raw / 2^`frac_bits` dB); `lkfs` swaps the label. */
  | { readonly decibel: { readonly lkfs: boolean } }

/** Settability bucket (ADR-0004). */
export type ParamAccess =
  'settable' | 'experimental' | 'read_only_dynamic' | 'read_only_static'

/** UI grouping. */
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
  | 'build_license'

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
  /** UI grouping. */
  readonly category: ParamCategory
  /** Settability bucket. */
  readonly access: ParamAccess
  /** Human-readable display name. */
  readonly label: string
  /** Engine one-liner. */
  readonly description: string
  /** Engine long help — may be empty. */
  readonly help: string
}

// The table is static per page load (parsed at daemon startup, injected
// at request time); absent only on a direct :5173 visit, where main.tsx
// redirects before anything resolves against it.
const table: readonly ParameterDef[] = window.__BOOTSTRAP__?.params ?? []

/**
 * Resolves a 4-CC against the bootstrap table. Throws when absent — a
 * curated descriptor naming an undeclared param is a programming error,
 * caught by the first render.
 */
export function paramDef(name: string): ParameterDef {
  const def = table.find((entry) => entry.name === name)
  if (!def) throw new Error(`parameter \`${name}\` missing from bootstrap`)
  return def
}

/**
 * The nine preset-carried 4-CCs, in table order — eligibility is
 * derived, `category ∈ {Ieq, Geq}`, never a flag (ADR-0003). The
 * vocabulary of the None row's scoped reset and its capture gesture
 * (issue #26).
 */
export function presetCarried(): readonly string[] {
  return table
    .filter((def) => def.category === 'ieq' || def.category === 'geq')
    .map((def) => def.name)
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
