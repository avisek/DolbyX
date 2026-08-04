// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The read/write wiring every widget shares — EqCurve's source rule
 * generalized: a preset-carried param with a preset selected reads and
 * writes the PRESET; everything else the profile.
 */
import { paramDef, presetCarried, type ParameterDef } from '../lib/parameters'
import {
  paramsDiverge,
  resolvedEqParam,
  selectedEqPreset,
  selectedProfile,
  state,
} from '../store/state'
import {
  editEqPresetLive,
  editProfile,
  editProfileLive,
  resetProfile,
} from '../store/ws'

/** `*nb` band-count gate per band-array 4-CC prefix (parameters.toml
 * help text: ge* → genb, ie* → ienb, ao* → aonb, ar* → arnb,
 * vn* → vnnb, vc* → vcnb). */
const NB_BY_PREFIX: Readonly<Record<string, string>> = {
  ie: 'ienb',
  ge: 'genb',
  ao: 'aonb',
  ar: 'arnb',
  vn: 'vnnb',
  vc: 'vcnb',
}

export function isWritable(def: ParameterDef): boolean {
  return def.access === 'settable' || def.access === 'experimental'
}

function carried(name: string): boolean {
  return presetCarried().includes(name)
}

/** Whether this card's read/write seat is the selected EQ preset. */
export function writesToPreset(def: ParameterDef): boolean {
  return carried(def.name) && selectedEqPreset() !== undefined
}

/** The card's current raw values (readouts / preset / profile). */
export function paramValues(def: ParameterDef): readonly number[] {
  if (def.access === 'read_only_static') {
    return state.readouts[def.name] ?? def.default
  }
  if (carried(def.name)) return resolvedEqParam(def.name) ?? def.default
  return selectedProfile()?.params[def.name] ?? def.default
}

/** Discrete commit (toggle / tristate / number entry) — ack-then-apply.
 * GAP: store/ws has no non-live `editEqPreset` params variant (only
 * `editEqPresetLive`), so preset-path discrete commits reuse the
 * optimistic live path. */
export function commitParam(
  def: ParameterDef,
  values: readonly number[],
): void {
  const preset = selectedEqPreset()
  if (carried(def.name) && preset) {
    editEqPresetLive(preset.id, { [def.name]: values })
    return
  }
  const profile = selectedProfile()
  if (profile) editProfile(profile.id, { [def.name]: values })
}

/** Continuous drag step — optimistic live edit. */
export function liveParam(def: ParameterDef, values: readonly number[]): void {
  const preset = selectedEqPreset()
  if (carried(def.name) && preset) {
    editEqPresetLive(preset.id, { [def.name]: values })
    return
  }
  const profile = selectedProfile()
  if (profile) editProfileLive(profile.id, { [def.name]: values })
}

/** Divergence of this one 4-CC, against whichever item the card writes. */
export function paramDiverged(def: ParameterDef): boolean {
  if (!isWritable(def)) return false
  const preset = selectedEqPreset()
  if (carried(def.name) && preset) return paramsDiverge(preset, [def.name])
  const profile = selectedProfile()
  return profile ? paramsDiverge(profile, [def.name]) : false
}

/** Per-param reset — profile path only: the wire's `reset_eq_preset`
 * carries `only` (lib/ws.ts Command) but store/ws's `resetEqPreset`
 * doesn't expose it, so preset-path cards omit the affordance. */
export function canResetParam(def: ParameterDef): boolean {
  return isWritable(def) && !writesToPreset(def)
}

export function resetParam(def: ParameterDef): void {
  const profile = selectedProfile()
  if (profile) resetProfile(profile.id, [def.name])
}

// — Per-category divergence + reset —

/** The 4-CCs a category-level reset targets: the category's writable
 * params, minus preset-shadowed ones while a preset is selected — those
 * params' live truth sits on the preset, so a profile-scoped reset
 * would touch stale profile copies underneath. EDGE (rough): the geq /
 * ieq categories therefore lose their reset (and divergence marker)
 * entirely while a preset is selected, even if the preset diverges. */
export function categoryCcs(params: readonly string[]): readonly string[] {
  return params.filter((name) => {
    const def = paramDef(name)
    return isWritable(def) && !writesToPreset(def)
  })
}

/** Category-level divergence — any profile-path writable param off its
 * baseline (same ccs the reset targets). */
export function categoryDiverged(params: readonly string[]): boolean {
  const profile = selectedProfile()
  if (!profile) return false
  const ccs = categoryCcs(params)
  return ccs.length > 0 && paramsDiverge(profile, ccs)
}

export function resetCategory(params: readonly string[]): void {
  const profile = selectedProfile()
  const ccs = categoryCcs(params)
  if (profile && ccs.length > 0) resetProfile(profile.id, ccs)
}

// — Composite grouping (variant C) —

export interface CompositeGroup {
  readonly axis: string
  readonly rows: readonly string[]
}

export type CategoryItem =
  | { readonly param: string }
  | { readonly composite: CompositeGroup }

/**
 * A category's params with band-array siblings merged into composite
 * plots — mechanically, by the same 2-char-prefix mechanism as `*nb`
 * gating: arrays (`length > 1`) group by prefix; a prefix owning
 * exactly one frequency array plus ≥ 1 sibling arrays becomes one
 * composite (axis = the frequency array), placed at its first member's
 * slot. Everything else stays a plain param, in category order.
 */
export function compositeItems(
  params: readonly string[],
): readonly CategoryItem[] {
  const groups = new Map<string, { axis?: string; rows: string[] }>()
  for (const name of params) {
    const def = paramDef(name)
    if (def.length <= 1) continue
    const prefix = name.slice(0, 2)
    const group = groups.get(prefix) ?? { rows: [] }
    if (def.kind === 'frequency_hz' && group.axis === undefined) {
      group.axis = name
    } else {
      group.rows.push(name)
    }
    groups.set(prefix, group)
  }
  const items: CategoryItem[] = []
  const placed = new Set<string>()
  for (const name of params) {
    const prefix = name.slice(0, 2)
    const group = groups.get(prefix)
    if (
      group?.axis !== undefined &&
      group.rows.length > 0 &&
      (group.axis === name || group.rows.includes(name))
    ) {
      if (!placed.has(prefix)) {
        placed.add(prefix)
        items.push({ composite: { axis: group.axis, rows: group.rows } })
      }
      continue
    }
    items.push({ param: name })
  }
  return items
}

/** The effective band count for a band array — the group's resolved
 * `*nb` value, clamped to the allocation; full length when ungated. */
export function effectiveCount(def: ParameterDef): number {
  if (def.length === 1) return 1
  const nb = NB_BY_PREFIX[def.name.slice(0, 2)]
  if (nb === undefined || nb === def.name) return def.length
  const raw = paramValues(paramDef(nb))[0]
  if (raw === undefined) return def.length
  return Math.min(def.length, Math.max(0, raw))
}
