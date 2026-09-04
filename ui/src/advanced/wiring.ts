// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The read/write wiring every widget shares — EqCurve's source rule
 * generalized: a preset-carried param with a preset selected reads,
 * writes, diverges against and resets the PRESET; everything else the
 * profile. Category-level divergence/reset splits a category's ccs
 * across those two seats and touches each with its own command.
 */
import { paramDef, presetCarried, type ParameterDef } from '../lib/parameters'
import type { EqPreset, Profile } from '../lib/ws'
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
  resetEqPreset,
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

/** Continuous step (drag / scrub / typing / painting) — optimistic
 * live edit. */
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

/** Per-param reset — scoped `reset_eq_preset` / `reset_profile` on
 * whichever seat the card writes. */
export function resetParam(def: ParameterDef): void {
  if (!isWritable(def)) return
  const preset = selectedEqPreset()
  if (carried(def.name) && preset) {
    resetEqPreset(preset.id, [def.name])
    return
  }
  const profile = selectedProfile()
  if (profile) resetProfile(profile.id, [def.name])
}

// — Per-category divergence + reset —

/** A category's writable ccs split by seat: the preset-carried ones
 * sit on the selected preset (while one is selected), the rest on the
 * profile. Categories are seat-pure in practice (ieq / geq are the
 * carried nine), but the split keeps the rule general. */
interface CategorySeats {
  readonly preset: EqPreset | undefined
  readonly profile: Profile | undefined
  readonly presetCcs: readonly string[]
  readonly profileCcs: readonly string[]
}

function categorySeats(params: readonly string[]): CategorySeats {
  const preset = selectedEqPreset()
  const presetCcs: string[] = []
  const profileCcs: string[] = []
  for (const name of params) {
    if (!isWritable(paramDef(name))) continue
    if (preset && carried(name)) presetCcs.push(name)
    else profileCcs.push(name)
  }
  return { preset, profile: selectedProfile(), presetCcs, profileCcs }
}

/** Whether the category's live truth sits (partly) on the selected EQ
 * preset — the `adv-cat--preset` modifier. */
export function categoryOnPreset(params: readonly string[]): boolean {
  return categorySeats(params).presetCcs.length > 0
}

/** Category-level divergence — any writable param off its seat's
 * baseline (exactly the ccs the category reset targets). */
export function categoryDiverged(params: readonly string[]): boolean {
  const seats = categorySeats(params)
  const onPreset =
    seats.preset !== undefined &&
    seats.presetCcs.length > 0 &&
    paramsDiverge(seats.preset, seats.presetCcs)
  const onProfile =
    seats.profile !== undefined &&
    seats.profileCcs.length > 0 &&
    paramsDiverge(seats.profile, seats.profileCcs)
  return onPreset || onProfile
}

export function resetCategory(params: readonly string[]): void {
  const seats = categorySeats(params)
  if (seats.preset && seats.presetCcs.length > 0) {
    resetEqPreset(seats.preset.id, seats.presetCcs)
  }
  if (seats.profile && seats.profileCcs.length > 0) {
    resetProfile(seats.profile.id, seats.profileCcs)
  }
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
