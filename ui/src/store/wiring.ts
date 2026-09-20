/**
 * The wiring every Advanced-panel card shares — the Source rule
 * (CONTEXT.md): which item a card reads (#85) and writes (#86); #92
 * adds divergence and Reset. Nothing per-param (ADR-0004): the bucket
 * and the category decide.
 */
import { isPresetCarried, paramDef, type ParameterDef } from '../lib/parameters'
import {
  resolvedEqParam,
  selectedEqPreset,
  selectedProfile,
  state,
} from './state'
import { visArray } from './vis'
import {
  editEqPreset,
  editEqPresetLive,
  editProfile,
  editProfileLive,
} from './ws'

/** Whether the bucket takes writes — Settable or Experimental. */
export function isWritable(def: ParameterDef): boolean {
  return def.access === 'settable' || def.access === 'experimental'
}

/**
 * A card's current raw values (engine-native i16): ReadOnly-Static from
 * the snapshot's Readouts; ReadOnly-Dynamic from the last `vis` frame (a
 * Live array — held, never idle); a preset-carried param through the EQ
 * selection (the selected EQ preset, else the profile); everything else
 * the active profile. The table default fills a value nothing has
 * served yet.
 */
export function paramValues(def: ParameterDef): readonly number[] {
  if (def.access === 'read_only_static') {
    return state.readouts[def.name] ?? def.default
  }
  if (def.access === 'read_only_dynamic') {
    return visArray(def.name) ?? def.default
  }
  if (isPresetCarried(def)) return resolvedEqParam(def.name) ?? def.default
  return selectedProfile()?.params[def.name] ?? def.default
}

/**
 * Whether a card's Source item is the selected EQ preset — a
 * preset-carried param while the active profile has an EQ selection
 * (ADR-0003). Publishes as `adv-card--preset`.
 */
export function writesToPreset(def: ParameterDef): boolean {
  return isPresetCarried(def) && selectedEqPreset() !== undefined
}

/**
 * Whether any of a category's params writes to the selected EQ preset
 * — `ieq` / `geq` while a preset is selected. Publishes as
 * `adv-cat--preset`.
 */
export function categoryWritesToPreset(params: readonly string[]): boolean {
  return params.some((name) => writesToPreset(paramDef(name)))
}

/**
 * A discrete commit — toggle, tristate — ack-then-apply on the Source
 * item, a 1-entry batch (ADR-0005). Experimental params write exactly
 * like Settable ones.
 */
export function commitParam(
  def: ParameterDef,
  values: readonly number[],
): void {
  const preset = selectedEqPreset()
  if (isPresetCarried(def) && preset) {
    editEqPreset(preset.id, { [def.name]: values })
  } else {
    editProfile(state.selected_profile, { [def.name]: values })
  }
}

/**
 * A continuous step — typing, keys, scrub, drag, paint (#87 on) —
 * optimistic on the Source item: a held key never waits on a
 * round trip (ADR-0005).
 */
export function liveParam(def: ParameterDef, values: readonly number[]): void {
  const preset = selectedEqPreset()
  if (isPresetCarried(def) && preset) {
    editEqPresetLive(preset.id, { [def.name]: values })
  } else {
    editProfileLive(state.selected_profile, { [def.name]: values })
  }
}
