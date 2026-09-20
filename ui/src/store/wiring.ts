/**
 * The wiring every Advanced-panel card shares (#85) — the read half of
 * the Source rule (CONTEXT.md): which item a card reads. #86 adds the
 * write half here; #92 divergence and Reset. Nothing per-param
 * (ADR-0004): the bucket and the category decide.
 */
import { isPresetCarried, type ParameterDef } from '../lib/parameters'
import { resolvedEqParam, selectedProfile, state } from './state'
import { visArray } from './vis'

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
