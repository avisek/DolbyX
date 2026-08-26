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
